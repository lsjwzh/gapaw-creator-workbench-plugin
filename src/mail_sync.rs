//! 飞书邮件增量同步：读取收件箱与已发送邮件，按达人邮箱归档到本地工作台。
//! 预览只读；正式同步先取完全部邮件，再在一个事务里写入，绝不写入部分结果。
use crate::{drafts::only_keys, now, open_db, Result};
use chrono::{
    DateTime, Duration as ChronoDuration, FixedOffset, NaiveDate, SecondsFormat, TimeZone, Utc,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const CURSOR_KEY: &str = "mail_sync";
const DEFAULT_SINCE: &str = "2026-09-25";
const SOURCE_PREFIX: &str = "lark-mail:";
const MAX_PER_FOLDER: usize = 2000;
const PAGE_SIZE: usize = 400;
const DETAIL_BATCH: usize = 20;
const CLI_TIMEOUT: Duration = Duration::from_secs(60);
const DEDUP_SECONDS: i64 = 30 * 60;
const BODY_LIMIT: usize = 20000;
const IMPORT_LIMIT: usize = 50;

fn counts() -> Value {
    json!({"listed":0,"new":0,"duplicate":0,"unmatched":0,"self":0,"existing":0})
}
fn bump(value: &mut Value, key: &str, n: i64) {
    if let Some(target) = value.get_mut(key) {
        if let Some(slot) = target.as_i64() {
            *target = json!(slot + n);
        }
    }
}

fn parse_time(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}
fn detail_time(detail: &Value) -> Option<DateTime<Utc>> {
    if let Some(raw) = detail["date"].as_str() {
        if let Some(at) = parse_time(raw) {
            return Some(at);
        }
        if let Ok(at) = DateTime::parse_from_rfc2822(raw) {
            return Some(at.with_timezone(&Utc));
        }
    }
    let millis = detail["internal_date"]
        .as_i64()
        .or_else(|| detail["internal_date"].as_str()?.parse().ok())?;
    Utc.timestamp_millis_opt(millis).single()
}
fn triage_time(message: &Value) -> Option<DateTime<Utc>> {
    message["date"].as_str().and_then(parse_time)
}
fn format_at(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, false)
}
fn east_eight() -> FixedOffset {
    FixedOffset::east_opt(8 * 3600).expect("东八区固定偏移有效")
}
/// 有游标时从游标回退两天；没有游标时从 since 当天零点（东八区）开始。
fn cursor_start(cursor: &Value, folder: &str, since: &str) -> String {
    if let Some(at) = cursor[folder]["lastAt"].as_str().and_then(parse_time) {
        return (at - ChronoDuration::days(2))
            .with_timezone(&east_eight())
            .to_rfc3339_opts(SecondsFormat::Secs, false);
    }
    format!("{since}T00:00:00+08:00")
}

fn entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => {
            let code = name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| name.strip_prefix('#')?.parse().ok())?;
            char::from_u32(code)
        }
    }
}
/// 解码常见 HTML 实体，单次扫描，避免 &amp;lt; 被重复解码成 <。
fn decode_entities(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw.as_bytes()[i] == b'&' {
            if let Some(rel) = raw[i..].find(';') {
                let end = i + rel;
                if let Some(ch) = entity(&raw[i + 1..end]) {
                    out.push(ch);
                    i = end + 1;
                    continue;
                }
            }
        }
        let ch = raw[i..].chars().next().expect("索引落在字符边界");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}
/// 去掉 HTML 标签；段落和换行标签保留为换行，脚本与样式内容整段丢弃。
fn strip_html(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        let rest = &lower[i..];
        let skip = if rest.starts_with("<script") {
            Some("script")
        } else if rest.starts_with("<style") {
            Some("style")
        } else {
            None
        };
        if let Some(name) = skip {
            let closing = format!("</{name}>");
            if let Some(offset) = rest.find(&closing) {
                i += offset + closing.len();
                continue;
            }
            break;
        }
        let ch = html[i..].chars().next().expect("索引落在字符边界");
        if ch == '<' {
            let Some(offset) = lower[i..].find('>') else {
                out.push(ch);
                i += ch.len_utf8();
                continue;
            };
            let tag = lower[i + 1..i + offset].trim();
            if tag.starts_with("br")
                || tag.starts_with("/p")
                || tag.starts_with("/div")
                || tag.starts_with("/li")
                || tag.starts_with("/tr")
            {
                out.push('\n');
            }
            i += offset + 1;
            continue;
        }
        out.push(ch);
        i += ch.len_utf8();
    }
    decode_entities(&out).trim().to_string()
}
fn clean_subject(raw: &str) -> String {
    decode_entities(raw).trim().chars().take(300).collect()
}
/// 输出摘要时隐去主题里可能出现的邮箱地址。
fn redact_addresses(text: &str) -> String {
    const LOCAL: &[u8] = b".!#$%&'*+/=?^_`{|}~-";
    let is_local = |byte: u8| byte.is_ascii_alphanumeric() || LOCAL.contains(&byte);
    let is_domain = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-';
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let mut start = i;
            while start > 0 && is_local(bytes[start - 1]) {
                start -= 1;
            }
            let mut end = i + 1;
            while end < bytes.len() && is_domain(bytes[end]) {
                end += 1;
            }
            if start < i && end > i + 1 && bytes[i + 1..end].contains(&b'.') {
                out.push_str(&text[last..start]);
                out.push_str("[邮箱]");
                last = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[last..]);
    out
}
fn normalize_subject(raw: &str) -> String {
    decode_entities(raw).trim().to_lowercase()
}
pub(crate) fn plain_body(detail: &Value) -> String {
    let body = detail["body_plain_text"]
        .as_str()
        .map(decode_entities)
        .filter(|text| !text.trim().is_empty())
        .or_else(|| {
            detail["body_html"]
                .as_str()
                .map(strip_html)
                .filter(|text| !text.trim().is_empty())
        })
        .or_else(|| {
            detail["body_preview"]
                .as_str()
                .map(decode_entities)
                .filter(|text| !text.trim().is_empty())
        })
        .unwrap_or_else(|| "（无正文）".into());
    body.trim().chars().take(BODY_LIMIT).collect()
}

