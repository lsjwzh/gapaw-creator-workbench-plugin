//! 连接与设置：发件邮箱、测试收件邮箱、运行模式与运行参数，以及飞书邮箱登录检测和测试信。
//! 登录与授权在飞书页面完成，这里只读取命令行的安全字段，不保存、不返回任何令牌。
use crate::{drafts::only_keys, now, open_db, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

const SETUP_KEY: &str = "app_setup";
const MAIL_CHECK_KEY: &str = "setup_mail_check";
const MAIL_TEST_KEY: &str = "setup_mail_test";
const SEND_SCOPE: &str = "mail:user_mailbox.message:send";
const READ_SCOPE: &str = "mail:user_mailbox.message:readonly";
// 结果未知或仍在投递中的测试信，必须先核对才能再发，避免重复外发。
const UNSETTLED: [&str; 2] = ["sending", "unknown"];

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS setup_history(version INTEGER PRIMARY KEY,at TEXT NOT NULL,previous TEXT NOT NULL,current TEXT NOT NULL,note TEXT NOT NULL DEFAULT '');")
        .map_err(|e| e.to_string())
}

fn defaults() -> Value {
    json!({"senderMailbox":"","senderName":"","testRecipient":"","mode":"test",
        "limits":{"dailySend":20,"maxFollowups":2,"minIntervalDays":5,"windowStart":"09:00","windowEnd":"21:00"},
        "delegation":{"streak":10,"creators":5,"undoMinutes":30},
        "sync":{"enabled":false,"intervalMinutes":60}})
}
fn read(db: Option<&Connection>, key: &str) -> Result<Value> {
    let Some(db) = db else { return Ok(Value::Null) };
    let raw: Option<String> = db
        .query_row("SELECT value FROM settings WHERE key=?", [key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null))
}
fn write(db: &Connection, key: &str, value: &Value) -> Result<()> {
    db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,&value.to_string()])
        .map(|_| ())
        .map_err(|e| e.to_string())
}
/// 保存的值叠加在默认值上，旧版本缺少的字段取默认值。
fn current(db: Option<&Connection>) -> Result<Value> {
    let stored = read(db, SETUP_KEY)?;
    let mut values = defaults();
    if let Some(saved) = stored["values"].as_object() {
        for (k, v) in saved {
            match (values.get_mut(k), v) {
                (Some(Value::Object(base)), Value::Object(patch)) => {
                    for (sk, sv) in patch {
                        if base.contains_key(sk) {
                            base.insert(sk.clone(), sv.clone());
                        }
                    }
                }
                (Some(slot), _) => *slot = v.clone(),
                (None, _) => {}
            }
        }
    }
    Ok(
        json!({"version":stored["version"].as_i64().unwrap_or(0),"updatedAt":stored["updatedAt"],"values":values}),
    )
}
/// 读取当前保存的发件邮箱；尚未设置时返回空字符串。
pub(crate) fn sender_mailbox(db: Option<&Connection>) -> Result<String> {
    Ok(current(db)?["values"]["senderMailbox"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase())
}

/// 发件箱用：当前设置值与最近一次邮箱检测结果。
pub(crate) fn outbox_settings(path: &Path) -> Result<(Value, Value)> {
    let db = open_db(path, false)?;
    Ok((
        current(db.as_ref())?["values"].clone(),
        read(db.as_ref(), MAIL_CHECK_KEY)?,
    ))
}
/// 已登录、有收发权限，且发件邮箱在可访问列表里。
pub(crate) fn mail_usable(check: &Value, sender: &str) -> bool {
    mail_ready(check) && mailboxes(check).contains(&sender.to_ascii_lowercase())
}

fn is_email(v: &str) -> bool {
    let Some((local, domain)) = v.split_once('@') else {
        return false;
    };
    v.len() <= 254
        && !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !v
            .chars()
            .any(|c| c.is_whitespace() || ",;<>\"'()[]\\".contains(c))
}
fn is_hhmm(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && v[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && v[3..].parse::<u8>().is_ok_and(|m| m < 60)
}
fn int_in(v: &Value, group: &str, key: &str, lo: i64, hi: i64, label: &str) -> Result<()> {
    match v[group][key].as_i64() {
        Some(n) if (lo..=hi).contains(&n) => Ok(()),
        _ => Err(format!("{label}应为 {lo}–{hi} 之间的整数")),
    }
}
fn validate(v: &Value) -> Result<()> {
    let sender = v["senderMailbox"].as_str().ok_or("发件邮箱格式不正确")?;
    if !sender.is_empty() && !is_email(sender) {
        return Err("发件邮箱格式不正确".into());
    }
    let test = v["testRecipient"]
        .as_str()
        .ok_or("测试收件邮箱格式不正确")?;
    if !test.is_empty() && !is_email(test) {
        return Err("测试收件邮箱格式不正确".into());
    }
    if !test.is_empty() && test.eq_ignore_ascii_case(sender) {
        return Err("测试收件邮箱不能与发件邮箱相同".into());
    }
    let name = v["senderName"].as_str().ok_or("发件人显示名格式不正确")?;
    if name.chars().count() > 60 || name.contains(['\n', '\r', '<', '>', '"']) {
        return Err("发件人显示名最多 60 个字，且不能含换行、引号或尖括号".into());
    }
    if !matches!(v["mode"].as_str(), Some("test" | "live")) {
        return Err("运行模式只能是测试或正式".into());
    }
    int_in(v, "limits", "dailySend", 1, 200, "每日发送上限")?;
    int_in(v, "limits", "maxFollowups", 0, 5, "每位达人跟进次数上限")?;
    int_in(v, "limits", "minIntervalDays", 1, 30, "跟进最小间隔天数")?;
    let (start, end) = (
        v["limits"]["windowStart"].as_str().unwrap_or(""),
        v["limits"]["windowEnd"].as_str().unwrap_or(""),
    );
    if !is_hhmm(start) || !is_hhmm(end) || start >= end {
        return Err("允许发送时段应为 HH:MM，且开始早于结束".into());
    }
    int_in(v, "delegation", "streak", 3, 50, "放权所需连续通过次数")?;
    int_in(v, "delegation", "creators", 1, 50, "放权所需覆盖达人数")?;
    int_in(v, "delegation", "undoMinutes", 0, 1440, "撤回窗口分钟数")?;
    if !v["sync"]["enabled"].is_boolean() {
        return Err("定时同步开关格式不正确".into());
    }
    int_in(v, "sync", "intervalMinutes", 15, 1440, "定时同步间隔分钟数")
}
fn mailboxes(check: &Value) -> Vec<String> {
    check["mailboxes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["address"].as_str().map(str::to_ascii_lowercase))
        .collect()
}
fn mail_ready(check: &Value) -> bool {
    check["login"]["state"] == "signed_in"
        && check["login"]["canSend"] == true
        && check["login"]["canRead"] == true
}
fn same_pair(test: &Value, values: &Value) -> bool {
    !test.is_null()
        && test["sender"] == values["senderMailbox"]
        && test["recipient"] == values["testRecipient"]
}
fn test_passed(test: &Value, values: &Value) -> bool {
    same_pair(test, values) && test["state"] == "replied"
}

fn save(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &["expectedVersion", "values", "confirmLive"],
        "setup-save",
    )?;
    let expected = input["expectedVersion"]
        .as_i64()
        .ok_or("缺少有效字段：expectedVersion")?;
    let patch = input["values"].as_object().ok_or("values 必须是对象")?;
    let mut db = open_db(path, true)?.ok_or("无法打开状态库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let cur = current(Some(&tx))?;
    if cur["version"].as_i64() != Some(expected) {
        return Err("设置已在其他页面修改，请刷新后再保存".into());
    }
    let previous = cur["values"].clone();
    let mut values = previous.clone();
    for (k, v) in patch {
        match (k.as_str(), v) {
            ("senderMailbox" | "testRecipient", Value::String(s)) => {
                values[k] = json!(s.trim().to_ascii_lowercase())
            }
            ("senderName", Value::String(s)) => values[k] = json!(s.trim()),
            ("mode", Value::String(_)) => values[k] = v.clone(),
            ("limits" | "delegation" | "sync", Value::Object(o)) => {
                for (sk, sv) in o {
                    if values[k].get(sk).is_none() {
                        return Err(format!("不支持的设置项：{k}.{sk}"));
                    }
                    values[k][sk] = sv.clone();
                }
            }
            _ => return Err(format!("不支持的设置项：{k}")),
        }
    }
    validate(&values)?;
    let check = read(Some(&tx), MAIL_CHECK_KEY)?;
    let test = read(Some(&tx), MAIL_TEST_KEY)?;
    let mut notes = vec![];
    let sender = values["senderMailbox"].as_str().unwrap_or("").to_string();
    if sender != previous["senderMailbox"].as_str().unwrap_or("") && !sender.is_empty() {
        if check.is_null() {
            return Err("请先检测飞书邮箱登录，再选择发件邮箱".into());
        }
        if !mailboxes(&check).contains(&sender) {
            return Err("所选发件邮箱不在当前登录账号可访问的邮箱中，请重新检测后选择".into());
        }
    }
    let pair_changed = values["senderMailbox"] != previous["senderMailbox"]
        || values["testRecipient"] != previous["testRecipient"];
    if pair_changed && values["mode"] == "live" {
        values["mode"] = json!("test");
        notes.push("发件或测试邮箱已更改，运行模式已退回测试模式");
    }
    if values["mode"] == "live" && previous["mode"] != "live" {
        if input["confirmLive"] != true {
            return Err("切换到正式模式需要单独确认".into());
        }
        if !test_passed(&test, &values) || !mail_ready(&check) {
            return Err("请先用当前发件邮箱和测试收件邮箱完成一次收发测试，再切换正式模式".into());
        }
    }
    if values == previous {
        return Ok(json!({"version":expected,"values":values,"changed":false,"notes":notes}));
    }
    let version = expected + 1;
    let at = now();
    write(
        &tx,
        SETUP_KEY,
        &json!({"version":version,"updatedAt":at,"values":values}),
    )?;
    tx.execute(
        "INSERT INTO setup_history(version,at,previous,current,note) VALUES(?,?,?,?,?)",
        rusqlite::params![
            version,
            at,
            previous.to_string(),
            values.to_string(),
            notes.join("；")
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"version":version,"values":values,"changed":true,"notes":notes}))
}

// —— 飞书命令行 ——
#[derive(Debug, PartialEq)]
pub(crate) enum CliError {
    Timeout,
    Unreadable,
    Failed(String),
    Spawn(String),
}
impl CliError {
    pub(crate) fn message(&self) -> String {
        match self {
            CliError::Timeout => "飞书命令行超时未返回".into(),
            CliError::Unreadable => "飞书命令行返回了无法解析的内容".into(),
            CliError::Failed(m) => m.clone(),
            CliError::Spawn(m) => format!("无法启动飞书命令行：{m}"),
        }
    }
}
pub(crate) struct Cli {
    pub(crate) path: PathBuf,
}
impl Cli {
    pub(crate) fn locate() -> Option<Self> {
        if let Some(p) = env::var_os("GAPAW_LARK_CLI") {
            let p = PathBuf::from(p);
            return (p.is_absolute() && p.is_file()).then_some(Cli { path: p });
        }
        let mut dirs: Vec<PathBuf> = env::var_os("PATH")
            .map(|p| env::split_paths(&p).collect())
            .unwrap_or_default();
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
        dirs.into_iter()
            .map(|d| d.join("lark-cli"))
            .find(|p| p.is_file())
            .map(|path| Cli { path })
    }
    pub(crate) fn run(
        &self,
        args: &[&str],
        timeout: Duration,
    ) -> std::result::Result<Value, CliError> {
        let mut child = Command::new(&self.path)
            .args(args)
            .env("LARKSUITE_CLI_NO_UPDATE_NOTIFIER", "1")
            .env("LARKSUITE_CLI_NO_SKILLS_NOTIFIER", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| CliError::Spawn(e.to_string()))?;
        let collect = |pipe: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut s = String::new();
                if let Some(p) = pipe {
                    let _ = p.take(4 << 20).read_to_string(&mut s);
                }
                s
            })
        };
        let out = collect(
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        );
        let err = collect(
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        );
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CliError::Timeout);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                Err(e) => return Err(CliError::Spawn(e.to_string())),
            }
        };
        let (stdout, stderr) = (
            out.join().unwrap_or_default(),
            err.join().unwrap_or_default(),
        );
        let parsed = parse_json(&stdout).or_else(|| parse_json(&stderr));
        match parsed {
            Some(v) if status.success() && v["ok"] != false => Ok(v),
            Some(v) => Err(CliError::Failed(error_text(&v))),
            None => Err(CliError::Unreadable),
        }
    }
}
/// 命令行可能先输出提示行，从第一个“{”开始解析一个 JSON 对象。
fn parse_json(s: &str) -> Option<Value> {
    let i = s.find('{')?;
    serde_json::Deserializer::from_str(&s[i..])
        .into_iter::<Value>()
        .next()?
        .ok()
        .filter(Value::is_object)
}
fn error_text(v: &Value) -> String {
    let e = &v["error"];
    let text = e["message"]
        .as_str()
        .or(e.as_str())
        .or(v["msg"].as_str())
        .unwrap_or("飞书命令行返回失败");
    text.chars().take(300).collect()
}
pub(crate) fn payload(v: &Value) -> &Value {
    if v["data"].is_object() {
        &v["data"]
    } else {
        v
    }
}

