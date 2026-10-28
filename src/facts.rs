//! 人工事实登记：唯一事实源是工作台，仅保存请求指纹和恢复回执。
use crate::{drafts::Outreach, identifier, now, open_db, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

const SETTINGS: &[&str] = &[
    "fee",
    "commission",
    "sender",
    "owner",
    "next_followup",
    "notes",
    "email",
    "email_source",
    "comment_target",
    "account_checked",
    "product_checked",
    "history_checked",
    "channel_ready",
];
const CHANNELS: &[&str] = &["comment", "dm", "email", "affiliate"];
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
const EVENT_FIELDS: &[&str] = &[
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
];
const MESSAGE_FIELDS: &[&str] = &[
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
];
const ACTIONS: &[&str] = &[
    "edit-settings",
    "record-event",
    "void-event",
    "record-message",
];
const NOTE: &str =
    "仅登记人工确认的既有事实，不发送消息、不执行触达；登记 out 消息或触达事件不代表插件执行发送。";

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS gapaw_fact_requests(request_id TEXT PRIMARY KEY,creator_id TEXT NOT NULL,action TEXT NOT NULL,endpoint TEXT NOT NULL,request_hash TEXT NOT NULL,target_hash TEXT NOT NULL,remote_key TEXT NOT NULL,expected_revision INTEGER,status TEXT NOT NULL,message TEXT NOT NULL,remote_id TEXT,revision INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS gapaw_fact_requests_creator ON gapaw_fact_requests(creator_id,created_at);")
        .map_err(|_|"无法初始化人工登记回执".into())
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
pub(crate) fn source_fingerprint(client: &Outreach) -> String {
    hash(&json!(client.root))
}
fn check_source(input: &Value, client: &Outreach) -> Result<()> {
    if input["expectedSource"] != source_fingerprint(client) {
        return Err("工作台来源已变化或缺少来源确认，请重新打开当前来源的达人表单".into());
    }
    Ok(())
}
fn keys(v: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let o = v.as_object().ok_or("人工登记输入必须是对象")?;
    if required.iter().any(|k| !o.contains_key(*k))
        || o.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err("人工登记包含缺失或未允许的字段".into());
    }
    Ok(())
}
fn text(v: &Value, max: usize, nonempty: bool) -> Result<String> {
    let s = v.as_str().ok_or("人工登记文本类型无效")?;
    if s.chars().count() > max
        || s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
        || nonempty && s.trim().is_empty()
    {
        return Err("人工登记文本为空、过长或含非法控制字符".into());
    }
    Ok(s.to_string())
}
fn id(v: &Value, key: &str) -> Result<String> {
    let id = identifier(v, key)?;
    if id.len() > 100 {
        return Err(format!("{key} 不能超过100字节"));
    }
    Ok(id)
}
fn timestamp(v: &Value, future_check: bool) -> Result<String> {
    let raw = text(v, 64, true)?;
    let at =
        DateTime::parse_from_rfc3339(&raw).map_err(|_| "发生时间必须是带时区的 RFC3339 时间")?;
    if at.timestamp_subsec_nanos() % 1000 != 0 {
        return Err("发生时间最多支持微秒精度".into());
    }
    if future_check && at.with_timezone(&Utc) > Utc::now() + chrono::Duration::minutes(2) {
        return Err("不能把未来计划登记为已发生事实".into());
    }
    Ok(at
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Micros, true))
}
fn http_link(v: &Value) -> Result<()> {
    let s = text(v, 6000, false)?;
    if s.is_empty() {
        return Ok(());
    }
    let u = url::Url::parse(&s).map_err(|_| "来源链接必须是有效 HTTP(S) 地址")?;
    if !["http", "https"].contains(&u.scheme())
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || s.chars().any(char::is_whitespace)
    {
        return Err("来源链接必须是无账号密码的 HTTP(S) 地址".into());
    }
    Ok(())
}
fn settings(input: &Value, full: bool) -> Result<Value> {
    if full {
        keys(input, SETTINGS, &[])?
    } else {
        keys(input, &[], SETTINGS)?;
        if input.as_object().unwrap().is_empty() {
            return Err("请至少填写一个要保存的设置字段".into());
        }
    }
    let mut out = input.clone();
    for (k, v) in input.as_object().unwrap() {
        match k.as_str() {
            "fee" => {
                if !v.is_null() && !v.as_i64().is_some_and(|n| [50, 100].contains(&n)) {
                    return Err("固定费只能是两条合计50或100美元的整数".into());
                }
            }
            "commission" => {
                if !v.is_null() {
                    let n = v
                        .as_f64()
                        .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))
                        .ok_or("佣金必须是0至100之间的数字或null")?;
                    out[k] = json!(n);
                }
            }
            "account_checked" | "product_checked" | "history_checked" => {
                if !v.is_boolean() {
                    return Err("核验设置必须是布尔值".into());
                }
            }
            "channel_ready" => {
                keys(v, CHANNELS, &[])?;
                if v.as_object().unwrap().values().any(|x| !x.is_boolean()) {
                    return Err("渠道核验必须完整提供四个布尔值".into());
                }
            }
            _ => {
                text(v, 6000, false)?;
            }
        }
    }
    if let Some(v) = input.get("email") {
        let email = v.as_str().unwrap();
        if !email.is_empty() {
            let parts = email.split('@').collect::<Vec<_>>();
            if parts.len() != 2
                || parts[0].is_empty()
                || !parts[1].contains('.')
                || parts[1].starts_with('.')
                || parts[1].ends_with('.')
                || email.chars().any(char::is_whitespace)
            {
                return Err("邮箱格式不正确".into());
            }
        }
    }
    for key in ["email_source", "comment_target"] {
        if let Some(v) = input.get(key) {
            http_link(v)?;
        }
    }
    if let Some(v) = input.get("next_followup") {
        let s = v.as_str().unwrap();
        if !s.is_empty() {
            let d = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .map_err(|_| "跟进日期必须为 YYYY-MM-DD 或空字符串")?;
            if d.format("%Y-%m-%d").to_string() != s {
                return Err("跟进日期必须为 YYYY-MM-DD".into());
            }
        }
    }
    if full {
        if input["channel_ready"]["email"] == true
            && (input["email"] == "" || input["email_source"] == "")
        {
            return Err("核验邮件渠道前须填写商务邮箱和来源链接".into());
        }
        if input["channel_ready"]["comment"] == true && input["comment_target"] == "" {
            return Err("核验评论渠道前须填写本次评论目标链接".into());
        }
    }
    Ok(out)
}
fn event_content(v: &Value) -> Result<Value> {
    let mut out = Map::new();
    for key in ["creator", "channel", "type", "proof", "note", "request_id"] {
        out.insert(
            key.into(),
            json!(text(&v[key], 6000, !["note", "proof"].contains(&key))?),
        );
    }
    out.insert("at".into(), json!(timestamp(&v["at"], false)?));
    Ok(json!(out))
}
fn message_content(v: &Value) -> Result<Value> {
    let mut out = Map::new();
    for key in [
        "creator",
        "channel",
        "direction",
        "sender",
        "subject",
        "body",
        "zh",
        "kind",
        "source",
    ] {
        out.insert(key.into(), v[key].clone());
    }
    out.insert("at".into(), json!(timestamp(&v["at"], false)?));
    Ok(json!(out))
}
fn event_safe(v: &Value, creator: &str) -> Result<Value> {
    let o = v.as_object().ok_or("工作台事件结构不兼容")?;
    let out: Value = json!(EVENT_FIELDS
        .iter()
        .map(|k| (k.to_string(), o.get(*k).cloned().unwrap_or(Value::Null)))
        .collect::<Map<_, _>>());
    if out["creator"] != creator
        || !CHANNELS.contains(&out["channel"].as_str().unwrap_or(""))
        || !EVENTS.contains(&out["type"].as_str().unwrap_or(""))
    {
        return Err("工作台事件归属或类型不兼容".into());
    }
    id(&out, "id")?;
    text(&out["request_id"], 100, true)?;
    timestamp(&out["at"], false)?;
    timestamp(&out["created"], false)?;
    for key in ["proof", "note"] {
        text(&out[key], 6000, false)?;
    }
    text(&out["void_reason"], 1000, false)?;
    Ok(out)
}
fn message_safe(v: &Value, creator: &str) -> Result<Value> {
    let o = v.as_object().ok_or("工作台消息结构不兼容")?;
    let out: Value = json!(MESSAGE_FIELDS
        .iter()
        .map(|k| (k.to_string(), o.get(*k).cloned().unwrap_or(Value::Null)))
        .collect::<Map<_, _>>());
    if out["creator"] != creator {
        return Err("工作台消息归属不一致".into());
    }
    id(&out, "id")?;
    timestamp(&out["at"], false)?;
    for key in ["sender", "subject", "source"] {
        text(&out[key], 300, key == "source")?;
    }
    text(&out["body"], 20000, true)?;
    text(&out["zh"], 4000, false)?;
    if !CHANNELS.contains(&out["channel"].as_str().unwrap_or(""))
        || !["in", "out"].contains(&out["direction"].as_str().unwrap_or(""))
        || !["正常", "自动回复"].contains(&out["kind"].as_str().unwrap_or(""))
    {
        return Err("工作台消息类型不兼容".into());
    }
    Ok(out)
}
fn detail(client: &Outreach, creator: &str) -> Result<Value> {
    let v = client
        .detail(creator)
        .map_err(|_| "无法读取达人当前档案，请检查工作台连接")?;
    if v["profile"]["id"] != creator
        || !v["events"].is_array()
        || !v["messages"].is_array()
        || v["revision"]
            .as_i64()
            .is_none_or(|n| n < 0 || n == i64::MAX)
    {
        return Err("工作台达人归属或事实结构不兼容".into());
    }
    Ok(v)
}
fn table(db: &Connection) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='gapaw_fact_requests')",[],|r|r.get(0)).map_err(|_|"无法读取人工登记回执结构".into())
}
#[derive(Clone)]
struct Receipt {
    request: String,
    creator: String,
    action: String,
    endpoint: String,
    request_hash: String,
    target_hash: String,
    remote_key: String,
    expected: Option<i64>,
    status: String,
    message: String,
    remote_id: Option<String>,
    revision: Option<i64>,
    created: String,
    updated: String,
}
impl Receipt {
    fn public(&self) -> Value {
        json!({"requestId":self.request,"creatorId":self.creator,"expectedSource":hash(&json!(self.endpoint)),"action":self.action,"status":self.status,"message":self.message,"createdAt":self.created,"updatedAt":self.updated,"remoteId":self.remote_id,"revision":self.revision,"canRetry":(["unknown","not_applied"].contains(&self.status.as_str())),"requestHash":self.request_hash})
    }
}
fn load(db: &Connection, request: &str) -> Result<Option<Receipt>> {
    if !table(db)? {
        return Ok(None);
    }
    db.query_row("SELECT request_id,creator_id,action,endpoint,request_hash,target_hash,remote_key,expected_revision,status,message,remote_id,revision,created_at,updated_at FROM gapaw_fact_requests WHERE request_id=?",[request],|r|Ok(Receipt{request:r.get(0)?,creator:r.get(1)?,action:r.get(2)?,endpoint:r.get(3)?,request_hash:r.get(4)?,target_hash:r.get(5)?,remote_key:r.get(6)?,expected:r.get(7)?,status:r.get(8)?,message:r.get(9)?,remote_id:r.get(10)?,revision:r.get(11)?,created:r.get(12)?,updated:r.get(13)?})).optional().map_err(|_|"无法读取人工登记回执".into())
}
fn recent(db: Option<&Connection>, creator: &str, endpoint: &str) -> Result<Vec<Value>> {
    let Some(db) = db else { return Ok(vec![]) };
    if !table(db)? {
        return Ok(vec![]);
    }
    let mut stmt=db.prepare("SELECT request_id FROM gapaw_fact_requests WHERE creator_id=? AND endpoint=? ORDER BY created_at DESC,rowid DESC LIMIT 100").map_err(|_|"无法读取人工登记历史")?;
    let ids = stmt
        .query_map([creator, endpoint], |r| r.get::<_, String>(0))
        .map_err(|_| "无法读取人工登记历史")?;
    ids.map(|r| {
        load(db, &r.map_err(|_| "无法读取人工登记历史")?)?
            .map(|r| r.public())
            .ok_or_else(|| "人工登记回执缺失".into())
    })
    .collect()
}
fn other_unknown(db: &Connection, creator: &str, request: &str, endpoint: &str) -> Result<bool> {
    if !table(db)? {
        return Ok(false);
    }
    db.query_row("SELECT EXISTS(SELECT 1 FROM gapaw_fact_requests WHERE creator_id=? AND request_id<>? AND endpoint=? AND status='unknown')",params![creator,request,endpoint],|r|r.get(0)).map_err(|_|"无法核对未完成的人工登记".into())
}
fn persist_mode(path: &Path, receipt: &Receipt, create_only: bool) -> Result<(Receipt, bool)> {
    let mut db = open_db(path, true)?.ok_or("无法打开插件回执库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "人工登记回执正忙")?;
    init(&tx)?;
    let mut inserted = false;
    if let Some(old) = load(&tx, &receipt.request)? {
        if old.request_hash != receipt.request_hash
            || old.creator != receipt.creator
            || old.action != receipt.action
            || old.endpoint != receipt.endpoint
        {
            return Err("同一请求编号不能更换达人、动作、地址或内容".into());
        }
        if create_only
            || old.status == "saved"
            || (receipt.status != "saved"
                && ["conflict", "rejected"].contains(&old.status.as_str()))
        {
            return Ok((old, false));
        }
        if old.target_hash != receipt.target_hash
            || old.remote_key != receipt.remote_key
            || old.expected != receipt.expected
        {
            return Err("人工登记回执绑定不一致，不能改写原恢复目标".into());
        }
        tx.execute("UPDATE gapaw_fact_requests SET status=?,message=?,remote_id=?,revision=?,updated_at=? WHERE request_id=?",params![receipt.status,receipt.message,receipt.remote_id,receipt.revision,receipt.updated,receipt.request]).map_err(|_|"无法更新人工登记回执")?;
    } else {
        inserted = true;
        if other_unknown(&tx, &receipt.creator, &receipt.request, &receipt.endpoint)? {
            return Err("此达人有结果未知的登记，请先用原请求编号核对，不能新建动作".into());
        }
        tx.execute(
            "INSERT INTO gapaw_fact_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                receipt.request,
                receipt.creator,
                receipt.action,
                receipt.endpoint,
                receipt.request_hash,
                receipt.target_hash,
                receipt.remote_key,
                receipt.expected,
                receipt.status,
                receipt.message,
                receipt.remote_id,
                receipt.revision,
                receipt.created,
                receipt.updated
            ],
        )
        .map_err(|_| "无法保存人工登记回执")?;
    }
    tx.commit().map_err(|_| "无法提交人工登记回执")?;
    Ok((receipt.clone(), inserted))
}
fn persist(path: &Path, receipt: &Receipt) -> Result<Receipt> {
    Ok(persist_mode(path, receipt, false)?.0)
}
enum Observed {
    Match(Option<String>, Option<i64>),
    Absent,
    Conflict,
}
fn observe(receipt: &Receipt, current: &Value) -> Result<Observed> {
    match receipt.action.as_str() {
        "edit-settings" => {
            let rev = current["revision"].as_i64().ok_or("工作台设置版本无效")?;
            let expected = receipt.expected.ok_or("设置回执缺少确认版本")?;
            if rev == expected + 1
                && hash(&settings(&current["settings"], true)?) == receipt.target_hash
            {
                Ok(Observed::Match(None, Some(rev)))
            } else if rev == expected {
                Ok(Observed::Absent)
            } else {
                Ok(Observed::Conflict)
            }
        }
        "record-event" => {
            let found = current["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["request_id"] == receipt.remote_key);
            if let Some(e) = found {
                let e = event_safe(e, &receipt.creator)?;
                if hash(&event_content(&e)?) == receipt.target_hash {
                    Ok(Observed::Match(Some(id(&e, "id")?), None))
                } else {
                    Ok(Observed::Conflict)
                }
            } else {
                Ok(Observed::Absent)
            }
        }
        "record-message" => {
            let found = current["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["source"] == receipt.remote_key);
            if let Some(m) = found {
                let m = message_safe(m, &receipt.creator)?;
                if hash(&message_content(&m)?) == receipt.target_hash {
                    Ok(Observed::Match(Some(id(&m, "id")?), None))
                } else {
                    Ok(Observed::Conflict)
                }
            } else {
                Ok(Observed::Absent)
            }
        }
        "void-event" => {
            if let Some(e) = current["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["id"] == receipt.remote_key)
            {
                let e = event_safe(e, &receipt.creator)?;
                if hash(&e) == receipt.target_hash {
                    Ok(Observed::Match(Some(id(&e, "id")?), None))
                } else if e["void_reason"] == "" {
                    Ok(Observed::Absent)
                } else {
                    Ok(Observed::Conflict)
                }
            } else {
                Ok(Observed::Conflict)
            }
        }
        _ => Err("人工登记回执动作不支持".into()),
    }
}
fn outcome(
    path: &Path,
    old: &Receipt,
    observation: Result<Observed>,
    rejected: bool,
) -> Result<Receipt> {
    let mut r = old.clone();
    r.updated = now();
    match observation {
        Ok(Observed::Match(remote, revision)) => {
            r.status = "saved".into();
            r.message = "已在工作台读回并核对一致；仅保存人工登记，不代表执行发送。".into();
            r.remote_id = remote;
            r.revision = revision;
        }
        Ok(Observed::Conflict) => {
            r.status = "conflict".into();
            r.message = "工作台版本、来源内容或撤销状态已变化；未确认本次结果，请刷新核对。".into();
        }
        _ if rejected => {
            r.status = "rejected".into();
            r.message = "工作台明确拒绝登记，请刷新核对前置事实、来源归属与字段条件。".into();
        }
        _ => {
            r.status = "unknown".into();
            r.message =
                "登记结果尚未确认，请保留原请求编号核对或重试；当前未看到记录不证明未执行。".into();
        }
    }
    persist(path, &r)
}
struct Submission {
    is_new: bool,
    receipt: Receipt,
    payload: Value,
    route: String,
    preflight: Option<Observed>,
}
fn initial_receipt(action: &str, input: &Value, client: &Outreach) -> Result<Receipt> {
    Ok(Receipt {
        request: id(input, "requestId")?,
        creator: id(input, "creatorId")?,
        action: action.into(),
        endpoint: client.root.clone(),
        request_hash: hash(input),
        target_hash: String::new(),
        remote_key: String::new(),
        expected: None,
        status: "unknown".into(),
        message: "人工登记已开始，结果等待读回确认。".into(),
        remote_id: None,
        revision: None,
        created: now(),
        updated: now(),
    })
}
fn submission(
    action: &str,
    input: &Value,
    client: &Outreach,
    current: &Value,
    previous: Option<Receipt>,
) -> Result<Submission> {
    let is_new = previous.is_none();
    let required = match action {
        "edit-settings" => vec![
            "requestId",
            "creatorId",
            "expectedSource",
            "confirmed",
            "expectedRevision",
            "settings",
            "basis",
        ],
        "record-event" => vec![
            "requestId",
            "creatorId",
            "expectedSource",
            "confirmed",
            "event",
        ],
        "record-message" => vec![
            "requestId",
            "creatorId",
            "expectedSource",
            "confirmed",
            "message",
        ],
        "void-event" => vec![
            "requestId",
            "creatorId",
            "expectedSource",
            "confirmed",
            "eventId",
            "expectedEventHash",
            "reason",
        ],
        _ => return Err("不支持的事实动作".into()),
    };
    keys(input, &required, &[])?;
    if input["confirmed"] != true {
        return Err("必须由用户明确确认本次人工登记".into());
    }
    let request = id(input, "requestId")?;
    let creator = id(input, "creatorId")?;
    let request_hash = hash(input);
    let mut receipt = initial_receipt(action, input, client)?;
    let mut preflight = None;
    let (payload, route) = match action {
        "edit-settings" => {
            text(&input["basis"], 2000, true)?;
            let rev = input["expectedRevision"]
                .as_i64()
                .filter(|v| *v >= 0 && *v < i64::MAX)
                .ok_or("expectedRevision 必须是有效非负整数")?;
            let patch = settings(&input["settings"], false)?;
            let mut merged = settings(&current["settings"], true)?;
            for (k, v) in patch.as_object().unwrap() {
                merged[k] = v.clone();
            }
            let merged = settings(&merged, true)?;
            receipt.expected = Some(rev);
            receipt.target_hash = hash(&merged);
            if previous.is_none() && current["revision"] != rev {
                preflight = Some(Observed::Conflict)
            }
            (
                json!({"settings":patch,"revision":rev}),
                format!("/api/creators/{creator}/settings"),
            )
        }
        "record-event" => {
            let e = &input["event"];
            keys(e, &["channel", "type", "at", "proof", "note"], &[])?;
            if !CHANNELS.contains(&e["channel"].as_str().unwrap_or(""))
                || !EVENTS.contains(&e["type"].as_str().unwrap_or(""))
            {
                return Err("请选择实际渠道和支持的事实事件类型".into());
            }
            let mut payload = e.clone();
            payload["at"] = json!(timestamp(&e["at"], true)?);
            payload["proof"] = json!(text(&e["proof"], 6000, true)?.trim());
            payload["note"] = json!(text(&e["note"], 6000, false)?.trim());
            payload["request_id"] = json!(request);
            let mut target = payload.clone();
            target["creator"] = json!(creator);
            receipt.target_hash = hash(&event_content(&target)?);
            receipt.remote_key = request.clone();
            (payload, format!("/api/creators/{creator}/events"))
        }
        "record-message" => {
            let m = &input["message"];
            keys(
                m,
                &[
                    "channel",
                    "direction",
                    "at",
                    "sender",
                    "subject",
                    "body",
                    "zh",
                    "kind",
                    "source",
                ],
                &[],
            )?;
            if !CHANNELS.contains(&m["channel"].as_str().unwrap_or(""))
                || !["in", "out"].contains(&m["direction"].as_str().unwrap_or(""))
                || !["正常", "自动回复"].contains(&m["kind"].as_str().unwrap_or(""))
            {
                return Err("消息渠道、方向或类型不受支持".into());
            }
            let mut payload = m.clone();
            payload["at"] = json!(timestamp(&m["at"], true)?);
            for (key, max, required) in [
                ("sender", 300, false),
                ("subject", 300, false),
                ("body", 20000, true),
                ("zh", 4000, false),
                ("source", 300, true),
            ] {
                payload[key] = json!(text(&m[key], max, required)?.trim());
            }
            let mut target = payload.clone();
            target["creator"] = json!(creator);
            receipt.target_hash = hash(&message_content(&target)?);
            receipt.remote_key = payload["source"].as_str().unwrap().into();
            (payload, format!("/api/creators/{creator}/messages"))
        }
        "void-event" => {
            let event = id(input, "eventId")?;
            let expected = text(&input["expectedEventHash"], 64, true)?;
            if expected.len() != 64
                || !expected
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("撤销确认摘要格式无效，请刷新事件".into());
            }
            let reason = text(&input["reason"], 1000, true)?;
            let target = current["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["id"] == event)
                .ok_or("要撤销的事件不属于此达人")?;
            let mut target = event_safe(target, &creator)?;
            if previous.is_none() && (hash(&target) != expected || target["void_reason"] != "") {
                preflight = Some(Observed::Conflict)
            }
            target["void_reason"] = json!(reason);
            receipt.target_hash = hash(&target);
            receipt.remote_key = event.clone();
            (
                json!({"reason":reason}),
                format!("/api/creators/{creator}/events/{event}/void"),
            )
        }
        _ => unreachable!(),
    };
    if payload.to_string().len() > 50000 {
        return Err("工作台请求最多50000字节，请缩短内容后提交".into());
    }
    if let Some(old) = previous {
        if old.request_hash != request_hash
            || old.creator != creator
            || old.action != action
            || old.endpoint != client.root
        {
            return Err("同一请求编号不能更换达人、动作、地址或内容".into());
        }
        receipt = old;
    }
    Ok(Submission {
        is_new,
        receipt,
        payload,
        route,
        preflight,
    })
}
fn mutate(action: &str, input: Value, path: &Path) -> Result<Value> {
    let request = id(&input, "requestId")?;
    let creator = id(&input, "creatorId")?;
    let db = open_db(path, false)?.ok_or("请先配置现有工作台")?;
    let client = Outreach::required(Some(&db))?;
    check_source(&input, &client)?;
    let previous = load(&db, &request)?;
    if let Some(old) = &previous {
        if old.request_hash != hash(&input)
            || old.creator != creator
            || old.action != action
            || old.endpoint != client.root
        {
            return Err("同一请求编号不能更换达人、动作、地址或内容".into());
        }
        if ["saved", "conflict", "rejected"].contains(&old.status.as_str()) {
            return Ok(json!({"receipt":old.public()}));
        }
    }
    if other_unknown(&db, &creator, &request, &client.root)? {
        return Err("此达人有结果未知的登记，请先核对原请求，不能新建动作".into());
    }
    drop(db);
    let current = detail(&client, &creator)?;
    let submission = match submission(action, &input, &client, &current, previous.clone()) {
        Ok(submission) => submission,
        Err(message) if previous.is_none() => {
            // 原子保留明确未发送的本地拒绝；并发已建立的回执优先，不能把未知改成拒绝。
            let mut rejected = initial_receipt(action, &input, &client)?;
            rejected.status = "rejected".into();
            rejected.message = format!("提交前校验未通过，未向工作台发送此登记：{message}");
            return Ok(json!({"receipt":persist_mode(path,&rejected,true)?.0.public()}));
        }
        Err(message) => return Err(message),
    };
    let (receipt, inserted) = persist_mode(path, &submission.receipt, submission.is_new)?;
    if submission.is_new && !inserted {
        return Ok(json!({"receipt":receipt.public()}));
    }
    if ["saved", "conflict", "rejected"].contains(&receipt.status.as_str()) {
        return Ok(json!({"receipt":receipt.public()}));
    }
    if let Some(preflight) = submission.preflight {
        return Ok(json!({"receipt":outcome(path,&receipt,Ok(preflight),false)?.public()}));
    }
    match observe(&receipt, &current)? {
        Observed::Match(remote, revision) => {
            return Ok(
                json!({"receipt":outcome(path,&receipt,Ok(Observed::Match(remote,revision)),false)?.public()}),
            )
        }
        Observed::Conflict => {
            return Ok(
                json!({"receipt":outcome(path,&receipt,Ok(Observed::Conflict),false)?.public()}),
            )
        }
        Observed::Absent => {}
    }
    // 网络调用前已持久化unknown，且不持有数据库连接或写事务。
    let rejected = matches!(
        client.post(&submission.route, &submission.payload),
        Ok(Err(_))
    );
    let after = detail(&client, &creator).and_then(|d| observe(&receipt, &d));
    Ok(json!({"receipt":outcome(path,&receipt,after,rejected)?.public()}))
}
fn contract(input: &Value, path: &Path) -> Result<Value> {
    keys(input, &["creatorId"], &[])?;
    let creator = id(input, "creatorId")?;
    let db = open_db(path, false)?;
    let client = Outreach::required(db.as_ref())?;
    let detail = detail(&client, &creator)?;
    let events = detail["events"].as_array().unwrap();
    if events.len() > 5000 {
        return Err("达人事件超过读取限制，请在工作台核对".into());
    }
    let mut projected = Vec::new();
    for e in events {
        let mut e = event_safe(e, &creator)?;
        let digest = hash(&e);
        e["eventHash"] = json!(digest);
        projected.push(e);
    }
    Ok(
        json!({"creatorId":creator,"sourceUrl":client.root,"expectedSource":source_fingerprint(&client),"settingsRevision":detail["revision"],"settings":settings(&detail["settings"],true)?,"stage":detail["stage"],"gates":detail["gates"],"events":projected,"recentReceipts":recent(db.as_ref(),&creator,&client.root)?,"contract":{"version":"manual-facts-v2","sourceScope":"来源指纹仅绑定工作台地址，不是数据库身份；同地址替换数据库无法识别。","settingsBasisScope":"合作设置依据仅用于本次确认与请求指纹，不长期保存；需长期保留的依据请写入备注。","settingsFields":SETTINGS,"feeChoices":[50,100],"feeScope":"工作台当前接口限制：两条视频合计美元，不代表通用业务报价默认","commissionMin":0,"commissionMax":100,"commissionNullable":true,"channels":CHANNELS,"eventTypes":EVENTS,"messageKinds":["正常","自动回复"],"directions":["in","out"],"requiresHumanConfirmation":true,"eventProofRequired":true,"emptyValues":"空字符串清除文本，null清除佣金；channel_ready须完整提供四个布尔值。","note":NOTE,"limits":{"requestBytes":50000,"eventProofChars":6000,"messageBodyChars":20000,"sourceChars":300},"recovery":"结果未知时必须沿用原请求编号核对或重试，不能新建同达人动作。"}}),
    )
}
fn status(input: &Value, path: &Path) -> Result<Value> {
    keys(
        input,
        &["creatorId", "expectedSource"],
        &["requestId", "reconcile"],
    )?;
    let creator = id(input, "creatorId")?;
    if input.get("reconcile").is_some_and(|v| !v.is_boolean()) {
        return Err("reconcile 必须是布尔值".into());
    }
    let db = open_db(path, false)?;
    let client = Outreach::required(db.as_ref())?;
    check_source(input, &client)?;
    let Some(request) = input.get("requestId") else {
        if input["reconcile"] == true {
            return Err("核对未知结果必须提供原requestId".into());
        }
        return Ok(
            json!({"creatorId":creator,"expectedSource":source_fingerprint(&client),"receipts":recent(db.as_ref(),&creator,&client.root)?}),
        );
    };
    let request = id(&json!({"requestId":request}), "requestId")?;
    let db = db.ok_or("人工登记回执不存在")?;
    let receipt = load(&db, &request)?.ok_or("人工登记回执不存在")?;
    if receipt.creator != creator {
        return Err("此请求编号不属于当前达人".into());
    }
    if client.root != receipt.endpoint {
        return Err("工作台地址已变化，不能跨地址读取或恢复原人工登记".into());
    }
    if input["reconcile"] != true
        || ["saved", "conflict", "rejected"].contains(&receipt.status.as_str())
    {
        return Ok(
            json!({"creatorId":creator,"expectedSource":source_fingerprint(&client),"receipts":[receipt.public()]}),
        );
    }
    drop(db);
    let observed = detail(&client, &creator).and_then(|d| observe(&receipt, &d));
    let saved = outcome(path, &receipt, observed, false)?;
    Ok(
        json!({"creatorId":creator,"expectedSource":source_fingerprint(&client),"receipts":[saved.public()]}),
    )
}
pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    match command {
        "workbench-fact-contract" => contract(&input, path),
        "workbench-fact-status" => status(&input, path),
        _ if ACTIONS.contains(&command) => mutate(command, input, path),
        _ => Err("不支持的人工事实命令".into()),
    }
}