fn header_value<'a>(detail: &'a Value, name: &str) -> Option<&'a str> {
    let headers = &detail["headers"];
    if let Some(map) = headers.as_object() {
        for (key, value) in map {
            if key.eq_ignore_ascii_case(name) {
                return value.as_str();
            }
        }
    }
    if let Some(list) = headers.as_array() {
        for item in list {
            if let Some(raw) = item.as_str() {
                if let Some((key, value)) = raw.split_once(':') {
                    if key.trim().eq_ignore_ascii_case(name) {
                        return Some(value.trim());
                    }
                }
            } else if item["name"]
                .as_str()
                .is_some_and(|key| key.eq_ignore_ascii_case(name))
            {
                return item["value"].as_str();
            }
        }
    }
    if name.eq_ignore_ascii_case("auto-submitted") {
        detail["auto_submitted"].as_str()
    } else {
        None
    }
}
fn auto_reply(subject: &str, detail: &Value) -> bool {
    if let Some(value) = header_value(detail, "Auto-Submitted") {
        let value = value.trim();
        if !value.is_empty() && !value.eq_ignore_ascii_case("no") {
            return true;
        }
    }
    let lower = subject.trim().to_ascii_lowercase();
    lower.starts_with("automatic reply")
        || lower.starts_with("auto:")
        || lower.starts_with("out of office")
        || subject.trim().starts_with("自动回复")
}

fn clean_address(raw: &str) -> String {
    let inner = match (raw.rfind('<'), raw.rfind('>')) {
        (Some(start), Some(end)) if start < end => &raw[start + 1..end],
        _ => raw,
    };
    inner
        .trim()
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '<' || ch == '>')
        .to_ascii_lowercase()
}
fn value_address(value: &Value) -> String {
    match value {
        Value::String(raw) => clean_address(raw),
        Value::Object(_) => clean_address(value["mail_address"].as_str().unwrap_or("")),
        _ => String::new(),
    }
}
fn triage_sender(message: &Value) -> String {
    value_address(&message["from"])
}
fn recipients(detail: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["to", "cc"] {
        if let Some(list) = detail[key].as_array() {
            for item in list {
                let address = value_address(item);
                if !address.is_empty() && !out.contains(&address) {
                    out.push(address);
                }
            }
        }
    }
    out
}

