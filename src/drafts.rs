//! 邀约草稿：从现有工作台冻结上下文，任务交回候选版本，用户采用时经原草稿接口按 revision 写回。
use crate::{
    effective_workspace, identifier, now, open_db, operation, required, runtime, truncate_utf16,
    Result,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Read, path::Path, time::Duration};
use uuid::Uuid;

pub const METHOD_VERSION: &str = "outreach-drafts-v1";
const INSTRUCTIONS: &str = include_str!("../resources/draft-instructions.md");
const BOUNDARY: &str = "\n\n【达人工作台操作边界】\n本次仅撰写邀约草稿候选版本，不发送邮件、私信、评论或联盟邀请，不登记触达事件，不修改合作设置与报价。候选版本交回插件后由用户比较并采用；采用前工作台现有文案保持不变。宿主受理消息不等于草稿完成。\n";
const CHANNELS: &[(&str, &str)] = &[
    ("comment", "评论区"),
    ("dm", "普通私信"),
    ("email", "邮件"),
    ("affiliate", "达人联盟"),
    ("followup", "跟进"),
];
const MAX_CREATORS: usize = 10;
const MAX_RESPONSE: u64 = 8 * 1024 * 1024;
const PROFILE_KEYS: &[&str] = &[
    "id",
    "handle",
    "priority",
    "followers",
    "topic",
    "angle",
    "anchor1",
    "anchor2",
    "products",
    "history",
    "kalodata_window",
    "data_collected",
    "warnings",
];
const SETTING_KEYS: &[&str] = &["fee", "commission", "sender", "notes"];
/// 工作台按合作设置自动替换的占位符。
pub(crate) const AUTO_PLACEHOLDERS: &[&str] = &["【固定费】", "【佣金比例】", "【姓名】"];
/// 现有文案沿用的人工占位符：允许保存，但发送前必须人工替换。
pub(crate) const MANUAL_PLACEHOLDERS: &[&str] = &["【两款商品资料链接】"];
const REPLY_INSTRUCTIONS: &str = include_str!("../resources/reply-instructions.md");
const REPLY_BOUNDARY: &str = "\n\n【达人工作台操作边界】\n本次只读已登记的往来消息，撰写谈判摘要和回复草稿候选版本；不发送邮件、私信、评论或联盟邀请，不登记消息或触达事件，不修改合作设置与报价。摘要和回复草稿交回插件后由用户分别比较并采用；未采用前工作台的谈判摘要和文案保持不变。宿主受理消息不等于完成。\n";
const MAX_CONVERSATION: usize = 40;
const NEGOTIATION_FIELDS: &[&str] = &["status", "our_offer", "their_ask", "next_step"];

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS gapaw_negotiation_proposals(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,submission_id TEXT NOT NULL,submission_hash TEXT NOT NULL,creator TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(operation_id,creator,version)); CREATE TABLE IF NOT EXISTS gapaw_negotiation_adoptions(adoption_id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL,expected_updated TEXT,status TEXT NOT NULL,message TEXT NOT NULL,updated_at TEXT NOT NULL);")
        .map_err(|_| "无法初始化谈判摘要候选数据结构")?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS gapaw_draft_proposals(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,submission_id TEXT NOT NULL,submission_hash TEXT NOT NULL,creator TEXT NOT NULL,channel TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(operation_id,creator,channel,version)); CREATE INDEX IF NOT EXISTS gapaw_draft_proposals_submission ON gapaw_draft_proposals(operation_id,submission_id); CREATE TABLE IF NOT EXISTS gapaw_draft_adoptions(adoption_id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL,expected_revision INTEGER NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,updated_at TEXT NOT NULL);")
        .map_err(|_| "无法初始化草稿候选数据结构".into())
}

pub(crate) fn channel_label(c: &str) -> Option<&'static str> {
    CHANNELS.iter().find(|(k, _)| *k == c).map(|(_, v)| *v)
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
pub(crate) fn only_keys(input: &Value, allowed: &[&str], name: &str) -> Result<()> {
    if input
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(format!("{name} 包含不支持的字段"));
    }
    Ok(())
}