fn probe(cli: &Cli) -> Value {
    let auth = match cli.run(&["auth", "status"], Duration::from_secs(20)) {
        Ok(v) => v,
        Err(e) => {
            return json!({"installed":true,"login":{"state":"error"},"mailboxes":[],"message":format!("读取飞书登录状态失败：{}",e.message())})
        }
    };
    let user = &auth["identities"]["user"];
    let status = user["status"].as_str().unwrap_or("");
    let scopes: HashSet<&str> = user["scope"]
        .as_str()
        .unwrap_or("")
        .split_whitespace()
        .collect();
    let signed = user["available"] == true && matches!(status, "ready" | "needs_refresh");
    let state = if signed {
        "signed_in"
    } else if user.is_null() || status.is_empty() {
        "signed_out"
    } else {
        "expired"
    };
    // 只取展示所需的安全字段，令牌和账号编号一律不带出。
    let login = json!({"state":state,"userName":user["userName"].as_str(),"canSend":scopes.contains(SEND_SCOPE),"canRead":scopes.contains(READ_SCOPE),"refreshExpiresAt":user["refreshExpiresAt"].as_str()});
    if !signed {
        return json!({"installed":true,"login":login,"mailboxes":[],"message":"飞书命令行尚未以用户身份登录或登录已过期，请按下方步骤在飞书页面授权。"});
    }
    let boxes = match cli.run(
        &[
            "mail",
            "user_mailboxes",
            "accessible_mailboxes",
            "--user-mailbox-id",
            "me",
            "--as",
            "user",
        ],
        Duration::from_secs(30),
    ) {
        Ok(v) => v,
        Err(e) => {
            return json!({"installed":true,"login":login,"mailboxes":[],"message":format!("读取可访问邮箱失败：{}",e.message())})
        }
    };
    let list: Vec<Value> = payload(&boxes)["accessible_mailboxes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let a = m["email_address"].as_str()?.to_ascii_lowercase();
            is_email(&a).then(|| json!({"address":a,"type":m["email_type"].as_str()}))
        })
        .collect();
    let message = if login["canSend"] != true || login["canRead"] != true {
        "已登录，但授权缺少邮件读取或发送权限，请重新授权并勾选邮件权限。".to_string()
    } else {
        format!(
            "已登录飞书：{}，可访问 {} 个邮箱。",
            login["userName"].as_str().unwrap_or("当前用户"),
            list.len()
        )
    };
    json!({"installed":true,"login":login,"mailboxes":list,"message":message})
}
fn mail_status(path: &Path) -> Result<Value> {
    let mut result = match Cli::locate() {
        None => {
            json!({"installed":false,"login":{"state":"missing"},"mailboxes":[],"message":"本机未找到飞书命令行 lark-cli，请先安装并登录。"})
        }
        Some(cli) => probe(&cli),
    };
    result["checkedAt"] = json!(now());
    let db = open_db(path, true)?.ok_or("无法打开状态库")?;
    write(&db, MAIL_CHECK_KEY, &result)?;
    Ok(result)
}