struct Creator {
    id: String,
    handle: String,
}
fn load_creators(db: &Connection) -> Result<(Vec<Creator>, HashMap<String, usize>)> {
    let mut stmt = db
        .prepare("SELECT id,handle,settings FROM creators ORDER BY id")
        .map_err(|e| format!("读取达人资料失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("读取达人资料失败：{e}"))?;
    let mut creators = Vec::new();
    let mut index = HashMap::new();
    for row in rows {
        let (id, handle, settings) = row.map_err(|e| format!("读取达人资料失败：{e}"))?;
        let email = serde_json::from_str::<Value>(&settings)
            .ok()
            .and_then(|value| {
                value["email"]
                    .as_str()
                    .map(|s| s.trim().to_ascii_lowercase())
            })
            .unwrap_or_default();
        if !email.is_empty() && !index.contains_key(&email) {
            index.insert(email.clone(), creators.len());
        }
        creators.push(Creator {
            id,
            handle: handle.unwrap_or_default(),
        });
    }
    Ok((creators, index))
}

struct OldMessage {
    creator: String,
    direction: String,
    at: DateTime<Utc>,
    subject: String,
}
fn load_old_messages(db: &Connection) -> Result<Vec<OldMessage>> {
    let mut stmt = db
        .prepare("SELECT creator,direction,at,subject FROM messages WHERE channel='email'")
        .map_err(|e| format!("读取旧邮件记录失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| format!("读取旧邮件记录失败：{e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let (creator, direction, at, subject) =
            row.map_err(|e| format!("读取旧邮件记录失败：{e}"))?;
        let (Some(creator), Some(direction), Some(at)) = (creator, direction, at) else {
            continue;
        };
        let Some(at) = parse_time(&at) else {
            continue;
        };
        out.push(OldMessage {
            creator,
            direction,
            at,
            subject: normalize_subject(&subject.unwrap_or_default()),
        });
    }
    Ok(out)
}
fn load_sources(db: &Connection) -> Result<HashSet<String>> {
    let mut stmt = db
        .prepare("SELECT source FROM messages WHERE source IS NOT NULL")
        .map_err(|e| format!("读取已有邮件来源失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("读取已有邮件来源失败：{e}"))?;
    rows.collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(|e| format!("读取已有邮件来源失败：{e}"))
}

fn open_business(path: &Path, write: bool) -> Result<Connection> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(path, flags)
        .map_err(|e| format!("无法打开本地工作台业务库：{e}"))?;
    db.busy_timeout(Duration::from_secs(20))
        .map_err(|e| format!("设置业务库等待时间失败：{e}"))?;
    if write {
        db.pragma_update(None, "foreign_keys", true)
            .map_err(|e| format!("启用业务库外键失败：{e}"))?;
    }
    Ok(db)
}
fn ensure_business(state_path: &Path) -> Result<PathBuf> {
    let status = crate::local_backend::status(state_path)?;
    if status["initialized"] != true || status["active"] != true {
        return Err("请先在数据管理中建立并启用本地工作台，再同步邮件".into());
    }
    crate::local_backend::business_path(state_path)
}

fn read_cursor(db: Option<&Connection>) -> Result<Value> {
    let Some(db) = db else {
        return Ok(Value::Null);
    };
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key=?",
            [CURSOR_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("读取邮件同步进度失败：{e}"))?;
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null))
}

fn list_folder(
    cli: &crate::setup::Cli,
    mailbox: &str,
    folder: &str,
    start: &str,
    label: &str,
) -> Result<Vec<Value>> {
    let filter = json!({"folder":folder,"time_range":{"start_time":start}}).to_string();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut token: Option<String> = None;
    while out.len() < MAX_PER_FOLDER {
        let max = (MAX_PER_FOLDER - out.len()).min(PAGE_SIZE).to_string();
        let args: Vec<&str> = {
            let mut args = vec![
                "mail",
                "+triage",
                "--mailbox",
                mailbox,
                "--filter",
                &filter,
                "--max",
                &max,
                "--format",
                "json",
                "--as",
                "user",
            ];
            if let Some(token) = &token {
                args.push("--page-token");
                args.push(token);
            }
            args
        };
        let response = cli
            .run(&args, CLI_TIMEOUT)
            .map_err(|e| format!("读取{label}邮件列表失败：{}", e.message()))?;
        let page = crate::setup::payload(&response);
        let messages = page["messages"].as_array().cloned().unwrap_or_default();
        for message in messages {
            let id = message["message_id"].as_str().unwrap_or("");
            if !id.is_empty() && !seen.insert(id.to_string()) {
                continue;
            }
            if out.len() < MAX_PER_FOLDER {
                out.push(message);
            }
        }
        if page["has_more"] != true {
            break;
        }
        let next = page["page_token"]
            .as_str()
            .filter(|token| !token.is_empty())
            .map(str::to_string);
        match next {
            Some(next) if Some(&next) != token.as_ref() => token = Some(next),
            _ => break,
        }
    }
    Ok(out)
}

fn fetch_details(
    cli: &crate::setup::Cli,
    mailbox: &str,
    ids: &[String],
    label: &str,
) -> Result<HashMap<String, Value>> {
    let mut details = HashMap::new();
    for chunk in ids.chunks(DETAIL_BATCH) {
        let joined = chunk.join(",");
        let args = [
            "mail",
            "+messages",
            "--mailbox",
            mailbox,
            "--message-ids",
            &joined,
            "--format",
            "json",
            "--as",
            "user",
        ];
        let response = cli
            .run(&args, CLI_TIMEOUT)
            .map_err(|e| format!("读取{label}邮件正文失败：{}", e.message()))?;
        let messages = crate::setup::payload(&response)["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for (position, message) in messages.into_iter().enumerate() {
            let id = message["message_id"]
                .as_str()
                .map(str::to_string)
                .or_else(|| chunk.get(position).cloned())
                .unwrap_or_default();
            if !id.is_empty() {
                details.insert(id, message);
            }
        }
    }
    Ok(details)
}

struct Context<'a> {
    mailbox: &'a str,
    details: &'a HashMap<String, Value>,
    creators: &'a [Creator],
    index: &'a HashMap<String, usize>,
    old: &'a [OldMessage],
    sources: &'a HashSet<String>,
}
struct Candidate {
    folder: &'static str,
    creator: String,
    handle: String,
    direction: &'static str,
    at: String,
    subject: String,
    sender: String,
    body: String,
    kind: &'static str,
    source: String,
}
impl Candidate {
    fn public(&self) -> Value {
        json!({"creator":self.creator,"handle":self.handle,"direction":self.direction,"at":self.at,"subject":redact_addresses(&self.subject)})
    }
}

fn process_folder(
    messages: &[Value],
    folder: &'static str,
    ctx: &Context<'_>,
) -> (Value, Vec<Candidate>, Option<DateTime<Utc>>) {
    let mut counters = counts();
    let mut candidates = Vec::new();
    let mut latest: Option<DateTime<Utc>> = None;
    for message in messages {
        bump(&mut counters, "listed", 1);
        let Some(message_id) = message["message_id"].as_str().filter(|id| !id.is_empty()) else {
            bump(&mut counters, "unmatched", 1);
            continue;
        };
        let source = format!("{SOURCE_PREFIX}{message_id}");
        if let Some(at) = triage_time(message) {
            latest = Some(latest.map_or(at, |current| current.max(at)));
        }
        if ctx.sources.contains(&source) {
            bump(&mut counters, "existing", 1);
            continue;
        }
        let Some(detail) = ctx.details.get(message_id) else {
            bump(&mut counters, "unmatched", 1);
            continue;
        };
        let Some(at) = triage_time(message).or_else(|| detail_time(detail)) else {
            bump(&mut counters, "unmatched", 1);
            continue;
        };
        latest = Some(latest.map_or(at, |current| current.max(at)));
        let direction = if folder == "inbox" { "in" } else { "out" };
        let (self_copy, addresses) = if folder == "inbox" {
            let sender = value_address(&detail["head_from"]);
            let sender = if sender.is_empty() {
                triage_sender(message)
            } else {
                sender
            };
            if sender.is_empty() {
                (false, Vec::new())
            } else {
                (sender.eq_ignore_ascii_case(ctx.mailbox), vec![sender])
            }
        } else {
            let all = recipients(detail);
            if all.is_empty() {
                (false, Vec::new())
            } else {
                let others: Vec<String> = all
                    .iter()
                    .filter(|address| !address.eq_ignore_ascii_case(ctx.mailbox))
                    .cloned()
                    .collect();
                if others.is_empty() {
                    (true, others)
                } else {
                    (false, others)
                }
            }
        };
        if self_copy {
            bump(&mut counters, "self", 1);
            continue;
        }
        if addresses.is_empty() {
            bump(&mut counters, "unmatched", 1);
            continue;
        }
        let Some(index) = addresses
            .iter()
            .find_map(|address| ctx.index.get(address).copied())
        else {
            bump(&mut counters, "unmatched", 1);
            continue;
        };
        let creator = &ctx.creators[index];
        let raw_subject = detail["subject"]
            .as_str()
            .filter(|subject| !subject.trim().is_empty())
            .or_else(|| message["subject"].as_str())
            .unwrap_or("");
        let normalized = normalize_subject(raw_subject);
        if ctx.old.iter().any(|old| {
            old.creator == creator.id
                && old.direction == direction
                && old.subject == normalized
                && (old.at - at).num_seconds().abs() <= DEDUP_SECONDS
        }) {
            bump(&mut counters, "duplicate", 1);
            continue;
        }
        let subject = clean_subject(raw_subject);
        let sender = if direction == "in" {
            addresses[0].clone()
        } else {
            ctx.mailbox.to_string()
        };
        bump(&mut counters, "new", 1);
        candidates.push(Candidate {
            folder,
            creator: creator.id.clone(),
            handle: creator.handle.clone(),
            direction,
            at: format_at(at),
            subject: subject.clone(),
            sender,
            body: plain_body(detail),
            kind: if auto_reply(&subject, detail) {
                "自动回复"
            } else {
                "正常"
            },
            source,
        });
    }
    (counters, candidates, latest)
}

fn insert_candidate(tx: &Connection, candidate: &Candidate) -> Result<bool> {
    let affected = tx
        .execute(
            "INSERT OR IGNORE INTO messages(id,creator,channel,direction,at,sender,subject,body,zh,kind,source,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                Uuid::new_v4().simple().to_string(),
                candidate.creator,
                "email",
                candidate.direction,
                candidate.at,
                candidate.sender,
                candidate.subject,
                candidate.body,
                "",
                candidate.kind,
                candidate.source,
                now(),
            ],
        )
        .map_err(|e| format!("写入邮件记录失败：{e}"))?;
    Ok(affected > 0)
}

fn save_cursor(state_path: &Path, cursor: &Value) -> Result<()> {
    let db = open_db(state_path, true)?.ok_or("无法打开状态库")?;
    db.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [CURSOR_KEY, &cursor.to_string()],
    )
    .map(|_| ())
    .map_err(|e| format!("保存邮件同步进度失败：{e}"))
}

