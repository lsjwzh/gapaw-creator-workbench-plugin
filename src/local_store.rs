//! 独立工作台业务库。保留原七表与业务语义，不依赖旧 HTTP 服务，也不执行外发。
use crate::Result;
use chrono::{DateTime, Local, SecondsFormat, Timelike, Utc};
use rusqlite::{
    params, types::ValueRef, Connection, OpenFlags, OptionalExtension, Params, TransactionBehavior,
};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    time::Duration,
};
use uuid::Uuid;

pub const IDENTITY_KEY: &str = "gapaw_local_business_id";
const CHANNELS: &[&str] = &["comment", "dm", "email", "affiliate", "followup"];
const EVENT_CHANNELS: &[&str] = &["comment", "dm", "email", "affiliate"];
const EVENTS: &[&str] = &[
    "发送尝试",
    "发送失败",
    "平台受理",
    "明确已读",
    "有效回复",
    "有意向",
    "确认合作",
    "明确拒绝",
    "寄样",
    "已发片",
];
const NEGOTIATION: &[&str] = &["status", "our_offer", "their_ask", "next_step"];
const PROFILE_LIST: &[&str] = &[
    "id",
    "rank",
    "handle",
    "priority",
    "followers",
    "affiliate_gmv_usd",
    "pet_gmv_share_pct",
    "topic",
    "history",
    "prior_invite",
    "kalodata_window",
    "anchor1",
    "anchor2",
];
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS creators(id TEXT PRIMARY KEY,handle TEXT UNIQUE,profile TEXT NOT NULL,settings TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS drafts(creator TEXT REFERENCES creators(id),channel TEXT,subject TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(creator,channel));
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,creator TEXT REFERENCES creators(id),channel TEXT,type TEXT,at TEXT,proof TEXT,note TEXT,created TEXT,void_reason TEXT DEFAULT '',request_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT,kind TEXT,creator TEXT,previous TEXT,current TEXT);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,creator TEXT REFERENCES creators(id),channel TEXT,direction TEXT,at TEXT,sender TEXT,subject TEXT,body TEXT,zh TEXT,kind TEXT,source TEXT UNIQUE,created TEXT);
CREATE TABLE IF NOT EXISTS negotiations(creator TEXT PRIMARY KEY REFERENCES creators(id),status TEXT,our_offer TEXT,their_ask TEXT,next_step TEXT,updated TEXT);";