/// 现有工作台的正式接口；只接受本机地址，不跟随跳转，不使用代理。
pub(crate) struct Outreach {
    pub(crate) root: String,
    agent: ureq::Agent,
}
impl Outreach {
    fn new(raw: &str) -> Result<Self> {
        let root = crate::workbench::endpoint(raw)?;
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .try_proxy_from_env(false)
            .timeout(Duration::from_secs(5))
            .build();
        Ok(Self { root, agent })
    }
    pub(crate) fn configured(db: Option<&Connection>) -> Result<Option<Self>> {
        let Some(db) = db else { return Ok(None) };
        let raw: Option<String> = db
            .query_row("SELECT value FROM settings WHERE key='outreach'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        match raw {
            None => Ok(None),
            Some(raw) => {
                let v: Value = serde_json::from_str(&raw).map_err(|_| "工作台地址配置损坏")?;
                Ok(Some(Self::new(required(&v, "url")?)?))
            }
        }
    }
    pub(crate) fn required(db: Option<&Connection>) -> Result<Self> {
        Self::configured(db)?.ok_or_else(|| "请先填写现有达人工作台的本机地址".into())
    }
    fn read(response: ureq::Response) -> Result<Value> {
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "工作台响应读取失败")?;
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err("工作台响应超过大小限制".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "工作台未返回有效 JSON".into())
    }
    pub(crate) fn get(&self, path: &str) -> Result<Value> {
        match self.agent.get(&format!("{}{path}", self.root)).call() {
            Ok(r) => Self::read(r),
            Err(ureq::Error::Status(code, r)) => Err(Self::read(r)
                .ok()
                .and_then(|v| v["error"].as_str().map(String::from))
                .unwrap_or_else(|| format!("工作台返回状态 {code}"))),
            Err(_) => Err("无法连接现有达人工作台，请确认服务已启动".into()),
        }
    }
    fn health(&self) -> Result<()> {
        let v = self.get("/api/health")?;
        if v["ok"] != true || v["service"] != "Gapaw达人触达系统" {
            return Err("该地址不是 Gapaw 达人工作台".into());
        }
        Ok(())
    }
    pub(crate) fn detail(&self, creator: &str) -> Result<Value> {
        let v = self.get(&format!("/api/creators/{creator}"))?;
        if !v["drafts"].is_array() || !v["profile"].is_object() {
            return Err("工作台档案格式不兼容".into());
        }
        Ok(v)
    }
    /// 返回 Ok(Ok(value)) 表示工作台已受理；Ok(Err(msg)) 表示工作台明确拒绝；Err 表示结果未知。
    pub(crate) fn post(
        &self,
        path: &str,
        payload: &Value,
    ) -> Result<std::result::Result<Value, String>> {
        match self
            .agent
            .post(&format!("{}{path}", self.root))
            .set("X-Outreach-Request", "1")
            .set("Content-Type", "application/json")
            .send_string(&payload.to_string())
        {
            Ok(r) => Ok(Ok(Self::read(r)?)),
            Err(ureq::Error::Status(400, r)) => Ok(Err(Self::read(r)
                .ok()
                .and_then(|v| v["error"].as_str().map(String::from))
                .unwrap_or_else(|| "工作台拒绝保存".into()))),
            Err(_) => Err("工作台未返回可确认的结果".into()),
        }
    }
    pub(crate) fn edit_draft(
        &self,
        creator: &str,
        channel: &str,
        subject: &str,
        body: &str,
        revision: i64,
    ) -> Result<std::result::Result<Value, String>> {
        self.post(
            &format!("/api/creators/{creator}/drafts/{channel}"),
            &json!({"subject":subject,"body":body,"revision":revision}),
        )
    }
}

/// 找出文中全部【…】占位符；未知占位符返回错误，人工占位符单独列出供界面提示。
pub(crate) fn check_placeholders(text: &str) -> Result<Vec<String>> {
    let mut manual = vec![];
    let mut rest = text;
    while let Some(start) = rest.find('【') {
        let after = &rest[start + '【'.len_utf8()..];
        let Some(end) = after.find('】') else { break };
        let inner = &after[..end];
        if !inner.is_empty() && inner.chars().count() <= 20 && !inner.contains('【') {
            let token = format!("【{inner}】");
            if MANUAL_PLACEHOLDERS.contains(&token.as_str()) {
                if !manual.contains(&token) {
                    manual.push(token);
                }
            } else if !AUTO_PLACEHOLDERS.contains(&token.as_str()) {
                return Err(format!(
                    "{token} 不是工作台支持的占位符；可用：{}，以及需人工替换的 {}",
                    AUTO_PLACEHOLDERS.join(""),
                    MANUAL_PLACEHOLDERS.join("")
                ));
            }
        }
        rest = &after[end + '】'.len_utf8()..];
    }
    Ok(manual)
}

pub(crate) fn draft_of<'a>(detail: &'a Value, channel: &str) -> Result<&'a Value> {
    detail["drafts"]
        .as_array()
        .and_then(|a| a.iter().find(|d| d["channel"] == channel))
        .ok_or_else(|| format!("工作台没有 {channel} 渠道的文案"))
}
pub(crate) fn revision(d: &Value) -> Result<i64> {
    d["revision"]
        .as_i64()
        .ok_or("文案 revision 格式不兼容".into())
}
pub(crate) fn pick(src: &Value, keys: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for k in keys {
        if let Some(v) = src.get(*k) {
            out.insert((*k).into(), v.clone());
        }
    }
    Value::Object(out)
}
fn conversation(detail: &Value) -> Vec<Value> {
    let all = detail["messages"].as_array().cloned().unwrap_or_default();
    let skip = all.len().saturating_sub(MAX_CONVERSATION);
    all.iter()
        .skip(skip)
        .map(|m| {
            json!({"messageId":m["id"],"at":m["at"],"direction":m["direction"],"channel":m["channel"],"kind":m["kind"],"subject":m["subject"],
                "body":truncate_utf16(m["body"].as_str().unwrap_or(""),3000),"zh":truncate_utf16(m["zh"].as_str().unwrap_or(""),1000)})
        })
        .collect()
}
fn snapshot(detail: &Value, channels: &[String], reply: bool) -> Result<Value> {
    let messages: Vec<Value> = detail["messages"]
        .as_array()
        .map(|a| {
            a.iter()
                .rev()
                .take(6)
                .rev()
                .map(|m| {
                    json!({"at":m["at"],"direction":m["direction"],"channel":m["channel"],"kind":m["kind"],"zh":truncate_utf16(m["zh"].as_str().unwrap_or(""),600)})
                })
                .collect()
        })
        .unwrap_or_default();
    let mut drafts = vec![];
    for c in channels {
        let d = draft_of(detail, c)?;
        drafts.push(json!({"channel":c,"label":channel_label(c),"subject":d["subject"],"body":d["body"],"revision":revision(d)?}));
    }
    let mut out = json!({
        "creatorId":detail["profile"]["id"],
        "profile":pick(&detail["profile"],PROFILE_KEYS),
        "settings":pick(&detail["settings"],SETTING_KEYS),
        "stage":detail["stage"],
        "negotiation":detail["negotiation"],
        "recentMessages":messages,
        "drafts":drafts
    });
    if reply {
        out["conversation"] = json!(conversation(detail));
        out["messageCount"] = json!(detail["messages"].as_array().map_or(0, Vec::len));
    }
    Ok(out)
}