pub(crate) fn delivery(
    cli: &Cli,
    sender: &str,
    message_id: &str,
    timeout: Duration,
) -> Option<&'static str> {
    let params = json!({"user_mailbox_id":sender,"message_id":message_id}).to_string();
    let v = cli
        .run(
            &[
                "mail",
                "user_mailbox.messages",
                "send_status",
                "--params",
                &params,
                "--as",
                "user",
            ],
            timeout,
        )
        .ok()?;
    let codes: Vec<i64> = payload(&v)["details"]
        .as_array()?
        .iter()
        .filter_map(|d| d["status"].as_i64())
        .collect();
    Some(if codes.contains(&3) {
        "bounced"
    } else if codes.contains(&6) {
        "blocked"
    } else if !codes.is_empty() && codes.iter().all(|c| *c == 4) {
        "delivered"
    } else {
        "accepted"
    })
}
/// 在指定文件夹里按测试编号查找邮件；from 不为空时只认该发件人的邮件。
fn find(
    cli: &Cli,
    mailbox: &str,
    folder: &str,
    token: &str,
    from: Option<&str>,
) -> std::result::Result<Option<Value>, CliError> {
    let mut filter = json!({ "folder": folder });
    if let Some(f) = from {
        filter["from"] = json!([f]);
    }
    let v = cli.run(
        &[
            "mail",
            "+triage",
            "--mailbox",
            mailbox,
            "--query",
            token,
            "--filter",
            &filter.to_string(),
            "--max",
            "20",
            "--format",
            "json",
            "--as",
            "user",
        ],
        Duration::from_secs(30),
    )?;
    Ok(payload(&v)["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|m| {
            m["subject"].as_str().is_some_and(|s| s.contains(token))
                && from.is_none_or(|f| {
                    m["from"]
                        .as_str()
                        .is_some_and(|s| s.to_ascii_lowercase().contains(f))
                })
        })
        .cloned())
}

