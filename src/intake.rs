//! 外部批次达人建档与发送事实登记。
//! 只登记已经发生的发送事实：不发送任何消息，也不修改已有达人档案和已有事件。
use crate::{drafts::only_keys, local_backend, local_store, Result};
use chrono::{DateTime, SecondsFormat, Timelike, Utc};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

const CREATOR_KEYS: &[&str] = &[
    "id",
    "handle",
    "email",
    "tiktokUrl",
    "followers",
    "source",
    "notes",
    "sends",
];
const SEND_KEYS: &[&str] = &["channel", "at", "proof", "status", "note"];
const CHANNELS: &[&str] = &["email", "dm", "comment", "affiliate"];
const STATUSES: &[&str] = &["accepted", "failed", "attempted"];
const MAX_CREATORS: usize = 500;
const MAX_SENDS: usize = 20;

#[derive(Clone)]
struct SendFact {
    channel: String,
    at: String,
    proof: String,
    status: String,
    note: String,
}

#[derive(Clone)]
struct IntakeCreator {
    id: String,
    handle: String,
    email: Option<String>,
    tiktok_url: String,
    followers: Option<u64>,
    source: String,
    notes: String,
    sends: Vec<SendFact>,
}

impl IntakeCreator {
    /// 规范化后的达人结构用于计算预览摘要；可选字段统一补空值，时间统一为 UTC。
    fn normalized(&self) -> Value {
        json!({
            "id": self.id,
            "handle": self.handle,
            "email": self.email.clone().unwrap_or_default(),
            "tiktok_url": self.tiktok_url.clone(),
            "followers": self.followers,
            "source": self.source.clone(),
            "notes": self.notes.clone(),
            "sends": self.sends.iter().map(|send| json!({
                "channel": send.channel.clone(),
                "at": send.at.clone(),
                "proof": send.proof.clone(),
                "status": send.status.clone(),
                "note": send.note.clone(),
            })).collect::<Vec<_>>(),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CreatorState {
    New,
    Existing,
    Conflict(&'static str),
}

struct PlannedEvent {
    channel: String,
    typ: &'static str,
    at: String,
    proof: String,
    note: String,
    request_id: String,
    exists: bool,
}

struct Plan {
    states: Vec<CreatorState>,
    events: Vec<Vec<PlannedEvent>>,
    events_new: usize,
    events_existing: usize,
}

fn valid_batch(value: &str) -> bool {
    (3..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("GW") else {
        return false;
    };
    (3..=6).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_digit())
}

fn valid_handle(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_')
}

fn normalize_email(raw: &str) -> Option<String> {
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let (local, domain) = raw.split_once('@')?;
    if local.is_empty() || domain.is_empty() || domain.contains('@') {
        return None;
    }
    let (left, right) = domain.rsplit_once('.')?;
    if left.is_empty() || right.is_empty() {
        return None;
    }
    Some(raw.to_ascii_lowercase())
}

fn canonical_time(raw: &str) -> Result<String> {
    let at = DateTime::parse_from_rfc3339(raw)
        .map_err(|_| "发送时间必须是带时区的 RFC3339 时间".to_string())?;
    let at = at.with_timezone(&Utc);
    let at = at
        .with_nanosecond(at.nanosecond() / 1000 * 1000)
        .ok_or_else(|| "发送时间格式不正确".to_string())?;
    Ok(at.to_rfc3339_opts(
        if at.nanosecond() == 0 {
            SecondsFormat::Secs
        } else {
            SecondsFormat::Micros
        },
        false,
    ))
}

fn required_str<'a>(value: &'a Value, key: &str, label: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少{label}，或{label}不是字符串"))
}

fn bounded_text<'a>(value: &'a Value, key: &str, max: usize, label: &str) -> Result<&'a str> {
    let text = required_str(value, key, label)?;
    if text.chars().count() > max
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(format!("{label}过长或包含非法控制字符"));
    }
    Ok(text)
}

fn optional_text(value: &Value, key: &str, max: usize, label: &str) -> Result<String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(item) => {
            let text = item
                .as_str()
                .ok_or_else(|| format!("{label}必须是字符串"))?;
            if text.chars().count() > max
                || text
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return Err(format!("{label}过长或包含非法控制字符"));
            }
            Ok(text.trim().to_string())
        }
    }
}

