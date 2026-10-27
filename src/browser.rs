//! Chrome 1.5 内部存储的只读适配。绝不执行来源插件或打开浏览器资料库。
use super::{identifier, now, open_db, operation, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env, fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const SOURCE_ID: &str = "chrome-proxy-launcher";
const MAX_FILE: usize = 4 * 1024 * 1024;
#[derive(Clone)]
struct SourcePaths {
    plugin: Option<PathBuf>,
    data: Option<PathBuf>,
}
impl SourcePaths {
    fn current() -> Self {
        let plugin = env::var_os("GAPAW_CHROME_PLUGIN_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                let executable = env::current_exe().ok()?;
                for parent in executable.ancestors().skip(1).take(4) {
                    let manifest = read_json(&parent.join("plugin.json"), 65536).ok();
                    if manifest.as_ref().is_some_and(|m| m["id"] == super::ID) {
                        return parent.parent().map(|p| p.join(SOURCE_ID));
                    }
                }
                None
            });
        let data = env::var_os("GAPAW_CHROME_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("HOME").map(|h| {
                    PathBuf::from(h)
                        .join(".multicc/plugins-data")
                        .join(SOURCE_ID)
                })
            });
        Self { plugin, data }
    }
}
fn read_bytes(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "来源文件不存在或不可读取")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit as u64 {
        return Err("来源文件类型或大小不支持".into());
    }
    let mut bytes = vec![];
    fs::File::open(path)
        .map_err(|_| "来源文件不可读取")?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "来源文件读取失败")?;
    if bytes.len() > limit {
        return Err("来源文件超过读取上限".into());
    }
    Ok(bytes)
}
fn read_json(path: &Path, limit: usize) -> Result<Value> {
    serde_json::from_slice(&read_bytes(path, limit)?)
        .map_err(|_| "来源数据格式无效，无法核查".into())
}
fn safe_id(v: &Value) -> Result<&str> {
    let id = v.as_str().ok_or("身份编号格式无效")?;
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || id.starts_with('-')
        || id.ends_with('-')
    {
        return Err("身份编号格式无效".into());
    }
    Ok(id)
}
fn safe_name(v: &Value) -> Result<&str> {
    v.as_str()
        .filter(|s| {
            !s.trim().is_empty() && s.chars().count() <= 200 && !s.chars().any(char::is_control)
        })
        .ok_or("身份名称格式无效".into())
}
fn number(v: &Value, key: &str) -> Result<i64> {
    match v.get(key) {
        None => Ok(0),
        Some(n) => n
            .as_i64()
            .filter(|n| *n >= 0)
            .ok_or("来源时间元数据格式无效".into()),
    }
}
fn known_keys(v: &Value, keys: &[&str]) -> Result<()> {
    let object = v.as_object().ok_or("来源结构无效")?;
    if object.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("来源数据结构不受当前适配器支持".into());
    }
    Ok(())
}
fn optional_text(v: &Value, key: &str, nullable: bool) -> Result<()> {
    if v.get(key)
        .is_some_and(|item| !item.is_string() && !(nullable && item.is_null()))
    {
        return Err("来源字段类型不受支持".into());
    }
    Ok(())
}
fn proxy_shape(v: Option<&Value>) -> Result<()> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(());
    };
    known_keys(v, &["scheme", "host", "port", "username", "password"])?;
    if !v["scheme"]
        .as_str()
        .is_some_and(|s| ["http", "https", "socks5"].contains(&s))
        || v["host"].as_str().is_none_or(|s| s.is_empty())
        || v["port"].as_u64().is_none_or(|p| p == 0 || p > 65535)
    {
        return Err("来源出口字段结构无效".into());
    }
    optional_text(v, "username", true)?;
    optional_text(v, "password", true)
}
fn relative_path(raw: &str) -> Option<PathBuf> {
    let p = Path::new(raw);
    if raw.is_empty()
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        None
    } else {
        Some(p.into())
    }
}
fn ordinary_binary(root: &Path, relative: &Path) -> bool {
    let path = root.join(relative);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return false;
    };
    if !meta.is_file() || meta.file_type().is_symlink() {
        return false;
    }
    let (Ok(base), Ok(actual)) = (root.canonicalize(), path.canonicalize()) else {
        return false;
    };
    if !actual.starts_with(base) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}