fn draft_operation(db: &Connection, id: &str) -> Result<Value> {
    let op = operation(db, id)?;
    if op["kind"] != "drafts" {
        return Err("该操作不是邀约草稿任务".into());
    }
    Ok(op)
}
fn bound(db: &Connection, id: &str, task: &str) -> Result<Value> {
    let op = draft_operation(db, id)?;
    if op["task"]["taskId"].as_str() != Some(task)
        || !["task_created", "accepted", "delivery_failed"]
            .contains(&op["status"].as_str().unwrap_or(""))
    {
        return Err("taskId 必须匹配原操作已创建的宿主任务".into());
    }
    Ok(op)
}
fn scope_entry<'a>(op: &'a Value, creator: &str) -> Option<&'a Value> {
    op["draftScope"]["creators"]
        .as_array()?
        .iter()
        .find(|c| c["creatorId"] == creator)
}

pub(crate) fn proposals(db: &Connection, op_id: &str) -> Result<Vec<Value>> {
    let mut stmt = db
        .prepare("SELECT value FROM gapaw_draft_proposals WHERE operation_id=? ORDER BY creator,channel,version")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([op_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        let mut v: Value =
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let id = v["proposalId"].as_str().unwrap_or("").to_string();
        let adoption: Option<(String, i64, String, String, String)> = db
            .query_row("SELECT adoption_id,expected_revision,status,message,updated_at FROM gapaw_draft_adoptions WHERE proposal_id=? ORDER BY updated_at DESC LIMIT 1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        v["adoption"] = adoption.map_or(Value::Null, |(a, e, s, m, u)| {
            json!({"adoptionId":a,"expectedRevision":e,"status":s,"message":m,"updatedAt":u})
        });
        out.push(v);
    }
    Ok(out)
}

pub(crate) fn negotiation_proposals(db: &Connection, op_id: &str) -> Result<Vec<Value>> {
    let mut stmt = db
        .prepare("SELECT value FROM gapaw_negotiation_proposals WHERE operation_id=? ORDER BY creator,version")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([op_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        let mut v: Value =
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let id = v["proposalId"].as_str().unwrap_or("").to_string();
        let adoption: Option<(String, Option<String>, String, String, String)> = db
            .query_row("SELECT adoption_id,expected_updated,status,message,updated_at FROM gapaw_negotiation_adoptions WHERE proposal_id=? ORDER BY updated_at DESC LIMIT 1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        v["adoption"] = adoption.map_or(Value::Null, |(a, e, s, m, u)| {
            json!({"adoptionId":a,"expectedUpdated":e,"status":s,"message":m,"updatedAt":u})
        });
        out.push(v);
    }
    Ok(out)
}
/// 用工作台当前谈判摘要标注候选：是否与候选一致、是否在发起后被改过。
pub(crate) fn annotate_negotiation(p: &mut Value, current: &Value) {
    let same = NEGOTIATION_FIELDS
        .iter()
        .all(|k| current[*k].as_str().unwrap_or("") == p["fields"][*k].as_str().unwrap_or(""));
    let base_updated = p["base"]["updated"].clone();
    p["current"] = json!({"fields":pick(current,NEGOTIATION_FIELDS),"updated":current["updated"],"matchesProposal":same});
    p["baseChanged"] = json!(current["updated"] != base_updated && !same);
}
/// 用工作台当前文案标注候选：版本是否变化、是否与候选一致。
pub(crate) fn annotate_draft(p: &mut Value, detail: &Value) {
    if let Ok(d) = draft_of(detail, p["channel"].as_str().unwrap_or("")) {
        let rev = d["revision"].clone();
        p["current"] = json!({"subject":d["subject"],"body":d["body"],"revision":rev,"matchesProposal":d["subject"]==p["subject"]&&d["body"]==p["body"]});
        p["baseChanged"] = json!(rev != p["baseRevision"]);
    }
}
/// 本任务自己采用造成的版本变化不算人工修改。
pub(crate) fn mark_own_adoptions(items: &mut [Value]) {
    let adopted: Vec<(Value, Value, Value, Value)> = items
        .iter()
        .filter(|p| p["adoption"]["status"] == "adopted")
        .map(|p| {
            (
                p["creatorId"].clone(),
                p["channel"].clone(),
                p["subject"].clone(),
                p["body"].clone(),
            )
        })
        .collect();
    for p in items.iter_mut() {
        let own = adopted.iter().any(|(c, ch, s, b)| {
            *c == p["creatorId"]
                && *ch == p["channel"]
                && p["current"]["subject"] == *s
                && p["current"]["body"] == *b
        });
        if own && p["baseChanged"] == true {
            p["baseChanged"] = json!(false);
            p["changedByAdoption"] = json!(true);
        }
    }
}

