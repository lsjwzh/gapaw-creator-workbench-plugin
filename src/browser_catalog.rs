//! 浏览器公开清单适配：只调用宿主发现与 list 命令，不依赖插件产品版本或内部文件。
use crate::Result;
use serde_json::{json, Value};
use std::{collections::HashSet, io::Read, time::Duration};

const ID: &str = "chrome-proxy-launcher";
const LIMIT: u64 = 4 * 1024 * 1024;

fn endpoint(raw: &str) -> Result<String> {
    let url = url::Url::parse(raw).map_err(|_| "MultiCC 本机地址无效")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("浏览器清单仅允许通过本机 MultiCC 根地址读取".into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

fn response(result: std::result::Result<ureq::Response, ureq::Error>) -> Result<Value> {
    let response = result.map_err(|e| match e {
        ureq::Error::Status(401 | 403, _) => "MultiCC 插件接口需要有效授权，未改用内部文件".into(),
        ureq::Error::Status(_, _) => "MultiCC 插件接口拒绝了只读清单请求".into(),
        _ => "无法连接 MultiCC 插件接口，请检查本机宿主地址与运行状态".to_string(),
    })?;
    let mut bytes = vec![];
    response
        .into_reader()
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "浏览器清单响应读取失败")?;
    if bytes.len() as u64 > LIMIT {
        return Err("浏览器清单响应超过上限".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "浏览器清单响应格式不正确")?;
    if value.get("error").is_some() || value["ok"] == false {
        // 来源错误及清单可能含代理凭据，绝不原样向页面或日志传播。
        return Err("浏览器来源拒绝了清单查询，请在原插件检查".into());
    }
    Ok(value)
}

fn text<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| {
            !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
        })
        .ok_or_else(|| "浏览器公开清单缺少有效标识或名称".into())
}
fn id(v: &Value) -> Result<&str> {
    let s = text(v, "id", 80)?;
    if s.starts_with('-')
        || s.ends_with('-')
        || !s
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("浏览器公开身份编号无效".into());
    }
    Ok(s)
}
fn timestamp(v: &Value, key: &str) -> Result<u64> {
    v[key]
        .as_u64()
        .ok_or_else(|| "浏览器公开版本元数据缺失或无效".into())
}

fn environments(payload: &Value) -> Result<Vec<Value>> {
    let profiles = payload["profiles"]
        .as_array()
        .filter(|a| a.len() <= 500)
        .ok_or("浏览器公开清单缺少 profiles 数组或超过上限")?;
    let empty = vec![];
    let subscriptions = match payload.get("subscriptions") {
        None => &empty,
        Some(v) => v
            .as_array()
            .filter(|a| a.len() <= 500)
            .ok_or("浏览器订阅元数据格式无效")?,
    };
    let mut ids = HashSet::new();
    let mut output = vec![];
    for p in profiles {
        let pid = id(p)?;
        if !ids.insert(pid) {
            return Err("浏览器公开清单存在重复身份".into());
        }
        let name = text(p, "name", 200)?;
        let subscription = if let Some(s) = p.get("subscription").filter(|v| !v.is_null()) {
            let sid = id(s)?;
            let matches: Vec<_> = subscriptions.iter().filter(|v| v["id"] == sid).collect();
            if matches.len() != 1 {
                return Err("浏览器身份引用的订阅元数据缺失或重复".into());
            }
            let found = matches[0];
            json!({"id":sid,"updatedAt":timestamp(found,"updatedAt")?,"sourceBytes":timestamp(found,"sourceBytes")?})
        } else {
            Value::Null
        };
        let process = match p.get("running") {
            Some(Value::Bool(true)) => "pid_alive",
            Some(Value::Bool(false)) => "not_running",
            None => "unknown",
            _ => return Err("浏览器公开运行状态格式无效".into()),
        };
        // 只选取非凭据元数据。代理、订阅 URL、Cookie、路径和任意新增字段均不传播或散列。
        output.push(json!({"id":pid,"name":name,"processState":process,"sourceRevision":{
            "profileCreatedAt":timestamp(p,"createdAt")?,"profileUpdatedAt":timestamp(p,"updatedAt")?,
            "subscription":subscription,"confidence":"public_metadata"
        }}));
    }
    Ok(output)
}

