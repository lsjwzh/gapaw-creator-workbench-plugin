//! 显式配置的本机工作台候选区客户端；提交动作与读回核验分离。
use crate::{identifier, now, open_db, platform::bound_operation, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, env, io::Read, path::Path, time::Duration};

const MAX_PAYLOAD: usize = 900_000;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const PENDING: &str = "candidate_pending_verification";
const RECEIPT_KEYS: &[&str] = &[
    "schemaVersion",
    "adoptionId",
    "businessStoreId",
    "payloadHash",
    "batchId",
    "operationId",
    "taskId",
    "resultId",
    "resultRevision",
    "candidateCount",
    "candidateIds",
    "status",
    "createdAt",
];

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS gapaw_workbench_adoptions(adoption_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,result_id TEXT NOT NULL,payload TEXT NOT NULL,endpoint TEXT NOT NULL,preview TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,message TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS gapaw_workbench_adoptions_report ON gapaw_workbench_adoptions(operation_id,result_id);")
        .map_err(|_| "无法初始化业务候选提交计划".into())
}
fn keys(v: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let o = v.as_object().ok_or("候选区数据必须是对象")?;
    if required.iter().any(|k| !o.contains_key(*k))
        || o.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err("候选区数据包含缺失或不支持的字段".into());
    }
    Ok(())
}
fn text(v: &Value, max: usize) -> Result<&str> {
    v.as_str()
        .filter(|s| {
            s.chars().count() <= max && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
        })
        .ok_or_else(|| "候选区文本格式无效".into())
}
fn string_list(v: &Value, max: usize) -> Result<()> {
    for item in v
        .as_array()
        .filter(|a| a.len() <= max)
        .ok_or("候选区列表格式无效")?
    {
        text(item, 2000)?;
    }
    Ok(())
}
fn missing_fields(v: &Value) -> Result<()> {
    for item in v
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or("缺失字段列表无效")?
    {
        if item
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 500)
        {
            return Err("缺失字段必须是非空短文本".into());
        }
    }
    Ok(())
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
pub(crate) fn endpoint(raw: &str) -> Result<String> {
    let root = raw.strip_suffix('/').unwrap_or(raw);
    let port = root
        .strip_prefix("http://127.0.0.1:")
        .ok_or("仅允许显式配置 http://127.0.0.1:端口 的工作台接口")?;
    let parsed = port
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or("工作台接口端口无效")?;
    if port != parsed.to_string() {
        return Err("工作台接口必须是无路径、账号、查询参数的本机地址".into());
    }
    Ok(root.into())
}
struct Client {
    endpoint: String,
    token: String,
    agent: ureq::Agent,
}
impl Client {
    fn configured() -> Result<Option<Self>> {
        let url = env::var("GAPAW_WORKBENCH_URL").ok();
        let token = env::var("GAPAW_WORKBENCH_ADOPTION_TOKEN").ok();
        if url.is_none() && token.is_none() {
            return Ok(None);
        }
        let endpoint = endpoint(&url.ok_or("尚未配置工作台接口地址")?)?;
        let token = token.ok_or("尚未配置工作台候选区授权")?;
        if token.len() < 32 || token.len() > 4096 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("工作台候选区授权配置无效".into());
        }
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .try_proxy_from_env(false)
            .timeout(Duration::from_secs(4))
            .build();
        Ok(Some(Self {
            endpoint,
            token,
            agent,
        }))
    }
    fn required() -> Result<Self> {
        Self::configured()?.ok_or_else(|| "请先配置本机工作台候选区接口与授权".into())
    }
    fn call(&self, action: &str, payload: &Value) -> Result<Value> {
        let response = self
            .agent
            .post(&format!("{}/api/plugin-selection", self.endpoint))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Content-Type", "application/json")
            .send_string(&json!({"action":action,"payload":payload}).to_string())
            .map_err(|_| {
                "工作台请求未得到可确认响应，请检查本机服务、授权与网络后用原动作编号核对"
                    .to_string()
            })?;
        if response.status() != 200 {
            return Err("工作台返回非成功状态；未跟随跳转或回显响应".into());
        }
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take((MAX_RESPONSE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "工作台响应读取失败，请保留原动作编号重试核对")?;
        if bytes.len() > MAX_RESPONSE {
            return Err("工作台响应超过 2 MiB 限制".into());
        }
        let raw = String::from_utf8(bytes).map_err(|_| "工作台响应编码无效")?;
        if raw.contains(&self.token) {
            return Err("工作台响应包含授权信息，已拒绝显示与保存".into());
        }
        let value: Value = serde_json::from_str(&raw).map_err(|_| "工作台未返回有效的协议数据")?;
        if value["ok"] != true {
            return Err("工作台拒绝该请求，请检查候选区配置与原操作状态".into());
        }
        keys(&value, &["ok", "data"], &[])?;
        Ok(value["data"].clone())
    }
    fn status(&self) -> Result<Value> {
        let data = self.call("status", &json!({}))?;
        keys(
            &data,
            &["protocolVersion", "ready", "businessStoreId", "status"],
            &[],
        )?;
        if data["protocolVersion"] != 1 || !data["ready"].is_boolean() {
            return Err("工作台候选区协议版本不兼容".into());
        }
        if data["ready"] == true {
            identifier(&data, "businessStoreId")?;
            if data["status"] != "ready" {
                return Err("工作台候选区状态不一致".into());
            }
        } else if !data["businessStoreId"].is_null() || data["status"] != "uninitialized" {
            return Err("工作台候选区状态不一致".into());
        }
        Ok(data)
    }
    fn ready_store(&self) -> Result<String> {
        let s = self.status()?;
        if s["ready"] != true {
            return Err("工作台候选区尚未显式初始化".into());
        }
        identifier(&s, "businessStoreId")
    }
}
fn has_table(db: &Connection) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='gapaw_workbench_adoptions')",[],|r|r.get(0)).map_err(|_|"无法读取提交计划结构".into())
}
fn parse(raw: &str) -> Result<Value> {
    serde_json::from_str(raw).map_err(|_| "已保存提交计划损坏".into())
}
fn report(
    db: &Connection,
    operation: &str,
    task: &str,
    result: &str,
    latest: bool,
) -> Result<Value> {
    bound_operation(db, operation, task)?;
    let row: Option<(String, u64)> = db
        .query_row(
            "SELECT record,revision FROM selection_results WHERE operation_id=? AND result_id=?",
            params![operation, result],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| "无法读取已保存报告")?;
    let (raw, revision) = row.ok_or("指定报告不存在或不属于本操作")?;
    let record = parse(&raw)?;
    if record["operationId"] != operation
        || record["taskId"] != task
        || record["resultId"] != result
        || record["revision"] != revision
    {
        return Err("已保存报告归属或版本不一致".into());
    }
    if latest {
        let current: u64 = db
            .query_row(
                "SELECT MAX(revision) FROM selection_results WHERE operation_id=?",
                [operation],
                |r| r.get(0),
            )
            .map_err(|_| "无法核对最新报告")?;
        if current != revision {
            return Err("报告已更新，请从最新报告重新准备候选提交计划".into());
        }
    }
    if crate::results::compute(&record["report"], crate::METHOD_VERSION)? != record["computed"] {
        return Err("已保存报告计算结果不一致".into());
    }
    Ok(record)
}
fn validate_payload(payload: &Value) -> Result<()> {
    keys(
        payload,
        &[
            "schemaVersion",
            "adoptionId",
            "expectedStoreId",
            "operationId",
            "taskId",
            "resultId",
            "resultRevision",
            "report",
            "computed",
            "observations",
        ],
        &[],
    )?;
    if payload.to_string().len() > MAX_PAYLOAD || payload["schemaVersion"] != 1 {
        return Err("候选提交载荷版本或大小无效".into());
    }
    for key in [
        "adoptionId",
        "expectedStoreId",
        "operationId",
        "taskId",
        "resultId",
    ] {
        identifier(payload, key)?;
    }
    if !payload["resultRevision"]
        .as_u64()
        .is_some_and(|n| n > 0 && n <= i64::MAX as u64)
    {
        return Err("候选提交报告版本无效".into());
    }
    if crate::results::compute(&payload["report"], crate::METHOD_VERSION)? != payload["computed"] {
        return Err("候选提交计算结果不一致".into());
    }
    if payload["report"]["candidates"]
        .as_array()
        .is_none_or(|v| v.is_empty())
    {
        return Err("空报告不能保存为业务候选".into());
    }
    let mut seen = HashSet::new();
    for o in payload["observations"]
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or("附属观测列表无效")?
    {
        crate::observations::validate_snapshot(o)?;
        if o["operationId"] != payload["operationId"]
            || o["taskId"] != payload["taskId"]
            || !seen.insert(o["observationId"].clone().to_string())
        {
            return Err("附属观测归属不一致或重复".into());
        }
    }
    Ok(())
}
fn preview_valid(v: &Value, payload: &Value) -> Result<()> {
    keys(
        v,
        &[
            "businessStoreId",
            "payloadHash",
            "candidateCount",
            "canAdopt",
            "verification",
            "warnings",
            "handleConflicts",
        ],
        &[],
    )?;
    if v["businessStoreId"] != payload["expectedStoreId"]
        || v["payloadHash"] != hash(payload)
        || v["candidateCount"] != payload["report"]["candidates"].as_array().unwrap().len()
        || v["canAdopt"] != true
        || v["verification"] != "unverified"
    {
        return Err("工作台预览的业务库、载荷摘要或数量不一致".into());
    }
    string_list(&v["warnings"], 10)?;
    conflicts_valid(&v["handleConflicts"])?;
    for c in v["handleConflicts"].as_array().unwrap() {
        if !payload["report"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["handle"] == c["reportedHandle"])
        {
            return Err("工作台预览包含不属于报告的同名提示".into());
        }
    }
    Ok(())
}
fn conflicts_valid(v: &Value) -> Result<()> {
    for c in v
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or("同名提示格式无效")?
    {
        keys(
            c,
            &["reportedHandle", "existingCount", "action", "message"],
            &[],
        )?;
        text(&c["reportedHandle"], 300)?;
        text(&c["message"], 2000)?;
        if !c["existingCount"].as_u64().is_some_and(|n| n > 0)
            || c["action"] != "manual_identity_review"
        {
            return Err("同名提示核验状态不合法".into());
        }
    }
    Ok(())
}
fn receipt_shape(r: &Value) -> Result<()> {
    keys(r, RECEIPT_KEYS, &[])?;
    for key in [
        "adoptionId",
        "businessStoreId",
        "batchId",
        "operationId",
        "taskId",
        "resultId",
    ] {
        identifier(r, key)?;
    }
    if r["schemaVersion"] != 1
        || r["status"] != PENDING
        || !r["resultRevision"].as_u64().is_some_and(|n| n > 0)
    {
        return Err("业务候选回执状态不合法".into());
    }
    let h = text(&r["payloadHash"], 64)?;
    if h.len() != 64
        || !h
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("业务候选回执摘要无效".into());
    }
    chrono::DateTime::parse_from_rfc3339(text(&r["createdAt"], 50)?)
        .map_err(|_| "业务候选回执时间无效")?;
    let ids = r["candidateIds"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 100)
        .ok_or("业务候选回执编号列表无效")?;
    let mut seen = HashSet::new();
    for id in ids {
        let id = identifier(&json!({"id":id}), "id")?;
        if !seen.insert(id) {
            return Err("业务候选回执编号重复".into());
        }
    }
    if r["candidateCount"] != ids.len() {
        return Err("业务候选回执数量不一致".into());
    }
    Ok(())
}
fn batch_shape(batch: &Value) -> Result<()> {
    let mut required = RECEIPT_KEYS.to_vec();
    required.extend([
        "verification",
        "reportMetadata",
        "observationCount",
        "warnings",
        "handleConflicts",
    ]);
    keys(batch, &required, &[])?;
    let receipt: Value = json!(RECEIPT_KEYS
        .iter()
        .map(|k| (k.to_string(), batch[*k].clone()))
        .collect::<serde_json::Map<_, _>>());
    receipt_shape(&receipt)?;
    if batch["verification"] != "unverified"
        || !batch["observationCount"].as_u64().is_some_and(|n| n <= 100)
    {
        return Err("业务候选批次核验状态不合法".into());
    }
    keys(
        &batch["reportMetadata"],
        &[
            "schemaVersion",
            "methodVersion",
            "generatedAt",
            "period",
            "currency",
            "coverage",
            "missingFields",
        ],
        &[],
    )?;
    text(&batch["reportMetadata"]["coverage"], 6000)?;
    missing_fields(&batch["reportMetadata"]["missingFields"])?;
    keys(
        &batch["reportMetadata"]["period"],
        &["start", "end", "timeZone"],
        &[],
    )?;
    for key in ["start", "end", "timeZone"] {
        text(&batch["reportMetadata"]["period"][key], 100)?;
    }
    if batch["reportMetadata"]["schemaVersion"] != 1
        || batch["reportMetadata"]["methodVersion"] != crate::METHOD_VERSION
    {
        return Err("业务候选报告方法不兼容".into());
    }
    text(&batch["reportMetadata"]["generatedAt"], 50)?;
    text(&batch["reportMetadata"]["currency"], 3)?;
    string_list(&batch["warnings"], 10)?;
    conflicts_valid(&batch["handleConflicts"])?;
    Ok(())
}
fn candidate_shape(c: &Value) -> Result<()> {
    keys(
        c,
        &[
            "candidateId",
            "batchId",
            "reportedIdentity",
            "reason",
            "computed",
            "missingFields",
            "sources",
            "verification",
            "status",
        ],
        &[],
    )?;
    identifier(c, "candidateId")?;
    identifier(c, "batchId")?;
    if c["verification"] != "unverified" || c["status"] != PENDING {
        return Err("业务候选核验状态不合法".into());
    }
    keys(
        &c["reportedIdentity"],
        &["platform", "creatorId", "handle", "profileUrl"],
        &[],
    )?;
    for key in ["platform", "creatorId", "handle", "profileUrl"] {
        text(&c["reportedIdentity"][key], 2048)?;
    }
    text(&c["reason"], 6000)?;
    missing_fields(&c["missingFields"])?;
    for source in c["sources"]
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or("业务候选来源结构无效")?
    {
        keys(source, &["url", "capturedAt", "note"], &[])?;
        for key in ["url", "capturedAt", "note"] {
            text(&source[key], 6000)?;
        }
    }
    keys(&c["computed"], &["creatorKey", "summary", "videos"], &[])?;
    text(&c["computed"]["creatorKey"], 500)?;
    keys(
        &c["computed"]["summary"],
        &[
            "status",
            "totalVideos",
            "evaluatedVideos",
            "knownPositiveVideos",
            "breakEvenCount",
            "breakEvenRate",
            "averageSurplus",
        ],
        &[],
    )?;
    for value in c["computed"]["summary"].as_object().unwrap().values() {
        if !(value.is_null() || value.is_string() || value.is_u64()) {
            return Err("业务候选计算摘要结构无效".into());
        }
        if value.is_string() {
            text(value, 200)?;
        }
    }
    for v in c["computed"]["videos"]
        .as_array()
        .filter(|a| a.len() <= 2000)
        .ok_or("业务候选视频摘要结构无效")?
    {
        keys(v, &["videoId", "surplus", "missingFields"], &[])?;
        identifier(v, "videoId")?;
        if !v["surplus"].is_null() {
            text(&v["surplus"], 200)?;
        }
        string_list(&v["missingFields"], 20)?;
    }
    Ok(())
}
fn verify_readback(data: &Value, payload: &Value) -> Result<Value> {
    keys(data, &["found", "receipt", "batch", "candidates"], &[])?;
    if data["found"] != true {
        return Err("工作台尚未读回该动作的业务回执".into());
    }
    let r = &data["receipt"];
    receipt_shape(r)?;
    let batch = &data["batch"];
    batch_shape(batch)?;
    for key in [
        "adoptionId",
        "operationId",
        "taskId",
        "resultId",
        "resultRevision",
    ] {
        if r[key] != payload[key] {
            return Err("业务回执与原操作报告不一致".into());
        }
    }
    if r["businessStoreId"] != payload["expectedStoreId"] || r["payloadHash"] != hash(payload) {
        return Err("业务回执库身份或载荷摘要不一致".into());
    }
    for key in RECEIPT_KEYS {
        if batch[*key] != r[*key] {
            return Err("业务批次与回执不一致".into());
        }
    }
    let metadata: Value = json!([
        "schemaVersion",
        "methodVersion",
        "generatedAt",
        "period",
        "currency",
        "coverage",
        "missingFields"
    ]
    .iter()
    .map(|k| (k.to_string(), payload["report"][*k].clone()))
    .collect::<serde_json::Map<_, _>>());
    if batch["reportMetadata"] != metadata
        || batch["observationCount"] != payload["observations"].as_array().unwrap().len()
    {
        return Err("业务批次的报告元数据或观测数量不一致".into());
    }
    let candidates = data["candidates"]
        .as_array()
        .ok_or("业务候选读回列表无效")?;
    let originals = payload["report"]["candidates"].as_array().unwrap();
    if candidates.len() != originals.len() || r["candidateCount"] != originals.len() {
        return Err("业务候选读回数量不一致".into());
    }
    for (i, (candidate, original)) in candidates.iter().zip(originals).enumerate() {
        candidate_shape(candidate)?;
        let expected = json!({"candidateId":r["candidateIds"][i],"batchId":r["batchId"],"reportedIdentity":{"platform":original["platform"],"creatorId":original["creatorId"],"handle":original["handle"],"profileUrl":original["profileUrl"]},"reason":original["reason"],"computed":payload["computed"]["candidates"][i],"missingFields":original["missingFields"],"sources":original["sources"],"verification":"unverified","status":PENDING});
        if *candidate != expected {
            return Err("读回候选内容、身份或计算结果与原报告不一致".into());
        }
    }
    Ok(r.clone())
}
type StoredPlanRow = (String, String, String, String, Option<String>, String, u64);