fn prepare(input: &Value, path: &Path, host: Option<(String, String)>) -> Result<Value> {
    only_keys(
        input,
        &[
            "requestId",
            "creatorIds",
            "channels",
            "prompt",
            "runtime",
            "mode",
        ],
        "prepare-drafts",
    )?;
    let reply = match input.get("mode").and_then(Value::as_str) {
        None | Some("drafts") => false,
        Some("reply") => true,
        _ => return Err("mode 只能是 drafts 或 reply".into()),
    };
    let request_id = identifier(input, "requestId")?;
    let prompt = required(input, "prompt")?.to_string();
    let rt = runtime(input)?;
    let mut creators = vec![];
    for c in input["creatorIds"].as_array().ok_or("请选择达人")? {
        let id = c.as_str().ok_or("达人编号格式不合法")?;
        identifier(&json!({ "id": id }), "id")?;
        if creators.contains(&id.to_string()) {
            return Err("达人编号重复".into());
        }
        creators.push(id.to_string());
    }
    if creators.is_empty() || creators.len() > MAX_CREATORS {
        return Err(format!("每次请选择 1 至 {MAX_CREATORS} 位达人"));
    }
    let mut channels = vec![];
    for c in input["channels"].as_array().ok_or("请选择渠道")? {
        let c = c
            .as_str()
            .filter(|c| channel_label(c).is_some())
            .ok_or("渠道不受支持")?;
        if !channels.contains(&c.to_string()) {
            channels.push(c.to_string());
        }
    }
    if channels.is_empty() {
        return Err("请至少选择一个渠道".into());
    }
    if reply && (creators.len() != 1 || channels.len() != 1) {
        return Err("总结对话并拟回复每次只处理一位达人、一个回复文案位置".into());
    }
    let mode = if reply { "reply" } else { "drafts" };
    let request = json!({"kind":"drafts","mode":mode,"prompt":prompt,"runtime":rt,"creatorIds":creators,"channels":channels});
    let mut db = open_db(path, true)?.ok_or("无法打开数据库")?;
    {
        let previous: Option<(String, String)> = db
            .query_row(
                "SELECT request,value FROM operations WHERE request_id=?",
                [&request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((old, op)) = previous {
            let mut old: Value = serde_json::from_str(&old).map_err(|e| e.to_string())?;
            if old.get("mode").is_none() {
                old["mode"] = json!("drafts");
            }
            if old != request {
                return Err("同一请求编号不能更改达人、渠道或内容，请新建任务".into());
            }
            return Ok(
                json!({"operation":serde_json::from_str::<Value>(&op).map_err(|e|e.to_string())?}),
            );
        }
    }
    // 先在事务外读取工作台；冻结的是发起时刻的档案与文案版本。
    let client = Outreach::required(Some(&db))?;
    let mut scope = vec![];
    for c in &creators {
        let detail = client.detail(c)?;
        if reply && detail["messages"].as_array().is_none_or(Vec::is_empty) {
            return Err(format!("{c} 还没有登记往来消息，无法总结对话"));
        }
        scope.push(snapshot(&detail, &channels, reply)?);
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if let Some(op) = tx
        .query_row(
            "SELECT value FROM operations WHERE request_id=?",
            [&request_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(
            json!({"operation":serde_json::from_str::<Value>(&op).map_err(|e|e.to_string())?}),
        );
    }
    let w = effective_workspace(Some(&tx), host, true)?.ok_or("请先设置插件专属目录")?;
    if w["valid"] != true {
        return Err(w["error"].as_str().unwrap_or("专属目录无效").into());
    }
    let id = format!("op_{}", Uuid::new_v4().simple());
    let handles: Vec<String> = scope
        .iter()
        .map(|s| {
            format!(
                "{}（@{}）",
                s["creatorId"].as_str().unwrap_or(""),
                s["profile"]["handle"].as_str().unwrap_or("")
            )
        })
        .collect();
    let labels: Vec<&str> = channels.iter().filter_map(|c| channel_label(c)).collect();
    let (title, boundary, instructions) = if reply {
        (
            format!("总结对话并拟回复：{}", handles.join("、")),
            REPLY_BOUNDARY,
            REPLY_INSTRUCTIONS,
        )
    } else {
        (
            format!("生成邀约草稿：{}", handles.join("、")),
            BOUNDARY,
            INSTRUCTIONS,
        )
    };
    let title = truncate_utf16(&title, 120);
    let message = format!(
        "{}{}\n【方法版本：{}】\n【范围】达人：{}；{}：{}\n【工作台操作编号：{}】\n{}",
        prompt,
        boundary,
        METHOD_VERSION,
        handles.join("、"),
        if reply {
            "回复文案位置"
        } else {
            "渠道"
        },
        labels.join("、"),
        id,
        instructions.replace("{{OPERATION_ID}}", &id)
    );
    if message.encode_utf16().count() > 32000 {
        return Err("提示词连同说明超过宿主 32000 字限制，请缩短后再发送".into());
    }
    let mut create = rt.clone();
    create["dirId"] = w["dirId"].clone();
    create["title"] = json!(title);
    create["clientMsgId"] = json!(format!("{id}_create"));
    let created = now();
    let op = json!({"id":id,"kind":"drafts","mode":mode,"requestId":request_id,"status":"prepared","task":null,"receipt":null,"error":null,"workspace":w,"prompt":prompt,"runtime":rt,"methodVersion":METHOD_VERSION,"createdAt":created,
        "draftScope":{"channels":channels,"capturedAt":created,"creators":scope},
        "dispatch":{"create":create,"message":{"clientMsgId":format!("{id}_message"),"text":message,"intent":"work","lang":"zh"}}});
    tx.execute(
        "INSERT INTO operations(id,request_id,request,value,created_at) VALUES(?,?,?,?,?)",
        params![id, request_id, request.to_string(), op.to_string(), created],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"operation":op}))
}

fn submission_template(op: &Value) -> Value {
    let mut drafts = vec![];
    for c in op["draftScope"]["creators"]
        .as_array()
        .into_iter()
        .flatten()
    {
        for ch in op["draftScope"]["channels"]
            .as_array()
            .into_iter()
            .flatten()
        {
            drafts.push(
                json!({"creatorId":c["creatorId"],"channel":ch,"subject":"","body":"","note":""}),
            );
        }
    }
    let mut t = json!({"operationId":op["id"],"taskId":op["task"]["taskId"],"submissionId":"新生成的唯一编号","drafts":drafts});
    if op["mode"] == "reply" {
        t["negotiation"] = json!({"status":"","our_offer":"","their_ask":"","next_step":"","basis":["依据消息的 messageId"],"note":""});
    }
    t
}

fn submit(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &[
            "operationId",
            "taskId",
            "submissionId",
            "drafts",
            "negotiation",
        ],
        "submit-drafts",
    )?;
    let op_id = identifier(input, "operationId")?;
    let task = identifier(input, "taskId")?;
    let submission = identifier(input, "submissionId")?;
    let mut db = open_db(path, true)?.ok_or("无法打开数据库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let op = bound(&tx, &op_id, &task)?;
    let reply = op["mode"] == "reply";
    let empty = vec![];
    let items = match input.get("drafts") {
        None if reply => &empty,
        v => v.and_then(Value::as_array).ok_or("drafts 必须是数组")?,
    };
    if reply {
        if items.len() > 1 {
            return Err("总结对话任务至多交回一条回复草稿".into());
        }
        if !input["negotiation"].is_object() {
            return Err("总结对话任务必须交回 negotiation 谈判摘要".into());
        }
    } else {
        if items.is_empty() || items.len() > 50 {
            return Err("drafts 必须是 1 至 50 条".into());
        }
        if input.get("negotiation").is_some() {
            return Err("邀约草稿任务不接受谈判摘要".into());
        }
    }
    // 邀约草稿沿用 0.7.0 的摘要口径，保证已保存的提交仍能幂等识别。
    let digest = if reply {
        hash(&json!({"drafts":items,"negotiation":input["negotiation"]}))
    } else {
        hash(&input["drafts"])
    };
    let mut existing: Option<String> = None;
    for table in ["gapaw_draft_proposals", "gapaw_negotiation_proposals"] {
        if existing.is_none() {
            existing = tx
                .query_row(
                    &format!("SELECT submission_hash FROM {table} WHERE operation_id=? AND submission_id=? LIMIT 1"),
                    params![op_id, submission],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
        }
    }
    if let Some(h) = existing {
        if h != digest {
            return Err("同一 submissionId 已保存不同内容；修改请使用新的 submissionId".into());
        }
        drop(tx);
        let mine: Vec<Value> = proposals(&db, &op_id)?
            .into_iter()
            .filter(|p| p["submissionId"] == submission.as_str())
            .collect();
        let negotiations: Vec<Value> = negotiation_proposals(&db, &op_id)?
            .into_iter()
            .filter(|p| p["submissionId"] == submission.as_str())
            .collect();
        return Ok(json!({"duplicate":true,"proposals":mine,"negotiations":negotiations}));
    }
    let channels: Vec<&str> = op["draftScope"]["channels"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let mut saved = vec![];
    let created = now();
    for item in items {
        only_keys(
            item,
            &["creatorId", "channel", "subject", "body", "note"],
            "草稿",
        )?;
        let creator = required(item, "creatorId")?;
        let channel = required(item, "channel")?;
        let entry =
            scope_entry(&op, creator).ok_or_else(|| format!("{creator} 不在本操作范围内"))?;
        if !channels.contains(&channel) {
            return Err(format!("渠道 {channel} 不在本操作范围内"));
        }
        if !seen.insert((creator.to_string(), channel.to_string())) {
            return Err(format!("{creator} 的 {channel} 在同一次提交中重复"));
        }
        let subject = item["subject"].as_str().unwrap_or("");
        let body = required(item, "body")?;
        let note = item["note"].as_str().unwrap_or("");
        if subject.chars().count() > 300
            || body.chars().count() > 10000
            || note.chars().count() > 2000
        {
            return Err(format!("{creator} 的 {channel} 文案超过长度限制"));
        }
        if channel == "email" && subject.trim().is_empty() {
            return Err(format!("{creator} 的邮件缺少主题"));
        }
        if regex_like_fixed_fee(body) {
            return Err(format!(
                "{creator} 的 {channel} 直接写了金额，请用【固定费】保留金额联动"
            ));
        }
        let manual = check_placeholders(&format!("{subject}\n{body}"))
            .map_err(|e| format!("{creator} 的 {channel}：{e}"))?;
        let base = entry["drafts"]
            .as_array()
            .and_then(|a| a.iter().find(|d| d["channel"] == channel))
            .ok_or("冻结快照缺少该渠道")?;
        let version: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(version),0)+1 FROM gapaw_draft_proposals WHERE operation_id=? AND creator=? AND channel=?",
                params![op_id, creator, channel],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let id = format!("dp_{}", Uuid::new_v4().simple());
        let value = json!({"proposalId":id,"operationId":op_id,"taskId":task,"submissionId":submission,"mode":op["mode"].as_str().unwrap_or("drafts"),"creatorId":creator,"handle":entry["profile"]["handle"],"channel":channel,"label":channel_label(channel),"version":version,"subject":subject,"body":body,"note":note,"manualPlaceholders":manual,"baseRevision":base["revision"],"createdAt":created});
        tx.execute(
            "INSERT INTO gapaw_draft_proposals(id,operation_id,submission_id,submission_hash,creator,channel,version,value,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            params![id, op_id, submission, digest, creator, channel, version, value.to_string(), created],
        )
        .map_err(|e| e.to_string())?;
        saved.push(value);
    }
    let mut negotiations = vec![];
    if reply {
        let n = &input["negotiation"];
        only_keys(
            n,
            &[
                "status",
                "our_offer",
                "their_ask",
                "next_step",
                "basis",
                "note",
            ],
            "谈判摘要",
        )?;
        let entry = op["draftScope"]["creators"]
            .get(0)
            .ok_or("冻结快照缺少达人")?;
        let creator = entry["creatorId"].as_str().unwrap_or("").to_string();
        let mut fields = serde_json::Map::new();
        for k in NEGOTIATION_FIELDS {
            let v = n.get(*k).and_then(Value::as_str).unwrap_or("").trim();
            if v.chars().count() > 3000 {
                return Err(format!("谈判摘要 {k} 超过 3000 字"));
            }
            fields.insert((*k).into(), json!(v));
        }
        if fields["status"].as_str().unwrap_or("").is_empty() {
            return Err("谈判摘要必须填写 status".into());
        }
        let known: HashSet<&str> = entry["conversation"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["messageId"].as_str())
            .collect();
        let basis: Vec<String> = n["basis"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= MAX_CONVERSATION)
            .ok_or("basis 必须列出 1 至 40 条依据消息的 messageId")?
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|id| known.contains(id))
                    .map(String::from)
                    .ok_or_else(|| format!("依据 {v} 不在本任务冻结的往来消息中"))
            })
            .collect::<Result<_>>()?;
        let note = n["note"].as_str().unwrap_or("");
        if note.chars().count() > 2000 {
            return Err("谈判摘要说明超过 2000 字".into());
        }
        let version: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(version),0)+1 FROM gapaw_negotiation_proposals WHERE operation_id=? AND creator=?",
                params![op_id, creator],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let id = format!("np_{}", Uuid::new_v4().simple());
        let value = json!({"proposalId":id,"operationId":op_id,"taskId":task,"submissionId":submission,"creatorId":creator,"handle":entry["profile"]["handle"],"version":version,"fields":fields,"basis":basis,"note":note,"base":entry["negotiation"],"createdAt":created});
        tx.execute(
            "INSERT INTO gapaw_negotiation_proposals(id,operation_id,submission_id,submission_hash,creator,version,value,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![id, op_id, submission, digest, creator, version, value.to_string(), created],
        )
        .map_err(|e| e.to_string())?;
        negotiations.push(value);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"duplicate":false,"proposals":saved,"negotiations":negotiations}))
}