/// 发送最多等 60 秒；测试可用 GAPAW_LARK_SEND_TIMEOUT_SECS 缩短（1–60）。
fn send_timeout() -> Duration {
    let secs = env::var("GAPAW_LARK_SEND_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| (1..=60).contains(n))
        .unwrap_or(60);
    Duration::from_secs(secs)
}
fn mail_test(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["action", "expectedVersion"], "mail-test")?;
    let action = input["action"].as_str().unwrap_or("");
    if !["send", "check"].contains(&action) {
        return Err("action 只能是 send 或 check".into());
    }
    let (values, version, check, existing) = {
        let db = open_db(path, false)?;
        let cur = current(db.as_ref())?;
        (
            cur["values"].clone(),
            cur["version"].as_i64().unwrap_or(0),
            read(db.as_ref(), MAIL_CHECK_KEY)?,
            read(db.as_ref(), MAIL_TEST_KEY)?,
        )
    };
    if input
        .get("expectedVersion")
        .is_some_and(|v| v.as_i64() != Some(version))
    {
        return Err("设置已在其他页面修改，请刷新后再测试".into());
    }
    let sender = values["senderMailbox"].as_str().unwrap_or("").to_string();
    let recipient = values["testRecipient"].as_str().unwrap_or("").to_string();
    if sender.is_empty() || recipient.is_empty() {
        return Err("请先保存发件邮箱和测试收件邮箱".into());
    }
    if !mail_ready(&check) || !mailboxes(&check).contains(&sender) {
        return Err("请先重新检测飞书邮箱登录，并确认发件邮箱可访问".into());
    }
    let cli = Cli::locate().ok_or("本机未找到飞书命令行 lark-cli")?;
    let store = |record: &Value| -> Result<()> {
        let db = open_db(path, true)?.ok_or("无法打开状态库")?;
        write(&db, MAIL_TEST_KEY, record)
    };
    if action == "send" {
        if same_pair(&existing, &values)
            && UNSETTLED.contains(&existing["state"].as_str().unwrap_or(""))
        {
            return Err("上一封测试信的结果还未核对，请先点“检查回信”，避免重复发送".into());
        }
        let token = format!(
            "GW-{}",
            Uuid::new_v4().simple().to_string()[..8].to_ascii_uppercase()
        );
        let subject = format!("[Gapaw 测试] 邮箱连接测试 {token}");
        let body = format!("这是 Gapaw 达人工作台发出的连接测试邮件（编号 {token}）。\n请直接回复这封邮件，内容任意。工作台收到回信后，即确认发信和收件都可用。\n\nThis is a connection test from the Gapaw creator workbench (ref {token}). Please reply to this email with any content.");
        let mut record = json!({"token":token,"sender":sender,"recipient":recipient,"subject":subject,"state":"sending","startedAt":now(),"messageId":null,"error":null});
        // 先落盘再调用发送：中途中断时记录停在“发送中”，下次只能核对、不能重发。
        store(&record)?;
        let args = [
            "mail",
            "+send",
            "--mailbox",
            &sender,
            "--from",
            &sender,
            "--to",
            &recipient,
            "--subject",
            &subject,
            "--body",
            &body,
            "--plain-text",
            "--no-signature",
            "--confirm-send",
            "--as",
            "user",
        ];
        match cli.run(&args, send_timeout()) {
            Ok(v) => {
                let p = payload(&v);
                if let Some(reason) = p["automation_send_disable_reason"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                {
                    record["state"] = json!("blocked");
                    record["error"] = json!(format!("邮箱禁止自动发送：{reason}"));
                } else if let Some(mid) = p["message_id"].as_str().filter(|s| !s.is_empty()) {
                    record["messageId"] = json!(mid);
                    record["state"] =
                        json!(delivery(&cli, &sender, mid, Duration::from_secs(20))
                            .unwrap_or("accepted"));
                } else {
                    record["state"] = json!("unknown");
                    record["error"] = json!("发送命令未返回邮件编号，结果待核对");
                }
            }
            Err(e) => {
                record["state"] = json!("unknown");
                record["error"] = json!(format!("{}；结果待核对，不会自动重发", e.message()));
            }
        }
        record["checkedAt"] = json!(now());
        store(&record)?;
        return Ok(record);
    }
    if !same_pair(&existing, &values) {
        return Err("当前设置还没有发过测试信，请先发送测试信".into());
    }
    let mut record = existing;
    let token = record["token"].as_str().unwrap_or("").to_string();
    record["error"] = Value::Null;
    if record["messageId"].is_null() {
        match find(&cli, &sender, "sent", &token, None) {
            Ok(Some(m)) => {
                record["messageId"] = m["message_id"].clone();
                record["state"] = json!("accepted");
            }
            Ok(None) if UNSETTLED.contains(&record["state"].as_str().unwrap_or("")) => {
                record["state"] = json!("not_sent");
                record["error"] = json!("已发送文件夹中没有找到这封测试信，可以重新发送");
            }
            Ok(None) => {}
            Err(e) => record["error"] = json!(format!("核对已发送邮件失败：{}", e.message())),
        }
    }
    if let Some(mid) = record["messageId"].as_str().map(str::to_string) {
        if record["state"] != "replied" {
            if let Some(d) = delivery(&cli, &sender, &mid, Duration::from_secs(20)) {
                record["state"] = json!(d);
            }
        }
        if !["bounced", "blocked"].contains(&record["state"].as_str().unwrap_or("")) {
            match find(&cli, &sender, "inbox", &token, Some(&recipient)) {
                Ok(Some(m)) => {
                    record["state"] = json!("replied");
                    record["replyAt"] = m["date"].clone();
                }
                Ok(None) => {}
                Err(e) => record["error"] = json!(format!("检查回信失败：{}", e.message())),
            }
        }
    }
    record["checkedAt"] = json!(now());
    store(&record)?;
    Ok(record)
}

// —— 汇总状态 ——
fn item(
    id: &str,
    title: &str,
    state: &str,
    summary: String,
    required_by: &[&str],
    required: bool,
) -> Value {
    json!({"id":id,"title":title,"state":state,"summary":summary,"requiredBy":required_by,"required":required})
}
fn history(db: Option<&Connection>) -> Vec<Value> {
    let Some(db) = db else { return vec![] };
    let Ok(mut q) = db.prepare(
        "SELECT version,at,previous,current,note FROM setup_history ORDER BY version DESC LIMIT 5",
    ) else {
        return vec![];
    };
    q.query_map([], |r| {
        let (prev, cur): (String, String) = (r.get(2)?, r.get(3)?);
        let (prev, cur): (Value, Value) = (
            serde_json::from_str(&prev).unwrap_or(Value::Null),
            serde_json::from_str(&cur).unwrap_or(Value::Null),
        );
        let mut changed = vec![];
        if let Some(o) = cur.as_object() {
            for (k, v) in o {
                if prev.get(k) != Some(v) {
                    changed.push(k.clone());
                }
            }
        }
        Ok(json!({"version":r.get::<_,i64>(0)?,"at":r.get::<_,String>(1)?,"changed":changed,"note":r.get::<_,String>(4)?}))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}
const TEST_LABEL: [(&str, &str); 8] = [
    ("sending", "测试信发送中，结果待核对"),
    ("unknown", "测试信结果未知，请点“检查回信”核对"),
    ("not_sent", "测试信未发出，可以重新发送"),
    ("accepted", "测试信已受理，请用测试邮箱回复后点“检查回信”"),
    ("delivered", "测试信已投递，请用测试邮箱回复后点“检查回信”"),
    ("bounced", "测试信被退回，请检查测试收件邮箱地址"),
    ("blocked", "发件邮箱被禁止自动发送，请联系邮箱管理员"),
    ("replied", "收发测试通过"),
];

fn status(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["brief"], "setup-status")?;
    let brief = input["brief"] == true;
    let db = open_db(path, false)?;
    let cur = current(db.as_ref())?;
    let values = &cur["values"];
    let check = read(db.as_ref(), MAIL_CHECK_KEY)?;
    let test = read(db.as_ref(), MAIL_TEST_KEY)?;
    let mut items = vec![];

    let data = crate::local_backend::status(path);
    items.push(match &data {
        Ok(d) if d["initialized"] == true && d["active"] == true => item(
            "data",
            "业务数据",
            "ok",
            format!("本地工作台已启用：{} 位达人。", d["counts"]["creators"]),
            &["全部功能"],
            true,
        ),
        Ok(d) if d["initialized"] == true => item(
            "data",
            "业务数据",
            "action",
            "本地工作台已存在但未启用，请在数据管理中启用。".into(),
            &["全部功能"],
            true,
        ),
        Ok(_) => item(
            "data",
            "业务数据",
            "missing",
            "尚未建立本地工作台：可以新建空白工作台，或从旧库迁入（迁入需你确认）。".into(),
            &["全部功能"],
            true,
        ),
        Err(e) => item(
            "data",
            "业务数据",
            "error",
            format!("读取本地工作台失败：{e}"),
            &["全部功能"],
            true,
        ),
    });

    let mail_fns = ["收件同步", "发送邮件"];
    items.push(if check.is_null() {
        item(
            "mailLogin",
            "飞书邮箱登录",
            "missing",
            "尚未检测。点击“检测”读取本机飞书命令行的登录状态。".into(),
            &mail_fns,
            true,
        )
    } else {
        let state = if mail_ready(&check) { "ok" } else { "action" };
        item(
            "mailLogin",
            "飞书邮箱登录",
            state,
            check["message"].as_str().unwrap_or("").into(),
            &mail_fns,
            true,
        )
    });

    let sender = values["senderMailbox"].as_str().unwrap_or("");
    items.push(if sender.is_empty() {
        item(
            "sender",
            "发件邮箱",
            "missing",
            "尚未选择。检测登录后，从可访问的邮箱中选择。".into(),
            &mail_fns,
            true,
        )
    } else if !check.is_null() && !mailboxes(&check).contains(&sender.to_string()) {
        item(
            "sender",
            "发件邮箱",
            "action",
            format!("{sender} 不在当前登录账号可访问的邮箱中。"),
            &mail_fns,
            true,
        )
    } else if same_pair(&test, values) && test["state"] == "blocked" {
        item(
            "sender",
            "发件邮箱",
            "action",
            format!("{sender} 被禁止自动发送。"),
            &mail_fns,
            true,
        )
    } else {
        item(
            "sender",
            "发件邮箱",
            "ok",
            sender.to_string(),
            &mail_fns,
            true,
        )
    });

    let recipient = values["testRecipient"].as_str().unwrap_or("");
    let test_fns = ["测试模式", "发送邮件"];
    items.push(if recipient.is_empty() {
        item(
            "testRecipient",
            "测试收件邮箱",
            "missing",
            "尚未填写。填一个你能登录的外部邮箱，用来扮演达人收发信。".into(),
            &test_fns,
            true,
        )
    } else if test_passed(&test, values) {
        item(
            "testRecipient",
            "测试收件邮箱",
            "ok",
            format!("{recipient}：收发测试通过。"),
            &test_fns,
            true,
        )
    } else if same_pair(&test, values) {
        let state = test["state"].as_str().unwrap_or("");
        let label = TEST_LABEL
            .iter()
            .find(|(k, _)| *k == state)
            .map(|(_, l)| *l)
            .unwrap_or("测试状态未知");
        item(
            "testRecipient",
            "测试收件邮箱",
            "action",
            format!("{recipient}：{label}。"),
            &test_fns,
            true,
        )
    } else {
        item(
            "testRecipient",
            "测试收件邮箱",
            "action",
            format!("{recipient}：还没有发过测试信。"),
            &test_fns,
            true,
        )
    });

    items.push(if values["mode"] == "live" {
        item(
            "mode",
            "运行模式",
            "ok",
            "正式模式：外发邮件发往达人真实邮箱。".into(),
            &["发送邮件"],
            true,
        )
    } else {
        item(
            "mode",
            "运行模式",
            "ok",
            "测试模式：所有外发邮件只发往测试收件邮箱。".into(),
            &["发送邮件"],
            true,
        )
    });

    items.push(if brief {
        item(
            "browser",
            "浏览器与平台登录",
            "skipped",
            "".into(),
            &["选人"],
            false,
        )
    } else {
        match crate::selection::execute("selection-environment", json!({}), path, None) {
            Ok(e) if e["ready"] == true => item(
                "browser",
                "浏览器与平台登录",
                "ok",
                e["message"].as_str().unwrap_or("").into(),
                &["选人"],
                false,
            ),
            Ok(e) => item(
                "browser",
                "浏览器与平台登录",
                "optional",
                format!(
                    "{}（邮件功能不需要此项）",
                    e["message"].as_str().unwrap_or("未就绪")
                ),
                &["选人"],
                false,
            ),
            Err(e) => item(
                "browser",
                "浏览器与平台登录",
                "optional",
                format!("读取浏览器状态失败：{e}（邮件功能不需要此项）"),
                &["选人"],
                false,
            ),
        }
    });

    let l = &values["limits"];
    items.push(item(
        "limits",
        "发送上限",
        "ok",
        format!(
            "每日最多 {} 封；每位达人最多跟进 {} 次，间隔至少 {} 天；发送时段 {}–{}。",
            l["dailySend"],
            l["maxFollowups"],
            l["minIntervalDays"],
            l["windowStart"].as_str().unwrap_or(""),
            l["windowEnd"].as_str().unwrap_or("")
        ),
        &["发送邮件"],
        false,
    ));
    let d = &values["delegation"];
    items.push(item("delegation","放权参数","ok",format!("某动作连续 {} 次未被实质修改、覆盖至少 {} 位达人时提议放权；自动外发前可撤回 {} 分钟。",d["streak"],d["creators"],d["undoMinutes"]),&["按动作放权"],false));
    let s = &values["sync"];
    items.push(item(
        "sync",
        "定时同步",
        "ok",
        if s["enabled"] == true {
            format!(
                "已保存每 {} 分钟同步的参数；自动调度尚未接入，目前请在办公室手动同步。",
                s["intervalMinutes"]
            )
        } else {
            "定时同步已关闭；可在办公室点击“同步邮件”手动同步。".into()
        },
        &["收件同步"],
        false,
    ));

    let state_of = |id: &str| {
        items
            .iter()
            .find(|i| i["id"] == id)
            .map(|i| i["state"] == "ok")
            .unwrap_or(false)
    };
    let feature = |ids: &[&str]| {
        let blockers: Vec<&str> = ids.iter().copied().filter(|id| !state_of(id)).collect();
        json!({"ready":blockers.is_empty(),"blockers":blockers})
    };
    let features = json!({
        "mailSync": feature(&["data", "mailLogin", "sender"]),
        "mailSend": feature(&["data", "mailLogin", "sender", "testRecipient"]),
        "selection": feature(&["data", "browser"]),
    });
    let pending = items
        .iter()
        .filter(|i| i["required"] == true && i["state"] != "ok")
        .count();
    // 只给出上次邮件同步的时间与计数，不带主题和达人名单。
    let sync = read(db.as_ref(), "mail_sync")?;
    let count = |folder: &str| {
        sync["lastResult"]["folders"][folder]["new"]
            .as_u64()
            .unwrap_or(0)
    };
    let mail_sync = if sync["lastRunAt"].is_string() {
        json!({"lastRunAt":sync["lastRunAt"],"mailbox":sync["mailbox"],"lastResult":{"imported":count("inbox")+count("sent"),"unmatched":sync["lastResult"]["unmatched"]}})
    } else {
        Value::Null
    };
    Ok(
        json!({"version":cur["version"],"updatedAt":cur["updatedAt"],"values":values,"items":items,"pending":pending,"features":features,
        "mailCheck":check,"mailTest":test,"history":history(db.as_ref()),"mailSync":mail_sync}),
    )
}

pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    match command {
        "setup-status" => status(&input, path),
        "setup-save" => save(&input, path),
        "mail-status" => {
            only_keys(&input, &[], "mail-status")?;
            mail_status(path)
        }
        "mail-test" => mail_test(&input, path),
        _ => Err("不支持的插件命令".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                env::temp_dir().join(format!("gapaw-setup-test-{}", Uuid::new_v4().simple()));
            fs::create_dir_all(&root).unwrap();
            Fixture { root }
        }
        fn db(&self) -> PathBuf {
            self.root.join("state.sqlite")
        }
        fn put(&self, key: &str, v: Value) {
            let db = open_db(&self.db(), true).unwrap().unwrap();
            write(&db, key, &v).unwrap();
        }
        fn save(&self, version: i64, values: Value) -> Result<Value> {
            save(
                &json!({"expectedVersion":version,"values":values}),
                &self.db(),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn signed_in() -> Value {
        json!({"installed":true,"login":{"state":"signed_in","canSend":true,"canRead":true},"mailboxes":[{"address":"shop@example.com"},{"address":"other@example.com"}],"message":"已登录"})
    }

    #[test]
    fn status_without_state_reports_defaults_and_pending_items() {
        let f = Fixture::new();
        let s = status(&json!({"brief":true}), &f.db()).unwrap();
        assert_eq!(s["version"], 0);
        assert_eq!(s["values"]["mode"], "test");
        assert_eq!(s["values"]["limits"]["dailySend"], 20);
        assert_eq!(s["pending"], 4);
        assert_eq!(s["features"]["mailSend"]["ready"], false);
        assert!(!f.db().exists(), "读取状态不应创建状态库");
    }
    #[test]
    fn save_is_versioned_and_rejects_stale_or_invalid_values() {
        let f = Fixture::new();
        let a = f
            .save(0, json!({"limits":{"dailySend":30},"senderName":" Gapaw "}))
            .unwrap();
        assert_eq!(a["version"], 1);
        assert_eq!(a["values"]["senderName"], "Gapaw");
        assert!(f
            .save(0, json!({"limits":{"dailySend":10}}))
            .unwrap_err()
            .contains("其他页面"));
        assert!(f
            .save(1, json!({"limits":{"dailySend":0}}))
            .unwrap_err()
            .contains("每日发送上限"));
        assert!(f
            .save(1, json!({"limits":{"windowStart":"22:00"}}))
            .unwrap_err()
            .contains("时段"));
        assert!(f
            .save(1, json!({"unknown":1}))
            .unwrap_err()
            .contains("不支持"));
        assert!(f
            .save(1, json!({"limits":{"extra":1}}))
            .unwrap_err()
            .contains("不支持"));
        let same = f.save(1, json!({"limits":{"dailySend":30}})).unwrap();
        assert_eq!(same["changed"], false);
        let s = status(&json!({"brief":true}), &f.db()).unwrap();
        assert_eq!(s["history"].as_array().unwrap().len(), 1);
        assert_eq!(s["history"][0]["changed"], json!(["limits", "senderName"]));
    }
    #[test]
    fn sender_must_come_from_checked_mailboxes() {
        let f = Fixture::new();
        assert!(f
            .save(0, json!({"senderMailbox":"shop@example.com"}))
            .unwrap_err()
            .contains("先检测"));
        f.put(MAIL_CHECK_KEY, signed_in());
        assert!(f
            .save(0, json!({"senderMailbox":"nobody@example.com"}))
            .unwrap_err()
            .contains("不在"));
        let ok = f
            .save(
                0,
                json!({"senderMailbox":"SHOP@example.com","testRecipient":"me@test.org"}),
            )
            .unwrap();
        assert_eq!(ok["values"]["senderMailbox"], "shop@example.com");
        assert!(f
            .save(1, json!({"testRecipient":"shop@example.com"}))
            .unwrap_err()
            .contains("不能与发件邮箱相同"));
        assert!(f
            .save(1, json!({"testRecipient":"bad address@x.org"}))
            .unwrap_err()
            .contains("格式"));
    }
    #[test]
    fn live_mode_needs_confirmation_and_a_passed_test_and_falls_back_on_change() {
        let f = Fixture::new();
        f.put(MAIL_CHECK_KEY, signed_in());
        f.save(
            0,
            json!({"senderMailbox":"shop@example.com","testRecipient":"me@test.org"}),
        )
        .unwrap();
        assert!(f
            .save(1, json!({"mode":"live"}))
            .unwrap_err()
            .contains("单独确认"));
        let live = |v| {
            save(
                &json!({"expectedVersion":v,"values":{"mode":"live"},"confirmLive":true}),
                &f.db(),
            )
        };
        assert!(live(1).unwrap_err().contains("收发测试"));
        f.put(
            MAIL_TEST_KEY,
            json!({"sender":"shop@example.com","recipient":"me@test.org","state":"delivered"}),
        );
        assert!(live(1).unwrap_err().contains("收发测试"));
        f.put(
            MAIL_TEST_KEY,
            json!({"sender":"shop@example.com","recipient":"me@test.org","state":"replied"}),
        );
        assert_eq!(live(1).unwrap()["values"]["mode"], "live");
        let s = status(&json!({"brief":true}), &f.db()).unwrap();
        assert_eq!(s["pending"], 1, "只剩业务数据未就绪：{s}");
        let changed = f
            .save(2, json!({"senderMailbox":"other@example.com"}))
            .unwrap();
        assert_eq!(changed["values"]["mode"], "test");
        assert!(changed["notes"][0]
            .as_str()
            .unwrap()
            .contains("退回测试模式"));
    }
    #[test]
    fn parse_json_skips_leading_hints_and_rejects_garbage() {
        assert_eq!(
            parse_json("tip: run x\n{\"ok\":true}\ntrailing").unwrap()["ok"],
            true
        );
        assert!(parse_json("no json here").is_none());
        assert!(parse_json("[1,2]").is_none());
        assert_eq!(
            error_text(&json!({"ok":false,"error":{"message":"denied"}})),
            "denied"
        );
    }
    #[test]
    fn email_and_time_validation() {
        assert!(is_email("a.b+c@example.co"));
        for bad in [
            "",
            "a@",
            "@b.c",
            "a@b",
            "a b@c.d",
            "a@b.c,d@e.f",
            "a@@b.c",
            "a@.b",
        ] {
            assert!(!is_email(bad), "{bad}");
        }
        assert!(is_hhmm("09:30") && !is_hhmm("24:00") && !is_hhmm("9:30"));
    }
}
