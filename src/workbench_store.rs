//! 工作台候选区供应端。只写同一旧业务库中独立命名的候选对象，不改旧达人事实。
use crate::{identifier, now, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const MAX_PAYLOAD: usize = 900_000;
const STATUS: &str = "candidate_pending_verification";
const LEGACY: &[(&str, &str)] = &[
    ("creators", "CREATE TABLE creators(id TEXT PRIMARY KEY,handle TEXT UNIQUE,profile TEXT NOT NULL,settings TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)"),
    ("drafts", "CREATE TABLE drafts(creator TEXT REFERENCES creators(id),channel TEXT,subject TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(creator,channel))"),
    ("events", "CREATE TABLE events(id TEXT PRIMARY KEY,creator TEXT REFERENCES creators(id),channel TEXT,type TEXT,at TEXT,proof TEXT,note TEXT,created TEXT,void_reason TEXT DEFAULT '',request_id TEXT UNIQUE)"),
    ("audit", "CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,kind TEXT,creator TEXT,previous TEXT,current TEXT)"),
    ("meta", "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)"),
    ("messages", "CREATE TABLE messages(id TEXT PRIMARY KEY,creator TEXT REFERENCES creators(id),channel TEXT,direction TEXT,at TEXT,sender TEXT,subject TEXT,body TEXT,zh TEXT,kind TEXT,source TEXT UNIQUE,created TEXT)"),
    ("negotiations", "CREATE TABLE negotiations(creator TEXT PRIMARY KEY REFERENCES creators(id),status TEXT,our_offer TEXT,their_ask TEXT,next_step TEXT,updated TEXT)"),
];
const OWN: &[(&str, &str)] = &[
    ("gapaw_selection_meta", "CREATE TABLE gapaw_selection_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)"),
    ("gapaw_selection_batches", "CREATE TABLE gapaw_selection_batches(batch_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,task_id TEXT NOT NULL,result_id TEXT NOT NULL,result_revision INTEGER NOT NULL,summary TEXT NOT NULL,report TEXT NOT NULL,computed TEXT NOT NULL,UNIQUE(operation_id,result_id,result_revision))"),
    ("gapaw_selection_candidates", "CREATE TABLE gapaw_selection_candidates(candidate_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES gapaw_selection_batches(batch_id),ordinal INTEGER NOT NULL,detail TEXT NOT NULL,raw_candidate TEXT NOT NULL,UNIQUE(batch_id,ordinal))"),
    ("gapaw_selection_observations", "CREATE TABLE gapaw_selection_observations(batch_id TEXT NOT NULL REFERENCES gapaw_selection_batches(batch_id),observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(batch_id,observation_id))"),
    ("gapaw_selection_receipts", "CREATE TABLE gapaw_selection_receipts(adoption_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL UNIQUE REFERENCES gapaw_selection_batches(batch_id),payload_hash TEXT NOT NULL,receipt TEXT NOT NULL)"),
    ("gapaw_selection_audit", "CREATE TABLE gapaw_selection_audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,action TEXT NOT NULL,batch_id TEXT NOT NULL REFERENCES gapaw_selection_batches(batch_id),adoption_id TEXT NOT NULL,payload_hash TEXT NOT NULL)"),
];

fn keys(v: &Value, allowed: &[&str]) -> Result<()> {
    let object = v.as_object().ok_or("候选区请求必须为对象")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("候选区请求包含不支持的字段".into());
    }
    Ok(())
}
fn authorize(input: &Value) -> Result<()> {
    let token = env::var("GAPAW_WORKBENCH_ADOPTION_TOKEN").map_err(|_| "候选区授权尚未配置")?;
    if token.len() < 32 || token.len() > 4096 || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("候选区授权配置无效".into());
    }
    let supplied = input["authorization"]
        .as_str()
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    // 不将凭证回显、散列、持久化或包含在错误中。
    let mut difference = token.len() ^ supplied.len();
    for (index, byte) in token.bytes().enumerate() {
        difference |= (byte ^ supplied.as_bytes().get(index).copied().unwrap_or(0)) as usize;
    }
    if difference != 0 {
        return Err("候选区授权失败".into());
    }
    Ok(())
}
fn configured_path() -> Result<PathBuf> {
    let path = PathBuf::from(env::var_os("GAPAW_WORKBENCH_DB").ok_or("候选区业务库尚未配置")?);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || crate::in_worktree(&path)
    {
        return Err("候选区业务库路径不符合持久目录要求".into());
    }
    let mut part = PathBuf::new();
    for component in path.components() {
        part.push(component.as_os_str());
        let meta = fs::symlink_metadata(&part).map_err(|_| "候选区业务库必须已存在且可访问")?;
        if meta.file_type().is_symlink() {
            return Err("候选区业务库路径不能包含符号链接".into());
        }
    }
    if !fs::metadata(&path)
        .map_err(|_| "候选区业务库不可访问")?
        .is_file()
    {
        return Err("候选区业务库必须是已有 SQLite 文件".into());
    }
    Ok(path)
}
fn sql_normalized(sql: &str) -> String {
    sql.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
        .replace("ifnotexists", "")
}
fn schema(db: &Connection) -> Result<bool> {
    let mut statement = db
        .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex_%'")
        .map_err(|_| "无法核对业务库结构")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|_| "无法核对业务库结构")?;
    let mut legacy = 0;
    let mut own = 0;
    for row in rows {
        let (kind, name, sql) = row.map_err(|_| "无法核对业务库结构")?;
        let expected = LEGACY.iter().chain(OWN.iter()).find(|(n, _)| *n == name);
        let Some((_, expected_sql)) = expected else {
            return Err("业务库包含未知结构，拒绝自动接入".into());
        };
        if kind != "table"
            || sql_normalized(sql.as_deref().unwrap_or("")) != sql_normalized(expected_sql)
        {
            return Err("业务库表结构与已验证版本不一致".into());
        }
        if name.starts_with("gapaw_selection_") {
            own += 1;
        } else {
            legacy += 1;
        }
    }
    if legacy != LEGACY.len() || (own != 0 && own != OWN.len()) {
        return Err("业务库表结构不完整，拒绝自动接入".into());
    }
    Ok(own == OWN.len())
}
fn open(path: &Path, write: bool) -> Result<Connection> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(path, flags).map_err(|_| "无法打开已有业务库")?;
    db.busy_timeout(Duration::from_secs(3))
        .map_err(|_| "无法配置业务库等待时间")?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")
        .map_err(|_| "无法配置业务库保护")?;
    Ok(db)
}
fn store_id(db: &Connection) -> Result<String> {
    let version: String = db
        .query_row(
            "SELECT value FROM gapaw_selection_meta WHERE key='schemaVersion'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "候选区初始化记录不完整")?;
    if version != "1" {
        return Err("候选区版本不受支持".into());
    }
    let id: String = db
        .query_row(
            "SELECT value FROM gapaw_selection_meta WHERE key='businessStoreId'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "候选区初始化记录不完整")?;
    identifier(&json!({"id":id}), "id")
}
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort();
            let mut result = Map::new();
            for key in keys {
                result.insert(key.clone(), canonical(&object[key]));
            }
            Value::Object(result)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        _ => v.clone(),
    }
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical(v).to_string().as_bytes()))
}
fn validate(payload: &Value, business_store_id: &str) -> Result<String> {
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
    )?;
    if payload.to_string().len() > MAX_PAYLOAD {
        return Err("候选区载荷超过 900000 字节上限".into());
    }
    if payload["schemaVersion"] != 1 || payload["expectedStoreId"] != business_store_id {
        return Err("候选区协议或业务库归属不匹配".into());
    }
    for key in ["adoptionId", "operationId", "taskId", "resultId"] {
        identifier(payload, key)?;
    }
    if !payload["resultRevision"]
        .as_u64()
        .is_some_and(|n| n > 0 && n <= i64::MAX as u64)
    {
        return Err("报告修订号无效".into());
    }
    let computed = crate::results::compute(&payload["report"], crate::METHOD_VERSION)?;
    if computed != payload["computed"] {
        return Err("报告计算结果与供应端重算不一致".into());
    }
    if payload["report"]["candidates"]
        .as_array()
        .is_none_or(|items| items.is_empty())
    {
        return Err("空报告无需保存为业务候选".into());
    }
    let observations = payload["observations"]
        .as_array()
        .filter(|items| items.len() <= 100)
        .ok_or("附属观测必须是最多100项的数组")?;
    for observation in observations {
        crate::observations::validate_snapshot(observation)?;
        if observation["operationId"] != payload["operationId"]
            || observation["taskId"] != payload["taskId"]
        {
            return Err("附属观测必须属于原操作与任务".into());
        }
    }
    Ok(hash(payload))
}
fn json_row(value: String) -> Result<Value> {
    serde_json::from_str(&value).map_err(|_| "已保存候选记录格式损坏".into())
}
fn receipt(db: &Connection, adoption_id: &str) -> Result<Option<Value>> {
    db.query_row(
        "SELECT receipt FROM gapaw_selection_receipts WHERE adoption_id=?",
        [adoption_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|_| "无法读取候选保存回执")?
    .map(json_row)
    .transpose()
}
fn batch_summary(db: &Connection, batch_id: &str) -> Result<Value> {
    json_row(
        db.query_row(
            "SELECT summary FROM gapaw_selection_batches WHERE batch_id=?",
            [batch_id],
            |r| r.get(0),
        )
        .map_err(|_| "未找到业务候选批次")?,
    )
}
fn candidates(db: &Connection, batch_id: &str, offset: u64, limit: u64) -> Result<Vec<Value>> {
    let mut query = db.prepare("SELECT detail FROM gapaw_selection_candidates WHERE batch_id=? ORDER BY ordinal LIMIT ? OFFSET ?")
        .map_err(|_| "无法读取业务候选")?;
    let rows = query
        .query_map(params![batch_id, limit, offset], |r| r.get::<_, String>(0))
        .map_err(|_| "无法读取业务候选")?;
    rows.map(|row| json_row(row.map_err(|_| "无法读取业务候选")?))
        .collect()
}
fn with_receipt(db: &Connection, receipt: Value) -> Result<Value> {
    let batch_id = receipt["batchId"].as_str().ok_or("候选回执批次编号损坏")?;
    Ok(
        json!({"receipt":receipt,"batch":batch_summary(db,batch_id)?,"candidates":candidates(db,batch_id,0,100)?}),
    )
}
fn warnings() -> Vec<&'static str> {
    vec![
        "仅保存到工作台待核验候选区，不代表正式入选或已确认指标。",
        "来源身份、来源内容、费用与覆盖范围仍待核验；缺失值保留未知。",
        "原始来源命名空间独立保存，同名不能证明是同一达人。",
    ]
}
fn conflicts(db: &Connection, payload: &Value) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for candidate in payload["report"]["candidates"].as_array().unwrap() {
        let handle = candidate["handle"].as_str().unwrap();
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM creators WHERE lower(handle)=lower(?)",
                [handle],
                |r| r.get(0),
            )
            .map_err(|_| "无法核对既有账号名冲突")?;
        if count > 0 {
            result.push(json!({"reportedHandle":handle,"existingCount":count,"action":"manual_identity_review","message":"既有达人库存在同名记录，未自动关联或覆盖。"}));
        }
    }
    Ok(result)
}
fn page(payload: &Value) -> Result<(u64, u64)> {
    let offset = match payload.get("offset") {
        None => 0,
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= 1_000_000)
            .ok_or("分页偏移无效")?,
    };
    let limit = match payload.get("limit") {
        None => 20,
        Some(v) => v
            .as_u64()
            .filter(|n| *n > 0 && *n <= 50)
            .ok_or("分页上限须为1到50")?,
    };
    Ok((offset, limit))
}