fn total(folders: &Value, key: &str) -> i64 {
    folders["inbox"][key].as_i64().unwrap_or(0) + folders["sent"][key].as_i64().unwrap_or(0)
}
fn summary(apply: bool, folders: &Value, unmatched: i64) -> String {
    if apply {
        format!(
            "邮件同步完成：新增 {} 封（收件箱 {}、已发送 {}），已有 {} 封，重复 {} 封，未匹配 {} 封，自己发送的副本 {} 封。",
            total(folders, "new"),
            folders["inbox"]["new"],
            folders["sent"]["new"],
            total(folders, "existing"),
            total(folders, "duplicate"),
            unmatched,
            total(folders, "self"),
        )
    } else {
        format!(
            "预览：收件箱 {} 封、已发送 {} 封；将新增 {} 封，已有 {} 封，重复 {} 封，未匹配 {} 封，自己发送的副本 {} 封。本次未写入。",
            folders["inbox"]["listed"],
            folders["sent"]["listed"],
            total(folders, "new"),
            total(folders, "existing"),
            total(folders, "duplicate"),
            unmatched,
            total(folders, "self"),
        )
    }
}

fn run(input: Value, path: &Path, cli: Option<&crate::setup::Cli>) -> Result<Value> {
    only_keys(&input, &["apply", "since"], "mail-sync")?;
    let apply = match input.get("apply") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("apply 必须是布尔值".into()),
    };
    let since = match input.get("since") {
        None => DEFAULT_SINCE.to_string(),
        Some(Value::String(value)) => {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| "since 应为 YYYY-MM-DD 格式的日期".to_string())?;
            value.clone()
        }
        Some(_) => return Err("since 应为 YYYY-MM-DD 格式的日期".into()),
    };

    let state = open_db(path, false)?;
    let mailbox = crate::setup::sender_mailbox(state.as_ref())?;
    if mailbox.is_empty() {
        return Err("请先在连接与设置页选择发件邮箱".into());
    }
    let stored_cursor = read_cursor(state.as_ref())?;
    // 换邮箱后旧游标不再适用，从 since 重新开始。
    let cursor = if stored_cursor["mailbox"]
        .as_str()
        .is_some_and(|saved| saved.eq_ignore_ascii_case(&mailbox))
    {
        stored_cursor
    } else {
        Value::Null
    };

    let business_path = ensure_business(path)?;
    crate::local_store::identity(&business_path)?;
    let (creators, index, old, sources) = {
        let db = open_business(&business_path, false)?;
        let (creators, index) = load_creators(&db)?;
        (creators, index, load_old_messages(&db)?, load_sources(&db)?)
    };

    let owned;
    let cli: &crate::setup::Cli = match cli {
        Some(cli) => cli,
        None => {
            owned = crate::setup::Cli::locate()
                .ok_or("本机未找到飞书命令行 lark-cli，请先安装并登录")?;
            &owned
        }
    };

    let mut all_candidates = Vec::new();
    let mut folders = json!({"inbox":counts(),"sent":counts()});
    let mut latest = std::collections::HashMap::new();
    for (folder, label) in [("inbox", "收件箱"), ("sent", "已发送")] {
        let messages = list_folder(
            cli,
            &mailbox,
            folder,
            &cursor_start(&cursor, folder, &since),
            label,
        )?;
        let ids: Vec<String> = messages
            .iter()
            .filter(|message| {
                message["message_id"].as_str().is_some_and(|id| {
                    !id.is_empty() && !sources.contains(&format!("{SOURCE_PREFIX}{id}"))
                })
            })
            .filter_map(|message| message["message_id"].as_str().map(str::to_string))
            .collect();
        let details = fetch_details(cli, &mailbox, &ids, label)?;
        let ctx = Context {
            mailbox: &mailbox,
            details: &details,
            creators: &creators,
            index: &index,
            old: &old,
            sources: &sources,
        };
        let (counters, candidates, newest) = process_folder(
            &messages,
            if folder == "inbox" { "inbox" } else { "sent" },
            &ctx,
        );
        folders[folder] = counters;
        all_candidates.extend(candidates);
        latest.insert(folder, newest);
    }

    let mut imported: Vec<Value> = if apply {
        Vec::new()
    } else {
        all_candidates
            .iter()
            .take(IMPORT_LIMIT)
            .map(Candidate::public)
            .collect()
    };
    let mut result_counts = folders.clone();
    if apply {
        let mut db = open_business(&business_path, true)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("打开业务库写入事务失败：{e}"))?;
        for candidate in &all_candidates {
            if insert_candidate(&tx, candidate)? {
                if imported.len() < IMPORT_LIMIT {
                    imported.push(candidate.public());
                }
            } else if let Some(counters) = result_counts.get_mut(candidate.folder) {
                bump(counters, "new", -1);
                bump(counters, "existing", 1);
            }
        }
        tx.commit()
            .map_err(|e| format!("提交邮件同步结果失败：{e}"))?;
    }
    let unmatched = total(&result_counts, "unmatched");
    let message = summary(apply, &result_counts, unmatched);
    let last_at = |folder: &str| -> String {
        latest
            .get(folder)
            .copied()
            .flatten()
            .map(format_at)
            .or_else(|| cursor[folder]["lastAt"].as_str().map(str::to_string))
            .unwrap_or_else(|| cursor_start(&cursor, folder, &since))
    };
    let (inbox_last, sent_last) = (last_at("inbox"), last_at("sent"));
    let cursor_out = json!({"inbox":{"lastAt":inbox_last},"sent":{"lastAt":sent_last}});
    if apply {
        let saved = json!({
            "mailbox": mailbox,
            "inbox": {"lastAt": inbox_last},
            "sent": {"lastAt": sent_last},
            "lastRunAt": now(),
            "lastResult": {
                "folders": &result_counts,
                "imported": &imported,
                "unmatched": unmatched,
                "message": &message,
            }
        });
        save_cursor(path, &saved)?;
    }
    Ok(json!({
        "mailbox": mailbox,
        "applied": apply,
        "folders": result_counts,
        "imported": imported,
        "unmatched": unmatched,
        "cursor": cursor_out,
        "message": message,
    }))
}

