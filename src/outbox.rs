//! 发件箱：人工写好的邮件从插件发出（v5 方案 0.13b）。
//!
//! 流程：保存草稿 → 发送前复查硬规则 → 先落盘“发送中” → 建飞书草稿并记下草稿编号 → 发送草稿
//! → 查投递状态 → 记结果。只有草稿编号已经写进发件记录之后才会调用发送，所以中途被杀、超时、
//! 断网时，记录停在“发送中／结果待核对”，只能核对、不能重发；核对时先查已发送文件夹，再看草稿
//! 是否还在。只要发送可能发生过，草稿仍在也不能作为未发送的证明。
//!
//! 测试模式：收件人强制改为测试收件邮箱，主题带测试编号、正文顶部标注“测试”；不写正式消息与
//! 事实台账，回信只记在发件记录上。正式模式：发给达人档案里的邮箱，有来信时按回复发出，并把
//! 发出的邮件和发送尝试／平台受理／发送失败写进业务库。
use crate::setup::{self, Cli};
use crate::{drafts::only_keys, Result};
use chrono::{DateTime, Duration as Span, Local, NaiveTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

const TABLE: &str = "CREATE TABLE IF NOT EXISTS outbox(
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, creator TEXT NOT NULL REFERENCES creators(id),
 subject TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT NOT NULL DEFAULT '', basis_at TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', sender TEXT NOT NULL DEFAULT '', recipient TEXT NOT NULL DEFAULT '',
 final_subject TEXT NOT NULL DEFAULT '', final_body TEXT NOT NULL DEFAULT '', body_hash TEXT NOT NULL DEFAULT '',
 token TEXT NOT NULL UNIQUE, draft_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
 error TEXT NOT NULL DEFAULT '', attempt_at TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL DEFAULT '',
 reply_at TEXT NOT NULL DEFAULT '', reply_subject TEXT NOT NULL DEFAULT '', reply_body TEXT NOT NULL DEFAULT '',
 history TEXT NOT NULL DEFAULT '[]', created TEXT NOT NULL, updated TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS outbox_creator ON outbox(creator);";
/// 已经调用或可能调用过发送的状态；这些状态不能再发，只能核对。
const UNSETTLED: [&str; 2] = ["sending", "unknown"];
/// 计入“已发出”的状态（每日上限、跟进次数）。
const SENT: [&str; 5] = ["sending", "unknown", "accepted", "delivered", "bounced"];
const STATES: [&str; 8] = [
    "draft",
    "sending",
    "unknown",
    "accepted",
    "delivered",
    "bounced",
    "blocked",
    "cancelled",
];
/// 宿主给插件命令 20 秒；建草稿、发送各最多 7 秒，查投递只在剩余时间够时做。
const STEP_TIMEOUT: Duration = Duration::from_secs(7);
const BUDGET: Duration = Duration::from_secs(16);
/// 发出后多久还查不到，才认定“没有发出”。
const SETTLE_SECONDS: i64 = 120;
const BODY_LIMIT: usize = 10000;
const SUBJECT_LIMIT: usize = 200;

/// 覆盖整个外部调用周期，避免另一进程核对尚在执行的发送。
/// 内核在进程退出或被杀时释放锁；锁文件不能删除，否则会出现两个锁 inode。
#[cfg(unix)]
fn action_lock(path: &Path) -> Result<std::fs::File> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(business(path)?.with_extension("outbox.lock"))
        .map_err(|e| format!("无法锁定发件箱：{e}"))?;
    // SAFETY: file 持有有效描述符，调用不转移其所有权。
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("发件箱正在发送或核对，请稍后再试；本次没有重复发送".into());
    }
    Ok(file)
}
#[cfg(not(unix))]
fn action_lock(_path: &Path) -> Result<std::fs::File> {
    Err("当前平台尚未支持发件箱跨进程锁，发送与核对未启用".into())
}