/// 与工作台保存规则一致：正文不能直接写 50/100 美元。
pub(crate) fn regex_like_fixed_fee(body: &str) -> bool {
    let chars: Vec<char> = body.chars().collect();
    for n in ["50", "100"] {
        let nc: Vec<char> = n.chars().collect();
        for i in 0..chars.len() {
            if chars[i..].starts_with(&nc) && (i == 0 || !chars[i - 1].is_ascii_digit()) {
                let rest: String = chars[i + nc.len()..].iter().collect();
                if rest.trim_start().starts_with("美元") {
                    return true;
                }
            }
        }
    }
    false
}

fn get(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["operationId", "live"], "get-drafts")?;
    let op_id = identifier(input, "operationId")?;
    let db = open_db(path, false)?.ok_or("操作单不存在")?;
    let op = draft_operation(&db, &op_id)?;
    let mut items = proposals(&db, &op_id)?;
    let mut negotiations = negotiation_proposals(&db, &op_id)?;
    let mut live_error = Value::Null;
    if input["live"] == true {
        match Outreach::required(Some(&db)) {
            Ok(client) => {
                let mut cache: Vec<(String, Value)> = vec![];
                let creators: Vec<String> = items
                    .iter()
                    .chain(negotiations.iter())
                    .filter_map(|p| p["creatorId"].as_str().map(String::from))
                    .collect();
                for c in creators {
                    if cache.iter().any(|(k, _)| *k == c) {
                        continue;
                    }
                    match client.detail(&c) {
                        Ok(d) => cache.push((c, d)),
                        Err(e) => {
                            live_error = json!(e);
                            break;
                        }
                    }
                }
                let find = |c: &Value| cache.iter().find(|(k, _)| c == k.as_str()).map(|(_, d)| d);
                for p in items.iter_mut() {
                    if let Some(d) = find(&p["creatorId"]) {
                        annotate_draft(p, d);
                    }
                }
                for p in negotiations.iter_mut() {
                    if let Some(d) = find(&p["creatorId"]) {
                        annotate_negotiation(p, &d["negotiation"]);
                    }
                }
            }
            Err(e) => live_error = json!(e),
        }
        mark_own_adoptions(&mut items);
    }
    Ok(
        json!({"operation":{"id":op["id"],"mode":op["mode"].as_str().unwrap_or("drafts"),"status":op["status"],"task":op["task"],"draftScope":{"channels":op["draftScope"]["channels"],"capturedAt":op["draftScope"]["capturedAt"],"creators":op["draftScope"]["creators"].as_array().map(|a|a.iter().map(|c|json!({"creatorId":c["creatorId"],"handle":c["profile"]["handle"]})).collect::<Vec<_>>())}},"proposals":items,"negotiations":negotiations,"liveError":live_error}),
    )
}