pub fn execute(_command: &str, input: Value, path: &Path) -> Result<Value> {
    run(input, path, None)
}

#[cfg(all(test, unix))]
mod tests {
    /// 测试读回的消息行：creator,channel,direction,at,sender,subject,body,zh,kind|source。
    type MessageRow = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    );
    use super::*;
    use rusqlite::params;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("gapaw-mailsync-{}", Uuid::new_v4().simple()));
            fs::create_dir_all(&root).unwrap();
            let state = root.join("state.sqlite");
            crate::local_backend::execute(
                "local-workbench-init",
                json!({"confirmed": true}),
                &state,
            )
            .unwrap();
            Self { root }
        }
        fn state(&self) -> PathBuf {
            self.root.join("state.sqlite")
        }
        fn business(&self) -> PathBuf {
            crate::local_backend::business_path(&self.state()).unwrap()
        }
        fn set_mailbox(&self, mailbox: &str) {
            let db = crate::open_db(&self.state(), true).unwrap().unwrap();
            let value =
                json!({"version":1,"updatedAt":crate::now(),"values":{"senderMailbox":mailbox}});
            db.execute(
                "INSERT INTO settings(key,value) VALUES('app_setup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [value.to_string()],
            )
            .unwrap();
        }
        fn creator(&self, id: &str, handle: &str, email: &str) {
            let db = Connection::open(self.business()).unwrap();
            let mut settings = crate::local_store::default_settings();
            settings["email"] = json!(email);
            db.execute(
                "INSERT INTO creators(id,handle,profile,settings) VALUES(?,?,?,?)",
                params![id, handle, "{}", settings.to_string()],
            )
            .unwrap();
        }
        fn old_message(
            &self,
            source: &str,
            creator: &str,
            direction: &str,
            at: &str,
            subject: &str,
        ) {
            let db = Connection::open(self.business()).unwrap();
            db.execute(
                "INSERT INTO messages(id,creator,channel,direction,at,sender,subject,body,zh,kind,source,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().simple().to_string(),
                    creator,
                    "email",
                    direction,
                    at,
                    "legacy@example.test",
                    subject,
                    "旧记录",
                    "",
                    "正常",
                    source,
                    now(),
                ],
            )
            .unwrap();
        }
        fn messages(&self) -> Vec<MessageRow> {
            let db = Connection::open(self.business()).unwrap();
            let mut stmt = db
                .prepare("SELECT creator,channel,direction,at,sender,subject,body,zh,kind||'|'||source FROM messages ORDER BY at")
                .unwrap();
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        }
        fn message_count(&self) -> i64 {
            let db = Connection::open(self.business()).unwrap();
            db.query_row("SELECT count(*) FROM messages", [], |row| row.get(0))
                .unwrap()
        }
        fn setting(&self, key: &str) -> Option<Value> {
            let db = crate::open_db(&self.state(), false).unwrap()?;
            let raw: Option<String> = db
                .query_row("SELECT value FROM settings WHERE key=?", [key], |row| {
                    row.get(0)
                })
                .optional()
                .unwrap();
            raw.and_then(|raw| serde_json::from_str(&raw).ok())
        }
        fn write_script(&self, content: &str) -> crate::setup::Cli {
            let path = self
                .root
                .join(format!("lark-{}.sh", Uuid::new_v4().simple()));
            fs::write(&path, content).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            crate::setup::Cli { path }
        }
        fn serve(&self, inbox: Value, sent: Value, details: Value) -> crate::setup::Cli {
            let inbox = json!({"ok":true,"data":{"messages":inbox,"has_more":false}});
            let sent = json!({"ok":true,"data":{"messages":sent,"has_more":false}});
            let details = json!({"ok":true,"data":{"messages":details}});
            self.write_script(&format!(
                r#"#!/bin/sh
case "$*" in
  *+triage*)
    case "$*" in
      *'"folder":"inbox"'*)
        cat <<'EOF'
{inbox}
EOF
        ;;
      *'"folder":"sent"'*)
        cat <<'EOF'
{sent}
EOF
        ;;
      *) echo '{{"ok":false,"error":{{"message":"无法识别邮件文件夹"}}}}'; exit 1 ;;
    esac
    ;;
  *+messages*)
    cat <<'EOF'
{details}
EOF
    ;;
  *) echo '{{"ok":false,"error":{{"message":"未预期的命令行参数"}}}}'; exit 1 ;;