fn stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}
fn parse_at(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .or_else(|_| DateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f%:z"))
        .ok()
        .map(|d| d.with_timezone(&Utc))
}
fn step_timeout() -> Duration {
    std::env::var("GAPAW_LARK_SEND_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| (1..=7).contains(n))
        .map(Duration::from_secs)
        .unwrap_or(STEP_TIMEOUT)
}
fn settle_seconds() -> i64 {
    std::env::var("GAPAW_OUTBOX_SETTLE_SECS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| (0..=600).contains(n))
        .unwrap_or(SETTLE_SECONDS)
}
/// 发送与核对的时间参数；生产值来自上面的常量（允许环境变量覆盖），测试里直接注入，
/// 避免并行测试互相干扰。
#[derive(Clone, Copy)]
struct Timing {
    step: Duration,
    settle: i64,
}
impl Timing {
    fn production() -> Self {
        Self {
            step: step_timeout(),
            settle: settle_seconds(),
        }
    }
}

// —— 业务库 ——
fn business(path: &Path) -> Result<PathBuf> {
    let status = crate::local_backend::status(path)?;
    if status["initialized"] != true || status["active"] != true {
        return Err("请先在“连接与设置”里建立并启用业务数据".into());
    }
    crate::local_backend::business_path(path)
}
fn open(path: &Path, write: bool) -> Result<Option<Connection>> {
    let bp = business(path)?;
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(&bp, flags).map_err(|e| format!("无法打开业务库：{e}"))?;
    db.busy_timeout(Duration::from_millis(250))
        .map_err(|e| e.to_string())?;
    if write {
        db.pragma_update(None, "foreign_keys", true)
            .map_err(|e| e.to_string())?;
        db.execute_batch(TABLE)
            .map_err(|e| format!("无法建立发件箱表：{e}"))?;
    } else if !has_table(&db) {
        return Ok(None);
    }
    Ok(Some(db))
}
pub(crate) fn has_table(db: &Connection) -> bool {
    db.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='outbox'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .is_ok_and(|n| n > 0)
}
fn db_err(e: rusqlite::Error) -> String {
    format!("发件箱读写失败：{e}")
}
const COLUMNS: &str = "id,client_id,creator,subject,body,reply_to,basis_at,state,mode,sender,recipient,final_subject,final_body,body_hash,token,draft_id,message_id,error,attempt_at,sent_at,reply_at,reply_subject,reply_body,history,created,updated,revision";
fn row_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let names = COLUMNS.split(',');
    let mut obj = serde_json::Map::new();
    for (i, name) in names.enumerate() {
        let v = if name == "revision" {
            json!(r.get::<_, i64>(i)?)
        } else if name == "history" {
            serde_json::from_str(&r.get::<_, String>(i)?).unwrap_or_else(|_| json!([]))
        } else {
            json!(r.get::<_, String>(i)?)
        };
        obj.insert(name.to_string(), v);
    }
    Ok(Value::Object(obj))
}
fn load(db: &Connection, id: &str) -> Result<Value> {
    db.query_row(
        &format!("SELECT {COLUMNS} FROM outbox WHERE id=?"),
        [id],
        row_json,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| "找不到这封邮件".into())
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

struct CreatorInfo {
    handle: String,
    settings: Value,
}
fn creator_info(db: &Connection, id: &str) -> Result<CreatorInfo> {
    let (handle, settings): (Option<String>, String) = db
        .query_row(
            "SELECT handle,settings FROM creators WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db_err)?
        .ok_or("找不到这位达人")?;
    Ok(CreatorInfo {
        handle: handle.unwrap_or_default(),
        settings: serde_json::from_str(&settings).unwrap_or_else(|_| json!({})),
    })
}
struct Inbound {
    at: String,
    source: String,
    sender: String,
}
/// 最近一封真人来信（不含自动回复）。
fn latest_inbound(db: &Connection, creator: &str) -> Result<Option<Inbound>> {
    db.query_row(
        "SELECT at,coalesce(source,''),coalesce(sender,'') FROM messages WHERE creator=? AND direction='in' AND channel='email' AND coalesce(kind,'')<>'自动回复' AND at IS NOT NULL ORDER BY at DESC LIMIT 1",
        [creator],
        |r| Ok(Inbound { at: r.get(0)?, source: r.get(1)?, sender: r.get(2)? }),
    )
    .optional()
    .map_err(db_err)
}

// —— 正文检查 ——
/// 裸金额：$12、＄12、12 美元、12USD、12 dollars、12 元。金额必须用【固定费】占位符。
fn bare_amount(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if (*c == '$' || *c == '＄')
            && chars[i + 1..]
                .iter()
                .find(|c| !c.is_whitespace())
                .is_some_and(|c| c.is_ascii_digit())
        {
            return true;
        }
        if c.is_ascii_digit()
            && !chars
                .get(i + 1)
                .is_some_and(|n| n.is_ascii_digit() || *n == '.' || *n == ',')
        {
            let rest: String = chars[i + 1..].iter().collect::<String>();
            let rest = rest.trim_start().to_lowercase();
            if ["美元", "美金", "usd", "dollar", "元", "块"]
                .iter()
                .any(|u| rest.starts_with(u))
            {
                return true;
            }
        }
    }
    false
}
fn render(text: &str, settings: &Value) -> String {
    let fill = |v: &Value| match v {
        Value::Null => None,
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    };
    let mut out = text.to_string();
    for (holder, key) in [
        ("【固定费】", "fee"),
        ("【佣金比例】", "commission"),
        ("【姓名】", "sender"),
    ] {
        if let Some(v) = fill(&settings[key]) {
            out = out.replace(holder, &v);
        }
    }
    out
}
fn leftover_placeholder(text: &str) -> Option<String> {
    let start = text.find('【')?;
    let end = text[start..]
        .find('】')
        .map(|e| start + e + '】'.len_utf8());
    Some(end.map_or_else(|| "【".into(), |e| text[start..e].to_string()))
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

// —— 设置 ——
struct Settings {
    mode: String,
    sender: String,
    test_recipient: String,
    limits: Value,
    usable: std::result::Result<(), String>,
}
fn settings(path: &Path) -> Result<Settings> {
    let (values, check) = setup::outbox_settings(path)?;
    let sender = s(&values, "senderMailbox").trim().to_ascii_lowercase();
    let usable = if sender.is_empty() {
        Err("还没有设置发件邮箱".to_string())
    } else if !setup::mail_usable(&check, &sender) {
        Err("请先在“连接与设置”里重新检测飞书邮箱登录，并确认发件邮箱可访问、有发信权限".into())
    } else if s(&values, "mode") != "live" && s(&values, "testRecipient").trim().is_empty() {
        Err("测试模式下请先设置测试收件邮箱".into())
    } else {
        Ok(())
    };
    Ok(Settings {
        mode: if s(&values, "mode") == "live" {
            "live"
        } else {
            "test"
        }
        .into(),
        sender,
        test_recipient: s(&values, "testRecipient").trim().to_ascii_lowercase(),
        limits: values["limits"].clone(),
        usable,
    })
}

// —— 硬规则 ——
fn rule(key: &str, label: &str, ok: bool, live_only: bool, message: String) -> Value {
    json!({"key":key,"label":label,"ok":ok,"liveOnly":live_only,"message":message})
}
fn valid_email(v: &str) -> bool {
    let Some((local, domain)) = v.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !v
            .chars()
            .any(|c| c.is_whitespace() || ",;<>\"'()[]\\".contains(c))
}
/// 发送前复查。liveOnly 的规则在测试模式下只提示，不拦截；其余规则两种模式都拦截。
fn rules(db: &Connection, entry: &Value, st: &Settings) -> Result<Vec<Value>> {
    let creator = s(entry, "creator");
    let info = creator_info(db, creator)?;
    let mut out = vec![];
    let refused: i64 = db
        .query_row(
            "SELECT count(*) FROM events WHERE creator=? AND type='明确拒绝' AND coalesce(void_reason,'')=''",
            [creator],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    out.push(rule(
        "refused",
        "未明确拒绝",
        refused == 0,
        true,
        if refused == 0 {
            "没有拒绝记录".into()
        } else {
            "这位达人已明确拒绝，停止联系".into()
        },
    ));
    let bounced: i64 = db
        .query_row(
            "SELECT count(*) FROM outbox WHERE creator=? AND mode='live' AND state='bounced'",
            [creator],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    out.push(rule(
        "bounced",
        "邮箱未退信",
        bounced == 0,
        true,
        if bounced == 0 {
            "没有退信记录".into()
        } else {
            "发往这位达人的邮件退过信，请先核实邮箱".into()
        },
    ));
    let email = s(&info.settings, "email").trim().to_ascii_lowercase();
    out.push(rule(
        "recipient",
        "达人邮箱已登记",
        valid_email(&email),
        true,
        if valid_email(&email) {
            "达人档案里有邮箱".into()
        } else {
            "达人档案里没有可用邮箱".into()
        },
    ));
    let latest = latest_inbound(db, creator)?;
    let fresh = latest.as_ref().is_some_and(|m| {
        parse_at(&m.at) > parse_at(s(entry, "basis_at")) || s(entry, "basis_at").is_empty()
    });
    out.push(rule(
        "fresh",
        "写信后没有新来信",
        !fresh,
        false,
        if fresh {
            "写这封信之后达人又来信了，请先看过新来信".into()
        } else {
            "没有新来信".into()
        },
    ));
    // 正文与占位符
    let body = format!("{}\n{}", s(entry, "subject"), s(entry, "body"));
    let bare = bare_amount(&body);
    out.push(rule(
        "amount",
        "金额使用占位符",
        !bare,
        false,
        if bare {
            "正文里有直接写出的金额，请改用【固定费】".into()
        } else {
            "没有裸金额".into()
        },
    ));
    let rendered = render(&body, &info.settings);
    let left = leftover_placeholder(&rendered);
    out.push(rule(
        "placeholder",
        "占位符都能填上",
        left.is_none(),
        false,
        match &left {
            Some(p) => format!("{p} 在合作设置里没有值，或不是可用的占位符"),
            None => "占位符已全部填好".into(),
        },
    ));
    // 发送上限与跟进节奏（只按正式发出的邮件计算）
    let cap = st.limits["dailySend"].as_i64().unwrap_or(20);
    let today = Local::now().format("%Y-%m-%d").to_string();
    let mut sent_today = 0i64;
    {
        let mut q = db
            .prepare("SELECT sent_at,attempt_at,state FROM outbox WHERE mode='live'")
            .map_err(db_err)?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(db_err)?;
        for row in rows {
            let (sent, attempt, state) = row.map_err(db_err)?;
            let at = if sent.is_empty() { attempt } else { sent };
            if SENT.contains(&state.as_str())
                && parse_at(&at).is_some_and(|t| {
                    t.with_timezone(&Local).format("%Y-%m-%d").to_string() == today
                })
            {
                sent_today += 1;
            }
        }
    }
    out.push(rule(
        "daily",
        "每日发送上限",
        sent_today < cap,
        true,
        format!("今天已正式发出 {sent_today} 封，上限 {cap} 封"),
    ));
    let (start, end) = (
        s(&st.limits, "windowStart").to_string(),
        s(&st.limits, "windowEnd").to_string(),
    );
    let now_t = Local::now().time();
    let in_window = match (
        NaiveTime::parse_from_str(&start, "%H:%M"),
        NaiveTime::parse_from_str(&end, "%H:%M"),
    ) {
        (Ok(a), Ok(b)) => now_t >= a && now_t <= b,
        _ => true,
    };
    out.push(rule(
        "window",
        "允许发送时段",
        in_window,
        true,
        format!("允许 {start}–{end} 发送（本机时间）"),
    ));
    let since = latest.as_ref().map(|m| m.at.clone()).unwrap_or_default();
    let mut outs: Vec<DateTime<Utc>> = vec![];
    {
        let mut q = db
            .prepare("SELECT at FROM messages WHERE creator=? AND direction='out' AND channel='email' AND at IS NOT NULL")
            .map_err(db_err)?;
        let rows = q
            .query_map([creator], |r| r.get::<_, String>(0))
            .map_err(db_err)?;
        for at in rows {
            if let Some(t) = parse_at(&at.map_err(db_err)?) {
                if parse_at(&since).is_none_or(|s| t > s) {
                    outs.push(t);
                }
            }
        }
    }
    let max_follow = st.limits["maxFollowups"].as_i64().unwrap_or(2);
    let gap = st.limits["minIntervalDays"].as_i64().unwrap_or(5);
    let unanswered = outs.len() as i64;
    let follow_ok = unanswered <= max_follow;
    out.push(rule(
        "followups",
        "跟进次数上限",
        follow_ok,
        true,
        format!("上次来信后已连发 {unanswered} 封未获回复，首封之外最多跟进 {max_follow} 次"),
    ));
    let last = outs.iter().max().copied();
    let gap_ok = last.is_none_or(|t| Utc::now() - t >= Span::days(gap));
    out.push(rule(
        "interval",
        "跟进最小间隔",
        gap_ok,
        true,
        match last {
            Some(t) => format!(
                "上一封未获回复的邮件发于 {}，间隔至少 {gap} 天",
                t.with_timezone(&Local).format("%m-%d %H:%M")
            ),
            None => "上次来信后还没发过信".into(),
        },
    ));
    Ok(out)
}
fn blocking(rules: &[Value], mode: &str) -> Vec<String> {
    rules
        .iter()
        .filter(|r| r["ok"] == false && (mode == "live" || r["liveOnly"] == false))
        .map(|r| r["message"].as_str().unwrap_or("").to_string())
        .collect()
}

// —— 保存、撤回 ——
fn check_text(subject: &str, body: &str) -> Result<()> {
    if subject.trim().is_empty()
        || subject.chars().count() > SUBJECT_LIMIT
        || subject.contains(['\n', '\r'])
    {
        return Err(format!(
            "主题不能为空，最多 {SUBJECT_LIMIT} 个字，且不能换行"
        ));
    }
    if body.trim().is_empty() || body.chars().count() > BODY_LIMIT {
        return Err(format!("正文不能为空，最多 {BODY_LIMIT} 个字"));
    }
    Ok(())
}
fn save(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &[
            "clientId",
            "id",
            "revision",
            "creatorId",
            "subject",
            "body",
            "asReply",
        ],
        "outbox-save",
    )?;
    let subject = input["subject"].as_str().ok_or("缺少主题")?;
    let body = input["body"].as_str().ok_or("缺少正文")?;
    check_text(subject, body)?;
    let as_reply = input["asReply"].as_bool().unwrap_or(true);
    let mut db = open(path, true)?.ok_or("无法打开发件箱")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let id = if let Some(id) = input["id"].as_str() {
        let entry = load(&tx, id)?;
        if entry["state"] != "draft" {
            return Err("这封邮件已经发出或撤回，不能再修改".into());
        }
        if input["revision"].as_i64() != entry["revision"].as_i64() {
            return Err("这封邮件已在别处修改，请刷新后再保存".into());
        }
        let latest = latest_inbound(&tx, s(&entry, "creator"))?;
        let reply_to = reply_source(as_reply, latest.as_ref());
        tx.execute(
            "UPDATE outbox SET subject=?,body=?,reply_to=?,basis_at=?,error='',updated=?,revision=revision+1 WHERE id=?",
            params![subject, body, reply_to, latest.map(|m| m.at).unwrap_or_default(), stamp(), id],
        )
        .map_err(db_err)?;
        id.to_string()
    } else {
        let client = input["clientId"].as_str().unwrap_or("");
        if client.is_empty()
            || client.len() > 100
            || !client
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c))
        {
            return Err("缺少有效的请求编号".into());
        }
        let creator = input["creatorId"].as_str().ok_or("缺少达人编号")?;
        creator_info(&tx, creator)?;
        if let Some(old) = tx
            .query_row("SELECT id FROM outbox WHERE client_id=?", [client], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(db_err)?
        {
            let entry = load(&tx, &old)?;
            if s(&entry, "creator") != creator {
                return Err("请求编号已被其他邮件使用".into());
            }
            return public(&tx, entry, None);
        }
        let latest = latest_inbound(&tx, creator)?;
        let reply_to = reply_source(as_reply, latest.as_ref());
        let id = Uuid::new_v4().simple().to_string();
        let token = format!("GWT-{}", id[..8].to_ascii_uppercase());
        let at = stamp();
        tx.execute(
            "INSERT INTO outbox(id,client_id,creator,subject,body,reply_to,basis_at,state,token,created,updated) VALUES(?,?,?,?,?,?,?,'draft',?,?,?)",
            params![id, client, creator, subject, body, reply_to, latest.map(|m| m.at).unwrap_or_default(), token, at, at],
        )
        .map_err(db_err)?;
        id
    };
    let entry = load(&tx, &id)?;
    tx.commit().map_err(db_err)?;
    let db = open(path, false)?.ok_or("无法打开发件箱")?;
    let st = settings(path)?;
    public(&db, entry, Some(&st))
}
fn reply_source(as_reply: bool, latest: Option<&Inbound>) -> String {
    match latest {
        Some(m) if as_reply => m
            .source
            .strip_prefix("lark-mail:")
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}
fn cancel(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["id", "revision"], "outbox-cancel")?;
    let id = input["id"].as_str().ok_or("缺少邮件编号")?;
    let mut db = open(path, true)?.ok_or("无法打开发件箱")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let entry = load(&tx, id)?;
    if entry["state"] != "draft" {
        return Err("只有待发送的邮件可以撤回".into());
    }
    if input["revision"].as_i64() != entry["revision"].as_i64() {
        return Err("这封邮件已在别处修改，请刷新后再操作".into());
    }
    tx.execute(
        "UPDATE outbox SET state='cancelled',updated=?,revision=revision+1 WHERE id=?",
        params![stamp(), id],
    )
    .map_err(db_err)?;
    let entry = load(&tx, id)?;
    tx.commit().map_err(db_err)?;
    public(&db, entry, None)
}

// —— 发送 ——
fn find_key<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    match v {
        Value::Object(map) => map
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| map.values().find_map(|x| find_key(x, key))),
        Value::Array(items) => items.iter().find_map(|x| find_key(x, key)),
        _ => None,
    }
}
fn history_push(db: &Connection, id: &str, note: &str) -> Result<()> {
    let raw: String = db
        .query_row("SELECT history FROM outbox WHERE id=?", [id], |r| r.get(0))
        .map_err(db_err)?;
    let mut list: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
    list.push(json!({"at":stamp(),"note":note}));
    if list.len() > 30 {
        list.drain(..list.len() - 30);
    }
    db.execute(
        "UPDATE outbox SET history=? WHERE id=?",
        params![Value::Array(list).to_string(), id],
    )
    .map_err(db_err)?;
    Ok(())
}
/// 更新状态并写历史；正式模式下同步写消息与事实。
fn settle(
    path: &Path,
    id: &str,
    state: &str,
    fields: &[(&str, String)],
    note: &str,
) -> Result<Value> {
    let mut db = open(path, true)?.ok_or("无法打开发件箱")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let mut sets = vec![
        "state=?".to_string(),
        "updated=?".to_string(),
        "revision=revision+1".to_string(),
    ];
    let mut values: Vec<String> = vec![state.into(), stamp()];
    for (k, v) in fields {
        sets.push(format!("{k}=?"));
        values.push(v.clone());
    }
    values.push(id.into());
    tx.execute(
        &format!("UPDATE outbox SET {} WHERE id=?", sets.join(",")),
        rusqlite::params_from_iter(values.iter()),
    )
    .map_err(db_err)?;
    history_push(&tx, id, note)?;
    let entry = load(&tx, id)?;
    if entry["mode"] == "live" {
        record_live(&tx, &entry)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(entry)
}
/// 正式模式：发出的邮件写进消息（来源与邮件同步一致，避免重复），并按状态补记事实。
fn record_live(db: &Connection, entry: &Value) -> Result<()> {
    let state = s(entry, "state");
    let mid = s(entry, "message_id");
    let creator = s(entry, "creator");
    let id = s(entry, "id");
    let at = if s(entry, "sent_at").is_empty() {
        s(entry, "attempt_at")
    } else {
        s(entry, "sent_at")
    };
    let attempt = s(entry, "attempt_at");
    if state == "draft" && !attempt.is_empty() {
        // 核对确认没有发出：作废这次尝试记下的事实。
        db.execute(
            "UPDATE events SET void_reason='核对确认未发出' WHERE request_id=? AND coalesce(void_reason,'')=''",
            [format!("outbox:{id}:{attempt}:attempt")],
        )
        .map_err(db_err)?;
        return Ok(());
    }
    if !SENT.contains(&state) && state != "blocked" {
        return Ok(());
    }
    let event = |kind: &str, suffix: &str, proof: &str| -> Result<()> {
        db.execute(
            "INSERT OR IGNORE INTO events(id,creator,channel,type,at,proof,note,created,void_reason,request_id) VALUES(?,?,?,?,?,?,?,?,'',?)",
            params![Uuid::new_v4().simple().to_string(), creator, "email", kind, at, proof, "发件箱", stamp(), format!("outbox:{id}:{attempt}:{suffix}")],
        )
        .map(|_| ())
        .map_err(db_err)
    };
    event("发送尝试", "attempt", "")?;
    if !mid.is_empty() {
        db.execute(
            "INSERT OR IGNORE INTO messages(id,creator,channel,direction,at,sender,subject,body,zh,kind,source,created) VALUES(?,?,?,?,?,?,?,?,'','正常',?,?)",
            params![Uuid::new_v4().simple().to_string(), creator, "email", "out", at, s(entry, "sender"), s(entry, "final_subject"), s(entry, "final_body"), format!("lark-mail:{mid}"), stamp()],
        )
        .map_err(db_err)?;
    }
    match state {
        "accepted" | "delivered" => event("平台受理", "accepted", &format!("飞书邮件编号 {mid}"))?,
        "bounced" | "blocked" => event(
            "发送失败",
            "failed",
            &format!(
                "飞书投递状态：{}",
                if state == "bounced" {
                    "退信"
                } else {
                    "被拦截"
                }
            ),
        )?,
        _ => {}
    }
    Ok(())
}
fn send(input: &Value, path: &Path, cli: Option<&Cli>, timing: Timing) -> Result<Value> {
    only_keys(
        input,
        &["id", "revision", "acknowledgeNewInbound"],
        "outbox-send",
    )?;
    let started = Instant::now();
    let _lock = action_lock(path)?;
    let id = input["id"].as_str().ok_or("缺少邮件编号")?.to_string();
    let st = settings(path)?;
    st.usable.clone()?;
    let owned;
    let cli = match cli {
        Some(cli) => cli,
        None => {
            owned = Cli::locate().ok_or("本机未找到飞书命令行 lark-cli")?;
            &owned
        }
    };
    // 1. 复查并先落盘“发送中”
    let entry = {
        let mut db = open(path, true)?.ok_or("无法打开发件箱")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let entry = load(&tx, &id)?;
        match s(&entry, "state") {
            "draft" => {}
            "sending" | "unknown" => {
                return Err("这封邮件上次的发送结果还没核对，请先点“核对结果”，避免重复发送".into())
            }
            _ => return Err("这封邮件已经发出或撤回，不能再发送".into()),
        }
        if input["revision"].as_i64() != entry["revision"].as_i64() {
            return Err("这封邮件已在别处修改，请刷新后再发送".into());
        }
        let creator = s(&entry, "creator").to_string();
        let mut checked = rules(&tx, &entry, &st)?;
        if input["acknowledgeNewInbound"] == true {
            checked.retain(|r| r["key"] != "fresh");
        }
        let blocked = blocking(&checked, &st.mode);
        if !blocked.is_empty() {
            return Err(format!("发送前复查没有通过：{}", blocked.join("；")));
        }
        let info = creator_info(&tx, &creator)?;
        let subject = render(s(&entry, "subject"), &info.settings);
        let body = render(s(&entry, "body"), &info.settings);
        let intended = s(&info.settings, "email").trim().to_ascii_lowercase();
        let (recipient, final_subject, final_body) = if st.mode == "live" {
            (intended.clone(), subject, body)
        } else {
            let handle = if info.handle.is_empty() {
                creator.clone()
            } else {
                format!("@{}", info.handle)
            };
            let target = if intended.is_empty() {
                "未登记邮箱".to_string()
            } else {
                intended.clone()
            };
            (
                st.test_recipient.clone(),
                format!("[测试 {}] {subject}", s(&entry, "token")),
                format!("【测试邮件】正式模式下这封信会发给 {handle}（{target}）。请直接回复这封邮件，回信会记到这封信上。\n\n{body}"),
            )
        };
        let latest = latest_inbound(&tx, &creator)?;
        let reply_to = if s(&entry, "reply_to").is_empty() {
            String::new()
        } else {
            reply_source(true, latest.as_ref())
        };
        if st.mode == "live"
            && !reply_to.is_empty()
            && latest
                .as_ref()
                .is_none_or(|m| address(&json!(m.sender)) != recipient)
        {
            return Err(
                "原来信发件人与达人邮箱不一致，不能直接回复；请核对联系人或另存为新邮件".into(),
            );
        }
        tx.execute(
            "UPDATE outbox SET state='sending',mode=?,sender=?,recipient=?,final_subject=?,final_body=?,body_hash=?,basis_at=?,reply_to=?,draft_id='',message_id='',error='',attempt_at=?,updated=?,revision=revision+1 WHERE id=?",
            params![st.mode, st.sender, recipient, final_subject, final_body, hash(&final_body), latest.map(|m| m.at).unwrap_or_else(|| s(&entry, "basis_at").to_string()), reply_to, stamp(), stamp(), id],
        )
        .map_err(db_err)?;
        history_push(
            &tx,
            &id,
            &format!(
                "开始发送（{}模式）",
                if st.mode == "live" {
                    "正式"
                } else {
                    "测试"
                }
            ),
        )?;
        let entry = load(&tx, &id)?;
        tx.commit().map_err(db_err)?;
        entry
    };
    // 2. 建草稿；失败时一定没有发出，回到待发送
    let (sender, recipient) = (
        s(&entry, "sender").to_string(),
        s(&entry, "recipient").to_string(),
    );
    let (subject, body) = (
        s(&entry, "final_subject").to_string(),
        s(&entry, "final_body").to_string(),
    );
    let reply_to = s(&entry, "reply_to").to_string();
    let mut args: Vec<&str> = if st.mode == "live" && !reply_to.is_empty() {
        vec![
            "mail",
            "+reply",
            "--message-id",
            &reply_to,
            "--subject",
            &subject,
        ]
    } else {
        vec![
            "mail",
            "+draft-create",
            "--to",
            &recipient,
            "--subject",
            &subject,
        ]
    };
    args.extend([
        "--mailbox",
        &sender,
        "--from",
        &sender,
        "--body",
        &body,
        "--plain-text",
        "--no-signature",
        "--format",
        "json",
        "--as",
        "user",
    ]);
    if started.elapsed() + timing.step > BUDGET {
        return settle(
            path,
            &id,
            "draft",
            &[("error", "本次准备耗时过长，尚未发送，请稍后重试".into())],
            "未调用外部草稿创建",
        );
    }
    let draft = match cli.run(&args, timing.step) {
        Ok(v) => match find_key(setup::payload(&v), "draft_id") {
            Some(d) => d.to_string(),
            None => {
                return settle(
                    path,
                    &id,
                    "draft",
                    &[(
                        "error",
                        "建草稿没有返回草稿编号，邮件没有发出，可以重新发送".into(),
                    )],
                    "建草稿未返回编号，未发送",
                );
            }
        },
        Err(e) => {
            let msg = format!("建草稿失败：{}；邮件没有发出，可以重新发送", e.message());
            return settle(path, &id, "draft", &[("error", msg.clone())], &msg);
        }
    };
    // 3. 先记下草稿编号，再发送
    {
        let db = open(path, true)?.ok_or("无法打开发件箱")?;
        let changed = db
            .execute(
                "UPDATE outbox SET draft_id=?,updated=? WHERE id=? AND state='sending'",
                params![draft, stamp(), id],
            )
            .map_err(db_err)?;
        if changed != 1 {
            return Err("发送状态已变化，未调用发送；请核对发件箱".into());
        }
        history_push(&db, &id, "已建飞书草稿")?;
    }
    if started.elapsed() + timing.step > BUDGET {
        return settle(
            path,
            &id,
            "unknown",
            &[("error", "草稿已保存，本次发送时间不足；请先核对结果".into())],
            "时间不足，未调用草稿发送",
        );
    }
    let sent = cli.run(
        &[
            "mail",
            "+draft-send",
            "--mailbox",
            &sender,
            "--draft-id",
            &draft,
            "--yes",
            "--format",
            "json",
            "--as",
            "user",
        ],
        timing.step,
    );
    let (state, mid, error) = match sent {
        Ok(v) => {
            let p = setup::payload(&v);
            if let Some(reason) = find_key(p, "automation_send_disable_reason") {
                (
                    "blocked",
                    String::new(),
                    format!("邮箱禁止自动发送：{reason}"),
                )
            } else if let Some(mid) = find_key(p, "message_id") {
                ("accepted", mid.to_string(), String::new())
            } else {
                (
                    "unknown",
                    String::new(),
                    "发送命令没有返回邮件编号，结果待核对，不会自动重发".to_string(),
                )
            }
        }
        Err(e) => (
            "unknown",
            String::new(),
            format!("{}；结果待核对，不会自动重发", e.message()),
        ),
    };
    let mut state = state.to_string();
    // 查投递也要占一个完整单步；只有剩余预算装得下才查，保证整条发送命令不超过总预算。
    if state == "accepted" && started.elapsed() + timing.step <= BUDGET {
        if let Some(d) = setup::delivery(cli, &sender, &mid, timing.step) {
            state = d.into();
        }
    }
    let note = match state.as_str() {
        "accepted" => "平台已受理",
        "delivered" => "已投递",
        "bounced" => "退信",
        "blocked" => "被拦截",
        _ => "发送结果未知，等待核对",
    };
    let entry = settle(
        path,
        &id,
        &state,
        &[
            ("message_id", mid),
            ("error", error),
            (
                "sent_at",
                if state == "unknown" {
                    String::new()
                } else {
                    stamp()
                },
            ),
        ],
        note,
    )?;
    let db = open(path, false)?.ok_or("无法打开发件箱")?;
    public(&db, entry, Some(&st))
}

// —— 核对 ——
fn address(v: &Value) -> String {
    let raw = v
        .as_str()
        .or_else(|| v["mail_address"].as_str())
        .unwrap_or("");
    let raw = match (raw.rfind('<'), raw.rfind('>')) {
        (Some(a), Some(b)) if a < b => &raw[a + 1..b],
        _ => raw,
    };
    raw.trim().to_ascii_lowercase()
}
/// 搜索仅用于找候选。测试邮件有唯一标记；正式邮件还须核对完整正文和地址。
/// 缺少证据或多义时保持待核对，不能取第一条同主题邮件。
fn find_sent(
    cli: &Cli,
    entry: &Value,
    step: Duration,
    started: Instant,
) -> std::result::Result<Option<String>, String> {
    let sender = s(entry, "sender");
    let query = if entry["mode"] == "live" {
        s(entry, "final_subject")
    } else {
        s(entry, "token")
    };
    let after = parse_at(s(entry, "attempt_at")).map(|t| t - Span::minutes(2));
    let filter = json!({"folder":"sent"}).to_string();
    let v = cli
        .run(
            &[
                "mail",
                "+triage",
                "--mailbox",
                sender,
                "--query",
                query,
                "--filter",
                &filter,
                "--max",
                "20",
                "--format",
                "json",
                "--as",
                "user",
            ],
            step,
        )
        .map_err(|e| e.message())?;
    let candidates: Vec<Value> = setup::payload(&v)["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| s(m, "subject") == s(entry, "final_subject"))
        .filter(|m| address(&m["from"]) == sender.to_ascii_lowercase())
        .filter(|m| {
            after.is_some_and(|a| {
                s(m, "date")
                    .parse::<DateTime<Utc>>()
                    .or_else(|_| {
                        DateTime::parse_from_rfc2822(s(m, "date")).map(|d| d.with_timezone(&Utc))
                    })
                    .is_ok_and(|d| d >= a && d <= Utc::now() + Span::minutes(2))
            })
        })
        .filter(|m| !s(m, "message_id").is_empty())
        .cloned()
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    if entry["mode"] != "live" {
        return if candidates.len() == 1 {
            Ok(Some(s(&candidates[0], "message_id").into()))
        } else {
            Err("已发送中有多封相同标记的邮件，无法唯一核对".into())
        };
    }
    if started.elapsed() + step > BUDGET {
        return Err("核对完整邮件的时间不足，请稍后再核对".into());
    }
    let ids = candidates
        .iter()
        .map(|m| s(m, "message_id"))
        .collect::<Vec<_>>()
        .join(",");
    let details = cli
        .run(
            &[
                "mail",
                "+messages",
                "--mailbox",
                sender,
                "--message-ids",
                &ids,
                "--format",
                "json",
                "--as",
                "user",
            ],
            step,
        )
        .map_err(|e| e.message())?;
    let mut matched = std::collections::BTreeSet::new();
    for m in setup::payload(&details)["messages"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let from = if m["head_from"].is_object() {
            address(&m["head_from"])
        } else {
            address(&m["from"])
        };
        let to: Vec<String> = m["to"]
            .as_array()
            .into_iter()
            .flatten()
            .map(address)
            .collect();
        // 不接受摘要、HTML 转换或多收件人近似匹配。
        if candidates
            .iter()
            .any(|c| s(c, "message_id") == s(m, "message_id"))
            && s(m, "subject") == s(entry, "final_subject")
            && from == sender.to_ascii_lowercase()
            && to == [s(entry, "recipient").to_ascii_lowercase()]
            && m["cc"].as_array().is_none_or(|a| a.is_empty())
            && m["bcc"].as_array().is_none_or(|a| a.is_empty())
            && m["body_plain_text"].as_str().is_some_and(|b| {
                b.replace("\r\n", "\n").trim()
                    == s(entry, "final_body").replace("\r\n", "\n").trim()
            })
        {
            matched.insert(s(m, "message_id").to_string());
        }
    }
    match matched.len() {
        1 => Ok(matched.into_iter().next()),
        0 => Err("同主题邮件的完整正文或地址不匹配，继续等待核对".into()),
        _ => Err("有多封正文和地址相同的邮件，无法唯一核对".into()),
    }
}
fn draft_exists(cli: &Cli, sender: &str, draft: &str, step: Duration) -> bool {
    let params = json!({"user_mailbox_id":sender,"draft_id":draft}).to_string();
    cli.run(
        &[
            "mail",
            "user_mailbox.drafts",
            "get",
            "--params",
            &params,
            "--as",
            "user",
        ],
        step,
    )
    .is_ok()
}
fn check(input: &Value, path: &Path, cli: Option<&Cli>, timing: Timing) -> Result<Value> {
    only_keys(input, &["id"], "outbox-check")?;
    let started = Instant::now();
    let _lock = action_lock(path)?;
    let id = input["id"].as_str().ok_or("缺少邮件编号")?.to_string();
    let entry = {
        let db = open(path, false)?.ok_or("发件箱里还没有邮件")?;
        load(&db, &id)?
    };
    let state = s(&entry, "state").to_string();
    if ["draft", "cancelled", "blocked"].contains(&state.as_str()) {
        let db = open(path, false)?.ok_or("无法打开发件箱")?;
        return public(&db, entry, None);
    }
    let owned;
    let cli = match cli {
        Some(cli) => cli,
        None => {
            owned = Cli::locate().ok_or("本机未找到飞书命令行 lark-cli")?;
            &owned
        }
    };
    // 宿主 20 秒会杀进程：每一步之前确认剩余预算还够一个完整单步，不够就留到下次核对。
    let room = || started.elapsed() + timing.step <= BUDGET;
    let sender = s(&entry, "sender").to_string();
    let mut mid = s(&entry, "message_id").to_string();
    let mut new_state = state.clone();
    let mut error = String::new();
    let mut note = String::new();
    if UNSETTLED.contains(&state.as_str()) && mid.is_empty() {
        let age =
            parse_at(s(&entry, "attempt_at")).map_or(i64::MAX, |t| (Utc::now() - t).num_seconds());
        match find_sent(cli, &entry, timing.step, started) {
            Ok(Some(found)) => {
                mid = found;
                new_state = "accepted".into();
                note = "在已发送里找到这封信".into();
            }
            Ok(None) if s(&entry, "draft_id").is_empty() => {
                new_state = "draft".into();
                error = "上次在建草稿之前就中断了，邮件没有发出，可以重新发送".into();
                note = "确认未发出".into();
            }
            Ok(None) if age < timing.settle => {
                error = "刚发出不久，已发送里还没出现，请过一两分钟再核对".into();
            }
            Ok(None) if !room() => {
                error = "这次核对没来得及查完，请再点一次“核对结果”".into();
            }
            Ok(None) if draft_exists(cli, &sender, s(&entry, "draft_id"), timing.step) => {
                new_state = "unknown".into();
                error = "草稿还在，但不能排除服务端延迟发送；保持待核对，不允许重发".into();
            }
            Ok(None) => {
                error = "草稿已不在，已发送里也还没找到，请稍后再核对".into();
            }
            Err(e) => error = format!("核对已发送邮件失败：{e}"),
        }
    }
    if !mid.is_empty() && room() {
        if let Some(d) = setup::delivery(cli, &sender, &mid, timing.step) {
            if new_state != d {
                note = format!("投递状态：{d}");
            }
            new_state = d.into();
        }
    }
    let mut fields: Vec<(&str, String)> = vec![("message_id", mid.clone()), ("error", error)];
    if new_state == "draft" {
        fields.push(("draft_id", String::new()));
    } else if s(&entry, "sent_at").is_empty() && !mid.is_empty() {
        fields.push(("sent_at", stamp()));
    }
    // 测试模式：找测试收件人的回信
    if entry["mode"] == "test"
        && !mid.is_empty()
        && new_state != "bounced"
        && s(&entry, "reply_at").is_empty()
        && room()
    {
        let filter = json!({"folder":"inbox","from":[s(&entry, "recipient")]}).to_string();
        if let Ok(v) = cli.run(
            &[
                "mail",
                "+triage",
                "--mailbox",
                &sender,
                "--query",
                s(&entry, "token"),
                "--filter",
                &filter,
                "--max",
                "10",
                "--format",
                "json",
                "--as",
                "user",
            ],
            timing.step,
        ) {
            let found = setup::payload(&v)["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| {
                    m["subject"]
                        .as_str()
                        .is_some_and(|x| x.contains(s(&entry, "token")))
                })
                .cloned();
            if let Some(m) = found {
                let reply_id = s(&m, "message_id").to_string();
                let mut body = String::new();
                if !reply_id.is_empty() && room() {
                    if let Ok(d) = cli.run(
                        &[
                            "mail",
                            "+messages",
                            "--mailbox",
                            &sender,
                            "--message-ids",
                            &reply_id,
                            "--format",
                            "json",
                            "--as",
                            "user",
                        ],
                        timing.step,
                    ) {
                        if let Some(detail) = setup::payload(&d)["messages"]
                            .as_array()
                            .and_then(|a| a.first())
                        {
                            body = crate::mail_sync::plain_body(detail)
                                .chars()
                                .take(4000)
                                .collect();
                        }
                    }
                }
                fields.push(("reply_at", s(&m, "date").to_string()));
                fields.push((
                    "reply_subject",
                    s(&m, "subject").chars().take(300).collect(),
                ));
                fields.push(("reply_body", body));
                note = "收到测试收件人的回信".into();
            }
        }
    }
    let entry = settle(
        path,
        &id,
        &new_state,
        &fields,
        if note.is_empty() {
            "已核对，状态未变"
        } else {
            &note
        },
    )?;
    let db = open(path, false)?.ok_or("无法打开发件箱")?;
    let st = settings(path)?;
    public(&db, entry, Some(&st))
}

// —— 查看 ——
fn public(db: &Connection, mut entry: Value, st: Option<&Settings>) -> Result<Value> {
    let info = creator_info(db, s(&entry, "creator"))?;
    entry["handle"] = json!(info.handle);
    if entry["state"] == "draft" {
        if let Some(st) = st {
            let checked = rules(db, &entry, st)?;
            entry["blocking"] = json!(blocking(&checked, &st.mode));
            entry["rules"] = json!(checked);
        }
        entry["preview"] = json!({"subject": render(s(&entry, "subject"), &info.settings), "body": render(s(&entry, "body"), &info.settings)});
    }
    if let Some(obj) = entry.as_object_mut() {
        obj.remove("client_id");
    }
    Ok(entry)
}
fn list(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["creatorId"], "outbox-list")?;
    let st = settings(path).ok();
    let gate = match &st {
        Some(st) => {
            json!({"mode":st.mode,"canSend":st.usable.is_ok(),"reason":st.usable.clone().err(),"testRecipient":st.test_recipient,"sender":st.sender})
        }
        None => json!({"mode":"test","canSend":false,"reason":"无法读取设置"}),
    };
    let Some(db) = open(path, false)? else {
        return Ok(json!({"gate":gate,"entries":[],"counts":{}}));
    };
    let mut q = db
        .prepare(&format!("SELECT {COLUMNS} FROM outbox WHERE (?1 IS NULL OR creator=?1) ORDER BY updated DESC LIMIT 100"))
        .map_err(db_err)?;
    let rows = q
        .query_map([input["creatorId"].as_str()], row_json)
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    let mut entries = vec![];
    for e in rows {
        entries.push(public(&db, e, st.as_ref())?);
    }
    Ok(json!({"gate":gate,"entries":entries,"counts":counts(&db)?}))
}
/// 各状态的邮件数，供首页显示；没有发件箱表时为空。
pub(crate) fn counts(db: &Connection) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for k in STATES {
        out.insert(k.into(), json!(0));
    }
    if !has_table(db) {
        return Ok(Value::Object(out));
    }
    let mut q = db
        .prepare("SELECT state,count(*) FROM outbox GROUP BY state")
        .map_err(db_err)?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(db_err)?;
    for row in rows {
        let (k, n) = row.map_err(db_err)?;
        out.insert(k, json!(n));
    }
    Ok(Value::Object(out))
}

pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    let timing = Timing::production();
    match command {
        "outbox-list" => list(&input, path),
        "outbox-save" => save(&input, path),
        "outbox-send" => send(&input, path, None, timing),
        "outbox-check" => check(&input, path, None, timing),
        "outbox-cancel" => cancel(&input, path),
        _ => Err("未知发件箱命令".into()),
    }
}