fn executable_present(root: &Path, manifest: &Value) -> bool {
    let Some(raw) = manifest["engine"]["binary"].as_str() else {
        return false;
    };
    let Some(binary) = relative_path(raw) else {
        return false;
    };
    let os = match env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    if let Some(dir) = manifest["engine"]["binaryPlatformDir"]
        .as_str()
        .and_then(relative_path)
    {
        if let Some(name) = binary.file_name() {
            if ordinary_binary(root, &dir.join(format!("{os}-{arch}")).join(name)) {
                return true;
            }
        }
    }
    ordinary_binary(root, &binary)
}
fn process_state(root: &Path, id: &str) -> &'static str {
    let file = root.join("run").join(format!("{id}.pid"));
    if !file.exists() {
        return "not_running";
    }
    let (Ok(base), Ok(actual)) = (root.canonicalize(), file.canonicalize()) else {
        return "unknown";
    };
    if !actual.starts_with(base) {
        return "unknown";
    }
    let Ok(bytes) = read_bytes(&file, 32) else {
        return "unknown";
    };
    let Some(pid) = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok())
        .filter(|p| *p > 1)
    else {
        return "unknown";
    };
    #[cfg(unix)]
    {
        let code = unsafe { libc::kill(pid, 0) };
        if code == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) {
            "pid_alive"
        } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            "not_running"
        } else {
            "unknown"
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        "unknown"
    }
}
fn catalog(paths: &SourcePaths) -> (Value, Vec<Value>) {
    let mut source = json!({"installed":false,"version":null,"supported":false,"available":false,"message":"未找到 Chrome 出口隔离插件"});
    let outcome = (|| -> Result<Vec<Value>> {
        let root = paths
            .plugin
            .as_ref()
            .filter(|p| p.is_absolute() && p.is_dir())
            .ok_or("未找到 Chrome 出口隔离插件")?;
        source["installed"] = json!(true);
        let manifest = read_json(&root.join("plugin.json"), 65536)?;
        let version = manifest["version"].as_str().ok_or("来源插件版本格式无效")?;
        if version.len() > 30 {
            return Err("来源插件版本格式无效".into());
        }
        let parts: Vec<_> = version.split('.').collect();
        if parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        {
            source["version"] = json!(version);
        }
        if parts.len() != 3
            || parts[0] != "1"
            || parts[1] != "5"
            || parts[2].is_empty()
            || !parts[2].bytes().all(|b| b.is_ascii_digit())
        {
            return Err("当前只读适配器仅支持 Chrome 插件 1.5.x".into());
        }
        source["version"] = json!(version);
        if manifest["id"] != SOURCE_ID || manifest["engine"]["type"] != "command" {
            return Err("来源插件清单不受支持".into());
        }
        source["supported"] = json!(true);
        source["readOnlyBridge"] =
            json!(manifest["readOnlyBridge"]["protocol"] == super::bridge::PROTOCOL);
        if !executable_present(root, &manifest) {
            return Err("来源插件缺少可用的本平台程序文件".into());
        }
        let data = paths
            .data
            .as_ref()
            .filter(|p| p.is_absolute())
            .ok_or("无法确定来源身份存储")?;
        let profile_path = data.join("profiles.json");
        let profile_bytes = read_bytes(&profile_path, MAX_FILE)?;
        let profiles: Value =
            serde_json::from_slice(&profile_bytes).map_err(|_| "身份清单格式无效，无法核查")?;
        let profiles = profiles
            .as_array()
            .filter(|p| p.len() <= 500)
            .ok_or("身份清单结构无效或超过 500 项")?;
        let needs_subs = profiles
            .iter()
            .any(|p| p.get("subscription").is_some_and(|s| !s.is_null()));
        let subscription_path = data.join("subscriptions.json");
        let subscription_bytes = if needs_subs {
            Some(read_bytes(&subscription_path, MAX_FILE)?)
        } else {
            None
        };
        let subscriptions: Value = if let Some(bytes) = &subscription_bytes {
            serde_json::from_slice(bytes).map_err(|_| "订阅元数据格式无效，无法核查")?
        } else {
            json!([])
        };
        let subscriptions = subscriptions
            .as_array()
            .filter(|s| s.len() <= 500)
            .ok_or("订阅元数据结构无效或超过上限")?;
        let mut sub_ids = HashSet::new();
        for sub in subscriptions {
            known_keys(
                sub,
                &[
                    "id",
                    "name",
                    "url",
                    "updatedAt",
                    "nodes",
                    "traffic",
                    "sourceBytes",
                ],
            )?;
            let id = safe_id(&sub["id"])?;
            if !sub_ids.insert(id) {
                return Err("订阅元数据身份重复".into());
            }
            number(sub, "updatedAt")?;
            if !sub["name"].is_string() || !sub["url"].is_string() {
                return Err("订阅元数据结构无效".into());
            }
            optional_text(sub, "traffic", true)?;
            if sub.get("nodes").is_some_and(|v| {
                v.as_array()
                    .is_none_or(|a| a.iter().any(|n| !n.is_string()))
            }) {
                return Err("订阅元数据结构无效".into());
            }
            if sub.get("sourceBytes").is_some_and(|n| n.as_u64().is_none()) {
                return Err("订阅元数据格式无效".into());
            }
        }
        let mut ids = HashSet::new();
        let mut environments = vec![];
        for profile in profiles {
            known_keys(
                profile,
                &[
                    "id",
                    "name",
                    "proxy",
                    "subscription",
                    "note",
                    "chromePath",
                    "createdAt",
                    "updatedAt",
                ],
            )?;
            let id = safe_id(&profile["id"])?;
            if !ids.insert(id) {
                return Err("身份清单包含重复编号".into());
            }
            let name = safe_name(&profile["name"])?;
            optional_text(profile, "note", false)?;
            optional_text(profile, "chromePath", true)?;
            proxy_shape(profile.get("proxy"))?;
            let sub = if let Some(s) = profile.get("subscription").filter(|s| !s.is_null()) {
                known_keys(s, &["id", "node", "via"])?;
                optional_text(s, "node", false)?;
                proxy_shape(s.get("via"))?;
                let sub_id = safe_id(&s["id"])?;
                let found = subscriptions
                    .iter()
                    .find(|sub| sub["id"] == sub_id)
                    .ok_or("身份引用的订阅已缺失，无法核查")?;
                json!({"id":sub_id,"updatedAt":number(found,"updatedAt")?,"sourceBytes":found.get("sourceBytes").and_then(Value::as_u64).unwrap_or(0)})
            } else {
                Value::Null
            };
            let revision = json!({"profileCreatedAt":number(profile,"createdAt")?,"profileUpdatedAt":number(profile,"updatedAt")?,"subscription":sub,"confidence":"metadata_only"});
            environments.push(json!({"id":id,"name":name,"sourceRevision":revision,"processState":process_state(data,id)}));
        }
        if read_bytes(&profile_path, MAX_FILE)? != profile_bytes
            || subscription_bytes
                .as_ref()
                .is_some_and(|old| read_bytes(&subscription_path, MAX_FILE).as_ref() != Ok(old))
        {
            return Err("来源配置在读取期间变化，请刷新重试".into());
        }
        Ok(environments)
    })();
    match outcome {
        Ok(environments) => {
            source["available"] = json!(true);
            source["message"] = json!(
                "已只读核查 1.5 内部清单；元数据版本不是完整配置指纹，跨文件快照不保证原子一致"
            );
            (source, environments)
        }
        Err(message) => {
            source["message"] = json!(message);
            (source, vec![])
        }
    }
}
fn empty_binding() -> Value {
    json!({"revision":0,"profile":null,"configuredAt":null})
}
fn sanitize_binding(v: &Value) -> Result<Value> {
    let revision = v["revision"].as_u64().ok_or("浏览器绑定记录损坏")?;
    let configured = v.get("configuredAt").cloned().ok_or("浏览器绑定记录损坏")?;
    if !configured.is_null() && configured.as_str().is_none() {
        return Err("浏览器绑定记录损坏".into());
    }
    let profile = if v["profile"].is_null() {
        Value::Null
    } else {
        let p = &v["profile"];
        let id = safe_id(&p["id"])?;
        let name = safe_name(&p["name"])?;
        let r = &p["sourceRevision"];
        known_keys(
            r,
            &[
                "profileCreatedAt",
                "profileUpdatedAt",
                "subscription",
                "confidence",
            ],
        )?;
        if r["confidence"] != "metadata_only" {
            return Err("浏览器绑定版本记录损坏".into());
        }
        let subscription = if r["subscription"].is_null() {
            Value::Null
        } else {
            let s = &r["subscription"];
            json!({"id":safe_id(&s["id"])?,"updatedAt":number(s,"updatedAt")?,"sourceBytes":s["sourceBytes"].as_u64().ok_or("浏览器绑定版本记录损坏")?})
        };
        json!({"id":id,"name":name,"sourceRevision":{"profileCreatedAt":number(r,"profileCreatedAt")?,"profileUpdatedAt":number(r,"profileUpdatedAt")?,"subscription":subscription,"confidence":"metadata_only"}})
    };
    Ok(json!({"revision":revision,"profile":profile,"configuredAt":configured}))
}
pub fn binding(db: Option<&Connection>) -> Result<Value> {
    let Some(db) = db else {
        return Ok(empty_binding());
    };
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='browser_binding'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "无法读取浏览器绑定")?;
    match raw {
        None => Ok(empty_binding()),
        Some(raw) => sanitize_binding(
            &serde_json::from_str::<Value>(&raw).map_err(|_| "浏览器绑定记录损坏")?,
        ),
    }
}
fn status(paths: &SourcePaths, db: Option<&Connection>, input: &Value) -> Result<Value> {
    let (bound, legacy, scope) = if input.get("operationId").is_some() {
        let id = identifier(input, "operationId")?;
        let db = db.ok_or("操作单不存在")?;
        let op = operation(db, &id)?;
        match op.get("browser") {
            Some(v) => (sanitize_binding(v)?, false, "operation"),
            None => (empty_binding(), true, "operation"),
        }
    } else {
        (binding(db)?, false, "default")
    };
    let (source, environments) = catalog(paths);
    let selected = environments
        .iter()
        .find(|e| e["id"] == bound["profile"]["id"]);
    let state = if legacy {
        "legacy_unbound"
    } else if source["available"] != true {
        "unavailable"
    } else if bound["profile"].is_null() {
        "unbound"
    } else if selected.is_none() {
        "missing"
    } else if selected.unwrap()["sourceRevision"] != bound["profile"]["sourceRevision"] {
        "changed"
    } else {
        "bound"
    };
    let process = selected
        .and_then(|e| e["processState"].as_str())
        .unwrap_or("unknown");
    let checks = json!([
        {"id":"source","label":"Chrome 出口隔离插件","status":if source["available"]==true{"passed"}else{"blocked"},"message":source["message"]},
        {"id":"binding","label":"本次专用环境绑定","status":if state=="bound"{"passed"}else{"blocked"},"message":match state{"bound"=>"身份存在且版本元数据与绑定一致；不证明代理或账号状态","unbound"=>"尚未绑定专用身份","legacy_unbound"=>"旧任务没有冻结浏览器身份，不能套用当前默认绑定","missing"=>"绑定身份已从来源清单删除","changed"=>"来源配置元数据已变化，需要重新确认",_=>"来源暂不可核查，保留原绑定"}},
        {"id":"process","label":"进程存活线索","status":if process=="pid_alive"{"info"}else{"unknown"},"message":match process{"pid_alive"=>"记录的 PID 存活，未核对 Chrome 身份、登录或出口","not_running"=>"没有运行记录或记录的进程已退出；不代表已检查浏览器身份",_=>"无法确认记录的进程状态"}},
        {"id":"egress","label":"网络出口","status":"not_checked","message":"本插件不运行网络探针，未核查出口；不承诺全流量断网保护"},
        {"id":"bridge","label":"浏览器只读桥接","status":if source["available"] != true {"blocked"} else if source["readOnlyBridge"] == true {"probe_available"} else {"requires_upgrade"},"message":if source["readOnlyBridge"] == true {"来源声明只读桥接，可手动探测；本次仅检查文件，未连接浏览器"} else {"来源未声明只读桥接协议，需要配套升级；不会打开浏览器或回退控制通道"}},
        {"id":"affiliate","label":"TikTok Affiliate 数据读取","status":"not_checked","message":"尚无读取适配器，未核验登录、权限和本次所需字段"},
        {"id":"kalodata","label":"Kalodata 数据读取","status":"not_checked","message":"尚无读取适配器，未核验登录、权限和本次所需字段"}
    ]);
    let requirements = [
        (
            "identity",
            "达人和视频稳定身份",
            "TikTok Affiliate / Kalodata",
        ),
        ("period", "统计区间、时区、币种与覆盖", "平台来源与任务约定"),
        (
            "sales",
            "逐视频成交及自然／广告拆分",
            "TikTok Affiliate / Kalodata",
        ),
        ("ads", "逐视频广告消耗", "已确认的广告来源"),
        (
            "costs",
            "贡献率、佣金、固定费与寄样分摊",
            "已确认的合作与成本资料",
        ),
    ]
    .into_iter()
    .map(
        |(id, label, source)| json!({"id":id,"label":label,"source":source,"status":"not_checked"}),
    )
    .collect::<Vec<_>>();
    Ok(
        json!({"source":source,"environments":environments,"binding":bound,"bindingState":state,"checkedAt":now(),"checks":checks,"fieldRequirements":requirements,"canDispatchTask":true,"canCollectPlatforms":false,"scope":scope}),
    )
}
fn bridge_files(source: &SourcePaths) -> Result<Vec<Vec<u8>>> {
    let plugin = source.plugin.as_deref().ok_or("来源插件不可用")?;
    let data = source.data.as_deref().ok_or("来源身份存储不可用")?;
    let mut files = vec![
        read_bytes(&plugin.join("plugin.json"), 65536)?,
        read_bytes(&data.join("profiles.json"), MAX_FILE)?,
    ];
    let subscriptions = data.join("subscriptions.json");
    files.push(if subscriptions.exists() {
        read_bytes(&subscriptions, MAX_FILE)?
    } else {
        Vec::new()
    });
    Ok(files)
}
fn bridge_execute(
    command: &str,
    input: &Value,
    path: &Path,
    source: &SourcePaths,
) -> Result<Value> {
    if input.to_string().len() > 16 * 1024 {
        return Err("只读桥接输入超过大小上限".into());
    }
    let keys: &[&str] = match command {
        "browser-probe" => &["operationId"],
        "browser-pages" => &["operationId", "taskId"],
        "browser-read-page" => &["operationId", "taskId", "targetId", "expectedInstanceId"],
        _ => return Err("不支持的只读桥接命令".into()),
    };
    if input
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !keys.contains(&k.as_str())))
    {
        return Err("只读桥接输入包含不支持的字段".into());
    }
    let db = open_db(path, false).map_err(|_| "无法读取只读桥接绑定状态")?;
    if let Some(db) = db.as_ref() {
        db.busy_timeout(std::time::Duration::from_millis(500))
            .map_err(|_| "无法设置桥接状态读取超时")?;
    }
    let files = bridge_files(source)?;
    let before = status(source, db.as_ref(), input)?;
    if before["bindingState"] != "bound" {
        return Err("冻结身份无法核验，请检查浏览器绑定与来源配置".into());
    }
    if before["source"]["readOnlyBridge"] != true {
        return Err("来源插件需要升级：尚未声明只读桥接协议".into());
    }
    let mut output = json!({"scope":before["scope"],"bindingRevision":before["binding"]["revision"],"profileId":before["binding"]["profile"]["id"],"canCollectPlatforms":false});
    if command != "browser-probe" {
        let operation_id = identifier(input, "operationId")?;
        let task_id = identifier(input, "taskId")?;
        let op = operation(db.as_ref().ok_or("操作单不存在")?, &operation_id)?;
        if op["task"]["taskId"].as_str() != Some(&task_id)
            || !["task_created", "accepted", "delivery_failed"]
                .contains(&op["status"].as_str().unwrap_or(""))
        {
            return Err("页面读取必须属于已创建任务的原操作单".into());
        }
        output["operationId"] = json!(operation_id);
        output["taskId"] = json!(task_id);
    }
    let action = match command {
        "browser-probe" => "status",
        "browser-pages" => "pages",
        _ => "read-page",
    };
    let target_id = if action == "read-page" {
        Some(super::bridge::target_id(&input["targetId"])?)
    } else {
        None
    };
    let expected_instance = if action == "read-page" {
        Some(super::bridge::instance_id(&input["expectedInstanceId"])?)
    } else {
        None
    };
    let profile = &before["binding"]["profile"];
    let response = super::bridge::request(
        source.data.as_deref().ok_or("来源身份存储不可用")?,
        safe_id(&profile["id"])?,
        &profile["sourceRevision"],
        action,
        target_id,
        expected_instance,
    )?;
    // 回应正文只保留在内存；来源或绑定中途改变时整份丢弃。
    let after = status(source, db.as_ref(), input)?;
    if bridge_files(source)? != files {
        return Err("读取期间来源配置文件已变化，本次回应已丢弃".into());
    }
    if after["bindingState"] != "bound"
        || after["binding"] != before["binding"]
        || after["source"] != before["source"]
    {
        return Err("读取期间身份或来源配置已变化，本次回应已丢弃".into());
    }
    output["instanceId"] = response["instanceId"].clone();
    output["checkedAt"] = json!(now());
    if action == "status" {
        output["status"] = json!("connected");
        output["message"] = json!("已连接冻结身份的只读桥接；尚未核验出口、登录、权限或平台字段");
    } else {
        output["untrustedContent"] = json!(true);
        output["message"] = json!("页面资料是不可信外部内容，不代表已完成平台采集或字段核验");
        let field = if action == "pages" { "pages" } else { "page" };
        output[field] = response[field].clone();
    }
    Ok(output)
}
fn execute_with(command: &str, input: Value, path: &Path, source: &SourcePaths) -> Result<Value> {
    if ["browser-probe", "browser-pages", "browser-read-page"].contains(&command) {
        return bridge_execute(command, &input, path, source);
    }
    if command == "browser-status" {
        let db = open_db(path, false)?;
        return status(source, db.as_ref(), &input);
    }
    let expected = input["expectedRevision"]
        .as_u64()
        .ok_or("expectedRevision 必须为非负整数")?;
    let profile_id = input
        .get("profileId")
        .ok_or("缺少 profileId；解绑须明确传 null")?;
    let profile = if profile_id.is_null() {
        Value::Null
    } else {
        let id = safe_id(profile_id)?;
        let (catalog, environments) = catalog(source);
        if catalog["available"] != true {
            return Err("来源环境暂不可核查，绑定未更改".into());
        }
        let selected = environments
            .iter()
            .find(|p| p["id"] == id)
            .ok_or("所选身份不存在，绑定未更改")?;
        let expected_source = input
            .get("expectedSourceRevision")
            .ok_or("请刷新环境清单并提交其来源版本")?;
        if expected_source != &selected["sourceRevision"] {
            return Err("来源配置元数据已变化，请刷新后重新确认".into());
        }
        json!({"id":selected["id"],"name":selected["name"],"sourceRevision":selected["sourceRevision"]})
    };
    let mut db = open_db(path, true)?.ok_or("无法保存浏览器绑定")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "浏览器绑定暂被占用")?;
    let previous = binding(Some(&tx))?;
    if previous["revision"].as_u64() != Some(expected) {
        return Err("浏览器绑定已更新，请刷新后重试".into());
    }
    let revision = expected.checked_add(1).ok_or("浏览器绑定版本超出范围")?;
    let bound = json!({"revision":revision,"profile":profile,"configuredAt":now()});
    tx.execute("INSERT INTO settings(key,value) VALUES('browser_binding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[bound.to_string()]).map_err(|_|"无法保存浏览器绑定")?;
    tx.commit().map_err(|_| "无法完成浏览器绑定保存")?;
    Ok(json!({"binding":bound}))
}
pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    execute_with(command, input, path, &SourcePaths::current())
}