#[derive(Debug)]
enum Failure {
    Rejected(String),
    Storage(String),
}
type StoreResult<T> = std::result::Result<T, Failure>;
impl From<rusqlite::Error> for Failure {
    fn from(e: rusqlite::Error) -> Self {
        Self::Storage(format!("本地工作台数据库操作失败：{e}"))
    }
}
impl Failure {
    fn message(self) -> String {
        match self {
            Self::Rejected(s) | Self::Storage(s) => s,
        }
    }
}
fn reject<T>(message: &str) -> StoreResult<T> {
    Err(Failure::Rejected(message.into()))
}
fn field<'a>(v: &'a Value, key: &str) -> StoreResult<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::Rejected(format!("字段格式不正确：{key}")))
}
fn json_field(v: &Value, key: &str) -> StoreResult<Value> {
    serde_json::from_str(field(v, key)?)
        .map_err(|_| Failure::Storage(format!("本地工作台 {key} 数据损坏")))
}
fn stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}
fn parse_time(value: &Value) -> StoreResult<DateTime<Utc>> {
    let raw = value
        .as_str()
        .ok_or_else(|| Failure::Rejected("时间必须带时区".into()))?;
    let at = DateTime::parse_from_rfc3339(raw)
        .or_else(|_| DateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f%:z"))
        .or_else(|_| DateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .map_err(|_| Failure::Rejected("时间必须带时区".into()))?
        .with_timezone(&Utc);
    // Python datetime 的精度为微秒；保留同一存储与比较边界。
    at.with_nanosecond(at.nanosecond() / 1000 * 1000)
        .ok_or_else(|| Failure::Rejected("时间格式不正确".into()))
}
fn formatted(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(
        if at.nanosecond() == 0 {
            SecondsFormat::Secs
        } else {
            SecondsFormat::Micros
        },
        false,
    )
}
fn py_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        _ => v.to_string(),
    }
}
fn text_default(v: &Value, key: &str) -> String {
    v.get(key).map(py_string).unwrap_or_default()
}
fn rows<P: Params>(db: &Connection, sql: &str, args: P) -> StoreResult<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let names = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let mut query = stmt.query(args)?;
    let mut out = Vec::new();
    while let Some(row) = query.next()? {
        let mut item = Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(n) => json!(n),
                ValueRef::Text(s) => json!(std::str::from_utf8(s)
                    .map_err(|_| Failure::Storage("业务库含无效文本".into()))?),
                ValueRef::Blob(_) => {
                    return Err(Failure::Storage("业务库含不兼容的二进制字段".into()))
                }
            };
            item.insert(name.clone(), value);
        }
        out.push(Value::Object(item));
    }
    Ok(out)
}
fn first<P: Params>(db: &Connection, sql: &str, args: P) -> StoreResult<Option<Value>> {
    Ok(rows(db, sql, args)?.into_iter().next())
}
pub(crate) fn default_settings() -> Value {
    json!({"fee":50,"commission":null,"sender":"","owner":"","next_followup":"","notes":"","email":"","email_source":"","comment_target":"","account_checked":false,"product_checked":false,"history_checked":false,"channel_ready":{"comment":false,"dm":false,"email":false,"affiliate":false}})
}
fn open(path: &Path, write: bool) -> Result<Connection> {
    if !path.is_absolute() || path.file_name().is_none_or(|s| s == "state.sqlite") {
        return Err("业务库必须使用独立于插件状态库的绝对文件路径".into());
    }
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("业务库文件不能是符号链接".into());
    }
    check_sidecars(path)?;
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(path, flags)
        .map_err(|e| format!("无法打开本地工作台业务库：{e}"))?;
    db.busy_timeout(Duration::from_secs(20))
        .map_err(|e| e.to_string())?;
    db.pragma_update(None, "foreign_keys", true)
        .map_err(|e| e.to_string())?;
    Ok(db)
}
fn check_sidecars(path: &Path) -> Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        if fs::symlink_metadata(format!("{}{suffix}", path.display()))
            .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
        {
            return Err("业务库附属文件必须是普通文件，不能使用符号链接".into());
        }
    }
    Ok(())
}
pub fn init_connection(db: &Connection) -> Result<()> {
    // 已有身份时 INSERT OR IGNORE 保留原身份，重复初始化不改变业务库身份。
    init_inner(db, &Uuid::new_v4().to_string()).map(|_| ())
}
/// 整库更新时沿用原业务库身份，其余初始化步骤与 `init_connection` 完全一致。
pub(crate) fn init_connection_with_identity(db: &Connection, identity: &str) -> Result<()> {
    if Uuid::parse_str(identity).is_err() {
        return Err("业务库身份格式不合法".into());
    }
    if init_inner(db, identity)? != identity {
        return Err("已有业务库身份与预期不一致，未执行初始化".into());
    }
    Ok(())
}
fn init_inner(db: &Connection, identity: &str) -> Result<String> {
    validate_existing(db)?;
    db.execute_batch(SCHEMA)
        .map_err(|e| format!("无法初始化本地工作台结构：{e}"))?;
    db.execute(
        "INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)",
        params![IDENTITY_KEY, identity],
    )
    .map_err(|e| e.to_string())?;
    identity_connection(db)
}
fn validate_existing(db: &Connection) -> Result<()> {
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "已有文件不是兼容的业务数据库")?;
    if count == 0 {
        return Ok(());
    }
    for (table, columns) in [
        (
            "creators",
            &["id", "handle", "profile", "settings", "revision"][..],
        ),
        (
            "drafts",
            &["creator", "channel", "subject", "body", "revision"][..],
        ),
        (
            "events",
            &[
                "id",
                "creator",
                "channel",
                "type",
                "at",
                "proof",
                "note",
                "created",
                "void_reason",
                "request_id",
            ][..],
        ),
        (
            "audit",
            &["id", "at", "kind", "creator", "previous", "current"][..],
        ),
        ("meta", &["key", "value"][..]),
        (
            "messages",
            &[
                "id",
                "creator",
                "channel",
                "direction",
                "at",
                "sender",
                "subject",
                "body",
                "zh",
                "kind",
                "source",
                "created",
            ][..],
        ),
        (
            "negotiations",
            &[
                "creator",
                "status",
                "our_offer",
                "their_ask",
                "next_step",
                "updated",
            ][..],
        ),
    ] {
        let kind: Option<String> = db
            .query_row(
                "SELECT type FROM sqlite_schema WHERE name=?",
                [table],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "无法核对已有业务库结构")?;
        if kind.as_deref() != Some("table") {
            return Err("已有数据库不是完整的旧工作台七表结构，未执行初始化".into());
        }
        let present =
            rows(db, &format!("PRAGMA table_info({table})"), []).map_err(Failure::message)?;
        for column in columns {
            let expected = if *column == "revision" || (table == "audit" && *column == "id") {
                "INTEGER"
            } else {
                "TEXT"
            };
            let primary = match (table, *column) {
                ("drafts", "creator") => 1,
                ("drafts", "channel") => 2,
                ("negotiations", "creator") | ("meta", "key") => 1,
                (_, "id") => 1,
                _ => 0,
            };
            if present
                .iter()
                .find(|c| c["name"] == *column)
                .is_none_or(|c| {
                    c["type"].as_str().unwrap_or("").to_uppercase() != expected
                        || c["pk"] != primary
                })
            {
                return Err("已有业务库字段不兼容，未执行初始化".into());
            }
        }
    }
    for (table, column) in [
        ("creators", "handle"),
        ("events", "request_id"),
        ("messages", "source"),
    ] {
        let mut found = false;
        for index in
            rows(db, &format!("PRAGMA index_list({table})"), []).map_err(Failure::message)?
        {
            if index["unique"] != 1 || index["partial"] != 0 {
                continue;
            }
            let name = index["name"]
                .as_str()
                .ok_or("已有业务库索引损坏")?
                .replace('"', "\"\"");
            let columns = rows(db, &format!("PRAGMA index_info(\"{name}\")"), [])
                .map_err(Failure::message)?;
            if columns.len() == 1 && columns[0]["name"] == column {
                found = true;
            }
        }
        if !found {
            return Err("已有业务库缺少必要唯一约束，未执行初始化".into());
        }
    }
    let identity: Option<String> = db
        .query_row("SELECT value FROM meta WHERE key=?", [IDENTITY_KEY], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|_| "已有业务库身份损坏，未执行初始化")?;
    if identity.is_some_and(|s| Uuid::parse_str(&s).is_err()) {
        return Err("已有业务库身份损坏，未执行初始化".into());
    }
    Ok(())
}
pub fn identity_connection(db: &Connection) -> Result<String> {
    let value: Option<String> = db
        .query_row("SELECT value FROM meta WHERE key=?", [IDENTITY_KEY], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|_| "无法读取本地业务库身份")?;
    let value = value.ok_or("本地业务库尚未初始化身份")?;
    if Uuid::parse_str(&value).is_err() {
        return Err("本地业务库身份损坏".into());
    }
    Ok(value)
}
pub fn init(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.file_name().is_none_or(|s| s == "state.sqlite") {
        return Err("业务库必须使用独立于插件状态库的绝对文件路径".into());
    }
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("业务库文件不能是符号链接".into());
    }
    check_sidecars(path)?;
    let parent = path.parent().ok_or("业务库路径没有父目录")?;
    if fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("业务库目录不能是符号链接".into());
    }
    if path.exists() {
        validate_existing(&open(path, false)?)?;
    }
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let mut db = Connection::open(path).map_err(|e| e.to_string())?;
    validate_existing(&db)?;
    db.busy_timeout(Duration::from_secs(20))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    init_connection(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn identity(path: &Path) -> Result<String> {
    identity_connection(&open(path, false)?)
}
/// 导出使用同一个只读事务，避免多次连接读取混入不同版本。
pub fn export_details(path: &Path) -> Result<Vec<Value>> {
    let mut db = open(path, false)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    identity_connection(&tx)?;
    rows(&tx, "SELECT id FROM creators ORDER BY id", [])
        .and_then(|ids| {
            ids.iter()
                .map(|row| detail(&tx, field(row, "id")?))
                .collect()
        })
        .map_err(Failure::message)
}

/// 空库合成数据与显式数据导入共用；重复导入保留已经编辑的所有记录。
#[allow(dead_code)] // 合成集成测试驱动调用；产品迁入使用 SQLite 一致性备份。
pub fn seed(path: &Path, input: &Value) -> Result<()> {
    let records = input["records"]
        .as_array()
        .ok_or("导入资料缺少 records 数组")?;
    let source = input["source_sha256"]
        .as_str()
        .ok_or("导入资料缺少来源摘要")?;
    let mut db = open(path, true)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    for record in records {
        let profile = &record["profile"];
        let creator = profile["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("导入资料缺少达人编号")?;
        let handle = profile["handle"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("导入资料缺少账号")?;
        let drafts = record["drafts"].as_array().ok_or("导入资料缺少草稿")?;
        tx.execute(
            "INSERT OR IGNORE INTO creators(id,handle,profile,settings) VALUES(?,?,?,?)",
            params![
                creator,
                handle,
                profile.to_string(),
                default_settings().to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        for draft in drafts {
            let channel = draft["channel"]
                .as_str()
                .filter(|s| CHANNELS.contains(s))
                .ok_or("导入草稿渠道不正确")?;
            let subject = draft["subject"].as_str().ok_or("导入草稿标题不正确")?;
            let body = draft["body"].as_str().ok_or("导入草稿正文不正确")?;
            tx.execute(
                "INSERT OR IGNORE INTO drafts(creator,channel,subject,body) VALUES(?,?,?,?)",
                params![creator, channel, subject, body],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "INSERT OR IGNORE INTO meta(key,value) VALUES('source_sha256',?)",
        [source],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
fn render(body: &str, settings: &Value) -> StoreResult<String> {
    let fee = settings
        .get("fee")
        .ok_or_else(|| Failure::Storage("合作设置缺少固定费".into()))?;
    let commission = settings
        .get("commission")
        .ok_or_else(|| Failure::Storage("合作设置缺少佣金".into()))?;
    let sender = field(settings, "sender")?;
    Ok(body
        .replace(
            "【固定费】",
            &if fee.is_null() {
                "【固定费】".into()
            } else {
                py_string(fee)
            },
        )
        .replace(
            "【佣金比例】",
            &if commission.is_null() {
                "【佣金比例】".into()
            } else {
                py_string(commission)
            },
        )
        .replace(
            "【姓名】",
            if sender.is_empty() {
                "【姓名】"
            } else {
                sender
            },
        ))
}
fn stage(events: &[Value]) -> String {
    let active = events
        .iter()
        .filter(|e| e["void_reason"] == "")
        .collect::<Vec<_>>();
    if active.is_empty() {
        return "待核验".into();
    }
    for typ in [
        "明确拒绝",
        "已发片",
        "寄样",
        "确认合作",
        "有意向",
        "有效回复",
        "明确已读",
        "平台受理",
    ] {
        if active.iter().any(|e| e["type"] == typ) {
            return typ.into();
        }
    }
    // 保留原实现按发生时间取第一条最大值的规则（同一时间时不让后插入覆盖）。
    let mut latest = active[0];
    for event in active.iter().skip(1) {
        if event["at"].as_str() > latest["at"].as_str() {
            latest = event;
        }
    }
    if latest["type"] == "发送失败" {
        "发送失败".into()
    } else {
        "发送尝试".into()
    }
}
fn gates(settings: &Value) -> Vec<&'static str> {
    let mut out = vec![];
    if settings["fee"].is_null() {
        out.push("固定费待填");
    }
    if settings["commission"].is_null() {
        out.push("佣金待填");
    }
    for (key, label) in [
        ("account_checked", "账号接单权待核"),
        ("product_checked", "适配与实品用法待核"),
        ("history_checked", "当前历史消息待查"),
    ] {
        if settings[key] != true {
            out.push(label);
        }
    }
    if settings["sender"].as_str().is_none_or(str::is_empty) {
        out.push("联系人姓名待填");
    }
    out
}
fn detail(db: &Connection, creator: &str) -> StoreResult<Value> {
    let row = first(db, "SELECT * FROM creators WHERE id=?", [creator])?
        .ok_or_else(|| Failure::Rejected("未找到达人".into()))?;
    let profile = json_field(&row, "profile")?;
    let settings = json_field(&row, "settings")?;
    let mut drafts = rows(db, "SELECT * FROM drafts WHERE creator=?", [creator])?;
    for draft in &mut drafts {
        draft["rendered"] = json!(render(field(draft, "body")?, &settings)?);
        draft["rendered_subject"] = json!(render(field(draft, "subject")?, &settings)?);
    }
    let events = rows(
        db,
        "SELECT * FROM events WHERE creator=? ORDER BY at,created",
        [creator],
    )?;
    let messages = rows(
        db,
        "SELECT * FROM messages WHERE creator=? ORDER BY at,created",
        [creator],
    )?;
    let negotiation =
        first(db, "SELECT * FROM negotiations WHERE creator=?", [creator])?.unwrap_or(Value::Null);
    Ok(
        json!({"messages":messages,"negotiation":negotiation,"profile":profile,"settings":settings,"revision":row["revision"],"drafts":drafts,"stage":stage(&events),"gates":gates(&settings),"events":events}),
    )
}
fn list(db: &Connection) -> StoreResult<Vec<Value>> {
    let creators = rows(db, "SELECT id FROM creators ORDER BY id", [])?;
    let mut out = vec![];
    for row in creators {
        let d = detail(db, field(&row, "id")?)?;
        let mut item = Map::new();
        for key in PROFILE_LIST {
            item.insert(
                (*key).into(),
                d["profile"]
                    .get(*key)
                    .cloned()
                    .ok_or_else(|| Failure::Storage(format!("达人资料缺少 {key}")))?,
            );
        }
        let messages = d["messages"].as_array().unwrap();
        let last_in = messages
            .iter()
            .filter(|m| m["direction"] == "in" && m["kind"] == "正常")
            .filter_map(|m| m["at"].as_str())
            .max()
            .unwrap_or("");
        for key in ["stage", "settings", "gates"] {
            item.insert(key.into(), d[key].clone());
        }
        item.insert("msg_count".into(), json!(messages.len()));
        item.insert("last_in".into(), json!(last_in));
        item.insert(
            "negotiation_status".into(),
            d["negotiation"].get("status").cloned().unwrap_or(json!("")),
        );
        out.push(Value::Object(item));
    }
    Ok(out)
}
fn conversations(db: &Connection) -> StoreResult<Vec<Value>> {
    let creators = rows(
        db,
        "SELECT DISTINCT creator FROM messages UNION SELECT creator FROM negotiations ORDER BY 1",
        [],
    )?;
    let mut out = vec![];
    for row in creators {
        let d = detail(db, field(&row, "creator")?)?;
        let p = &d["profile"];
        out.push(json!({"id":p["id"],"handle":p["handle"],"priority":p["priority"],"followers":p["followers"],"stage":d["stage"],"negotiation":d["negotiation"],"messages":d["messages"]}));
    }
    Ok(out)
}
fn summary(db: &Connection, asof: Option<&str>) -> StoreResult<Value> {
    let asof = match asof {
        Some(s) => parse_time(&json!(s))?,
        None => Utc::now(),
    };
    let creators = list(db)?;
    let events = rows(db, "SELECT * FROM events WHERE void_reason=''", [])?;
    let mut groups: HashMap<String, Vec<(Value, DateTime<Utc>)>> = HashMap::new();
    for event in events {
        let at = parse_time(&event["at"])?;
        if at <= asof {
            groups
                .entry(field(&event, "creator")?.into())
                .or_default()
                .push((event, at));
        }
    }
    let (mut mature, mut reply7, mut started, mut responded, mut interested, mut confirmed) =
        (0, 0, 0, 0, 0, 0);
    for events in groups.values() {
        let Some(first) = events
            .iter()
            .filter(|(e, _)| e["type"] == "发送尝试")
            .map(|(_, at)| *at)
            .min()
        else {
            continue;
        };
        started += 1;
        let is_reply = |e: &Value| {
            ["有效回复", "有意向", "明确拒绝", "确认合作"]
                .contains(&e["type"].as_str().unwrap_or(""))
        };
        if events.iter().any(|(e, _)| is_reply(e)) {
            responded += 1;
        }
        if events.iter().any(|(e, _)| e["type"] == "有意向") {
            interested += 1;
        }
        if events.iter().any(|(e, _)| e["type"] == "确认合作") {
            confirmed += 1;
        }
        if let Some(deadline) = first.checked_add_signed(chrono::Duration::days(7)) {
            if asof >= deadline {
                mature += 1;
                if events
                    .iter()
                    .any(|(e, at)| is_reply(e) && *at >= first && *at <= deadline)
                {
                    reply7 += 1;
                }
            }
        }
    }
    let today = asof.with_timezone(&Local).date_naive().to_string();
    let due = creators
        .iter()
        .filter(|r| {
            r["settings"]["next_followup"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s <= today.as_str())
                && r["stage"] != "明确拒绝"
        })
        .count();
    let historical = creators
        .iter()
        .map(|r| match &r["prior_invite"] {
            Value::Bool(b) => i64::from(*b),
            v => v.as_i64().unwrap_or(0),
        })
        .sum::<i64>();
    let rate = if mature == 0 {
        Value::Null
    } else {
        json!(format!("{:.2}", reply7 as f64 / mature as f64 * 100.0)
            .parse::<f64>()
            .map_err(|_| Failure::Storage("统计比例格式错误".into()))?)
    };
    Ok(
        json!({"total":creators.len(),"drafts":creators.len()*5,"started":started,"responded":responded,"interested":interested,"confirmed":confirmed,"mature7":mature,"reply7":reply7,"reply7_rate":rate,"historical_invites":historical,"due":due}),
    )
}
pub fn get(path: &Path, route: &str) -> Result<Value> {
    let mut db = open(path, false)?;
    identity_connection(&db)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let (route, query) = route.split_once('?').unwrap_or((route, ""));
    let route = route.trim_end_matches('/');
    let result = match route {
        "/api/health" => Ok(json!({"ok":true,"service":"Gapaw达人触达系统"})),
        "/api/creators" => {
            list(&tx).and_then(|items| Ok(json!({"items":items,"summary":summary(&tx,None)?})))
        }
        "/api/conversations" => conversations(&tx).map(|items| json!({"items":items})),
        "/api/summary" => {
            let params = url::form_urlencoded::parse(query.as_bytes()).collect::<Vec<_>>();
            if params.iter().any(|(k, _)| k != "asof") || params.len() > 1 {
                reject("统计查询字段不正确")
            } else {
                summary(&tx, params.first().map(|(_, v)| v.as_ref()))
            }
        }
        _ => match route
            .strip_prefix("/api/creators/")
            .filter(|s| !s.is_empty() && !s.contains('/'))
        {
            Some(creator) => detail(&tx, creator),
            None => reject("本地工作台读取接口不存在"),
        },
    };
    result.map_err(Failure::message)
}

fn audit(
    db: &Connection,
    kind: &str,
    creator: &str,
    previous: &str,
    current: &str,
) -> StoreResult<()> {
    db.execute(
        "INSERT INTO audit(at,kind,creator,previous,current) VALUES(?,?,?,?,?)",
        params![stamp(), kind, creator, previous, current],
    )?;
    Ok(())
}
fn validate_settings(settings: &Value) -> StoreResult<()> {
    if !settings["fee"].is_null()
        && !settings["fee"]
            .as_i64()
            .is_some_and(|n| [50, 100].contains(&n))
    {
        return reject("固定费只能为两条合计50或100美元");
    }
    if !settings["commission"].is_null()
        && !settings["commission"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n))
    {
        return reject("佣金必须是0—100之间的数字或留空");
    }
    for key in ["account_checked", "product_checked", "history_checked"] {
        if !settings[key].is_boolean() {
            return reject("核验字段格式不正确");
        }
    }
    if settings["channel_ready"].as_object().is_none_or(|o| {
        o.len() != EVENT_CHANNELS.len()
            || EVENT_CHANNELS
                .iter()
                .any(|k| !o.get(*k).is_some_and(Value::is_boolean))
    }) {
        return reject("渠道核验格式不正确");
    }
    for key in [
        "sender",
        "owner",
        "notes",
        "email",
        "email_source",
        "comment_target",
        "next_followup",
    ] {
        if settings[key]
            .as_str()
            .is_none_or(|s| s.chars().count() > 6000)
        {
            return reject("文本过长或格式不正确");
        }
    }
    let email = field(settings, "email")?;
    if !email.is_empty() {
        let parts = email.split('@').collect::<Vec<_>>();
        if email.chars().any(char::is_whitespace)
            || parts.len() != 2
            || parts[0].is_empty()
            || parts[1]
                .rsplit_once('.')
                .is_none_or(|(left, right)| left.is_empty() || right.is_empty())
        {
            return reject("邮箱格式不正确");
        }
    }
    for key in ["email_source", "comment_target"] {
        let s = field(settings, key)?;
        if !s.is_empty() && !s.starts_with("https://") && !s.starts_with("http://") {
            return reject("来源链接须以http或https开头");
        }
    }
    if settings["channel_ready"]["email"] == true
        && (settings["email"] == "" || settings["email_source"] == "")
    {
        return reject("核验邮件渠道前请填写商务邮箱和来源链接");
    }
    if settings["channel_ready"]["comment"] == true && settings["comment_target"] == "" {
        return reject("核验评论渠道前请填写本次评论的视频链接");
    }
    let date = field(settings, "next_followup")?;
    if !date.is_empty() && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
        return reject("跟进日期格式应为年-月-日");
    }
    Ok(())
}
fn update_settings(db: &Connection, creator: &str, payload: &Value) -> StoreResult<Value> {
    let patch = payload["settings"]
        .as_object()
        .ok_or_else(|| Failure::Rejected("不支持的设置字段".into()))?;
    let defaults = default_settings();
    if patch.keys().any(|k| defaults.get(k).is_none()) {
        return reject("不支持的设置字段");
    }
    let row = first(
        db,
        "SELECT settings,revision FROM creators WHERE id=?",
        [creator],
    )?
    .ok_or_else(|| Failure::Rejected("未找到达人".into()))?;
    if payload["revision"].as_i64() != row["revision"].as_i64() {
        return reject("页面已过期，请刷新后再保存");
    }
    let revision = row["revision"]
        .as_i64()
        .filter(|r| *r < i64::MAX)
        .ok_or_else(|| Failure::Storage("合作设置版本无效".into()))?;
    let mut settings = json_field(&row, "settings")?;
    if !settings.is_object() {
        return Err(Failure::Storage("合作设置结构损坏".into()));
    }
    for (key, value) in patch {
        settings[key] = value.clone();
    }
    validate_settings(&settings)?;
    db.execute(
        "UPDATE creators SET settings=?,revision=? WHERE id=?",
        params![settings.to_string(), revision + 1, creator],
    )?;
    audit(
        db,
        "设置",
        creator,
        field(&row, "settings")?,
        &settings.to_string(),
    )?;
    detail(db, creator)
}
fn hardcoded_fee(body: &str) -> bool {
    ["50", "100"].iter().any(|fee| {
        body.match_indices(fee).any(|(i, _)| {
            !body[..i].chars().next_back().is_some_and(char::is_numeric)
                && body[i + fee.len()..].trim_start().starts_with("美元")
        })
    })
}
fn edit_draft(
    db: &Connection,
    creator: &str,
    channel: &str,
    payload: &Value,
) -> StoreResult<Value> {
    let subject = payload.get("subject").and_then(Value::as_str).unwrap_or("");
    let body = payload["body"].as_str().unwrap_or("");
    if !CHANNELS.contains(&channel)
        || body.trim().is_empty()
        || body.chars().count() > 10000
        || subject.chars().count() > 300
        || payload.get("subject").is_some_and(|v| !v.is_string())
    {
        return reject("文案格式不正确");
    }
    if hardcoded_fee(body) {
        return reject("请用【固定费】保留金额联动，避免改报价后遗留旧金额");
    }
    let row = first(
        db,
        "SELECT * FROM drafts WHERE creator=? AND channel=?",
        params![creator, channel],
    )?
    .ok_or_else(|| Failure::Rejected("文案已更新，请刷新后再保存".into()))?;
    if payload["revision"].as_i64() != row["revision"].as_i64() {
        return reject("文案已更新，请刷新后再保存");
    }
    let revision = row["revision"]
        .as_i64()
        .filter(|r| *r < i64::MAX)
        .ok_or_else(|| Failure::Storage("草稿版本无效".into()))?;
    db.execute(
        "UPDATE drafts SET subject=?,body=?,revision=? WHERE creator=? AND channel=?",
        params![subject, body, revision + 1, creator, channel],
    )?;
    audit(
        db,
        &format!("文案:{channel}"),
        creator,
        &row.to_string(),
        &json!({"subject":subject,"body":body}).to_string(),
    )?;
    detail(db, creator)
}
fn add_event(db: &Connection, creator: &str, payload: &Value) -> StoreResult<Value> {
    let channel = payload["channel"].as_str().unwrap_or("");
    let typ = payload["type"].as_str().unwrap_or("");
    if !EVENT_CHANNELS.contains(&channel) || !EVENTS.contains(&typ) {
        return reject("请选择实际渠道与事件");
    }
    let at = parse_time(&payload["at"])?;
    let created = stamp();
    if at > Utc::now() + chrono::Duration::minutes(2) {
        return reject("不能把未来计划记为已发生事件");
    }
    let proof = text_default(payload, "proof").trim().to_string();
    let note = text_default(payload, "note").trim().to_string();
    let request = text_default(payload, "request_id");
    if request.is_empty() || request.chars().count() > 100 {
        return reject("缺少请求编号");
    }
    if proof.chars().count() > 6000 || note.chars().count() > 6000 {
        return reject("记录内容过长");
    }
    if typ != "发送尝试" && proof.is_empty() {
        return reject("请填写回执、回复摘录或其他事实依据");
    }
    if let Some(old) = first(db, "SELECT * FROM events WHERE request_id=?", [&request])? {
        if old["creator"] != creator {
            return reject("请求编号已被其他记录使用");
        }
        return Ok(old);
    }
    let row = first(db, "SELECT settings FROM creators WHERE id=?", [creator])?
        .ok_or_else(|| Failure::Rejected("未找到达人".into()))?;
    let settings = json_field(&row, "settings")?;
    let events = rows(
        db,
        "SELECT * FROM events WHERE creator=? AND void_reason=''",
        [creator],
    )?;
    let mut types = HashSet::new();
    let mut same = HashSet::new();
    for event in &events {
        if parse_time(&event["at"])? <= at {
            let t = field(event, "type")?;
            types.insert(t);
            if event["channel"] == channel {
                same.insert(t);
            }
        }
    }
    if typ == "发送尝试" && types.contains("明确拒绝") {
        return reject("该达人已明确拒绝，停止继续触达");
    }
    if ["发送失败", "平台受理", "明确已读"].contains(&typ) && !same.contains("发送尝试")
    {
        return reject("先记录同渠道的发送尝试");
    }
    if typ == "明确已读" && !same.contains("平台受理") {
        return reject("先记录同渠道的平台受理依据");
    }
    if ["有效回复", "有意向", "明确拒绝"].contains(&typ) && !types.contains("发送尝试")
    {
        return reject("先记录本轮至少一次发送尝试；不要求先有已读回执");
    }
    if typ == "确认合作" {
        if !types.contains("有意向") {
            return reject("先记录达人有意向的回复");
        }
        if settings["commission"].is_null() {
            return reject("确认合作前应填写约定佣金");
        }
    }
    if ["寄样", "已发片"].contains(&typ) && !types.contains("确认合作") {
        return reject("先记录双方确认合作");
    }
    let result = json!({"id":Uuid::new_v4().simple().to_string(),"creator":creator,"channel":channel,"type":typ,"at":formatted(at),"proof":proof,"note":note,"created":created,"void_reason":"","request_id":request});
    db.execute(
        "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",
        params![
            field(&result, "id")?,
            creator,
            channel,
            typ,
            field(&result, "at")?,
            proof,
            note,
            created,
            "",
            request
        ],
    )?;
    Ok(result)
}
fn add_message(db: &Connection, creator: &str, payload: &Value) -> StoreResult<Value> {
    let channel = payload["channel"].as_str().unwrap_or("");
    let direction = payload["direction"].as_str().unwrap_or("");
    if !EVENT_CHANNELS.contains(&channel) || !["in", "out"].contains(&direction) {
        return reject("请选择实际渠道与方向");
    }
    let kind = match payload.get("kind") {
        None | Some(Value::Null) => "正常",
        Some(Value::String(s)) if s.is_empty() => "正常",
        Some(Value::String(s)) => s,
        _ => return reject("消息类型不正确"),
    };
    if !["正常", "自动回复"].contains(&kind) {
        return reject("消息类型不正确");
    }
    let at = parse_time(&payload["at"])?;
    if at > Utc::now() + chrono::Duration::minutes(2) {
        return reject("不能登记未来的消息");
    }
    let body = text_default(payload, "body").trim().to_string();
    let zh = text_default(payload, "zh").trim().to_string();
    let source = text_default(payload, "source").trim().to_string();
    let sender = text_default(payload, "sender").trim().to_string();
    let subject = text_default(payload, "subject").trim().to_string();
    if body.is_empty()
        || body.chars().count() > 20000
        || zh.chars().count() > 4000
        || sender.chars().count() > 300
        || subject.chars().count() > 300
    {
        return reject("消息内容为空或过长");
    }
    if source.is_empty() || source.chars().count() > 300 {
        return reject("缺少来源编号（邮件编号或截图路径）");
    }
    if first(db, "SELECT id FROM creators WHERE id=?", [creator])?.is_none() {
        return reject("未找到达人");
    }
    if let Some(old) = first(db, "SELECT * FROM messages WHERE source=?", [&source])? {
        if old["creator"] != creator {
            return reject("来源编号已登记在其他达人名下");
        }
        if old["zh"] != zh || old["kind"] != kind {
            db.execute(
                "UPDATE messages SET zh=?,kind=? WHERE id=?",
                params![zh, kind, field(&old, "id")?],
            )?;
            audit(
                db,
                "消息摘要",
                creator,
                &old.to_string(),
                &json!({"zh":zh,"kind":kind}).to_string(),
            )?;
        }
        return first(
            db,
            "SELECT * FROM messages WHERE id=?",
            [field(&old, "id")?],
        )?
        .ok_or_else(|| Failure::Storage("已登记消息消失".into()));
    }
    let result = json!({"id":Uuid::new_v4().simple().to_string(),"creator":creator,"channel":channel,"direction":direction,"at":formatted(at),"sender":sender,"subject":subject,"body":body,"zh":zh,"kind":kind,"source":source,"created":stamp()});
    db.execute(
        "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            field(&result, "id")?,
            creator,
            channel,
            direction,
            field(&result, "at")?,
            sender,
            subject,
            body,
            zh,
            kind,
            source,
            field(&result, "created")?
        ],
    )?;
    Ok(result)
}
fn negotiation(db: &Connection, creator: &str, payload: &Value) -> StoreResult<Value> {
    if payload
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !NEGOTIATION.contains(&k.as_str())))
    {
        return reject("不支持的谈判字段");
    }
    let mut values = Map::new();
    for key in NEGOTIATION {
        let s = text_default(payload, key).trim().to_string();
        if s.chars().count() > 3000 {
            return reject("谈判摘要过长");
        }
        values.insert((*key).into(), json!(s));
    }
    let values = Value::Object(values);
    if first(db, "SELECT id FROM creators WHERE id=?", [creator])?.is_none() {
        return reject("未找到达人");
    }
    let old = first(db, "SELECT * FROM negotiations WHERE creator=?", [creator])?;
    db.execute(
        "INSERT OR REPLACE INTO negotiations VALUES(?,?,?,?,?,?)",
        params![
            creator,
            field(&values, "status")?,
            field(&values, "our_offer")?,
            field(&values, "their_ask")?,
            field(&values, "next_step")?,
            stamp()
        ],
    )?;
    audit(
        db,
        "谈判摘要",
        creator,
        &old.map(|v| v.to_string()).unwrap_or_default(),
        &values.to_string(),
    )?;
    detail(db, creator)
}
fn void_event(db: &Connection, creator: &str, event: &str, payload: &Value) -> StoreResult<Value> {
    let reason = payload["reason"].as_str().unwrap_or("");
    if reason.trim().is_empty() || reason.chars().count() > 1000 {
        return reject("请填写撤销原因");
    }
    let old = first(
        db,
        "SELECT * FROM events WHERE id=? AND creator=?",
        params![event, creator],
    )?
    .ok_or_else(|| Failure::Rejected("未找到该记录".into()))?;
    if old["void_reason"] != "" {
        return reject("该记录已撤销");
    }
    let latest = first(
        db,
        "SELECT id FROM events WHERE creator=? AND void_reason='' ORDER BY created DESC LIMIT 1",
        [creator],
    )?
    .ok_or_else(|| Failure::Storage("事件依赖结构损坏".into()))?;
    if latest["id"] != event {
        return reject("为保留事件依赖，请先从最后一条有效记录开始撤销");
    }
    db.execute(
        "UPDATE events SET void_reason=? WHERE id=?",
        params![reason, event],
    )?;
    audit(db, "撤销事件", creator, &old.to_string(), reason)?;
    detail(db, creator)
}
fn dispatch(db: &Connection, route: &str, payload: &Value) -> StoreResult<Value> {
    if payload.to_string().len() > 50000 {
        return reject("请求长度不正确");
    }
    let route = route.split('?').next().unwrap_or(route).trim_matches('/');
    let parts = route.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["api", "creators", creator, "settings"] => update_settings(db, creator, payload),
        ["api", "creators", creator, "drafts", channel] => {
            edit_draft(db, creator, channel, payload)
        }
        ["api", "creators", creator, "events"] => add_event(db, creator, payload),
        ["api", "creators", creator, "messages"] => add_message(db, creator, payload),
        ["api", "creators", creator, "negotiation"] => negotiation(db, creator, payload),
        ["api", "creators", creator, "events", event, "void"] => {
            void_event(db, creator, event, payload)
        }
        _ => reject("本地工作台写入接口不存在"),
    }
}
/// 内层错误是业务明确拒绝；外层错误表示存储不可用或提交结果需读回核对。
pub fn post(
    path: &Path,
    route: &str,
    payload: &Value,
) -> Result<std::result::Result<Value, String>> {
    let mut db = open(path, true)?;
    identity_connection(&db)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    match dispatch(&tx, route, payload) {
        Ok(value) => {
            tx.commit()
                .map_err(|e| format!("本地工作台提交失败，请读回核对：{e}"))?;
            Ok(Ok(value))
        }
        Err(Failure::Rejected(message)) => Ok(Err(message)),
        Err(Failure::Storage(message)) => Err(message),
    }
}