#[cfg(all(test, unix))]
mod tests {
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
                std::env::temp_dir().join(format!("gapaw-outbox-{}", Uuid::new_v4().simple()));
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
        /// 写 app_setup 与 setup_mail_check；mode 为 test 时补齐测试收件邮箱。
        fn setup_env(&self, mode: &str, limits: Value) {
            let values = json!({
                "senderMailbox": "shop@example.com",
                "senderName": "小店",
                "testRecipient": if mode == "test" { "qa@example.test" } else { "" },
                "mode": mode,
                "limits": limits,
            });
            let setup = json!({"version":1,"updatedAt":crate::now(),"values":values});
            let check = json!({
                "login":{"state":"signed_in","canSend":true,"canRead":true},
                "mailboxes":[{"address":"shop@example.com"}],
            });
            let db = crate::open_db(&self.state(), true).unwrap().unwrap();
            for (key, value) in [("app_setup", setup), ("setup_mail_check", check)] {
                db.execute(
                    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![key, value.to_string()],
                )
                .unwrap();
            }
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
        fn message(&self, creator: &str, direction: &str, at: &str, subject: &str, source: &str) {
            let db = Connection::open(self.business()).unwrap();
            db.execute(
                "INSERT INTO messages(id,creator,channel,direction,at,sender,subject,body,zh,kind,source,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().simple().to_string(),
                    creator,
                    "email",
                    direction,
                    at,
                    if direction == "in" { "alice@creator.test" } else { "shop@example.com" },
                    subject,
                    "旧记录",
                    "",
                    "正常",
                    source,
                    crate::now(),
                ],
            )
            .unwrap();
        }
        fn refuse(&self, creator: &str) {
            let db = Connection::open(self.business()).unwrap();
            db.execute(
                "INSERT INTO events(id,creator,channel,type,at,proof,note,created,void_reason,request_id) VALUES(?,?,?,?,?,?,?,?,'',?)",
                params![
                    Uuid::new_v4().simple().to_string(),
                    creator,
                    "email",
                    "明确拒绝",
                    crate::now(),
                    "",
                    "",
                    crate::now(),
                    Uuid::new_v4().simple().to_string(),
                ],
            )
            .unwrap();
        }
        fn count(&self, table: &str) -> i64 {
            let db = Connection::open(self.business()).unwrap();
            db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        }
        /// `creator,direction,sender,subject,source`
        fn messages(&self) -> Vec<(String, String, String, String, String)> {
            let db = Connection::open(self.business()).unwrap();
            let mut q = db
                .prepare("SELECT creator,direction,coalesce(sender,''),coalesce(subject,''),coalesce(source,'') FROM messages ORDER BY source")
                .unwrap();
            q.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        }
        /// `type,request_id,void_reason`
        fn events(&self) -> Vec<(String, String, String)> {
            let db = Connection::open(self.business()).unwrap();
            let mut q = db
                .prepare("SELECT coalesce(type,''),coalesce(request_id,''),coalesce(void_reason,'') FROM events ORDER BY created")
                .unwrap();
            q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        }
        fn serve(&self, script: &Script) -> Cli {
            let path = self
                .root
                .join(format!("lark-{}.sh", Uuid::new_v4().simple()));
            let log = format!("{}.log", path.display());
            let body = [
                "#!/bin/sh".to_string(),
                format!("printf '%s\\n' \"$*\" >> '{log}'"),
                "case \"$*\" in".to_string(),
                format!("  *+draft-send*) {} ;;", script.send),
                format!("  *+draft-create*) {} ;;", script.draft),
                format!("  *+reply*) {} ;;", script.draft),
                format!("  *send_status*) {} ;;", script.status),
                format!("  *user_mailbox.drafts*) {} ;;", script.drafts),
                "  *+triage*)".to_string(),
                "    case \"$*\" in".to_string(),
                format!(
                    "      *'\"folder\":\"inbox\"'*) {} ;;",
                    script.inbox
                ),
                format!("      *) {} ;;", script.sent),
                "    esac".to_string(),
                "    ;;".to_string(),
                format!("  *+messages*) {} ;;", script.detail),
                "  *) echo '{\"ok\":false,\"error\":{\"message\":\"未预期的命令行参数\"}}'; exit 1 ;;"
                    .to_string(),
                "esac".to_string(),
            ]
            .join("\n");
            fs::write(&path, body).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            Cli { path }
        }
        fn calls(&self, cli: &Cli) -> Vec<String> {
            fs::read_to_string(format!("{}.log", cli.path.display()))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct Script {
        draft: String,
        send: String,
        status: String,
        drafts: String,
        sent: String,
        inbox: String,
        detail: String,
    }
    impl Script {
        fn new() -> Self {
            Self {
                draft: json_out(json!({"ok":true,"data":{"draft_id":"draft-1"}})),
                send: json_out(json!({"ok":true,"data":{"message_id":"m-out-1"}})),
                status: json_out(json!({"ok":true,"data":{"details":[{"status":4}]}})),
                drafts: json_out(json!({"ok":true,"data":{"draft_id":"draft-1"}})),
                sent: json_out(json!({"ok":true,"data":{"messages":[]}})),
                inbox: json_out(json!({"ok":true,"data":{"messages":[]}})),
                detail: json_out(json!({"ok":true,"data":{"messages":[]}})),
            }
        }
    }

    fn json_out(v: Value) -> String {
        format!("cat <<'EOF'\n{v}\nEOF\n")
    }
    fn failure(message: &str) -> String {
        format!(
            "echo '{}'; exit 1\n",
            json!({"ok":false,"error":{"message":message}})
        )
    }
    fn triage(id: &str, date: &str, from: &str, subject: &str) -> Value {
        json!({"message_id":id,"date":date,"from":from,"subject":subject})
    }
    fn limits() -> Value {
        json!({"dailySend":20,"maxFollowups":2,"minIntervalDays":5,"windowStart":"00:00","windowEnd":"23:59"})
    }
    fn outside_window() -> (String, String) {
        let now = Local::now();
        (
            (now + Span::hours(2)).format("%H:%M").to_string(),
            (now + Span::hours(3)).format("%H:%M").to_string(),
        )
    }
    fn try_save(f: &Fixture, input: Value) -> Result<Value> {
        super::save(&input, &f.state())
    }
    fn save(f: &Fixture, input: Value) -> Value {
        try_save(f, input).unwrap()
    }
    fn send(f: &Fixture, input: Value, cli: &Cli, timing: Timing) -> Result<Value> {
        super::send(&input, &f.state(), Some(cli), timing)
    }
    fn check(f: &Fixture, id: &str, cli: &Cli, timing: Timing) -> Result<Value> {
        super::check(&json!({"id":id}), &f.state(), Some(cli), timing)
    }
    fn draft_input(client: &str, creator: &str, subject: &str, body: &str) -> Value {
        json!({"clientId":client,"creatorId":creator,"subject":subject,"body":body})
    }
    fn fast() -> Timing {
        Timing {
            step: Duration::from_millis(150),
            settle: 0,
        }
    }
    fn normal() -> Timing {
        Timing {
            step: Duration::from_secs(2),
            settle: SETTLE_SECONDS,
        }
    }

    #[test]
    fn save_create_is_idempotent_and_revisioned() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let first = save(
            &f,
            draft_input("req-1", "c1", "合作", "你好，想和您聊聊合作。"),
        );
        assert_eq!(first["state"], "draft");
        assert!(first["token"].as_str().unwrap().starts_with("GWT-"));
        let id = first["id"].as_str().unwrap().to_string();

        let again = save(
            &f,
            draft_input("req-1", "c1", "合作", "你好，想和您聊聊合作。"),
        );
        assert_eq!(again["id"], id);
        assert_eq!(f.count("outbox"), 1);

        let edited = save(
            &f,
            json!({"id":id,"revision":0,"subject":"合作（改）","body":"改过的正文"}),
        );
        assert_eq!(edited["subject"], "合作（改）");
        assert_eq!(edited["revision"], 1);

        let error = try_save(
            &f,
            json!({"id":id,"revision":0,"subject":"又改","body":"又改的正文"}),
        )
        .unwrap_err();
        assert!(error.contains("已在别处修改"), "{error}");

        let cancelled = cancel(&json!({"id":id,"revision":1}), &f.state()).unwrap();
        assert_eq!(cancelled["state"], "cancelled");
        let cli = f.serve(&Script::new());
        let error = send(&f, json!({"id":id,"revision":2}), &cli, normal()).unwrap_err();
        assert!(error.contains("已经发出或撤回"), "{error}");
        let error = try_save(
            &f,
            json!({"id":id,"revision":2,"subject":"再改","body":"再改的正文"}),
        )
        .unwrap_err();
        assert!(error.contains("已经发出或撤回"), "{error}");
        assert_eq!(f.count("outbox"), 1);
    }