fn parse_send(value: &Value) -> Result<SendFact> {
    only_keys(value, SEND_KEYS, "发送事实")?;
    let channel = required_str(value, "channel", "发送渠道")?;
    if !CHANNELS.contains(&channel) {
        return Err("发送渠道只能是 email、dm、comment 或 affiliate".into());
    }
    let at = canonical_time(required_str(value, "at", "发送时间")?)?;
    let proof = bounded_text(value, "proof", 200, "发送凭证")?
        .trim()
        .to_string();
    let status = required_str(value, "status", "发送状态")?;
    if !STATUSES.contains(&status) {
        return Err("发送状态只能是 accepted、failed 或 attempted".into());
    }
    let note = optional_text(value, "note", 300, "发送备注")?;
    Ok(SendFact {
        channel: channel.into(),
        at,
        proof,
        status: status.into(),
        note,
    })
}

fn parse_creator(value: &Value) -> Result<IntakeCreator> {
    only_keys(value, CREATOR_KEYS, "达人")?;
    let id = required_str(value, "id", "达人编号")?;
    if !valid_id(id) {
        return Err("达人编号必须是 GW 加 3 到 6 位数字".into());
    }
    let handle = required_str(value, "handle", "达人账号")?;
    if !valid_handle(handle) {
        return Err("达人账号只能包含字母、数字、点和下划线，长度 2 到 64，且不带 @".into());
    }
    let email = match value.get("email") {
        None | Some(Value::Null) => None,
        Some(item) => {
            let raw = item.as_str().ok_or("邮箱必须是字符串")?;
            Some(normalize_email(raw).ok_or("邮箱格式不正确")?)
        }
    };
    let tiktok_url = format!("https://www.tiktok.com/@{handle}");
    match value.get("tiktokUrl") {
        None | Some(Value::Null) => {}
        Some(item) => {
            let raw = item.as_str().ok_or("tiktokUrl 必须是字符串")?;
            if raw != tiktok_url.as_str() {
                return Err("tiktokUrl 必须等于 https://www.tiktok.com/@<handle>".into());
            }
        }
    }
    let followers = match value.get("followers") {
        None | Some(Value::Null) => None,
        Some(item) => Some(item.as_u64().ok_or("followers 必须是非负整数")?),
    };
    let source = optional_text(value, "source", 200, "来源说明")?;
    let notes = optional_text(value, "notes", 500, "备注")?;
    let sends = match value.get("sends") {
        None | Some(Value::Null) => Vec::new(),
        Some(item) => {
            let list = item.as_array().ok_or("sends 必须是数组")?;
            if list.len() > MAX_SENDS {
                return Err("每位达人最多登记 20 条发送事实".into());
            }
            let mut sends = Vec::with_capacity(list.len());
            for send in list {
                sends.push(parse_send(send)?);
            }
            sends.sort_by(|a, b| {
                (&a.at, &a.channel, &a.status, &a.proof, &a.note)
                    .cmp(&(&b.at, &b.channel, &b.status, &b.proof, &b.note))
            });
            sends
        }
    };
    Ok(IntakeCreator {
        id: id.into(),
        handle: handle.into(),
        email,
        tiktok_url,
        followers,
        source,
        notes,
        sends,
    })
}