pub fn catalog(raw_url: &str) -> (Value, Vec<Value>) {
    let mut source = json!({"installed":null,"version":null,"supported":false,"available":false,
        "catalogTransport":"host-command","catalogCommand":"list","readOnlyBridge":false,
        "message":"正在核查浏览器公开清单接口"});
    let result = (|| {
        let root = endpoint(raw_url)?;
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .try_proxy_from_env(false)
            .timeout(Duration::from_secs(3))
            .build();
        let plugins = response(agent.get(&format!("{root}/api/plugins")).call())?;
        let plugins = plugins["plugins"]
            .as_array()
            .ok_or("宿主插件发现接口格式不兼容")?;
        let matches: Vec<_> = plugins.iter().filter(|p| p["id"] == ID).collect();
        if matches.is_empty() {
            source["installed"] = json!(false);
        }
        if matches.len() != 1 {
            return Err("未找到唯一的浏览器隔离插件，请在宿主插件管理检查".into());
        }
        let plugin = matches[0];
        source["installed"] = json!(true);
        source["version"] = plugin
            .get("version")
            .filter(|v| {
                v.as_str()
                    .is_some_and(|s| s.len() <= 64 && !s.chars().any(char::is_control))
            })
            .cloned()
            .unwrap_or(Value::Null);
        if !plugin["commands"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "list"))
        {
            return Err("浏览器插件未声明公开 list 清单能力".into());
        }
        source["supported"] = json!(true);
        source["pageReadDeclared"] = json!(plugin["commands"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "browser-read-capabilities")
                && a.iter().any(|v| v == "browser-read")));
        if plugin["engine"]["available"] != true {
            return Err("浏览器插件当前不可执行，请检查宿主插件状态".into());
        }
        let list = response(
            agent
                .post(&format!("{root}/api/plugins/{ID}/run"))
                .set("Content-Type", "application/json")
                .send_string(r#"{"command":"list","input":{}}"#),
        )?;
        environments(&list)
    })();
    match result {
        Ok(items) => {
            source["available"] = json!(true);
            source["message"] = json!("已通过 MultiCC 公开 list 命令读取实例；按命令与返回字段适配，不限制插件产品版本。元数据不能证明完整配置、出口或平台登录状态。");
            (source, items)
        }
        Err(message) => {
            source["message"] = json!(message);
            (source, vec![])
        }
    }
}

pub const READ_PROTOCOL: &str = "multicc-browser-read-v1";

/// 经公开命令访问已经绑定的实例；不计算 socket 或回退到内部文件。
pub fn read(profile: &Value, action: &str, extra: Value) -> Result<Value> {
    let root = endpoint(
        &std::env::var("GAPAW_BROWSER_HOST_URL")
            .or_else(|_| std::env::var("MULTICC_BASE_URL"))
            .unwrap_or_else(|_| "http://127.0.0.1:3000".into()),
    )?;
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout(Duration::from_secs(12))
        .build();
    let invoke = |command: &str, input: Value| {
        response(
            agent
                .post(&format!("{root}/api/plugins/{ID}/run"))
                .set("Content-Type", "application/json")
                .send_string(&json!({"command":command,"input":input}).to_string()),
        )
    };
    let caps = invoke("browser-read-capabilities", json!({}))?;
    if caps["protocol"] != READ_PROTOCOL
        || !caps["actions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == action))
    {
        return Err("浏览器插件尚未提供兼容的页面读取能力".into());
    }
    let mut input = extra;
    input["protocol"] = json!(READ_PROTOCOL);
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    input["profileId"] = profile["id"].clone();
    input["sourceRevision"] = profile["sourceRevision"].clone();
    input["action"] = json!(action);
    let result = invoke("browser-read", input.clone())?;
    if result["available"] == false {
        return Err(if result["reason"] == "session_upgrade_required" {
            "此实例仍由旧监督进程运行，需要正常关闭并重开此实例后才能检查页面。"
        } else {
            "实例页面读取能力当前不可用。"
        }
        .into());
    }
    for key in [
        "requestId",
        "profileId",
        "sourceRevision",
        "protocol",
        "action",
    ] {
        if result[key] != input[key] {
            return Err("浏览器检查回应与绑定实例不一致".into());
        }
    }
    crate::bridge::instance_id(&result["instanceId"])?;
    if input
        .get("expectedInstanceId")
        .is_some_and(|v| v != &result["instanceId"])
    {
        return Err("浏览器运行实例已变化，请重新检测".into());
    }
    Ok(result)
}