pub fn execute(input: Value) -> Result<Value> {
    keys(&input, &["action", "authorization", "payload"])?;
    authorize(&input)?;
    let action = input["action"].as_str().ok_or("缺少候选区操作")?;
    if ![
        "initialize",
        "status",
        "preview",
        "adopt",
        "receipt",
        "list",
        "batch",
    ]
    .contains(&action)
    {
        return Err("不支持的候选区操作".into());
    }
    let payload = input
        .get("payload")
        .filter(|v| v.is_object())
        .ok_or("缺少候选区载荷")?;
    let path = configured_path()?;
    let mut db = open(&path, ["initialize", "adopt"].contains(&action))?;
    if !["initialize", "adopt"].contains(&action) {
        // 只读操作使用同一 SQLite 快照；连接离开作用域时释放读事务。
        db.execute_batch("BEGIN DEFERRED")
            .map_err(|_| "无法创建候选区一致读取视图")?;
    }
    let initialized = schema(&db)?;
    if action == "initialize" {
        keys(payload, &[])?;
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "业务库正忙，初始化未执行")?;
        if !schema(&transaction)? {
            for (_, sql) in OWN {
                transaction
                    .execute_batch(sql)
                    .map_err(|_| "候选区初始化失败")?;
            }
            transaction.execute("INSERT INTO gapaw_selection_meta(key,value) VALUES('schemaVersion','1'),('businessStoreId',?)", [format!("gws_{}",Uuid::new_v4())])
                .map_err(|_| "候选区初始化失败")?;
        }
        let id = store_id(&transaction)?;
        transaction.commit().map_err(|_| "候选区初始化未能提交")?;
        return Ok(json!({"protocolVersion":1,"ready":true,"businessStoreId":id,"status":"ready"}));
    }
    if action == "status" {
        keys(payload, &[])?;
        return Ok(
            json!({"protocolVersion":1,"ready":initialized,"businessStoreId":if initialized{json!(store_id(&db)?)}else{Value::Null},"status":if initialized{"ready"}else{"uninitialized"}}),
        );
    }
    if !initialized {
        return Err("业务候选区尚未显式初始化".into());
    }
    let business_store_id = store_id(&db)?;
    match action {
        "preview" => {
            let payload_hash = validate(payload, &business_store_id)?;
            Ok(
                json!({"businessStoreId":business_store_id,"payloadHash":payload_hash,"candidateCount":payload["report"]["candidates"].as_array().unwrap().len(),"canAdopt":true,"verification":"unverified","warnings":warnings(),"handleConflicts":conflicts(&db,payload)?}),
            )
        }
        "adopt" => {
            let transaction = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| "业务库正忙，候选保存未执行")?;
            // 在持有写锁的同一事务内重新核对结构、归属、数学与幂等。
            if !schema(&transaction)? {
                return Err("候选区结构已改变".into());
            }
            let id = store_id(&transaction)?;
            let payload_hash = validate(payload, &id)?;
            let adoption_id = identifier(payload, "adoptionId")?;
            if let Some(existing) = receipt(&transaction, &adoption_id)? {
                if existing["payloadHash"] != payload_hash {
                    return Err("采纳编号已用于不同载荷".into());
                }
                let mut output = with_receipt(&transaction, existing)?;
                output["replayed"] = json!(true);
                transaction.commit().map_err(|_| "无法完成回执核对")?;
                return Ok(output);
            }
            let duplicate: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM gapaw_selection_batches WHERE operation_id=? AND result_id=? AND result_revision=?)", params![payload["operationId"].as_str(),payload["resultId"].as_str(),payload["resultRevision"].as_i64()],|r|r.get(0)).map_err(|_|"无法核对重复候选批次")?;
            if duplicate {
                return Err("此操作报告版本已保存，请沿用原采纳编号读取回执".into());
            }
            let batch_id = format!("gwb_{}", Uuid::new_v4());
            let created = now();
            let raw_candidates = payload["report"]["candidates"].as_array().unwrap();
            let candidate_ids: Vec<_> = raw_candidates
                .iter()
                .map(|_| format!("gwc_{}", Uuid::new_v4()))
                .collect();
            let saved_receipt = json!({"schemaVersion":1,"adoptionId":adoption_id,"businessStoreId":id,"payloadHash":payload_hash,"batchId":batch_id,"operationId":payload["operationId"],"taskId":payload["taskId"],"resultId":payload["resultId"],"resultRevision":payload["resultRevision"],"candidateCount":raw_candidates.len(),"candidateIds":candidate_ids,"status":STATUS,"createdAt":created});
            let mut metadata = Map::new();
            for key in [
                "schemaVersion",
                "methodVersion",
                "generatedAt",
                "period",
                "currency",
                "coverage",
                "missingFields",
            ] {
                metadata.insert(key.into(), payload["report"][key].clone());
            }
            let mut summary = saved_receipt.clone();
            summary["verification"] = json!("unverified");
            summary["reportMetadata"] = json!(metadata);
            summary["observationCount"] = json!(payload["observations"].as_array().unwrap().len());
            summary["warnings"] = json!(warnings());
            summary["handleConflicts"] = json!(conflicts(&transaction, payload)?);
            transaction
                .execute(
                    "INSERT INTO gapaw_selection_batches VALUES(?,?,?,?,?,?,?,?)",
                    params![
                        batch_id,
                        payload["operationId"].as_str(),
                        payload["taskId"].as_str(),
                        payload["resultId"].as_str(),
                        payload["resultRevision"].as_i64(),
                        summary.to_string(),
                        payload["report"].to_string(),
                        payload["computed"].to_string()
                    ],
                )
                .map_err(|_| "候选批次写入失败，事务已回滚")?;
            for (ordinal, candidate) in raw_candidates.iter().enumerate() {
                let detail = json!({"candidateId":candidate_ids[ordinal],"batchId":batch_id,"reportedIdentity":{"platform":candidate["platform"],"creatorId":candidate["creatorId"],"handle":candidate["handle"],"profileUrl":candidate["profileUrl"]},"reason":candidate["reason"],"computed":payload["computed"]["candidates"][ordinal],"missingFields":candidate["missingFields"],"sources":candidate["sources"],"verification":"unverified","status":STATUS});
                transaction
                    .execute(
                        "INSERT INTO gapaw_selection_candidates VALUES(?,?,?,?,?)",
                        params![
                            candidate_ids[ordinal],
                            batch_id,
                            ordinal as i64,
                            detail.to_string(),
                            candidate.to_string()
                        ],
                    )
                    .map_err(|_| "候选记录写入失败，事务已回滚")?;
            }
            for (ordinal, observation) in payload["observations"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
            {
                transaction
                    .execute(
                        "INSERT INTO gapaw_selection_observations VALUES(?,?,?,?)",
                        params![
                            batch_id,
                            observation["observationId"].as_str(),
                            ordinal as i64,
                            observation.to_string()
                        ],
                    )
                    .map_err(|_| "附属观测写入失败，事务已回滚")?;
            }
            transaction
                .execute(
                    "INSERT INTO gapaw_selection_receipts VALUES(?,?,?,?)",
                    params![
                        adoption_id,
                        batch_id,
                        payload_hash,
                        saved_receipt.to_string()
                    ],
                )
                .map_err(|_| "候选回执写入失败，事务已回滚")?;
            transaction.execute("INSERT INTO gapaw_selection_audit(at,action,batch_id,adoption_id,payload_hash) VALUES(?,'store_unverified_candidates',?,?,?)",params![created,batch_id,adoption_id,payload_hash]).map_err(|_|"候选审计写入失败，事务已回滚")?;
            let mut output = with_receipt(&transaction, saved_receipt)?;
            output["replayed"] = json!(false);
            transaction.commit().map_err(|_| "候选保存事务未能提交")?;
            Ok(output)
        }
        "receipt" => {
            keys(payload, &["adoptionId"])?;
            match receipt(&db, &identifier(payload, "adoptionId")?)? {
                None => Ok(json!({"found":false})),
                Some(receipt) => {
                    let mut output = with_receipt(&db, receipt)?;
                    output["found"] = json!(true);
                    Ok(output)
                }
            }
        }
        "list" => {
            keys(payload, &["offset", "limit"])?;
            let (offset, limit) = page(payload)?;
            let total: u64 = db
                .query_row("SELECT count(*) FROM gapaw_selection_batches", [], |r| {
                    r.get(0)
                })
                .map_err(|_| "无法统计业务候选批次")?;
            let mut query=db.prepare("SELECT summary FROM gapaw_selection_batches ORDER BY rowid DESC LIMIT ? OFFSET ?").map_err(|_|"无法列出业务候选批次")?;
            let rows = query
                .query_map(params![limit, offset], |r| r.get::<_, String>(0))
                .map_err(|_| "无法列出业务候选批次")?;
            let items: Vec<Value> = rows
                .map(|r| json_row(r.map_err(|_| "无法列出业务候选批次")?))
                .collect::<Result<_>>()?;
            Ok(
                json!({"items":items,"total":total,"offset":offset,"limit":limit,"nextOffset":if offset+limit<total{json!(offset+limit)}else{Value::Null}}),
            )
        }
        "batch" => {
            keys(payload, &["batchId", "offset", "limit"])?;
            let (offset, limit) = page(payload)?;
            let batch_id = identifier(payload, "batchId")?;
            let batch = batch_summary(&db, &batch_id)?;
            let total = batch["candidateCount"].as_u64().ok_or("候选批次数量损坏")?;
            Ok(
                json!({"batch":batch,"candidates":candidates(&db,&batch_id,offset,limit)?,"total":total,"offset":offset,"limit":limit,"nextOffset":if offset+limit<total{json!(offset+limit)}else{Value::Null}}),
            )
        }
        _ => Err("不支持的候选区操作".into()),
    }
}