fn set_adoption(
    db: &Connection,
    id: &str,
    proposal: &str,
    expected: i64,
    status: &str,
    message: &str,
) -> Result<()> {
    db.execute(
        "INSERT INTO gapaw_draft_adoptions(adoption_id,proposal_id,expected_revision,status,message,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(adoption_id) DO UPDATE SET status=excluded.status,message=excluded.message,updated_at=excluded.updated_at",
        params![id, proposal, expected, status, message, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 采用：只在工作台当前 revision 等于用户确认的版本时写入，写后读回核对内容与 revision。
fn adopt(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &["proposalId", "adoptionId", "expectedRevision"],
        "adopt-draft",
    )?;
    let proposal_id = identifier(input, "proposalId")?;
    let adoption_id = identifier(input, "adoptionId")?;
    let expected = input["expectedRevision"]
        .as_i64()
        .filter(|r| *r >= 0)
        .ok_or("expectedRevision 必须是非负整数")?;
    let db = open_db(path, true)?.ok_or("无法打开数据库")?;
    let raw: String = db
        .query_row(
            "SELECT value FROM gapaw_draft_proposals WHERE id=?",
            [&proposal_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("草稿候选不存在")?;
    let p: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let previous: Option<(String, i64, String)> = db
        .query_row(
            "SELECT proposal_id,expected_revision,status FROM gapaw_draft_adoptions WHERE adoption_id=?",
            [&adoption_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((pid, exp, status)) = &previous {
        if *pid != proposal_id || *exp != expected {
            return Err("同一采用编号不能更换草稿或版本".into());
        }
        if status == "adopted" || status == "rejected" {
            return Ok(json!({"adoptionId":adoption_id,"status":status}));
        }
    }
    let client = Outreach::required(Some(&db))?;
    let creator = required(&p, "creatorId")?;
    let channel = required(&p, "channel")?;
    let subject = p["subject"].as_str().unwrap_or("");
    let body = required(&p, "body")?;
    let matches = |d: &Value| d["subject"] == subject && d["body"] == body;
    let current = client.detail(creator)?;
    let d = draft_of(&current, channel)?;
    let rev = revision(d)?;
    // 先核对：上次结果未知时，以读回判断是否已经写入。
    if rev == expected + 1 && matches(d) {
        set_adoption(
            &db,
            &adoption_id,
            &proposal_id,
            expected,
            "adopted",
            "已写入工作台并读回一致",
        )?;
        return Ok(json!({"adoptionId":adoption_id,"status":"adopted","revision":rev}));
    }
    if rev != expected {
        let msg = format!("工作台文案已更新到版本 {rev}，与确认时的版本 {expected} 不一致；未写入，请刷新比较后重新采用");
        set_adoption(&db, &adoption_id, &proposal_id, expected, "conflict", &msg)?;
        return Ok(
            json!({"adoptionId":adoption_id,"status":"conflict","revision":rev,"message":msg}),
        );
    }
    set_adoption(
        &db,
        &adoption_id,
        &proposal_id,
        expected,
        "pending",
        "正在写入工作台",
    )?;
    match client.edit_draft(creator, channel, subject, body, expected) {
        Ok(Ok(_)) | Err(_) => {
            // 无论响应如何，只以独立读回为准。
            let after = client.detail(creator).and_then(|v| {
                let d = draft_of(&v, channel)?;
                Ok((revision(d)?, matches(d)))
            });
            match after {
                Ok((r, true)) if r == expected + 1 => {
                    set_adoption(
                        &db,
                        &adoption_id,
                        &proposal_id,
                        expected,
                        "adopted",
                        "已写入工作台并读回一致",
                    )?;
                    Ok(json!({"adoptionId":adoption_id,"status":"adopted","revision":r}))
                }
                Ok((r, _)) if r == expected => {
                    let msg = "工作台未写入，可用同一采用编号重试";
                    set_adoption(
                        &db,
                        &adoption_id,
                        &proposal_id,
                        expected,
                        "not_applied",
                        msg,
                    )?;
                    Ok(json!({"adoptionId":adoption_id,"status":"not_applied","message":msg}))
                }
                Ok((r, _)) => {
                    let msg = format!("工作台文案已变为版本 {r}，内容与本草稿不一致；请刷新比较");
                    set_adoption(&db, &adoption_id, &proposal_id, expected, "conflict", &msg)?;
                    Ok(json!({"adoptionId":adoption_id,"status":"conflict","message":msg}))
                }
                Err(e) => {
                    let msg = format!("写入结果未知：{e}；请用同一采用编号重试核对");
                    set_adoption(&db, &adoption_id, &proposal_id, expected, "unknown", &msg)?;
                    Ok(json!({"adoptionId":adoption_id,"status":"unknown","message":msg}))
                }
            }
        }
        Ok(Err(msg)) => {
            let status = if msg.contains("已更新") {
                "conflict"
            } else {
                "rejected"
            };
            let msg = format!("工作台拒绝保存：{msg}");
            set_adoption(&db, &adoption_id, &proposal_id, expected, status, &msg)?;
            Ok(json!({"adoptionId":adoption_id,"status":status,"message":msg}))
        }
    }
}

fn set_negotiation_adoption(
    db: &Connection,
    id: &str,
    proposal: &str,
    expected: Option<&str>,
    status: &str,
    message: &str,
) -> Result<()> {
    db.execute(
        "INSERT INTO gapaw_negotiation_adoptions(adoption_id,proposal_id,expected_updated,status,message,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(adoption_id) DO UPDATE SET status=excluded.status,message=excluded.message,updated_at=excluded.updated_at",
        params![id, proposal, expected, status, message, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 采用谈判摘要。工作台的谈判摘要没有版本号，只能以 updated 时间核对：写入前确认仍是用户看到的版本，写后读回字段。
fn adopt_negotiation(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &["proposalId", "adoptionId", "expectedUpdated"],
        "adopt-negotiation",
    )?;
    let proposal_id = identifier(input, "proposalId")?;
    let adoption_id = identifier(input, "adoptionId")?;
    let expected: Option<String> = match input.get("expectedUpdated") {
        Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 64 => Some(s.clone()),
        _ => {
            return Err(
                "expectedUpdated 必须是确认时看到的更新时间，或 null 表示原本没有摘要".into(),
            )
        }
    };
    let db = open_db(path, true)?.ok_or("无法打开数据库")?;
    let raw: String = db
        .query_row(
            "SELECT value FROM gapaw_negotiation_proposals WHERE id=?",
            [&proposal_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("谈判摘要候选不存在")?;
    let p: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let previous: Option<(String, Option<String>, String)> = db
        .query_row(
            "SELECT proposal_id,expected_updated,status FROM gapaw_negotiation_adoptions WHERE adoption_id=?",
            [&adoption_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((pid, exp, status)) = &previous {
        if *pid != proposal_id || *exp != expected {
            return Err("同一采用编号不能更换摘要或版本".into());
        }
        if status == "adopted" || status == "rejected" {
            return Ok(json!({"adoptionId":adoption_id,"status":status}));
        }
    }
    let client = Outreach::required(Some(&db))?;
    let creator = required(&p, "creatorId")?;
    let fields = &p["fields"];
    let same = |n: &Value| {
        NEGOTIATION_FIELDS
            .iter()
            .all(|k| n[*k].as_str().unwrap_or("") == fields[*k].as_str().unwrap_or(""))
    };
    let current = client.detail(creator)?["negotiation"].clone();
    if same(&current) {
        set_negotiation_adoption(
            &db,
            &adoption_id,
            &proposal_id,
            expected.as_deref(),
            "adopted",
            "工作台谈判摘要与本候选一致",
        )?;
        return Ok(
            json!({"adoptionId":adoption_id,"status":"adopted","updated":current["updated"]}),
        );
    }
    let now_updated = current["updated"].as_str().map(String::from);
    if now_updated != expected {
        let msg = "工作台谈判摘要已在你确认之后被修改；未写入，请刷新比较后重新采用";
        set_negotiation_adoption(
            &db,
            &adoption_id,
            &proposal_id,
            expected.as_deref(),
            "conflict",
            msg,
        )?;
        return Ok(json!({"adoptionId":adoption_id,"status":"conflict","message":msg}));
    }
    set_negotiation_adoption(
        &db,
        &adoption_id,
        &proposal_id,
        expected.as_deref(),
        "pending",
        "正在写入工作台",
    )?;
    let posted = client.post(
        &format!("/api/creators/{creator}/negotiation"),
        &pick(fields, NEGOTIATION_FIELDS),
    );
    if let Ok(Err(msg)) = posted {
        let msg = format!("工作台拒绝保存：{msg}");
        set_negotiation_adoption(
            &db,
            &adoption_id,
            &proposal_id,
            expected.as_deref(),
            "rejected",
            &msg,
        )?;
        return Ok(json!({"adoptionId":adoption_id,"status":"rejected","message":msg}));
    }
    // 无论响应如何，只以独立读回为准。
    match client.detail(creator) {
        Ok(after) if same(&after["negotiation"]) => {
            set_negotiation_adoption(
                &db,
                &adoption_id,
                &proposal_id,
                expected.as_deref(),
                "adopted",
                "已写入工作台并读回一致",
            )?;
            Ok(
                json!({"adoptionId":adoption_id,"status":"adopted","updated":after["negotiation"]["updated"]}),
            )
        }
        Ok(after) if after["negotiation"]["updated"].as_str().map(String::from) == expected => {
            let msg = "工作台未写入，可用同一采用编号重试";
            set_negotiation_adoption(
                &db,
                &adoption_id,
                &proposal_id,
                expected.as_deref(),
                "not_applied",
                msg,
            )?;
            Ok(json!({"adoptionId":adoption_id,"status":"not_applied","message":msg}))
        }
        Ok(_) => {
            let msg = "工作台谈判摘要已变化，内容与本候选不一致；请刷新比较";
            set_negotiation_adoption(
                &db,
                &adoption_id,
                &proposal_id,
                expected.as_deref(),
                "conflict",
                msg,
            )?;
            Ok(json!({"adoptionId":adoption_id,"status":"conflict","message":msg}))
        }
        Err(e) => {
            let msg = format!("写入结果未知：{e}；请用同一采用编号重试核对");
            set_negotiation_adoption(
                &db,
                &adoption_id,
                &proposal_id,
                expected.as_deref(),
                "unknown",
                &msg,
            )?;
            Ok(json!({"adoptionId":adoption_id,"status":"unknown","message":msg}))
        }
    }
}

pub fn execute(
    command: &str,
    input: Value,
    path: &Path,
    host: Option<(String, String)>,
) -> Result<Value> {
    match command {
        "outreach-status" => {
            let db = open_db(path, false)?;
            match Outreach::configured(db.as_ref()) {
                Ok(None) => Ok(
                    json!({"configured":false,"available":false,"url":null,"message":"尚未填写现有达人工作台地址。"}),
                ),
                Err(e) => Ok(json!({"configured":true,"available":false,"url":null,"message":e})),
                Ok(Some(c)) => Ok(match c.health() {
                    Ok(()) => {
                        json!({"configured":true,"available":true,"url":c.root,"message":"现有达人工作台可读取。"})
                    }
                    Err(e) => json!({"configured":true,"available":false,"url":c.root,"message":e}),
                }),
            }
        }
        "outreach-configure" => {
            only_keys(&input, &["url"], "outreach-configure")?;
            let client = Outreach::new(required(&input, "url")?)?;
            client.health()?;
            let db = open_db(path, true)?.ok_or("无法打开数据库")?;
            db.execute("INSERT INTO settings(key,value) VALUES('outreach',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [json!({"url":client.root}).to_string()]).map_err(|e| e.to_string())?;
            Ok(json!({"configured":true,"available":true,"url":client.root}))
        }
        "outreach-creators" => {
            let db = open_db(path, false)?;
            let client = Outreach::required(db.as_ref())?;
            let v = client.get("/api/creators")?;
            let items: Vec<Value> = v["items"]
                .as_array()
                .ok_or("工作台达人列表格式不兼容")?
                .iter()
                .map(|c| {
                    pick(
                        c,
                        &[
                            "id",
                            "rank",
                            "handle",
                            "priority",
                            "followers",
                            "topic",
                            "stage",
                            "negotiation_status",
                        ],
                    )
                })
                .collect();
            Ok(json!({"items":items}))
        }
        "prepare-drafts" => prepare(&input, path, host),
        "draft-context" => {
            only_keys(&input, &["operationId", "taskId"], "draft-context")?;
            let db = open_db(path, false)?.ok_or("操作单不存在")?;
            let op = bound(
                &db,
                &identifier(&input, "operationId")?,
                &identifier(&input, "taskId")?,
            )?;
            Ok(
                json!({"operationId":op["id"],"taskId":op["task"]["taskId"],"methodVersion":METHOD_VERSION,"scope":op["draftScope"],"mode":op["mode"].as_str().unwrap_or("drafts"),"placeholders":AUTO_PLACEHOLDERS,"manualPlaceholders":MANUAL_PLACEHOLDERS,"submissionTemplate":submission_template(&op)}),
            )
        }
        "submit-drafts" => submit(&input, path),
        "get-drafts" => get(&input, path),
        "adopt-draft" => adopt(&input, path),
        "adopt-negotiation" => adopt_negotiation(&input, path),
        _ => Err("不支持的插件命令".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_fee_mirrors_workbench_rule() {
        assert!(regex_like_fixed_fee("pay 50 美元 total"));
        assert!(regex_like_fixed_fee("100美元"));
        assert!(!regex_like_fixed_fee(
            "150美元 is not matched by prefix rule"
        ));
        assert!(!regex_like_fixed_fee("【固定费】 for 2 videos"));
    }
}
