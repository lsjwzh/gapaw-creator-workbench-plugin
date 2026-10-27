use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;
mod bridge;
mod browser;
mod console;
mod drafts;
mod observations;
mod platform;
mod results;
mod workbench;
mod workbench_store;

const ID: &str = "gapaw-creator-workbench";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const METHOD_VERSION: &str = "roi-selection-v1";
const TEMPLATE: &str = include_str!("../resources/selection-method.md");
const BOUNDARY: &str = "\n\n【达人工作台操作边界】\n本次仅执行选人和资料核验，不发送邮件、私信、正式联盟邀请，不修改已确认的报价或合作事实。使用已确认成本与未舍入回本率，不将缺失值补零。插件支持受限页面读取及离线平台响应标准化，导入不代表实时采集、账号可读或全量已核验。来源编号保留命名空间，不能按昵称合并身份。报告和观测保存到原操作记录，不等于正式入选。工作台候选区保存是另一个明确的用户操作，未经授权不调用 adopt-result；即使候选入库且读回成功，身份、指标与费用仍待核验，不能声称已更新旧达人档案或已确认合作事实。实际连接和业务回执分别核对，依赖缺失时在原任务请求补充。宿主受理消息不等于选人完成。\n";
const RESULT_INSTRUCTIONS: &str = include_str!("../resources/result-instructions.md");
const BROWSER_INSTRUCTIONS: &str = include_str!("../resources/browser-instructions.md");
type Result<T> = std::result::Result<T, String>;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("缺少有效字段：{key}"))
}
fn identifier(v: &Value, key: &str) -> Result<String> {
    let s = required(v, key)?;
    if s.len() > 200
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
    {
        return Err(format!("{key} 格式不合法"));
    }
    Ok(s.into())
}
fn storage_path() -> Result<PathBuf> {
    if let Some(path) = env::var_os("GAPAW_CREATOR_DATA_DIR") {
        let p = PathBuf::from(path);
        if !p.is_absolute() {
            return Err("数据目录必须是绝对路径".into());
        }
        let mut existing = p.as_path();
        while !existing.exists() {
            existing = existing.parent().ok_or("数据目录路径无效")?;
        }
        let resolved = existing
            .canonicalize()
            .map_err(|e| format!("数据目录路径不可访问：{e}"))?;
        if in_worktree(&p) || in_worktree(&resolved) {
            return Err("持久数据不能保存到任务工作区".into());
        }
        return Ok(p.join("state.sqlite"));
    }
    let home = env::var_os("HOME").ok_or("无法确定用户持久数据目录")?;
    Ok(PathBuf::from(home)
        .join(".multicc/plugins-data")
        .join(ID)
        .join("state.sqlite"))
}
fn open_db(path: &Path, write: bool) -> Result<Option<Connection>> {
    if !write && !path.exists() {
        return Ok(None);
    }
    if write {
        fs::create_dir_all(path.parent().ok_or("数据路径无父目录")?)
            .map_err(|e| format!("无法创建持久数据目录：{e}"))?;
    }
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db =
        Connection::open_with_flags(path, flags).map_err(|e| format!("无法打开持久数据库：{e}"))?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    if write {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request TEXT NOT NULL,value TEXT NOT NULL,created_at TEXT NOT NULL);")
            .map_err(|e| format!("无法初始化数据结构：{e}"))?;
        results::init(&db)?;
        observations::init(&db)?;
        workbench::init(&db)?;
        drafts::init(&db)?;
    }
    Ok(Some(db))
}
fn in_worktree(p: &Path) -> bool {
    p.components()
        .any(|c| matches!(c, Component::Normal(n) if n == ".multicc-worktrees"))
}
fn protected_workspace(p: &Path, home: &Path) -> bool {
    p.parent().is_none()
        || p == home
        || [
            "Library/Application Support/Google/Chrome",
            "Library/Application Support/Chromium",
            ".config/google-chrome",
            ".config/chromium",
            ".multicc/plugins-data/chrome-proxy-launcher",
            "AppData/Local/Google/Chrome/User Data",
            "AppData/Local/Chromium/User Data",
        ]
        .iter()
        .any(|relative| p.starts_with(home.join(relative)))
}
fn check_workspace(raw: &str, probe: bool) -> Result<PathBuf> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err("专属目录必须是绝对路径".into());
    }
    let p = p
        .canonicalize()
        .map_err(|e| format!("专属目录不存在或无法访问：{e}"))?;
    if !p.is_dir() {
        return Err("专属目录不是文件夹".into());
    }
    let home = PathBuf::from(env::var_os("HOME").ok_or("无法确定用户目录")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if protected_workspace(&p, &home)
        || p.join("Local State").is_file()
        || p.join("Preferences").is_file() && p.join("History").is_file()
    {
        return Err(
            "请选择独立运营目录，不能使用根目录、整个用户目录或 Chrome 登录资料目录".into(),
        );
    }
    let forbidden = in_worktree(&p);
    if forbidden
        || [
            "/tmp",
            "/private/tmp",
            "/var/tmp",
            "/private/var/tmp",
            "/var/folders",
            "/private/var/folders",
        ]
        .iter()
        .any(|s| p.starts_with(s))
        || p.starts_with(env::temp_dir())
    {
        return Err("专属目录不能放在临时目录或任务工作区；请选择持久运营目录".into());
    }
    if probe {
        let file = p.join(format!(".gapaw-write-check-{}", Uuid::new_v4()));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .map_err(|e| format!("专属目录不可写：{e}"))?;
        let written = f.write_all(b"gapaw workspace check\n");
        drop(f);
        let removed = fs::remove_file(&file);
        written.map_err(|e| format!("专属目录写入检查失败：{e}"))?;
        removed.map_err(|e| format!("专属目录清理检查失败：{e}"))?;
    }
    Ok(p)
}
fn saved_workspace(db: Option<&Connection>) -> Result<Option<Value>> {
    let Some(db) = db else {
        return Ok(None);
    };
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='workspace'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|s| serde_json::from_str(&s).map_err(|e| format!("目录配置损坏：{e}")))
        .transpose()
}
fn effective_workspace(
    db: Option<&Connection>,
    host: Option<(String, String)>,
    probe: bool,
) -> Result<Option<Value>> {
    let mut workspace = if let Some((path, dir_id)) = host {
        Some(
            json!({"path":path,"dirId":dir_id,"revision":format!("host:{dir_id}:{path}"),"source":"host"}),
        )
    } else {
        saved_workspace(db)?
    };
    if let Some(w) = workspace.as_mut() {
        let result = (|| {
            identifier(w, "dirId")?;
            check_workspace(required(w, "path")?, probe)
        })();
        match result {
            Ok(path) => {
                w["path"] = json!(path.to_string_lossy());
                w["valid"] = json!(true);
                w["error"] = Value::Null;
            }
            Err(error) => {
                w["valid"] = json!(false);
                w["error"] = json!(error);
            }
        }
    }
    Ok(workspace)
}
fn operations(db: Option<&Connection>) -> Result<Vec<Value>> {
    let Some(db) = db else {
        return Ok(vec![]);
    };
    let mut stmt = db
        .prepare("SELECT value FROM operations ORDER BY created_at DESC,id DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        serde_json::from_str(&r.map_err(|e| e.to_string())?)
            .map_err(|e| format!("操作记录损坏：{e}"))
    })
    .collect()
}
fn runtime(input: &Value) -> Result<Value> {
    let source = input
        .get("runtime")
        .and_then(Value::as_object)
        .ok_or("请选择明确的运行环境")?;
    let cli = source
        .get("cli")
        .and_then(Value::as_str)
        .ok_or("必须明确选择 CLI，不能使用隐式默认值")?;
    if cli.is_empty()
        || cli.len() > 64
        || !cli.as_bytes()[0].is_ascii_lowercase()
        || !cli
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
    {
        return Err("CLI 标识格式不合法".into());
    }
    let mut result = Map::new();
    result.insert("cli".into(), json!(cli));
    for key in ["model", "provider", "effort"] {
        if let Some(v) = source.get(key) {
            let s = v
                .as_str()
                .filter(|s| {
                    !s.trim().is_empty() && s.len() <= 300 && !s.chars().any(char::is_control)
                })
                .ok_or_else(|| format!("运行配置 {key} 不合法"))?;
            result.insert(key.into(), json!(s));
        }
    }
    if source
        .keys()
        .any(|k| !["cli", "model", "provider", "effort"].contains(&k.as_str()))
    {
        return Err("运行配置包含不支持的字段".into());
    }
    Ok(Value::Object(result))
}
fn truncate_utf16(s: &str, max: usize) -> String {
    let mut count = 0;
    s.chars()
        .take_while(|c| {
            count += c.len_utf16();
            count <= max
        })
        .collect()
}
fn operation(db: &Connection, id: &str) -> Result<Value> {
    let raw: Option<String> = db
        .query_row("SELECT value FROM operations WHERE id=?", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&raw.ok_or("操作单不存在")?).map_err(|e| e.to_string())
}
fn save_operation(db: &Connection, op: &Value) -> Result<()> {
    db.execute(
        "UPDATE operations SET value=? WHERE id=?",
        params![op.to_string(), required(op, "id")?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn task_response(v: &Value) -> Result<Value> {
    let task_id = identifier(v, "taskId")?;
    let session_id = identifier(v, "sessionId")?;
    let shell_id = identifier(v, "shellId")?;
    let link = required(v, "url")?;
    if !link.starts_with("/air?") || link.chars().any(char::is_control) {
        return Err("任务地址必须是宿主同源的 /air 地址".into());
    }
    let parsed = url::Url::parse(&format!("https://multicc.invalid{link}"))
        .map_err(|_| "任务地址格式不合法")?;
    if parsed.host_str() != Some("multicc.invalid")
        || parsed.path() != "/air"
        || parsed
            .query_pairs()
            .filter(|(k, _)| k == "task")
            .map(|(_, v)| v.into_owned())
            .collect::<Vec<_>>()
            != vec![task_id.clone()]
    {
        return Err("任务地址与任务编号不一致".into());
    }
    Ok(json!({"taskId":task_id,"sessionId":session_id,"shellId":shell_id,"url":link}))
}

fn execute(
    command: &str,
    input: Value,
    path: &Path,
    host: Option<(String, String)>,
) -> Result<Value> {
    if input.to_string().len() > 1024 * 1024 {
        return Err("命令输入超过 1 MiB 限制".into());
    }
    if [
        "result-contract",
        "get-result",
        "submit-result",
        "validate-result",
    ]
    .contains(&command)
    {
        return results::execute(command, input, path);
    }
    if [
        "outreach-status",
        "outreach-configure",
        "outreach-creators",
        "prepare-drafts",
        "draft-context",
        "submit-drafts",
        "get-drafts",
        "adopt-draft",
        "adopt-negotiation",
    ]
    .contains(&command)
    {
        return drafts::execute(command, input, path, host);
    }
    if [
        "workbench-home",
        "workbench-creator",
        "workbench-conversations",
        "edit-draft",
    ]
    .contains(&command)
    {
        return console::execute(command, input, path);
    }
    if command == "platform-contract" {
        return platform::execute(input, path);
    }
    if [
        "workbench-status",
        "prepare-adoption",
        "adopt-result",
        "get-adoption",
        "reconcile-adoption",
        "workbench-list",
        "workbench-batch",
    ]
    .contains(&command)
    {
        return workbench::execute(command, input, path);
    }
    if [
        "observation-contract",
        "preview-observation",
        "submit-observation",
        "get-observations",
    ]
    .contains(&command)
    {
        return observations::execute(command, input, path);
    }
    if [
        "browser-status",
        "bind-browser",
        "browser-probe",
        "browser-pages",
        "browser-read-page",
    ]
    .contains(&command)
    {
        return browser::execute(command, input, path);
    }
    if command == "status" || command == "list-operations" {
        let db = open_db(path, false)?;
        let mut ops = operations(db.as_ref())?;
        results::annotate(db.as_ref(), &mut ops)?;
        if command == "list-operations" {
            return Ok(json!({"operations":ops}));
        }
        return Ok(
            json!({"plugin":{"id":ID,"version":VERSION},"workspace":effective_workspace(db.as_ref(),host,false)?,"browserBinding":browser::binding(db.as_ref())?,"template":{"version":METHOD_VERSION,"text":TEMPLATE},"operations":ops,"capabilities":{"taskDispatch":true,"platformRead":false,"browserBridge":false,"browserReadBridge":true,"reportCollection":true,"resultValidation":true,"platformContract":true,"sourceObservations":true,"workbenchCandidateClient":true,"resultWriteback":false,"draftWriteback":true}}),
        );
    }
    if ![
        "configure",
        "prepare-operation",
        "record-dispatch",
        "record-error",
    ]
    .contains(&command)
    {
        return Err("不支持的插件命令".into());
    }
    let mut db = open_db(path, true)?.ok_or("无法打开数据库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let output = match command {
        "configure" => {
            if host.is_some() {
                return Err("当前目录由 MultiCC 宿主管理，请在宿主插件设置中修改".into());
            }
            let w = input.get("workspace").ok_or("缺少专属目录配置")?;
            let dir_id = identifier(w, "dirId")?;
            let p = check_workspace(required(w, "path")?, true)?;
            let previous = saved_workspace(Some(&tx))?;
            let revision = previous
                .as_ref()
                .and_then(|v| v["revision"].as_u64())
                .unwrap_or(0)
                + 1;
            let value = json!({"dirId":dir_id,"path":p.to_string_lossy(),"revision":revision,"valid":true,"error":null,"source":"plugin"});
            tx.execute("INSERT INTO settings(key,value) VALUES('workspace',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[value.to_string()]).map_err(|e|e.to_string())?;
            json!({"workspace":value})
        }
        "prepare-operation" => {
            let request_id = identifier(&input, "requestId")?;
            let prompt = required(&input, "prompt")?.to_string();
            let rt = runtime(&input)?;
            let title = if let Some(v) = input.get("title") {
                v.as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or("任务标题无效")?
                    .to_string()
            } else {
                truncate_utf16(prompt.lines().next().unwrap_or("达人选人"), 120)
            };
            if title.encode_utf16().count() > 120 || title.chars().any(char::is_control) {
                return Err("任务标题必须为不超过 120 字的单行文本".into());
            }
            let request = json!({"prompt":prompt,"runtime":rt,"title":title});
            let previous: Option<(String, String)> = tx
                .query_row(
                    "SELECT request,value FROM operations WHERE request_id=?",
                    [&request_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((old, op)) = previous {
                if serde_json::from_str::<Value>(&old).map_err(|e| e.to_string())? != request {
                    return Err("同一请求编号不能更改提示词、标题或运行配置，请新建任务".into());
                }
                json!({"operation":serde_json::from_str::<Value>(&op).map_err(|e|e.to_string())?})
            } else {
                let w =
                    effective_workspace(Some(&tx), host, true)?.ok_or("请先设置插件专属目录")?;
                if w["valid"] != true {
                    return Err(w["error"].as_str().unwrap_or("专属目录无效").into());
                }
                let id = format!("op_{}", Uuid::new_v4().simple());
                let browser = browser::binding(Some(&tx))?;
                let message = format!(
                    "{}{}\n【方法版本：{}】\n{}\n【工作台操作编号：{}】\n{}\n{}",
                    prompt,
                    BOUNDARY,
                    METHOD_VERSION,
                    TEMPLATE,
                    id,
                    RESULT_INSTRUCTIONS.replace("{{OPERATION_ID}}", &id),
                    BROWSER_INSTRUCTIONS
                        .replace("{{OPERATION_ID}}", &id)
                        .replace("{{BROWSER_BINDING}}", &browser.to_string())
                );
                if message.encode_utf16().count() > 32000 {
                    return Err(
                        "提示词连同方法与边界说明超过宿主 32000 字限制，请缩短后再发送".into(),
                    );
                }
                let mut create = rt.clone();
                create["dirId"] = w["dirId"].clone();
                create["title"] = json!(title);
                create["clientMsgId"] = json!(format!("{id}_create"));
                let created = now();
                let op = json!({"id":id,"requestId":request_id,"status":"prepared","task":null,"receipt":null,"error":null,"workspace":w,"browser":browser,"prompt":prompt,"runtime":rt,"methodVersion":METHOD_VERSION,"createdAt":created,"dispatch":{"create":create,"message":{"clientMsgId":format!("{id}_message"),"text":message,"intent":"work","lang":"zh"}}});
                tx.execute("INSERT INTO operations(id,request_id,request,value,created_at) VALUES(?,?,?,?,?)",params![id,request_id,request.to_string(),op.to_string(),created]).map_err(|e|e.to_string())?;
                json!({"operation":op})
            }
        }
        "record-dispatch" => {
            let id = identifier(&input, "operationId")?;
            let stage = required(&input, "stage")?;
            let response = input.get("response").ok_or("缺少真实宿主回执")?;
            let mut op = operation(&tx, &id)?;
            match stage {
                "created" => {
                    let task = task_response(response)?;
                    if !op["task"].is_null() && op["task"] != task {
                        return Err("操作已绑定另一份宿主任务回执，不允许替换".into());
                    }
                    if op["task"].is_null() {
                        op["task"] = task;
                        op["status"] = json!("task_created");
                        op["error"] = Value::Null;
                    }
                }
                "sent" => {
                    let task_id = identifier(response, "taskId")?;
                    let receipt_id = identifier(response, "receiptId")?;
                    if op["task"]["taskId"].as_str() != Some(&task_id) {
                        return Err("消息回执不属于本操作的任务，或尚未记录任务创建回执".into());
                    }
                    let receipt = json!({"taskId":task_id,"receiptId":receipt_id});
                    if !op["receipt"].is_null() && op["receipt"] != receipt {
                        return Err("消息已保存不同回执，不允许替换".into());
                    }
                    op["receipt"] = receipt;
                    op["status"] = json!("accepted");
                    op["error"] = Value::Null;
                }
                _ => return Err("不支持的投递阶段".into()),
            }
            save_operation(&tx, &op)?;
            json!({"operation":op})
        }
        "record-error" => {
            let id = identifier(&input, "operationId")?;
            let stage = required(&input, "stage")?;
            let message = required(&input, "message")?;
            if !["create", "message"].contains(&stage) {
                return Err("不支持的错误阶段".into());
            }
            let mut op = operation(&tx, &id)?;
            let has_receipt = ["receiptId", "taskId", "notDelivered"]
                .iter()
                .any(|key| input.get(key).is_some());
            let failed_receipt = if has_receipt {
                if stage != "message" {
                    return Err("只有消息阶段错误可以保存宿主回执".into());
                }
                let receipt_id = identifier(&input, "receiptId")?;
                let task_id = identifier(&input, "taskId")?;
                let not_delivered = input
                    .get("notDelivered")
                    .and_then(Value::as_bool)
                    .ok_or("失败回执的 notDelivered 必须为布尔值")?;
                if op["task"]["taskId"].as_str() != Some(&task_id) {
                    return Err("失败回执不属于本操作已绑定的任务".into());
                }
                Some(json!({"receiptId":receipt_id,"taskId":task_id,"notDelivered":not_delivered}))
            } else {
                None
            };
            if op["status"] != "accepted" {
                if stage == "create" && !op["task"].is_null() {
                    return Err("已创建任务不能退回创建失败".into());
                }
                if stage == "message" && op["task"].is_null() {
                    return Err("尚未创建任务，不能记录消息阶段错误".into());
                }
                op["status"] = json!(if stage == "create" {
                    "create_failed"
                } else {
                    "delivery_failed"
                });
                let mut error =
                    json!({"stage":stage,"message":truncate_utf16(message,2000),"at":now()});
                let receipt_source = failed_receipt.as_ref().unwrap_or(&op["error"]);
                if stage == "message" && !receipt_source["receiptId"].is_null() {
                    for key in ["receiptId", "taskId", "notDelivered"] {
                        error[key] = receipt_source[key].clone();
                    }
                }
                op["error"] = error;
                save_operation(&tx, &op)?;
            }
            json!({"operation":op})
        }
        _ => unreachable!(),
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(output)
}

fn main() {
    let result = (|| {
        let command = env::args().nth(1).ok_or("缺少插件命令")?;
        let mut input = String::new();
        std::io::stdin()
            .take(1048577)
            .read_to_string(&mut input)
            .map_err(|e| format!("无法读取输入：{e}"))?;
        if input.len() > 1048576 {
            return Err("命令输入超过限制".into());
        }
        let input = if input.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&input).map_err(|e| format!("输入不是合法 JSON：{e}"))?
        };
        if !input.is_object() {
            return Err("命令输入必须是 JSON 对象".into());
        }
        if command == "workbench-provider" {
            return workbench_store::execute(input);
        }
        let workspace = env::var("MULTICC_PLUGIN_WORKSPACE").ok();
        let dir_id = env::var("MULTICC_PLUGIN_DIR_ID").ok();
        let host = match (workspace, dir_id) {
            (None, None) => None,
            (a, b) => Some((a.unwrap_or_default(), b.unwrap_or_default())),
        };
        execute(&command, input, &storage_path()?, host)
    })();
    let response = match result {
        Ok(data) => json!({"ok":true,"data":data}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    println!("{response}");
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        workspace: PathBuf,
        other: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let id = Uuid::new_v4().simple().to_string();
            let root = env::temp_dir().join(format!("gapaw-core-test-{id}"));
            let workspace =
                PathBuf::from(env::var_os("HOME").unwrap()).join(format!(".gapaw-core-test-{id}"));
            let other = workspace.join("other");
            fs::create_dir_all(&other).unwrap();
            Self {
                root,
                workspace,
                other,
            }
        }
        fn db(&self) -> PathBuf {
            self.root.join("state.sqlite")
        }
        fn run(&self, cmd: &str, input: Value) -> Result<Value> {
            execute(cmd, input, &self.db(), None)
        }
        fn configure(&self) {
            self.run(
                "configure",
                json!({"workspace":{"dirId":"dir_one","path":self.workspace}}),
            )
            .unwrap();
        }
        fn prepare(&self, request: &str) -> Value {
            self.run("prepare-operation",json!({"requestId":request,"prompt":"请按已确认成本选人","runtime":{"cli":"codex","model":"test-model"}})).unwrap()["operation"].clone()
        }
        fn create(&self, op: &Value) -> Value {
            self.run("record-dispatch",json!({"operationId":op["id"],"stage":"created","response":{"taskId":"tsk_one","sessionId":"session_one","shellId":"shell_one","url":"/air?task=tsk_one&dir=dir_one"}})).unwrap()["operation"].clone()
        }
        fn sent(&self, op: &Value) -> Value {
            self.run("record-dispatch",json!({"operationId":op["id"],"stage":"sent","response":{"taskId":"tsk_one","receiptId":"receipt_one"}})).unwrap()["operation"].clone()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
            let _ = fs::remove_dir_all(&self.workspace);
        }
    }

    #[test]
    fn status_without_state_has_no_filesystem_side_effects() {
        let f = Fixture::new();
        let status = f.run("status", json!({})).unwrap();
        assert!(status["workspace"].is_null());
        assert_eq!(status["capabilities"]["platformRead"], false);
        assert!(status["operations"].as_array().unwrap().is_empty());
        assert!(!f.root.exists());
        assert_eq!(
            f.run("list-operations", json!({})).unwrap()["operations"],
            json!([])
        );
        assert!(!f.root.exists());
    }
    #[test]
    fn dedicated_workspace_rejects_temp_and_worktree_paths() {
        let f = Fixture::new();
        fs::create_dir_all(&f.root).unwrap();
        assert!(f
            .run(
                "configure",
                json!({"workspace":{"dirId":"dir_one","path":f.root}})
            )
            .is_err());
        let p = f.workspace.join(".multicc-worktrees/task");
        fs::create_dir_all(&p).unwrap();
        assert!(f
            .run(
                "configure",
                json!({"workspace":{"dirId":"dir_one","path":p}})
            )
            .is_err());
        assert!(f
            .run(
                "configure",
                json!({"workspace":{"dirId":"dir_one","path":"relative"}})
            )
            .is_err());
        assert!(check_workspace("/", false).is_err());
        assert!(check_workspace(&env::var("HOME").unwrap(), false).is_err());
        let home = PathBuf::from(env::var("HOME").unwrap());
        assert!(protected_workspace(
            &home.join(".multicc/plugins-data/chrome-proxy-launcher/chrome-profiles/example"),
            &home
        ));
        assert!(protected_workspace(
            &home.join("Library/Application Support/Google/Chrome/Default"),
            &home
        ));
        let browser = f.workspace.join("browser");
        fs::create_dir(&browser).unwrap();
        fs::write(browser.join("Local State"), "{}").unwrap();
        assert!(check_workspace(browser.to_str().unwrap(), true).is_err());
        #[cfg(unix)]
        {
            let link = f.workspace.join("temporary-link");
            std::os::unix::fs::symlink(&f.root, &link).unwrap();
            assert!(f
                .run(
                    "configure",
                    json!({"workspace":{"dirId":"dir_one","path":link}})
                )
                .is_err());
        }
    }
    #[test]
    fn explicit_runtime_and_binding_are_required() {
        let f = Fixture::new();
        assert!(f
            .run(
                "prepare-operation",
                json!({"requestId":"r1","prompt":"选人","runtime":{"cli":"codex"}})
            )
            .is_err());
        f.configure();
        for runtime in [
            json!({}),
            json!({"cli":""}),
            json!({"cli":"codex; rm"}),
            json!({"cli":"codex","unsafe":true}),
        ] {
            assert!(f
                .run(
                    "prepare-operation",
                    json!({"requestId":"r1","prompt":"选人","runtime":runtime})
                )
                .is_err());
        }
    }
    #[test]
    fn requests_freeze_payload_and_reject_changed_content() {
        let f = Fixture::new();
        f.configure();
        let first = f.prepare("same");
        assert_eq!(first, f.prepare("same"));
        assert!(f.run("prepare-operation",json!({"requestId":"same","prompt":"改条件","runtime":{"cli":"codex","model":"test-model"}})).is_err());
        assert_ne!(
            first["dispatch"]["create"]["clientMsgId"],
            first["dispatch"]["message"]["clientMsgId"]
        );
        assert!(first["dispatch"]["message"]["text"]
            .as_str()
            .unwrap()
            .contains("不发送邮件"));
        assert_eq!(
            f.run("list-operations", json!({})).unwrap()["operations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn directory_switch_changes_only_new_operations() {
        let f = Fixture::new();
        f.configure();
        let old = f.prepare("old");
        f.run(
            "configure",
            json!({"workspace":{"dirId":"dir_two","path":f.other}}),
        )
        .unwrap();
        assert_eq!(old, f.prepare("old"));
        let new = f.prepare("new");
        assert_eq!(new["workspace"]["dirId"], "dir_two");
        assert_eq!(old["dispatch"]["create"]["dirId"], "dir_one");
    }
    #[test]
    fn host_binding_takes_priority_and_invalid_binding_does_not_fallback() {
        let f = Fixture::new();
        f.configure();
        let host = Some((f.other.to_string_lossy().into_owned(), "host_dir".into()));
        let status = execute("status", json!({}), &f.db(), host.clone()).unwrap();
        assert_eq!(status["workspace"]["dirId"], "host_dir");
        assert_eq!(status["workspace"]["source"], "host");
        assert!(execute(
            "configure",
            json!({"workspace":{"dirId":"new","path":f.workspace}}),
            &f.db(),
            host
        )
        .is_err());
        let invalid = Some((f.other.to_string_lossy().into_owned(), "".into()));
        assert_eq!(
            execute("status", json!({}), &f.db(), invalid.clone()).unwrap()["workspace"]["valid"],
            false
        );
        assert!(execute(
            "prepare-operation",
            json!({"requestId":"r","prompt":"选人","runtime":{"cli":"codex"}}),
            &f.db(),
            invalid
        )
        .is_err());
    }
    #[test]
    fn two_stage_dispatch_is_idempotent_and_does_not_claim_completion() {
        let f = Fixture::new();
        f.configure();
        let prepared = f.prepare("dispatch");
        assert_eq!(prepared["status"], "prepared");
        let created = f.create(&prepared);
        assert_eq!(created["status"], "task_created");
        assert_eq!(created, f.create(&prepared));
        let failed = f
            .run(
                "record-error",
                json!({"operationId":created["id"],"stage":"message","message":"暂时不可用"}),
            )
            .unwrap()["operation"]
            .clone();
        assert_eq!(failed["status"], "delivery_failed");
        assert_eq!(failed["task"], created["task"]);
        assert_eq!(failed["dispatch"], prepared["dispatch"]);
        let accepted = f.sent(&failed);
        assert_eq!(accepted["status"], "accepted");
        assert_eq!(accepted, f.sent(&failed));
        assert_eq!(accepted, f.create(&prepared));
        let after = f
            .run(
                "record-error",
                json!({"operationId":created["id"],"stage":"message","message":"迟到的失败"}),
            )
            .unwrap()["operation"]
            .clone();
        assert_eq!(accepted, after);
    }
    #[test]
    fn conflicting_task_or_receipt_is_rejected() {
        let f = Fixture::new();
        f.configure();
        let op = f.prepare("receipts");
        assert!(f.run("record-dispatch",json!({"operationId":op["id"],"stage":"sent","response":{"taskId":"tsk_one","receiptId":"receipt_one"}})).is_err());
        for url in [
            "https://evil.invalid/air?task=tsk_one",
            "//evil.invalid/air?task=tsk_one",
            "/air?task=wrong",
            "/air?task=tsk_one&task=tsk_one",
        ] {
            assert!(f.run("record-dispatch",json!({"operationId":op["id"],"stage":"created","response":{"taskId":"tsk_one","sessionId":"s","shellId":"sh","url":url}})).is_err());
        }
        f.create(&op);
        assert!(f.run("record-dispatch",json!({"operationId":op["id"],"stage":"created","response":{"taskId":"tsk_two","sessionId":"s","shellId":"sh","url":"/air?task=tsk_two"}})).is_err());
        assert!(f
            .run(
                "record-error",
                json!({"operationId":op["id"],"stage":"create","message":"旧请求失败"})
            )
            .is_err());
        f.sent(&op);
        assert!(f.run("record-dispatch",json!({"operationId":op["id"],"stage":"sent","response":{"taskId":"tsk_one","receiptId":"receipt_two"}})).is_err());
    }
    #[test]
    fn failed_receipt_survives_transport_errors_and_duplicate_creation_ack() {
        let f = Fixture::new();
        f.configure();
        let prepared = f.prepare("failed-receipt");
        let created = f.create(&prepared);
        let failed = f.run("record-error",json!({"operationId":created["id"],"stage":"message","message":"宿主未投递","taskId":"tsk_one","receiptId":"failed_receipt","notDelivered":true})).unwrap()["operation"].clone();
        assert_eq!(failed["error"]["receiptId"], "failed_receipt");
        assert_eq!(failed["error"]["taskId"], "tsk_one");
        assert_eq!(failed["error"]["notDelivered"], true);
        assert_eq!(failed, f.create(&prepared));
        let network_error = f
            .run(
                "record-error",
                json!({"operationId":created["id"],"stage":"message","message":"重试请求超时"}),
            )
            .unwrap()["operation"]
            .clone();
        assert_eq!(network_error["error"]["receiptId"], "failed_receipt");
        assert_eq!(network_error["error"]["notDelivered"], true);
        assert_eq!(network_error["dispatch"], prepared["dispatch"]);
        let listed = f.run("list-operations", json!({})).unwrap();
        assert_eq!(
            listed["operations"][0]["error"]["receiptId"],
            "failed_receipt"
        );
        let accepted = f.sent(&network_error);
        let late = f.run("record-error",json!({"operationId":created["id"],"stage":"message","message":"迟到的失败回执","taskId":"tsk_one","receiptId":"failed_receipt","notDelivered":true})).unwrap()["operation"].clone();
        assert_eq!(late, accepted);
    }
    #[test]
    fn failed_receipt_requires_complete_typed_and_matching_fields() {
        let f = Fixture::new();
        f.configure();
        let op = f.prepare("strict-failed-receipt");
        let fields = json!({"operationId":op["id"],"stage":"message","message":"投递失败","taskId":"tsk_one","receiptId":"failed_receipt","notDelivered":true});
        assert!(f.run("record-error", fields.clone()).is_err());
        f.create(&op);
        for key in ["receiptId", "taskId", "notDelivered"] {
            let mut missing = fields.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(f.run("record-error", missing).is_err());
        }
        for (key, value) in [
            ("stage", json!("create")),
            ("receiptId", json!("invalid receipt")),
            ("taskId", json!("other_task")),
            ("notDelivered", json!("true")),
            ("notDelivered", Value::Null),
        ] {
            let mut bad = fields.clone();
            bad[key] = value;
            assert!(f.run("record-error", bad).is_err());
        }
        let mut uncertain = fields;
        uncertain["notDelivered"] = json!(false);
        assert_eq!(
            f.run("record-error", uncertain).unwrap()["operation"]["error"]["notDelivered"],
            false
        );
    }
    #[test]
    fn utf16_limits_include_frozen_method_and_boundary() {
        let f = Fixture::new();
        f.configure();
        let prompt = "😀".repeat(16000);
        assert!(f
            .run(
                "prepare-operation",
                json!({"requestId":"long","prompt":prompt,"runtime":{"cli":"codex"}})
            )
            .is_err());
        assert!(f.run("prepare-operation",json!({"requestId":"title","prompt":"选人","title":"😀".repeat(61),"runtime":{"cli":"codex"}})).is_err());
        let short = f
            .run(
                "prepare-operation",
                json!({"requestId":"short","prompt":"😀".repeat(100),"runtime":{"cli":"codex"}}),
            )
            .unwrap();
        assert_eq!(
            short["operation"]["dispatch"]["create"]["title"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            120
        );
    }
    #[test]
    fn concurrent_requests_share_one_persisted_operation() {
        let f = Fixture::new();
        f.configure();
        let mut threads = vec![];
        for _ in 0..6 {
            let db = f.db();
            threads.push(std::thread::spawn(move || {
                execute(
                    "prepare-operation",
                    json!({"requestId":"concurrent","prompt":"选人","runtime":{"cli":"codex"}}),
                    &db,
                    None,
                )
                .unwrap()["operation"]["id"]
                    .clone()
            }));
        }
        let ids: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(
            f.run("list-operations", json!({})).unwrap()["operations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