fn parse_body(input: &Value) -> Result<(String, Vec<IntakeCreator>, Value)> {
    let batch = required_str(input, "batch", "批次编号")?;
    if !valid_batch(batch) {
        return Err("批次编号只能包含小写字母、数字和连字符，长度 3 到 64".into());
    }
    let list = input
        .get("creators")
        .and_then(Value::as_array)
        .ok_or("缺少达人列表 creators")?;
    if list.is_empty() || list.len() > MAX_CREATORS {
        return Err("每次导入达人数量必须在 1 到 500 之间".into());
    }
    let mut ids = HashSet::new();
    let mut handles = HashSet::new();
    let mut creators = Vec::with_capacity(list.len());
    for raw in list {
        let creator = parse_creator(raw)?;
        if !ids.insert(creator.id.clone()) {
            return Err(format!("达人编号重复：{}", creator.id));
        }
        if !handles.insert(creator.handle.clone()) {
            return Err(format!("达人账号重复：{}", creator.handle));
        }
        creators.push(creator);
    }
    // 规范化顺序，保证同一份内容不论达人顺序如何都得到相同摘要。
    creators.sort_by(|a, b| a.id.cmp(&b.id));
    let normalized = json!({
        "batch": batch,
        "creators": creators.iter().map(IntakeCreator::normalized).collect::<Vec<_>>(),
    });
    Ok((batch.to_string(), creators, normalized))
}

fn digest_of(normalized: &Value) -> String {
    format!("{:x}", Sha256::digest(normalized.to_string().as_bytes()))
}

fn event_request_id(batch: &str, creator: &str, proof: &str, typ: &str, at: &str) -> String {
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{proof}|{typ}|{at}").as_bytes())
    );
    format!("intake:{batch}:{creator}:{}", &hash[..16])
}

fn event_types(status: &str) -> &'static [&'static str] {
    match status {
        "accepted" => &["发送尝试", "平台受理"],
        "failed" => &["发送尝试", "发送失败"],
        _ => &["发送尝试"],
    }
}

fn stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}

fn open_business(path: &Path, write: bool) -> Result<Connection> {
    if !path.is_absolute() || path.file_name().is_none_or(|name| name == "state.sqlite") {
        return Err("业务库必须使用独立于插件状态库的绝对文件路径".into());
    }
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("业务库文件不能是符号链接".into());
    }
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(path, flags)
        .map_err(|e| format!("无法打开本地工作台业务库：{e}"))?;
    db.busy_timeout(Duration::from_secs(20))
        .map_err(|e| format!("无法设置业务库等待时间：{e}"))?;
    if write {
        db.pragma_update(None, "foreign_keys", true)
            .map_err(|e| format!("无法开启业务库外键约束：{e}"))?;
    }
    Ok(db)
}

/// 业务库必须已经初始化并处于本地工作台模式，避免向旧服务或未启用的库写入。
fn database(state: &Path, write: bool) -> Result<Connection> {
    let status = local_backend::status(state)?;
    if status["initialized"] != true {
        return Err("本地工作台尚未初始化，请先建立或迁入工作台".into());
    }
    if status["active"] != true {
        return Err("本地工作台尚未启用，请先启用本地工作台".into());
    }
    open_business(&local_backend::business_path(state)?, write)
}