    #[test]
    fn test_mode_send_uses_test_recipient_and_writes_nothing() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(
            &f,
            draft_input("req-1", "c1", "合作", "你好，想和您聊聊合作。"),
        );
        let id = saved["id"].as_str().unwrap().to_string();
        let token = saved["token"].as_str().unwrap().to_string();
        let cli = f.serve(&Script::new());
        let result = send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap();

        assert!(
            ["accepted", "delivered"].contains(&result["state"].as_str().unwrap()),
            "{}",
            result["state"]
        );
        assert_eq!(result["recipient"], "qa@example.test");
        assert_ne!(result["recipient"], "alice@creator.test");
        let subject = result["final_subject"].as_str().unwrap();
        assert!(subject.starts_with(&format!("[测试 {token}]")), "{subject}");
        let body = result["final_body"].as_str().unwrap();
        assert!(body.starts_with("【测试邮件】"), "{body}");

        let calls = f.calls(&cli);
        let create = calls
            .iter()
            .position(|c| c.contains("+draft-create"))
            .expect("建草稿");
        let send_at = calls
            .iter()
            .position(|c| c.contains("+draft-send"))
            .expect("发送草稿");
        assert!(create < send_at, "{calls:?}");
        assert!(
            calls
                .iter()
                .filter(|c| c.contains("+draft-send"))
                .all(|c| c.contains("--yes")),
            "{calls:?}"
        );
        assert_eq!(f.count("messages"), 0);
        assert_eq!(f.count("events"), 0);
    }

    #[test]
    fn repeat_send_is_rejected() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let cli = f.serve(&Script::new());
        send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap();
        let error = send(&f, json!({"id":id,"revision":1}), &cli, normal()).unwrap_err();
        assert!(error.contains("已经发出或撤回"), "{error}");
        assert_eq!(
            f.calls(&cli)
                .iter()
                .filter(|c| c.contains("+draft-send"))
                .count(),
            1
        );
    }

    #[test]
    fn draft_send_timeout_stays_unknown_and_blocks_resend() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.send = format!(
            "sleep 1\n{}",
            json_out(json!({"ok":true,"data":{"message_id":"m-out-1"}}))
        );
        let cli = f.serve(&script);
        let result = send(&f, json!({"id":id,"revision":0}), &cli, fast()).unwrap();
        assert_eq!(result["state"], "unknown");
        assert_eq!(result["sent_at"], "");
        assert_eq!(result["draft_id"], "draft-1");
        assert!(result["error"].as_str().unwrap().contains("结果待核对"));
        let error = send(&f, json!({"id":id,"revision":1}), &cli, fast()).unwrap_err();
        assert!(error.contains("还没核对"), "{error}");
        assert_eq!(
            f.calls(&cli)
                .iter()
                .filter(|c| c.contains("+draft-send"))
                .count(),
            1
        );
    }

    #[test]
    fn check_after_timeout_finds_sent_message() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let token = saved["token"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.send = format!(
            "sleep 1\n{}",
            json_out(json!({"ok":true,"data":{"message_id":"m-out-1"}}))
        );
        script.sent = json_out(json!({"ok":true,"data":{"messages":[
            triage("m-found", &stamp(), "shop@example.com", &format!("[测试 {token}] 合作"))
        ]}}));
        let cli = f.serve(&script);
        let sent = send(&f, json!({"id":id,"revision":0}), &cli, fast()).unwrap();
        assert_eq!(sent["state"], "unknown");
        let result = check(&f, &id, &cli, fast()).unwrap();
        assert!(
            ["accepted", "delivered"].contains(&result["state"].as_str().unwrap()),
            "{}",
            result["state"]
        );
        assert_eq!(result["message_id"], "m-found");
    }

    #[test]
    fn check_after_timeout_keeps_unknown_when_draft_remains() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.send = format!(
            "sleep 1\n{}",
            json_out(json!({"ok":true,"data":{"message_id":"m-out-1"}}))
        );
        let cli = f.serve(&script);
        send(&f, json!({"id":id,"revision":0}), &cli, fast()).unwrap();
        let result = check(&f, &id, &cli, fast()).unwrap();
        assert_eq!(result["state"], "unknown");
        assert_eq!(result["draft_id"], "draft-1");
        assert!(result["error"].as_str().unwrap().contains("不允许重发"));
    }

    #[test]
    fn check_after_timeout_stays_unknown_when_draft_gone() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.send = format!(
            "sleep 1\n{}",
            json_out(json!({"ok":true,"data":{"message_id":"m-out-1"}}))
        );
        script.drafts = failure("草稿不存在");
        let cli = f.serve(&script);
        send(&f, json!({"id":id,"revision":0}), &cli, fast()).unwrap();
        let result = check(&f, &id, &cli, fast()).unwrap();
        assert_eq!(result["state"], "unknown");
        assert_eq!(result["draft_id"], "draft-1");
        assert!(result["error"].as_str().unwrap().contains("请稍后再核对"));
    }

    #[test]
    fn draft_create_failure_returns_to_draft() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.draft = failure("建草稿失败");
        let cli = f.serve(&script);
        let result = send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap();
        assert_eq!(result["state"], "draft");
        assert_eq!(result["draft_id"], "");
        let error = result["error"].as_str().unwrap();
        assert!(error.contains("建草稿失败"), "{error}");
        assert!(error.contains("可以重新发送"), "{error}");
        assert!(!f.calls(&cli).iter().any(|c| c.contains("+draft-send")));
    }

    #[test]
    fn bare_amount_blocks_send() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let cli = f.serve(&Script::new());
        let saved = save(&f, draft_input("req-1", "c1", "合作", "报价 $100"));
        let id = saved["id"].as_str().unwrap().to_string();
        let error = send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap_err();
        assert!(error.contains("金额"), "{error}");
        let edited = save(
            &f,
            json!({"id":id,"revision":0,"subject":"合作","body":"报价 100 美元"}),
        );
        assert_eq!(edited["revision"], 1);
        let error = send(&f, json!({"id":id,"revision":1}), &cli, normal()).unwrap_err();
        assert!(error.contains("金额"), "{error}");
        assert!(!f.calls(&cli).iter().any(|c| c.contains("+draft-create")));
    }

    #[test]
    fn missing_commission_placeholder_blocks_but_fee_renders() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let cli = f.serve(&Script::new());
        let saved = save(&f, draft_input("req-1", "c1", "合作", "佣金是【佣金比例】"));
        let id = saved["id"].as_str().unwrap().to_string();
        let error = send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap_err();
        assert!(error.contains("【佣金比例】"), "{error}");
        assert!(error.contains("占位符"), "{error}");

        save(
            &f,
            json!({"id":id,"revision":0,"subject":"合作","body":"费用是【固定费】元"}),
        );
        let result = send(&f, json!({"id":id,"revision":1}), &cli, normal()).unwrap();
        let body = result["final_body"].as_str().unwrap();
        assert!(body.contains("费用是50元"), "{body}");
        assert!(!body.contains("【固定费】"), "{body}");
    }

    #[test]
    fn new_inbound_blocks_send_until_acknowledged() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        f.message("c1", "in", &crate::now(), "新的来信", "lark-mail:m-new");
        let cli = f.serve(&Script::new());
        let error = send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap_err();
        assert!(error.contains("又来信"), "{error}");
        let result = send(
            &f,
            json!({"id":id,"revision":0,"acknowledgeNewInbound":true}),
            &cli,
            normal(),
        )
        .unwrap();
        assert!(
            ["accepted", "delivered"].contains(&result["state"].as_str().unwrap()),
            "{}",
            result["state"]
        );
    }

    #[test]
    fn test_mode_ignores_live_only_rules() {
        let f = Fixture::new();
        let (start, end) = outside_window();
        f.setup_env(
            "test",
            json!({"dailySend":0,"maxFollowups":-1,"minIntervalDays":5,"windowStart":start,"windowEnd":end}),
        );
        f.creator("c1", "alpha", "");
        f.refuse("c1");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let cli = f.serve(&Script::new());
        let result = send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap();
        assert!(
            ["accepted", "delivered"].contains(&result["state"].as_str().unwrap()),
            "{}",
            result["state"]
        );
    }

    #[test]
    fn live_mode_enforces_live_only_rules() {
        let f = Fixture::new();
        let (start, end) = outside_window();
        f.setup_env(
            "live",
            json!({"dailySend":0,"maxFollowups":-1,"minIntervalDays":5,"windowStart":start,"windowEnd":end}),
        );
        f.creator("c1", "alpha", "");
        f.refuse("c1");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let cli = f.serve(&Script::new());
        let error = send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap_err();
        assert!(error.contains("发送前复查没有通过"), "{error}");
        assert!(error.contains("达人档案里没有可用邮箱"), "{error}");
        assert!(error.contains("明确拒绝"), "{error}");
        assert!(error.contains("今天已正式发出 0 封"), "{error}");
        assert!(error.contains("最多跟进 -1 次"), "{error}");
        assert!(error.contains("允许"), "{error}");
        assert!(f.calls(&cli).is_empty());
    }

    #[test]
    fn live_send_replies_and_records_message_and_events() {
        let f = Fixture::new();
        f.setup_env("live", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        f.message(
            "c1",
            "in",
            "2026-10-25T01:00:00+00:00",
            "合作邀请",
            "lark-mail:m-in-1",
        );
        let saved = save(
            &f,
            json!({"clientId":"req-1","creatorId":"c1","subject":"Re: 合作邀请","body":"你好，想和您聊聊合作。"}),
        );
        assert_eq!(saved["reply_to"], "m-in-1");
        let id = saved["id"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.send = json_out(json!({"ok":true,"data":{"message_id":"m-out-9"}}));
        let cli = f.serve(&script);
        let result = send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap();
        assert!(
            ["accepted", "delivered"].contains(&result["state"].as_str().unwrap()),
            "{}",
            result["state"]
        );
        let calls = f.calls(&cli);
        let reply = calls
            .iter()
            .find(|c| c.contains("+reply"))
            .expect("回复命令");
        assert!(reply.contains("--message-id m-in-1"), "{reply}");
        assert!(!calls.iter().any(|c| c.contains("+draft-create")));

        let rows = f.messages();
        assert_eq!(rows.len(), 2);
        let out = rows
            .iter()
            .find(|r| r.4 == "lark-mail:m-out-9")
            .expect("发出的邮件");
        assert_eq!(out.0, "c1");
        assert_eq!(out.1, "out");
        assert_eq!(out.2, "shop@example.com");
        assert_eq!(out.3, "Re: 合作邀请");

        let events = f.events();
        assert!(events.iter().any(|e| e.0 == "发送尝试"), "{events:?}");
        assert!(events.iter().any(|e| e.0 == "平台受理"), "{events:?}");
        let prefix = format!("outbox:{id}:");
        assert!(events
            .iter()
            .all(|e| e.1.is_empty() || e.1.starts_with(&prefix)));
        assert!(events.iter().all(|e| e.2.is_empty()));
    }

    #[test]
    fn live_check_preserves_attempt_when_send_is_unsettled() {
        let f = Fixture::new();
        f.setup_env("live", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.send = format!(
            "sleep 1\n{}",
            json_out(json!({"ok":true,"data":{"message_id":"m-out-1"}}))
        );
        let cli = f.serve(&script);
        let sent = send(&f, json!({"id":id,"revision":0}), &cli, fast()).unwrap();
        assert_eq!(sent["state"], "unknown");
        let events = f.events();
        let attempt = events
            .iter()
            .find(|e| e.0 == "发送尝试")
            .expect("发送尝试事件");
        assert_eq!(attempt.2, "");
        assert!(attempt.1.starts_with(&format!("outbox:{id}:")));

        let result = check(&f, &id, &cli, fast()).unwrap();
        assert_eq!(result["state"], "unknown");
        let events = f.events();
        let attempt = events
            .iter()
            .find(|e| e.0 == "发送尝试")
            .expect("发送尝试事件");
        assert!(attempt.2.is_empty(), "{events:?}");
        assert_eq!(f.count("messages"), 0);
    }

    #[test]
    fn live_reconciliation_requires_complete_unique_evidence() {
        for case in ["exact", "other-recipient", "preview-only", "duplicate"] {
            let f = Fixture::new();
            f.setup_env("live", limits());
            f.creator("c1", "alpha", "alice@creator.test");
            let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
            let id = s(&saved, "id");
            let db = Connection::open(f.business()).unwrap();
            db.execute("UPDATE outbox SET state='unknown', mode='live', sender='shop@example.com',recipient='alice@creator.test',final_subject='合作',final_body='正文',attempt_at=?,draft_id='draft-1' WHERE id=?", params![stamp(),id]).unwrap();
            drop(db);
            let mut script = Script::new();
            let mut detail = json!({"message_id":"m-found", "subject":"合作", "head_from":{"mail_address":"shop@example.com"}, "to":[{"mail_address":"alice@creator.test"}], "body_plain_text":"正文"});
            if case == "other-recipient" {
                detail["to"][0]["mail_address"] = json!("other@creator.test");
            }
            if case == "preview-only" {
                detail.as_object_mut().unwrap().remove("body_plain_text");
                detail["body_preview"] = json!("正文");
            }
            let mut candidates = vec![triage("m-found", &stamp(), "shop@example.com", "合作")];
            let mut details = vec![detail.clone()];
            if case == "duplicate" {
                candidates.push(triage("m-other", &stamp(), "shop@example.com", "合作"));
                detail["message_id"] = json!("m-other");
                details.push(detail);
            }
            script.sent = json_out(json!({"messages":candidates}));
            script.detail = json_out(json!({"messages":details}));
            let cli = f.serve(&script);
            let result = check(&f, id, &cli, normal()).unwrap();
            if case == "exact" {
                assert_eq!(result["state"], "delivered");
                assert_eq!(result["message_id"], "m-found");
                assert_eq!(f.count("messages"), 1);
            } else {
                assert_eq!(result["state"], "unknown", "{case}");
                assert_eq!(result["message_id"], "", "{case}");
                assert_eq!(f.count("messages"), 0, "{case}");
            }
        }
    }

    #[test]
    fn test_mode_check_records_reply_from_test_recipient() {
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let token = saved["token"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.send = json_out(json!({"ok":true,"data":{"message_id":"m-out-1"}}));
        script.inbox = json_out(json!({"ok":true,"data":{"messages":[
            triage("r-1", &stamp(), "qa@example.test", &format!("Re: [测试 {token}] 合作"))
        ]}}));
        script.detail = json_out(json!({"ok":true,"data":{"messages":[
            {"message_id":"r-1","body_plain_text":"收到，谢谢"}
        ]}}));
        let cli = f.serve(&script);
        send(&f, json!({"id":id,"revision":0}), &cli, normal()).unwrap();
        let result = check(&f, &id, &cli, normal()).unwrap();
        assert_eq!(result["reply_subject"], format!("Re: [测试 {token}] 合作"));
        assert_eq!(result["reply_body"], "收到，谢谢");
        assert!(!result["reply_at"].as_str().unwrap().is_empty());
        assert_eq!(f.count("messages"), 0);
    }

    #[test]
    fn check_on_draft_does_not_call_cli() {
        // 回归：核对命令在草稿状态下不调用命令行，直接返回原记录。
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let cli = f.serve(&Script::new());
        let result = check(&f, &id, &cli, normal()).unwrap();
        assert_eq!(result["state"], "draft");
        assert!(f.calls(&cli).is_empty());
    }

    #[test]
    fn delivery_status_step_respects_injected_timeout() {
        // 查投递状态也必须受单步超时约束；否则整条发送命令可能撑破宿主 20 秒上限。
        let f = Fixture::new();
        f.setup_env("test", limits());
        f.creator("c1", "alpha", "alice@creator.test");
        let saved = save(&f, draft_input("req-1", "c1", "合作", "正文"));
        let id = saved["id"].as_str().unwrap().to_string();
        let mut script = Script::new();
        script.status = "exec sleep 2\n".to_string();
        let cli = f.serve(&script);
        let started = Instant::now();
        let result = send(&f, json!({"id":id,"revision":0}), &cli, fast()).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "查投递耗时 {:?}",
            started.elapsed()
        );
        assert_eq!(result["state"], "accepted");
        assert!(f.calls(&cli).iter().any(|c| c.contains("send_status")));
    }
}