#[derive(Clone)]
struct Plan {
    payload: Value,
    endpoint: String,
    preview: Value,
    status: String,
    readback: Option<Value>,
    message: String,
    version: u64,
}
impl Plan {
    fn public(&self) -> Value {
        json!({"adoptionId":self.payload["adoptionId"],"operationId":self.payload["operationId"],"taskId":self.payload["taskId"],"resultId":self.payload["resultId"],"resultRevision":self.payload["resultRevision"],"payloadHash":hash(&self.payload),"businessStoreId":self.payload["expectedStoreId"],"candidateCount":self.payload["report"]["candidates"].as_array().unwrap().len(),"preview":self.preview,"observationIds":self.payload["observations"].as_array().unwrap().iter().map(|o|o["observationId"].clone()).collect::<Vec<_>>(),"status":self.status,"receipt":self.readback.as_ref().map(|r|r["receipt"].clone()),"message":self.message})
    }
    fn validate(&self) -> Result<()> {
        validate_payload(&self.payload)?;
        endpoint(&self.endpoint)?;
        preview_valid(&self.preview, &self.payload)?;
        text(&json!(self.message), 2000)?;
        if ![
            "prepared",
            "submission_unknown",
            "verification_pending",
            "verified",
        ]
        .contains(&self.status.as_str())
        {
            return Err("提交计划状态不合法".into());
        }
        if self.status == "verified" {
            verify_readback(
                self.readback.as_ref().ok_or("已核验计划缺少读回证据")?,
                &self.payload,
            )?;
        } else if self.readback.is_some() {
            return Err("未核验计划不能保存已核验回执".into());
        }
        Ok(())
    }
}
fn load(db: &Connection, id: &str) -> Result<Option<Plan>> {
    if !has_table(db)? {
        return Ok(None);
    }
    let row:Option<StoredPlanRow>=db.query_row("SELECT payload,endpoint,preview,status,receipt,message,version FROM gapaw_workbench_adoptions WHERE adoption_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(|_|"无法读取提交计划")?;
    row.map(
        |(payload, endpoint, preview, status, receipt, message, version)| {
            let plan = Plan {
                payload: parse(&payload)?,
                endpoint,
                preview: parse(&preview)?,
                status,
                readback: receipt.map(|r| parse(&r)).transpose()?,
                message,
                version,
            };
            plan.validate()?;
            if plan.payload["adoptionId"] != id {
                return Err("提交计划编号不一致".into());
            }
            Ok(plan)
        },
    )
    .transpose()
}
fn required_plan(path: &Path, id: &str) -> Result<Plan> {
    let db = open_db(path, false)?.ok_or("提交计划不存在")?;
    load(&db, id)?.ok_or_else(|| "提交计划不存在".into())
}
fn check_client(client: &Client, plan: &Plan) -> Result<()> {
    if client.endpoint != plan.endpoint {
        return Err("工作台接口地址已变化，不能沿用旧提交计划".into());
    }
    if client.ready_store()? != plan.payload["expectedStoreId"] {
        return Err("工作台业务库身份已变化，不能沿用旧提交计划".into());
    }
    Ok(())
}
fn persist_transition(
    path: &Path,
    id: &str,
    status: &str,
    readback: Option<Value>,
    message: &str,
) -> Result<Plan> {
    let mut db = open_db(path, true)?.ok_or("无法打开提交计划数据库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "提交计划正忙")?;
    let mut plan = load(&tx, id)?.ok_or("提交计划不存在")?;
    let rank = |s: &str| match s {
        "prepared" => 0,
        "submission_unknown" => 1,
        "verification_pending" => 2,
        "verified" => 3,
        _ => 4,
    };
    if plan.status == "verified" || rank(status) < rank(&plan.status) {
        return Ok(plan);
    }
    plan.status = status.into();
    plan.readback = readback;
    plan.message = message.into();
    plan.validate()?;
    let changed=tx.execute("UPDATE gapaw_workbench_adoptions SET status=?,receipt=?,message=?,version=version+1 WHERE adoption_id=? AND version=? AND status<>'verified'",params![plan.status,plan.readback.as_ref().map(Value::to_string),plan.message,id,plan.version]).map_err(|_|"无法保存提交计划状态")?;
    if changed != 1 {
        return Err("提交计划已更新，请重新读取原动作".into());
    }
    plan.version += 1;
    tx.commit().map_err(|_| "无法保存提交计划状态")?;
    Ok(plan)
}
fn reconcile(client: &Client, path: &Path, plan: &Plan) -> Result<Plan> {
    if plan.status == "verified" {
        return Ok(plan.clone());
    }
    let id = plan.payload["adoptionId"].as_str().unwrap();
    let result = client.call("receipt", &json!({"adoptionId":id}));
    match result {
        Ok(data) if verify_readback(&data, &plan.payload).is_ok() => persist_transition(
            path,
            id,
            "verified",
            Some(data),
            "业务候选已保存并读回核对；身份、来源与费用仍待核验。",
        ),
        Ok(data) if data == json!({"found":false}) => persist_transition(
            path,
            id,
            &plan.status,
            None,
            "尚未读到原动作回执；保留原编号，可继续核对或重试同一提交。",
        ),
        _ => persist_transition(
            path,
            id,
            &plan.status,
            None,
            "回执读取或内容核对尚未通过；未标记成功，请保留原编号继续核对。",
        ),
    }
}
fn observations(db: &Connection, ids: &Value, operation: &str, task: &str) -> Result<Vec<Value>> {
    let ids = ids
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or("observationIds 必须是最多100项的数组")?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        let id = identifier(&json!({"id":id}), "id")?;
        if !seen.insert(id.clone()) {
            return Err("来源观测编号不能重复".into());
        }
        let raw:Option<String>=db.query_row("SELECT snapshot FROM source_observations WHERE observation_id=? AND operation_id=? AND task_id=?",params![id,operation,task],|r|r.get(0)).optional().map_err(|_|"无法读取原操作的来源观测")?;
        let value = parse(&raw.ok_or("来源观测不存在或不属于原操作任务")?)?;
        crate::observations::validate_snapshot(&value)?;
        if value["operationId"] != operation
            || value["taskId"] != task
            || value["observationId"] != id
        {
            return Err("来源观测归属不一致".into());
        }
        out.push(value);
    }
    Ok(out)
}
fn prepare(input: &Value, path: &Path) -> Result<Value> {
    keys(
        input,
        &[
            "operationId",
            "taskId",
            "resultId",
            "adoptionId",
            "observationIds",
        ],
        &[],
    )?;
    let op = identifier(input, "operationId")?;
    let task = identifier(input, "taskId")?;
    let result = identifier(input, "resultId")?;
    let id = identifier(input, "adoptionId")?;
    let db = open_db(path, false)?.ok_or("操作单不存在")?;
    bound_operation(&db, &op, &task)?;
    if let Some(old) = load(&db, &id)? {
        let old_ids = json!(old.payload["observations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["observationId"].clone())
            .collect::<Vec<_>>());
        if old.payload["operationId"] != op
            || old.payload["taskId"] != task
            || old.payload["resultId"] != result
            || old_ids != input["observationIds"]
        {
            return Err("同一采纳编号不能改变原操作、报告或观测附件".into());
        }
        let client = Client::required()?;
        check_client(&client, &old)?;
        return Ok(json!({"plan":old.public(),"preview":old.preview}));
    }
    if has_table(&db)? {
        let duplicate:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM gapaw_workbench_adoptions WHERE operation_id=? AND result_id=? AND status<>'prepared')",params![op,result],|r|r.get(0)).map_err(|_|"无法核对已有提交计划")?;
        if duplicate {
            return Err("此报告已有已发起提交的计划，请读取并沿用原采纳编号恢复".into());
        }
    }
    let record = report(&db, &op, &task, &result, true)?;
    let observations = observations(&db, &input["observationIds"], &op, &task)?;
    drop(db);
    let client = Client::required()?;
    let store = client.ready_store()?;
    let payload = json!({"schemaVersion":1,"adoptionId":id,"expectedStoreId":store,"operationId":op,"taskId":task,"resultId":result,"resultRevision":record["revision"],"report":record["report"],"computed":record["computed"],"observations":observations});
    validate_payload(&payload)?;
    let preview = client.call("preview", &payload)?;
    preview_valid(&preview, &payload)?;
    let plan = Plan {
        payload,
        endpoint: client.endpoint,
        preview,
        status: "prepared".into(),
        readback: None,
        message: "已生成待确认计划；尚未写入业务候选区。".into(),
        version: 0,
    };
    plan.validate()?;
    let mut db = open_db(path, true)?.ok_or("无法打开提交计划数据库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "提交计划正忙")?;
    init(&tx)?;
    let current = report(&tx, &op, &task, &result, true)?;
    if current["report"] != plan.payload["report"]
        || current["computed"] != plan.payload["computed"]
    {
        return Err("报告在预览期间发生变化，请重新准备".into());
    }
    if let Some(existing) = load(&tx, &id)? {
        if existing.payload != plan.payload || existing.endpoint != plan.endpoint {
            return Err("采纳编号已用于不同计划".into());
        }
        return Ok(json!({"plan":existing.public(),"preview":existing.preview}));
    }
    tx.execute(
        "INSERT INTO gapaw_workbench_adoptions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        params![
            id,
            op,
            result,
            plan.payload.to_string(),
            plan.endpoint,
            plan.preview.to_string(),
            plan.status,
            Option::<String>::None,
            plan.message,
            0,
            now()
        ],
    )
    .map_err(|_| "此报告已有并发提交计划，请读取并沿用原采纳编号")?;
    tx.commit().map_err(|_| "无法保存提交计划")?;
    Ok(json!({"plan":plan.public(),"preview":plan.preview}))
}
fn adopt(input: &Value, path: &Path) -> Result<Value> {
    keys(input, &["adoptionId", "expectedPayloadHash"], &[])?;
    let id = identifier(input, "adoptionId")?;
    let plan = required_plan(path, &id)?;
    if input["expectedPayloadHash"] != hash(&plan.payload) {
        return Err("提交摘要与已准备计划不一致，请重新核对".into());
    }
    let client = Client::required()?;
    check_client(&client, &plan)?;
    if plan.status == "verified" {
        return Ok(json!({"plan":plan.public()}));
    }
    if plan.status == "verification_pending" {
        return Ok(json!({"plan":reconcile(&client,path,&plan)?.public()}));
    }
    if plan.status == "submission_unknown" {
        let checked = reconcile(&client, path, &plan)?;
        if checked.status == "verified" {
            return Ok(json!({"plan":checked.public()}));
        }
    }
    // 第一次写入前再核对最新报告；未知提交允许沿用原载荷恢复。
    let mut db = open_db(path, true)?.ok_or("无法打开提交计划数据库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "提交计划正忙")?;
    let mut current = load(&tx, &id)?.ok_or("提交计划不存在")?;
    if current.status == "verified" || current.status == "verification_pending" {
        return Ok(json!({"plan":current.public()}));
    }
    if current.endpoint != client.endpoint || hash(&current.payload) != input["expectedPayloadHash"]
    {
        return Err("提交计划已变化，请重新读取".into());
    }
    if current.status == "prepared" {
        let other_active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM gapaw_workbench_adoptions WHERE operation_id=? AND result_id=? AND adoption_id<>? AND status<>'prepared')",
            params![current.payload["operationId"].as_str(), current.payload["resultId"].as_str(), id],
            |r|r.get(0)).map_err(|_| "无法核对同报告的未完成提交")?;
        if other_active {
            return Err("此报告已有其他已发起的提交，请沿用原动作核对，不能重复写入".into());
        }
        let record = report(
            &tx,
            current.payload["operationId"].as_str().unwrap(),
            current.payload["taskId"].as_str().unwrap(),
            current.payload["resultId"].as_str().unwrap(),
            true,
        )?;
        if record["report"] != current.payload["report"]
            || record["computed"] != current.payload["computed"]
        {
            return Err("报告内容已改变，不能提交旧计划".into());
        }
    }
    tx.execute("UPDATE gapaw_workbench_adoptions SET status='submission_unknown',message=?,version=version+1 WHERE adoption_id=? AND version=?",params!["提交请求已开始，结果尚未确认；请保留原动作编号。",id,current.version]).map_err(|_|"无法记录提交状态")?;
    tx.commit().map_err(|_| "无法记录提交状态")?;
    drop(db);
    current.status = "submission_unknown".into();
    match client.call("adopt", &current.payload) {
        Ok(_) => {
            let pending = persist_transition(
                path,
                &id,
                "verification_pending",
                None,
                "写入已应答，正在独立读回核对业务候选。",
            )?;
            Ok(json!({"plan":reconcile(&client,path,&pending)?.public()}))
        }
        Err(_) => Ok(
            json!({"plan":persist_transition(path,&id,"submission_unknown",None,"提交结果未知；保留原编号和载荷，可核对回执或重试同一提交。")?.public()}),
        ),
    }
}
fn page_input(input: &Value, batch: bool) -> Result<Value> {
    keys(
        input,
        if batch { &["batchId"] } else { &[] },
        &["offset", "limit"],
    )?;
    let offset = input
        .get("offset")
        .unwrap_or(&json!(0))
        .as_u64()
        .filter(|v| *v <= 1_000_000)
        .ok_or("分页偏移无效")?;
    let limit = input
        .get("limit")
        .unwrap_or(&json!(20))
        .as_u64()
        .filter(|v| *v > 0 && *v <= 50)
        .ok_or("分页大小必须是1到50")?;
    let mut out = json!({"offset":offset,"limit":limit});
    if batch {
        out["batchId"] = json!(identifier(input, "batchId")?)
    }
    Ok(out)
}
fn page_output(data: Value, input: &Value, batch: bool, store: &str) -> Result<Value> {
    keys(
        &data,
        if batch {
            &[
                "batch",
                "candidates",
                "total",
                "offset",
                "limit",
                "nextOffset",
            ]
        } else {
            &["items", "total", "offset", "limit", "nextOffset"]
        },
        &[],
    )?;
    let total = data["total"].as_u64().ok_or("业务候选分页总量无效")?;
    if data["offset"] != input["offset"] || data["limit"] != input["limit"] {
        return Err("业务候选分页位置不一致".into());
    }
    let offset = input["offset"].as_u64().unwrap();
    let limit = input["limit"].as_u64().unwrap();
    let expected = if offset + limit < total {
        json!(offset + limit)
    } else {
        Value::Null
    };
    if data["nextOffset"] != expected {
        return Err("业务候选分页状态不一致".into());
    }
    let items = data[if batch { "candidates" } else { "items" }]
        .as_array()
        .filter(|a| a.len() <= limit as usize)
        .ok_or("业务候选分页列表无效")?;
    if items.len() as u64 != limit.min(total.saturating_sub(offset)) {
        return Err("业务候选分页条数不完整，不能视为完整页面".into());
    }
    if batch {
        batch_shape(&data["batch"])?;
        if data["batch"]["businessStoreId"] != store {
            return Err("业务候选批次与当前业务库身份不一致".into());
        }
        if data["batch"]["batchId"] != input["batchId"] || data["batch"]["candidateCount"] != total
        {
            return Err("业务候选批次归属不一致".into());
        }
        for (i, item) in items.iter().enumerate() {
            candidate_shape(item)?;
            if item["batchId"] != input["batchId"]
                || item["candidateId"] != data["batch"]["candidateIds"][offset as usize + i]
            {
                return Err("业务候选分页内容归属不一致".into());
            }
        }
    } else {
        for item in items {
            batch_shape(item)?;
            if item["businessStoreId"] != store {
                return Err("业务候选列表与当前业务库身份不一致".into());
            }
        }
    }
    Ok(data)
}
pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    match command {
        "workbench-status" => {
            keys(&input, &[], &[])?;
            match Client::configured() {
                Ok(None) => Ok(
                    json!({"configured":false,"available":false,"ready":false,"businessStoreId":null,"message":"尚未配置本机工作台候选区接口。"}),
                ),
                Err(_) => Ok(
                    json!({"configured":true,"available":false,"ready":false,"businessStoreId":null,"message":"工作台接口或授权配置无效，请检查本机地址和授权设置。"}),
                ),
                Ok(Some(client)) => match client.status() {
                    Ok(s) => Ok(
                        json!({"configured":true,"available":true,"ready":s["ready"],"businessStoreId":s["businessStoreId"],"message":if s["ready"]==true{"工作台候选区可用；写入后仍需读回核对，候选身份与指标保持待核验。"}else{"工作台候选区尚未显式初始化。"}}),
                    ),
                    Err(_) => Ok(
                        json!({"configured":true,"available":false,"ready":false,"businessStoreId":null,"message":"无法确认工作台候选区可用，请检查本机服务、授权和协议。"}),
                    ),
                },
            }
        }
        "prepare-adoption" => prepare(&input, path),
        "adopt-result" => adopt(&input, path),
        "reconcile-adoption" => {
            keys(&input, &["adoptionId"], &[])?;
            let id = identifier(&input, "adoptionId")?;
            let plan = required_plan(path, &id)?;
            let client = Client::required()?;
            check_client(&client, &plan)?;
            Ok(json!({"plan":reconcile(&client,path,&plan)?.public()}))
        }
        "get-adoption" => {
            keys(&input, &["operationId"], &["resultId"])?;
            let op = identifier(&input, "operationId")?;
            let result = if input.get("resultId").is_some() {
                Some(identifier(&input, "resultId")?)
            } else {
                None
            };
            let mut plans = Vec::new();
            if let Some(db) = open_db(path, false)? {
                if has_table(&db)? {
                    let mut stmt=db.prepare("SELECT adoption_id FROM gapaw_workbench_adoptions WHERE operation_id=? AND (? IS NULL OR result_id=?) ORDER BY created_at DESC,rowid DESC LIMIT 101").map_err(|_|"无法读取提交计划")?;
                    let rows = stmt
                        .query_map(params![op, result, result], |r| r.get::<_, String>(0))
                        .map_err(|_| "无法读取提交计划")?;
                    for row in rows {
                        let plan = load(&db, &row.map_err(|_| "无法读取提交计划")?)?
                            .ok_or("提交计划不存在")?;
                        if plan.payload["operationId"] != op
                            || result
                                .as_ref()
                                .is_some_and(|r| plan.payload["resultId"] != *r)
                        {
                            return Err("提交计划归属不一致".into());
                        }
                        plans.push(plan.public());
                    }
                }
            }
            if plans.len() > 100 {
                return Err("提交计划超过单次读取限制".into());
            }
            Ok(json!({"plans":plans}))
        }
        "workbench-list" | "workbench-batch" => {
            let batch = command == "workbench-batch";
            let payload = page_input(&input, batch)?;
            let client = Client::required()?;
            let store = client.ready_store()?;
            page_output(
                client.call(if batch { "batch" } else { "list" }, &payload)?,
                &payload,
                batch,
                &store,
            )
        }
        _ => Err("不支持的工作台候选区命令".into()),
    }
}