/// 只读核对：返回每位达人的归类以及每条待登记事件是否已经存在。
fn plan(db: &Connection, creators: &[IntakeCreator], batch: &str) -> Result<Plan> {
    let mut by_id: HashMap<String, String> = HashMap::new();
    let mut by_handle: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = db
            .prepare("SELECT id,handle FROM creators")
            .map_err(|e| format!("无法读取达人档案：{e}"))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| format!("无法读取达人档案：{e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("无法读取达人档案：{e}"))? {
            let id: String = row.get(0).map_err(|e| format!("无法读取达人档案：{e}"))?;
            let handle: Option<String> =
                row.get(1).map_err(|e| format!("无法读取达人档案：{e}"))?;
            let handle = handle.unwrap_or_default();
            by_handle.insert(handle.clone(), id.clone());
            by_id.insert(id, handle);
        }
    }
    let mut states = Vec::with_capacity(creators.len());
    let mut events = Vec::with_capacity(creators.len());
    let mut events_new = 0usize;
    let mut events_existing = 0usize;
    for creator in creators {
        let state = match (by_id.get(&creator.id), by_handle.get(&creator.handle)) {
            (Some(saved), _) if saved == &creator.handle => CreatorState::Existing,
            (Some(_), _) => CreatorState::Conflict("达人编号已存在但账号不同"),
            (None, Some(other)) if other != &creator.id => {
                CreatorState::Conflict("达人账号已被其他编号使用")
            }
            (None, _) => CreatorState::New,
        };
        let mut seen = HashSet::new();
        let mut planned = Vec::new();
        for send in &creator.sends {
            for typ in event_types(&send.status) {
                let request_id = event_request_id(batch, &creator.id, &send.proof, typ, &send.at);
                // 同一达人内完全相同的发送事实只登记一次。
                if !seen.insert(request_id.clone()) {
                    continue;
                }
                let exists: i64 = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM events WHERE request_id=?)",
                        [&request_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| format!("无法核对已有事件：{e}"))?;
                if exists == 1 {
                    events_existing += 1;
                } else {
                    events_new += 1;
                }
                planned.push(PlannedEvent {
                    channel: send.channel.clone(),
                    typ,
                    at: send.at.clone(),
                    proof: send.proof.clone(),
                    note: send.note.clone(),
                    request_id,
                    exists: exists == 1,
                });
            }
        }
        states.push(state);
        events.push(planned);
    }
    Ok(Plan {
        states,
        events,
        events_new,
        events_existing,
    })
}

fn conflicts(plan: &Plan, creators: &[IntakeCreator]) -> Vec<Value> {
    creators
        .iter()
        .zip(&plan.states)
        .filter_map(|(creator, state)| match state {
            CreatorState::Conflict(reason) => Some(json!({
                "id": creator.id,
                "handle": creator.handle,
                "reason": reason,
            })),
            _ => None,
        })
        .collect()
}

fn preview(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["batch", "creators"], "creator-import-preview")?;
    let (batch, creators, normalized) = parse_body(input)?;
    let digest = digest_of(&normalized);
    let db = database(path, false)?;
    let plan = plan(&db, &creators, &batch)?;
    let new_count = plan
        .states
        .iter()
        .filter(|state| matches!(state, CreatorState::New))
        .count();
    let existing_count = plan
        .states
        .iter()
        .filter(|state| matches!(state, CreatorState::Existing))
        .count();
    let found = conflicts(&plan, &creators);
    let can_import = found.is_empty();
    let message = if can_import {
        format!(
            "可导入：新增 {} 位达人，已有 {} 位；待登记事件 {} 条，已有事件 {} 条。仅登记既有发送事实，不会发送消息。",
            new_count, existing_count, plan.events_new, plan.events_existing
        )
    } else {
        format!(
            "存在 {} 项编号或账号冲突，无法导入；请修正后重新预览。",
            found.len()
        )
    };
    Ok(json!({
        "batch": batch,
        "digest": digest,
        "canImport": can_import,
        "creators": {"new": new_count, "existing": existing_count, "conflicts": found},
        "events": {"new": plan.events_new, "existing": plan.events_existing},
        "message": message,
    }))
}