esac
"#
            ))
        }
        fn fail_details(&self, inbox: Value, sent: Value) -> crate::setup::Cli {
            let inbox = json!({"ok":true,"data":{"messages":inbox,"has_more":false}});
            let sent = json!({"ok":true,"data":{"messages":sent,"has_more":false}});
            self.write_script(&format!(
                r#"#!/bin/sh
case "$*" in
  *+triage*)
    case "$*" in
      *'"folder":"inbox"'*)
        cat <<'EOF'
{inbox}
EOF
        ;;
      *)
        cat <<'EOF'
{sent}
EOF
        ;;
    esac
    ;;
  *+messages*)
    echo '{{"ok":false,"error":{{"message":"邮箱服务暂时不可用"}}}}'
    exit 1
    ;;
  *) echo '{{"ok":false,"error":{{"message":"未预期的命令行参数"}}}}'; exit 1 ;;
esac
"#
            ))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn triage(id: &str, date: &str, from: &str, subject: &str) -> Value {
        json!({"message_id":id,"date":date,"from":from,"subject":subject})
    }
    fn inbox_detail(id: &str, from: &str, subject: &str, body: &str) -> Value {
        json!({"message_id":id,"head_from":{"mail_address":from,"name":"发件人"},"subject":subject,"body_plain_text":body})
    }
    fn sent_detail(id: &str, to: &str, subject: &str, html: &str) -> Value {
        json!({"message_id":id,"head_from":{"mail_address":"shop@example.com"},"to":[{"mail_address":to,"name":"收件人"}],"cc":[],"subject":subject,"body_html":html})
    }

    #[test]
    fn preview_reports_without_writing_anywhere() {
        let f = Fixture::new();
        f.set_mailbox("shop@example.com");
        f.creator("c1", "alpha", "Alice@Creator.test");
        let cli = f.serve(
            json!([triage(
                "m1",
                "2026-10-25T01:00:00Z",
                "Alice <alice@creator.test>",
                "合作"
            )]),
            json!([]),
            json!([inbox_detail("m1", "alice@creator.test", "合作", "预览正文")]),
        );
        let result = run(json!({}), &f.state(), Some(&cli)).unwrap();
        assert_eq!(result["applied"], false);
        assert_eq!(result["folders"]["inbox"]["listed"], 1);
        assert_eq!(result["folders"]["inbox"]["new"], 1);
        assert_eq!(result["imported"][0]["creator"], "c1");
        assert_eq!(result["imported"][0]["handle"], "alpha");
        assert_eq!(f.message_count(), 0);
        assert!(f.setting("mail_sync").is_none());
        let text = result.to_string();
        assert!(!text.contains("alice@creator.test"));
        assert!(!text.contains("预览正文"));
    }

    #[test]
    fn apply_writes_expected_message_fields() {
        let f = Fixture::new();
        f.set_mailbox("shop@example.com");
        f.creator("c1", "alpha", "alice@creator.test");
        let cli = f.serve(
            json!([triage(
                "m1",
                "2026-10-25T01:00:00Z",
                "Alice <alice@creator.test>",
                "合作 &amp; 报价 &#39;x&#39;"
            )]),
            json!([triage(
                "m2",
                "2026-10-26T02:30:00Z",
                "shop@example.com",
                "Automatic reply: 合作"
            )]),
            json!([
                inbox_detail(
                    "m1",
                    "alice@creator.test",
                    "合作 &amp; 报价 &#39;x&#39;",
                    "Hello team\nThanks"
                ),
                sent_detail(
                    "m2",
                    "alice@creator.test",
                    "Automatic reply: 合作",
                    "<p>Thanks for your email.</p><p>Best.</p>"
                )
            ]),
        );
        let result = run(json!({"apply":true}), &f.state(), Some(&cli)).unwrap();
        assert_eq!(result["applied"], true);
        assert_eq!(result["folders"]["inbox"]["new"], 1);
        assert_eq!(result["folders"]["sent"]["new"], 1);
        assert_eq!(result["unmatched"], 0);
        assert_eq!(result["imported"].as_array().unwrap().len(), 2);
        assert_eq!(result["imported"][0]["direction"], "in");
        assert_eq!(result["imported"][0]["at"], "2026-10-25T01:00:00+00:00");
        assert_eq!(result["imported"][0]["subject"], "合作 & 报价 'x'");

        let rows = f.messages();
        assert_eq!(rows.len(), 2);
        let incoming = &rows[0];
        assert_eq!(incoming.0, "c1");
        assert_eq!(incoming.1, "email");
        assert_eq!(incoming.2, "in");
        assert_eq!(incoming.3, "2026-10-25T01:00:00+00:00");
        assert_eq!(incoming.4, "alice@creator.test");
        assert_eq!(incoming.5, "合作 & 报价 'x'");
        assert_eq!(incoming.6, "Hello team\nThanks");
        assert_eq!(incoming.7, "");
        assert_eq!(incoming.8, "正常|lark-mail:m1");
        let outgoing = &rows[1];
        assert_eq!(outgoing.2, "out");
        assert_eq!(outgoing.4, "shop@example.com");
        assert_eq!(outgoing.5, "Automatic reply: 合作");
        assert_eq!(outgoing.6, "Thanks for your email.\nBest.");
        assert_eq!(outgoing.8, "自动回复|lark-mail:m2");

        let cursor = f.setting("mail_sync").unwrap();
        assert_eq!(cursor["mailbox"], "shop@example.com");
        assert_eq!(cursor["inbox"]["lastAt"], "2026-10-25T01:00:00+00:00");
        assert_eq!(cursor["sent"]["lastAt"], "2026-10-26T02:30:00+00:00");
        assert!(cursor["lastRunAt"].as_str().is_some());
        let text = result.to_string();
        assert!(!text.contains("alice@creator.test"));
        assert!(!text.contains("Hello team"));
        assert!(!text.contains("Thanks for your email"));
    }

    #[test]
    fn apply_twice_is_idempotent() {
        let f = Fixture::new();
        f.set_mailbox("shop@example.com");
        f.creator("c1", "alpha", "alice@creator.test");
        let cli = f.serve(
            json!([triage(
                "m1",
                "2026-10-25T01:00:00Z",
                "alice@creator.test",
                "合作"
            )]),
            json!([]),
            json!([inbox_detail("m1", "alice@creator.test", "合作", "正文")]),
        );
        run(json!({"apply":true}), &f.state(), Some(&cli)).unwrap();
        let second = run(json!({"apply":true}), &f.state(), Some(&cli)).unwrap();
        assert_eq!(second["folders"]["inbox"]["new"], 0);
        assert_eq!(second["folders"]["inbox"]["existing"], 1);
        assert_eq!(second["imported"].as_array().unwrap().len(), 0);
        assert_eq!(f.message_count(), 1);
    }

    #[test]
    fn old_record_with_same_subject_is_duplicate() {
        let f = Fixture::new();
        f.set_mailbox("shop@example.com");
        f.creator("c1", "alpha", "alice@creator.test");
        f.old_message(
            "legacy:old1",
            "c1",
            "in",
            "2026-10-25T01:10:00+00:00",
            "合作 & 报价 'x'",
        );
        let cli = f.serve(
            json!([triage(
                "m1",
                "2026-10-25T01:20:00Z",
                "alice@creator.test",
                " 合作 &amp; 报价 &#39;x&#39; "
            )]),
            json!([]),
            json!([inbox_detail(
                "m1",
                "alice@creator.test",
                "合作 &amp; 报价 &#39;x&#39;",
                "正文"
            )]),
        );
        let result = run(json!({"apply":true}), &f.state(), Some(&cli)).unwrap();
        assert_eq!(result["folders"]["inbox"]["duplicate"], 1);
        assert_eq!(result["folders"]["inbox"]["new"], 0);
        assert_eq!(f.message_count(), 1);
    }

    #[test]
    fn unmatched_creator_is_only_counted() {
        let f = Fixture::new();
        f.set_mailbox("shop@example.com");
        let cli = f.serve(
            json!([triage(
                "m1",
                "2026-10-25T01:00:00Z",
                "stranger@unknown.test",
                "合作"
            )]),
            json!([]),
            json!([inbox_detail("m1", "stranger@unknown.test", "合作", "正文")]),
        );
        let result = run(json!({"apply":true}), &f.state(), Some(&cli)).unwrap();
        assert_eq!(result["unmatched"], 1);
        assert_eq!(result["folders"]["inbox"]["new"], 0);
        assert_eq!(result["imported"].as_array().unwrap().len(), 0);
        assert_eq!(f.message_count(), 0);
    }

    #[test]
    fn self_copy_is_skipped() {
        let f = Fixture::new();
        f.set_mailbox("shop@example.com");
        f.creator("c1", "alpha", "alice@creator.test");
        let cli = f.serve(
            json!([triage(
                "m1",
                "2026-10-25T01:00:00Z",
                "Shop <shop@example.com>",
                "自己发的副本"
            )]),
            json!([]),
            json!([inbox_detail(
                "m1",
                "shop@example.com",
                "自己发的副本",
                "正文"
            )]),
        );
        let result = run(json!({"apply":true}), &f.state(), Some(&cli)).unwrap();
        assert_eq!(result["folders"]["inbox"]["self"], 1);
        assert_eq!(result["folders"]["inbox"]["new"], 0);
        assert_eq!(f.message_count(), 0);
    }

    #[test]
    fn missing_sender_mailbox_is_rejected() {
        let f = Fixture::new();
        let cli = f.serve(json!([]), json!([]), json!([]));
        let error = run(json!({"apply":true}), &f.state(), Some(&cli)).unwrap_err();
        assert!(error.contains("请先在连接与设置页选择发件邮箱"), "{error}");
        assert_eq!(f.message_count(), 0);
    }

    #[test]
    fn cli_failure_writes_nothing() {
        let f = Fixture::new();
        f.set_mailbox("shop@example.com");
        f.creator("c1", "alpha", "alice@creator.test");
        let cli = f.fail_details(
            json!([triage(
                "m1",
                "2026-10-25T01:00:00Z",
                "alice@creator.test",
                "合作"
            )]),
            json!([]),
        );
        let error = run(json!({"apply":true}), &f.state(), Some(&cli)).unwrap_err();
        assert!(error.contains("读取收件箱邮件正文失败"), "{error}");
        assert!(error.contains("邮箱服务暂时不可用"), "{error}");
        assert_eq!(f.message_count(), 0);
        assert!(f.setting("mail_sync").is_none());
    }

    #[test]
    fn output_redacts_addresses_in_subject() {
        let f = Fixture::new();
        f.set_mailbox("shop@example.com");
        f.creator("c1", "alpha", "alice@creator.test");
        let cli = f.serve(
            json!([triage(
                "m1",
                "2026-10-25T01:00:00Z",
                "Alice <alice@creator.test>",
                "Re: alice@creator.test 合作"
            )]),
            json!([]),
            json!([inbox_detail(
                "m1",
                "alice@creator.test",
                "Re: alice@creator.test 合作",
                "正文"
            )]),
        );
        let result = run(json!({}), &f.state(), Some(&cli)).unwrap();
        assert_eq!(result["imported"][0]["subject"], "Re: [邮箱] 合作");
        assert!(!result.to_string().contains("alice@creator.test"));
    }

    #[test]
    fn html_body_keeps_text_and_drops_style() {
        assert_eq!(
            strip_html("<style>.x{color:red}</style><p>你好 &amp; 再见</p>"),
            "你好 & 再见"
        );
    }

    #[test]
    fn input_fields_are_validated() {
        let f = Fixture::new();
        let cli = f.serve(json!([]), json!([]), json!([]));
        assert!(run(json!({"unknown":1}), &f.state(), Some(&cli))
            .unwrap_err()
            .contains("不支持"));
        assert!(run(json!({"apply":"yes"}), &f.state(), Some(&cli))
            .unwrap_err()
            .contains("布尔"));
        assert!(run(json!({"since":"2026/09/25"}), &f.state(), Some(&cli))
            .unwrap_err()
            .contains("YYYY-MM-DD"));
    }
}