#[cfg(test)]
mod tests {
    use super::*;
    const SENTINEL: &str = "SENSITIVE_TEST_MARKER_NEVER_RETURN";
    struct Fixture {
        root: PathBuf,
        workspace: PathBuf,
        paths: SourcePaths,
    }
    impl Fixture {
        fn new() -> Self {
            let id = uuid::Uuid::new_v4();
            let root = env::temp_dir().join(format!("gapaw-browser-test-{id}"));
            let plugin = root.join("plugins/chrome-proxy-launcher");
            let data = root.join("source-data");
            fs::create_dir_all(plugin.join("bin")).unwrap();
            fs::create_dir_all(data.join("run")).unwrap();
            fs::write(
                plugin.join("bin/chrome-proxy-launcher"),
                b"test fixture, never execute",
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    plugin.join("bin/chrome-proxy-launcher"),
                    fs::Permissions::from_mode(0o755),
                )
                .unwrap();
            }
            fs::write(plugin.join("plugin.json"),json!({"id":SOURCE_ID,"version":"1.5.0","engine":{"type":"command","binary":"bin/chrome-proxy-launcher","binaryPlatformDir":"bin"}}).to_string()).unwrap();
            let workspace = PathBuf::from(env::var_os("HOME").unwrap())
                .join(format!(".gapaw-browser-test-{id}"));
            fs::create_dir(&workspace).unwrap();
            let f = Self {
                root,
                workspace,
                paths: SourcePaths {
                    plugin: Some(plugin),
                    data: Some(data),
                },
            };
            f.profiles(json!([profile("one"), profile("two")]));
            f
        }
        fn db(&self) -> PathBuf {
            self.root.join("own-data/state.sqlite")
        }
        fn data(&self) -> &Path {
            self.paths.data.as_deref().unwrap()
        }
        fn profiles(&self, v: Value) {
            fs::write(self.data().join("profiles.json"), v.to_string()).unwrap();
        }
        fn run(&self, cmd: &str, input: Value) -> Result<Value> {
            execute_with(cmd, input, &self.db(), &self.paths)
        }
        fn status(&self) -> Value {
            self.run("browser-status", json!({})).unwrap()
        }
        fn bind(&self, id: &str, revision: u64) -> Value {
            let status = self.status();
            let p = status["environments"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == id)
                .unwrap();
            self.run("bind-browser",json!({"profileId":id,"expectedRevision":revision,"expectedSourceRevision":p["sourceRevision"]})).unwrap()["binding"].clone()
        }
        fn prepare(&self, id: &str) -> Value {
            super::super::execute(
                "configure",
                json!({"workspace":{"dirId":"test_directory","path":self.workspace}}),
                &self.db(),
                None,
            )
            .unwrap();
            super::super::execute(
                "prepare-operation",
                json!({"requestId":id,"prompt":"按确认成本选人","runtime":{"cli":"codex"}}),
                &self.db(),
                None,
            )
            .unwrap()["operation"]
                .clone()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
            let _ = fs::remove_dir_all(&self.workspace);
        }
    }
    fn profile(id: &str) -> Value {
        json!({"id":id,"name":format!("测试身份{id}"),"proxy":{"scheme":"http","host":SENTINEL,"port":8080,"username":SENTINEL,"password":SENTINEL},"note":SENTINEL,"chromePath":SENTINEL,"createdAt":10,"updatedAt":20})
    }
    fn assert_safe(v: &Value, f: &Fixture) {
        let text = v.to_string();
        assert!(!text.contains(SENTINEL));
        assert!(!text.contains(f.root.to_str().unwrap()));
        for key in [
            "password",
            "username",
            "chromePath",
            "egressText",
            "proxyUrl",
            "pid\"",
        ] {
            assert!(!text.contains(key), "泄漏字段 {key}");
        }
    }
    fn source_snapshot(f: &Fixture) -> Vec<(PathBuf, Vec<u8>, u32)> {
        fn scan(p: &Path, out: &mut Vec<(PathBuf, Vec<u8>, u32)>) {
            for entry in fs::read_dir(p).unwrap() {
                let e = entry.unwrap();
                let p = e.path();
                if p.is_dir() {
                    scan(&p, out)
                } else {
                    #[cfg(unix)]
                    let mode = {
                        use std::os::unix::fs::PermissionsExt;
                        fs::metadata(&p).unwrap().permissions().mode()
                    };
                    #[cfg(not(unix))]
                    let mode = 0;
                    out.push((p.clone(), fs::read(&p).unwrap(), mode));
                }
            }
        }
        let mut output = vec![];
        scan(f.paths.plugin.as_ref().unwrap(), &mut output);
        scan(f.data(), &mut output);
        output.sort_by(|a, b| a.0.cmp(&b.0));
        output
    }
    #[test]
    fn readonly_inventory_projects_only_safe_fields_and_does_not_create_own_state() {
        let f = Fixture::new();
        let before = source_snapshot(&f);
        let status = f.status();
        assert_eq!(status["source"]["available"], true);
        assert_eq!(status["bindingState"], "unbound");
        assert_eq!(status["canCollectPlatforms"], false);
        assert_eq!(status["canDispatchTask"], true);
        assert_safe(&status, &f);
        assert!(!f.db().parent().unwrap().exists());
        assert_eq!(before, source_snapshot(&f));
    }
    #[test]
    fn process_evidence_reports_pid_liveness_without_claiming_browser_identity() {
        let f = Fixture::new();
        fs::write(f.data().join("run/one.pid"), std::process::id().to_string()).unwrap();
        f.bind("one", 0);
        let status = f.status();
        #[cfg(unix)]
        assert_eq!(status["environments"][0]["processState"], "pid_alive");
        assert_eq!(status["checks"][2]["status"], "info");
        assert!(status["checks"][2]["message"]
            .as_str()
            .unwrap()
            .contains("未核对"));
        assert_safe(&status, &f);
        fs::write(f.data().join("run/one.pid"), "invalid").unwrap();
        assert_eq!(f.status()["environments"][0]["processState"], "unknown");
        fs::remove_file(f.data().join("run/one.pid")).unwrap();
        assert_eq!(f.status()["environments"][0]["processState"], "not_running");
    }
    #[test]
    fn invalid_source_data_is_unavailable_not_a_valid_empty_inventory() {
        let f = Fixture::new();
        for bytes in [
            format!("broken {SENTINEL}"),
            json!({"profiles":[]}).to_string(),
            json!([{"id":"../outside","name":"bad"}]).to_string(),
            json!([{"id":"ok","name":"bad\nname"}]).to_string(),
            json!([{"id":"ok","name":"ok","futureField":SENTINEL}]).to_string(),
        ] {
            fs::write(f.data().join("profiles.json"), bytes).unwrap();
            let s = f.status();
            assert_eq!(s["source"]["available"], false);
            assert_eq!(s["bindingState"], "unavailable");
            assert_safe(&s, &f);
        }
        fs::write(f.data().join("profiles.json"), vec![b'x'; MAX_FILE + 1]).unwrap();
        assert_eq!(f.status()["source"]["available"], false);
        f.profiles(Value::Array(
            (0..501).map(|i| profile(&format!("profile-{i}"))).collect(),
        ));
        assert_eq!(f.status()["source"]["available"], false);
    }
    #[test]
    fn unsupported_manifest_or_missing_binary_is_unavailable() {
        let f = Fixture::new();
        let manifest = f.paths.plugin.as_ref().unwrap().join("plugin.json");
        let mut m = read_json(&manifest, 65536).unwrap();
        m["version"] = json!("1.6.0");
        fs::write(&manifest, m.to_string()).unwrap();
        let s = f.status();
        assert_eq!(s["source"]["supported"], false);
        assert_eq!(s["source"]["available"], false);
        m["version"] = json!("1.5.0");
        m["engine"]["binary"] = json!("../../outside");
        fs::write(&manifest, m.to_string()).unwrap();
        assert_eq!(f.status()["source"]["available"], false);
    }
    #[test]
    fn changed_deleted_profiles_stale_saves_and_unbinding_preserve_revision_rules() {
        let f = Fixture::new();
        let old = f.bind("one", 0);
        assert_eq!(f.status()["bindingState"], "bound");
        assert!(f
            .run(
                "bind-browser",
                json!({"profileId":null,"expectedRevision":0})
            )
            .is_err());
        let mut updated = profile("one");
        updated["updatedAt"] = json!(21);
        f.profiles(json!([updated, profile("two")]));
        assert_eq!(f.status()["bindingState"], "changed");
        assert!(f.run("bind-browser",json!({"profileId":"one","expectedRevision":1,"expectedSourceRevision":old["profile"]["sourceRevision"]})).is_err());
        assert_eq!(f.status()["binding"], old);
        f.bind("one", 1);
        assert_eq!(f.status()["bindingState"], "bound");
        f.profiles(json!([profile("two")]));
        assert_eq!(f.status()["bindingState"], "missing");
        let cleared = f
            .run(
                "bind-browser",
                json!({"profileId":null,"expectedRevision":2}),
            )
            .unwrap();
        assert_eq!(cleared["binding"]["revision"], 3);
        assert_eq!(f.status()["bindingState"], "unbound");
    }
    #[test]
    fn subscription_metadata_is_projected_and_missing_reference_blocks_binding() {
        let f = Fixture::new();
        let mut p = profile("one");
        p["proxy"] = Value::Null;
        p["subscription"] = json!({"id":"sub-one","node":SENTINEL,"via":{"scheme":"socks5","host":SENTINEL,"port":1080,"username":SENTINEL,"password":SENTINEL}});
        f.profiles(json!([p]));
        fs::write(f.data().join("subscriptions.json"),json!([{"id":"sub-one","name":SENTINEL,"url":format!("https://example.invalid/{SENTINEL}"),"nodes":[SENTINEL],"traffic":SENTINEL,"updatedAt":30,"sourceBytes":123}]).to_string()).unwrap();
        let before = source_snapshot(&f);
        let s = f.status();
        assert_eq!(s["source"]["available"], true);
        assert_safe(&s, &f);
        let b = f.bind("one", 0);
        assert_safe(&b, &f);
        assert_eq!(before, source_snapshot(&f));
        fs::write(f.data().join("subscriptions.json"), "[]").unwrap();
        let s = f.status();
        assert_eq!(s["bindingState"], "unavailable");
        assert!(f.run("bind-browser",json!({"profileId":"one","expectedRevision":1,"expectedSourceRevision":b["profile"]["sourceRevision"]})).is_err());
        assert_eq!(f.status()["binding"], b);
    }
    #[test]
    fn default_switch_does_not_change_frozen_operation_and_legacy_stays_unbound() {
        let f = Fixture::new();
        f.bind("one", 0);
        let op = f.prepare("frozen");
        assert_safe(&op["browser"], &f);
        f.bind("two", 1);
        let retry = f.prepare("frozen");
        assert_eq!(op, retry);
        let status = f
            .run("browser-status", json!({"operationId":op["id"]}))
            .unwrap();
        assert_eq!(status["binding"]["profile"]["id"], "one");
        assert_eq!(status["scope"], "operation");
        let db = open_db(&f.db(), true).unwrap().unwrap();
        let mut legacy = op.clone();
        legacy.as_object_mut().unwrap().remove("browser");
        super::super::save_operation(&db, &legacy).unwrap();
        let status = f
            .run("browser-status", json!({"operationId":op["id"]}))
            .unwrap();
        assert_eq!(status["bindingState"], "legacy_unbound");
        assert!(status["binding"]["profile"].is_null());
    }
    #[test]
    fn source_uninstalled_does_not_block_task_creation_or_common_status() {
        let mut f = Fixture::new();
        f.paths.plugin = Some(f.root.join("missing"));
        let s = f.status();
        assert_eq!(s["source"]["installed"], false);
        assert!(!f.db().exists());
        let op = f.prepare("source-missing");
        assert!(op["browser"]["profile"].is_null());
        assert!(op["dispatch"]["message"]["text"]
            .as_str()
            .unwrap()
            .contains("canCollectPlatforms"));
        let status = super::super::execute("status", json!({}), &f.db(), None).unwrap();
        assert_eq!(status["browserBinding"]["revision"], 0);
    }
    #[test]
    fn errors_never_echo_sensitive_inputs_and_source_symlinks_are_rejected() {
        let f = Fixture::new();
        let error = f
            .run(
                "bind-browser",
                json!({"profileId":format!("../{SENTINEL}"),"expectedRevision":0}),
            )
            .unwrap_err();
        assert!(!error.contains(SENTINEL));
        #[cfg(unix)]
        {
            let path = f.data().join("profiles.json");
            let other = f.data().join("hidden.json");
            fs::rename(&path, &other).unwrap();
            std::os::unix::fs::symlink(&other, &path).unwrap();
            let s = f.status();
            assert_eq!(s["source"]["available"], false);
            assert_safe(&s, &f);
        }
    }
}