fn import(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &["batch", "creators", "expectedDigest", "confirmed"],
        "creator-import",
    )?;
    if input["confirmed"] != true {
        return Err("必须明确确认本次导入".into());
    }
    let expected = input
        .get("expectedDigest")
        .and_then(Value::as_str)
        .ok_or("缺少预览摘要 expectedDigest")?;
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("expectedDigest 必须是 64 位小写十六进制".into());
    }
    let (batch, creators, normalized) = parse_body(input)?;
    if digest_of(&normalized) != expected {
        return Err("预览摘要与本次输入不一致，请重新预览".into());
    }
    let mut db = database(path, true)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("本地工作台正忙，未执行导入：{e}"))?;
    let plan = plan(&tx, &creators, &batch)?;
    if plan
        .states
        .iter()
        .any(|state| matches!(state, CreatorState::Conflict(_)))
    {
        return Err("存在达人编号或账号冲突，未执行导入；请修正后重新预览".into());
    }
    let created = plan
        .states
        .iter()
        .filter(|state| matches!(state, CreatorState::New))
        .count();
    let existing = plan.states.len() - created;
    let created_at = stamp();
    let mut events_created = 0usize;
    for (creator, state) in creators.iter().zip(&plan.states) {
        if *state != CreatorState::New {
            continue;
        }
        let mut settings = local_store::default_settings();
        settings["email"] = json!(creator.email.clone().unwrap_or_default());
        settings["email_source"] = json!(format!("intake:{batch}"));
        let profile = json!({
            "id": creator.id,
            "handle": creator.handle,
            "tiktok_url": creator.tiktok_url,
            "followers": creator.followers,
            "source": creator.source,
            "notes": creator.notes,
            "intake_batch": batch,
        });
        tx.execute(
            "INSERT INTO creators(id,handle,profile,settings,revision) VALUES(?,?,?,?,0)",
            params![
                creator.id,
                creator.handle,
                profile.to_string(),
                settings.to_string()
            ],
        )
        .map_err(|e| format!("写入达人 {} 失败：{e}", creator.id))?;
        tx.execute(
            "INSERT INTO audit(at,kind,creator,previous,current) VALUES(?,'intake',?,?,?)",
            params![created_at, creator.id, "", profile.to_string()],
        )
        .map_err(|e| format!("写入达人 {} 审计失败：{e}", creator.id))?;
    }
    for (creator, planned) in creators.iter().zip(&plan.events) {
        for event in planned {
            if event.exists {
                continue;
            }
            tx.execute(
                "INSERT INTO events(id,creator,channel,type,at,proof,note,created,void_reason,request_id) VALUES(?,?,?,?,?,?,?,?,'',?)",
                params![
                    Uuid::new_v4().simple().to_string(),
                    creator.id,
                    event.channel,
                    event.typ,
                    event.at,
                    event.proof,
                    event.note,
                    created_at,
                    event.request_id
                ],
            )
            .map_err(|e| format!("写入达人 {} 的事件失败：{e}", creator.id))?;
            events_created += 1;
        }
    }
    tx.commit()
        .map_err(|e| format!("导入提交失败，请重新预览后核对：{e}"))?;
    Ok(json!({
        "batch": batch,
        "created": created,
        "existing": existing,
        "eventsCreated": events_created,
        "eventsExisting": plan.events_existing,
    }))
}

pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    match command {
        "creator-import-preview" => preview(&input, path),
        "creator-import" => import(&input, path),
        _ => Err("未知达人导入命令".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct F {
        root: PathBuf,
    }

    impl F {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("gapaw-intake-{}", Uuid::new_v4().simple()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn state(&self) -> PathBuf {
            self.root.join("state.sqlite")
        }
    }

    impl Drop for F {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn init(f: &F) {
        crate::local_backend::execute(
            "local-workbench-init",
            json!({"confirmed": true}),
            &f.state(),
        )
        .unwrap();
    }

    fn business(f: &F) -> PathBuf {
        crate::local_backend::business_path(&f.state()).unwrap()
    }

    fn body() -> Value {
        json!({
            "batch": "gw-batch-3",
            "creators": [{
                "id": "GW301",
                "handle": "alpha.one",
                "email": "Alpha.One@Example.COM",
                "tiktokUrl": "https://www.tiktok.com/@alpha.one",
                "followers": 1200,
                "source": "lark",
                "notes": "第三轮",
                "sends": [
                    {"channel": "email", "at": "2026-10-01T08:30:00Z", "proof": "lark-mail:M1", "status": "accepted", "note": "首封"},
                    {"channel": "dm", "at": "2026-10-02T09:00:00+08:00", "proof": "lark-mail:M2", "status": "failed"}
                ]
            }]
        })
    }

    fn run_preview(f: &F, body: &Value) -> Value {
        execute("creator-import-preview", body.clone(), &f.state()).unwrap()
    }

    fn confirmed(body: &Value, digest: &Value) -> Value {
        let mut input = body.clone();
        input["expectedDigest"] = digest.clone();
        input["confirmed"] = json!(true);
        input
    }

    #[test]
    fn preview_is_read_only_and_does_not_leak_email() {
        let f = F::new();
        init(&f);
        let db_path = business(&f);
        let before = fs::read(&db_path).unwrap();
        let result = run_preview(&f, &body());
        assert_eq!(fs::read(&db_path).unwrap(), before);
        assert_eq!(result["batch"], "gw-batch-3");
        assert_eq!(result["canImport"], true);
        assert_eq!(result["creators"]["new"], 1);
        assert_eq!(result["creators"]["existing"], 0);
        assert_eq!(result["creators"]["conflicts"], json!([]));
        assert_eq!(result["events"]["new"], 4);
        assert_eq!(result["events"]["existing"], 0);
        assert_eq!(result["digest"].as_str().unwrap().len(), 64);
        let text = result.to_string();
        assert!(!text.contains('@'));
        assert!(!text.to_lowercase().contains("example.com"));
    }

    #[test]
    fn import_creates_creator_settings_profile_audit_events_and_is_idempotent() {
        let f = F::new();
        init(&f);
        let preview = run_preview(&f, &body());
        let first = execute(
            "creator-import",
            confirmed(&body(), &preview["digest"]),
            &f.state(),
        )
        .unwrap();
        assert_eq!(first["created"], 1);
        assert_eq!(first["existing"], 0);
        assert_eq!(first["eventsCreated"], 4);
        assert_eq!(first["eventsExisting"], 0);

        {
            let db = Connection::open(business(&f)).unwrap();
            let (handle, profile, settings, revision): (String, String, String, i64) = db
                .query_row(
                    "SELECT handle,profile,settings,revision FROM creators WHERE id='GW301'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(handle, "alpha.one");
            assert_eq!(revision, 0);
            let profile: Value = serde_json::from_str(&profile).unwrap();
            assert_eq!(profile["id"], "GW301");
            assert_eq!(profile["handle"], "alpha.one");
            assert_eq!(profile["tiktok_url"], "https://www.tiktok.com/@alpha.one");
            assert_eq!(profile["followers"], 1200);
            assert_eq!(profile["source"], "lark");
            assert_eq!(profile["notes"], "第三轮");
            assert_eq!(profile["intake_batch"], "gw-batch-3");
            let settings: Value = serde_json::from_str(&settings).unwrap();
            assert_eq!(settings["email"], "alpha.one@example.com");
            assert_eq!(settings["email_source"], "intake:gw-batch-3");
            assert_eq!(settings["fee"], 50);
            let audits: i64 = db
                .query_row(
                    "SELECT count(*) FROM audit WHERE kind='intake' AND creator='GW301'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(audits, 1);
            let events: i64 = db
                .query_row(
                    "SELECT count(*) FROM events WHERE creator='GW301' AND void_reason='' AND request_id IS NOT NULL AND created IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(events, 4);
            let attempts: i64 = db
                .query_row(
                    "SELECT count(*) FROM events WHERE creator='GW301' AND type='发送尝试'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(attempts, 2);
            let accepted: i64 = db
                .query_row(
                    "SELECT count(*) FROM events WHERE creator='GW301' AND type='平台受理'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(accepted, 1);
            let failed: i64 = db
                .query_row(
                    "SELECT count(*) FROM events WHERE creator='GW301' AND type='发送失败'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(failed, 1);
            let unique_requests: i64 = db
                .query_row(
                    "SELECT count(DISTINCT request_id) FROM events WHERE creator='GW301'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(unique_requests, 4);
        }

        let again = execute(
            "creator-import",
            confirmed(&body(), &preview["digest"]),
            &f.state(),
        )
        .unwrap();
        assert_eq!(again["created"], 0);
        assert_eq!(again["existing"], 1);
        assert_eq!(again["eventsCreated"], 0);
        assert_eq!(again["eventsExisting"], 4);

        let db = Connection::open(business(&f)).unwrap();
        let creators: i64 = db
            .query_row("SELECT count(*) FROM creators", [], |row| row.get(0))
            .unwrap();
        let events: i64 = db
            .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
            .unwrap();
        let audits: i64 = db
            .query_row("SELECT count(*) FROM audit", [], |row| row.get(0))
            .unwrap();
        assert_eq!((creators, events, audits), (1, 4, 1));
    }

    #[test]
    fn conflicts_block_import() {
        let f = F::new();
        init(&f);
        let preview = run_preview(&f, &body());
        execute(
            "creator-import",
            confirmed(&body(), &preview["digest"]),
            &f.state(),
        )
        .unwrap();

        let mut same_id = body();
        same_id["creators"][0]["handle"] = json!("beta.two");
        same_id["creators"][0]["tiktokUrl"] = json!("https://www.tiktok.com/@beta.two");
        let p = run_preview(&f, &same_id);
        assert_eq!(p["canImport"], false);
        assert_eq!(p["creators"]["conflicts"][0]["id"], "GW301");
        assert!(p["creators"]["conflicts"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("编号"));
        assert!(execute(
            "creator-import",
            confirmed(&same_id, &p["digest"]),
            &f.state()
        )
        .is_err());

        let mut used_handle = body();
        used_handle["creators"][0]["id"] = json!("GW302");
        let p = run_preview(&f, &used_handle);
        assert_eq!(p["canImport"], false);
        assert_eq!(p["creators"]["conflicts"][0]["id"], "GW302");
        assert!(p["creators"]["conflicts"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("账号"));
        assert!(execute(
            "creator-import",
            confirmed(&used_handle, &p["digest"]),
            &f.state()
        )
        .is_err());
    }

    #[test]
    fn rejects_bad_digest_missing_confirmation_and_unknown_fields() {
        let f = F::new();
        init(&f);
        let preview = run_preview(&f, &body());

        let bad_digest = confirmed(&body(), &json!("0".repeat(64)));
        let error = execute("creator-import", bad_digest, &f.state()).unwrap_err();
        assert!(error.contains("摘要"));

        let mut missing_confirmation = body();
        missing_confirmation["expectedDigest"] = preview["digest"].clone();
        assert!(execute("creator-import", missing_confirmation, &f.state()).is_err());

        let mut not_confirmed = confirmed(&body(), &preview["digest"]);
        not_confirmed["confirmed"] = json!(false);
        assert!(execute("creator-import", not_confirmed, &f.state()).is_err());

        let mut bad_top = body();
        bad_top["extra"] = json!(true);
        assert!(execute("creator-import-preview", bad_top, &f.state()).is_err());

        let mut bad_creator = body();
        bad_creator["creators"][0]["extra"] = json!(1);
        assert!(execute("creator-import-preview", bad_creator, &f.state()).is_err());

        let mut bad_send = body();
        bad_send["creators"][0]["sends"][0]["extra"] = json!(1);
        assert!(execute("creator-import-preview", bad_send, &f.state()).is_err());

        let mut bad_email = body();
        bad_email["creators"][0]["email"] = json!("not-an-email");
        assert!(execute("creator-import-preview", bad_email, &f.state()).is_err());

        let mut bad_url = body();
        bad_url["creators"][0]["tiktokUrl"] = json!("https://www.tiktok.com/@other");
        assert!(execute("creator-import-preview", bad_url, &f.state()).is_err());

        let mut duplicate_id = body();
        let mut second = body()["creators"][0].clone();
        second["handle"] = json!("beta.two");
        second["tiktokUrl"] = json!("https://www.tiktok.com/@beta.two");
        duplicate_id["creators"]
            .as_array_mut()
            .unwrap()
            .push(second);
        assert!(execute("creator-import-preview", duplicate_id, &f.state()).is_err());

        let mut duplicate_handle = body();
        let mut second = body()["creators"][0].clone();
        second["id"] = json!("GW302");
        duplicate_handle["creators"]
            .as_array_mut()
            .unwrap()
            .push(second);
        assert!(execute("creator-import-preview", duplicate_handle, &f.state()).is_err());
    }
}
