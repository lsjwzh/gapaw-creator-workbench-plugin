//! 选人数据契约与正式档案采用；只补资料，不写合作与触达事实。
use crate::{identifier, local_backend, local_store, now, open_db, required, selection, Result};
use chrono::{DateTime, NaiveDate};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path, str::FromStr};

pub fn contract() -> Value {
    json!({"schemaVersion":1,"rules":["只收集账号资料与证据；不得加入报价、合作状态或触达事件","accountId 必须是有来源依据的平台稳定账号编号，未知为 null；不能拿昵称冒充","metrics 数值为普通十进制字符串或 null；GMV 等区间指标必须给出起止日期、时区与单位","sourceId 引用同一达人 sources 中的来源编号；未知项列入 missingFields","每次提交完整名单快照，旧版保持不变"],"list":{"schemaVersion":1,"criteria":"本轮筛选条件与判断依据","candidates":[{"key":"本任务稳定候选编号","identity":{"platform":"tiktok","accountId":null,"handle":"展示账号名","url":"https://www.tiktok.com/@handle","sourceId":"source1"},"content":{"country":"US","language":null,"categories":["宠物"],"fit":"待核验","reason":"适配依据或缺失说明"},"metrics":[{"name":"followers","value":null,"unit":"人","sourceId":"source1","period":null}],"contacts":[],"sources":[{"id":"source1","platform":"tiktok","url":"https://www.tiktok.com/@handle","capturedAt":"2026-10-28T00:00:00Z","note":"实际观察依据，不填演示数据"}],"missingFields":["账号稳定编号待核验"]}]}})
}
fn keys(v: &Value, allowed: &[&str]) -> Result<()> {
    let obj = v.as_object().ok_or("数据项必须为对象")?;
    if obj.len() != allowed.len() || obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("名单字段不完整或含未定义字段，请按 selection-contract 提交".into());
    }
    Ok(())
}
fn arr<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a Vec<Value>> {
    v[key]
        .as_array()
        .filter(|a| a.len() <= max)
        .ok_or_else(|| format!("{key} 必须是有界数组"))
}
fn url(v: &Value, key: &str) -> Result<()> {
    let raw = selection::text(v, key, 2048)?;
    let u = url::Url::parse(raw).map_err(|_| "来源链接格式无效")?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("来源链接需为不含凭据、查询参数和片段的 HTTPS 地址".into());
    }
    Ok(())
}
fn strings(v: &Value, key: &str, max: usize) -> Result<()> {
    for x in arr(v, key, max)? {
        if x.as_str()
            .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 500)
        {
            return Err(format!("{key} 必须为短文本数组"));
        }
    }
    Ok(())
}
pub fn validate(list: &Value) -> Result<()> {
    keys(list, &["schemaVersion", "criteria", "candidates"])?;
    if list["schemaVersion"] != 1 {
        return Err("名单协议版本不支持".into());
    }
    selection::text(list, "criteria", 4000)?;
    let mut seen = HashSet::new();
    let mut accounts = HashSet::new();
    for c in arr(list, "candidates", 200)? {
        keys(
            c,
            &[
                "key",
                "identity",
                "content",
                "metrics",
                "contacts",
                "sources",
                "missingFields",
            ],
        )?;
        if !seen.insert(identifier(c, "key")?) {
            return Err("同版名单候选编号重复".into());
        }
        let mut sources = HashSet::new();
        for s in arr(c, "sources", 30)? {
            keys(s, &["id", "platform", "url", "capturedAt", "note"])?;
            if !sources.insert(identifier(s, "id")?) {
                return Err("来源编号重复".into());
            }
            selection::text(s, "platform", 80)?;
            selection::text(s, "note", 4000)?;
            url(s, "url")?;
            DateTime::parse_from_rfc3339(selection::text(s, "capturedAt", 80)?)
                .map_err(|_| "来源采集时间无效")?;
        }
        if sources.is_empty() {
            return Err("每位候选必须保留至少一项来源依据".into());
        }
        let reference = |v: &Value| -> Result<()> {
            if !sources.contains(required(v, "sourceId")?) {
                return Err("数据引用了不存在的来源".into());
            }
            Ok(())
        };
        let i = &c["identity"];
        keys(i, &["platform", "accountId", "handle", "url", "sourceId"])?;
        if i["platform"] != "tiktok" {
            return Err("本版正式达人身份仅支持 TikTok，其他平台请保留在外部资料中".into());
        }
        selection::text(i, "handle", 200)?;
        url(i, "url")?;
        reference(i)?;
        let parsed = url::Url::parse(required(i, "url")?).map_err(|_| "达人链接无效")?;
        if !matches!(parsed.host_str(), Some("www.tiktok.com" | "tiktok.com"))
            || !parsed.path().starts_with("/@")
        {
            return Err("达人身份必须引用 TikTok 账号主页".into());
        }
        if !i["accountId"].is_null() {
            let account = selection::text(i, "accountId", 200)?;
            if !account.bytes().all(|b| b.is_ascii_digit()) {
                return Err("TikTok 稳定账号编号须为数字字符串，不能用昵称或供应商编号代替".into());
            }
            if !accounts.insert(account) {
                return Err("同版名单存在重复平台账号".into());
            }
        }
        let content = &c["content"];
        keys(
            content,
            &["country", "language", "categories", "fit", "reason"],
        )?;
        for k in ["country", "language"] {
            if !content[k].is_null() {
                selection::text(content, k, 100)?;
            }
        }
        strings(content, "categories", 20)?;
        selection::text(content, "fit", 100)?;
        selection::text(content, "reason", 4000)?;
        let mut metric_keys = HashSet::new();
        for m in arr(c, "metrics", 60)? {
            keys(m, &["name", "value", "unit", "sourceId", "period"])?;
            selection::text(m, "name", 100)?;
            selection::text(m, "unit", 100)?;
            reference(m)?;
            if !metric_keys.insert((
                m["name"].to_string(),
                m["sourceId"].to_string(),
                m["period"].to_string(),
            )) {
                return Err("指标来源与时窗重复".into());
            }
            if !m["value"].is_null() {
                let s = selection::text(m, "value", 64)?;
                let parts: Vec<_> = s.split('.').collect();
                if parts.len() > 2
                    || parts
                        .iter()
                        .any(|x| x.is_empty() || !x.bytes().all(|b| b.is_ascii_digit()))
                {
                    return Err("指标必须是非负普通十进制字符串或 null".into());
                }
            }
            if !m["period"].is_null() {
                let p = &m["period"];
                keys(p, &["start", "end", "timeZone"])?;
                let a = NaiveDate::parse_from_str(required(p, "start")?, "%Y-%m-%d")
                    .map_err(|_| "指标开始日期无效")?;
                let b = NaiveDate::parse_from_str(required(p, "end")?, "%Y-%m-%d")
                    .map_err(|_| "指标结束日期无效")?;
                if a > b {
                    return Err("指标开始日期不能晚于结束日期".into());
                }
                Tz::from_str(required(p, "timeZone")?).map_err(|_| "指标时区无效")?;
            } else if !["followers", "following", "total_likes"].contains(&required(m, "name")?) {
                return Err("区间指标必须注明统计时窗".into());
            }
        }
        for contact in arr(c, "contacts", 20)? {
            keys(contact, &["type", "value", "sourceId", "verified"])?;
            selection::text(contact, "type", 80)?;
            selection::text(contact, "value", 500)?;
            reference(contact)?;
            if contact["verified"] != false {
                return Err("采集到的联系方式应保留待核验，不自动标为已确认".into());
            }
        }
        strings(c, "missingFields", 100)?;
    }
    Ok(())
}
fn digest(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn creator_id(c: &Value) -> String {
    format!(
        "creator_{}",
        &digest(&json!([
            c["identity"]["platform"],
            c["identity"]["accountId"]
        ]))[..24]
    )
}
fn database(path: &Path, write: bool) -> Result<Connection> {
    let p = local_backend::business_path(path)?;
    local_store::identity(&p)?;
    let db = Connection::open_with_flags(
        p,
        if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        },
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(db)
}
fn selected(input: &Value, record: &Value) -> Result<Vec<Value>> {
    let keys = arr(input, "keys", 200)?;
    if keys.is_empty() {
        return Err("请先选择要采用的达人".into());
    }
    let mut seen = HashSet::new();
    let mut out = vec![];
    for k in keys {
        let k = k.as_str().ok_or("候选编号无效")?;
        if !seen.insert(k) {
            return Err("候选编号重复".into());
        }
        let c = record["list"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["key"] == k)
            .ok_or("候选不属于所选版本")?;
        out.push(c.clone());
    }
    Ok(out)
}
pub fn receipts(path: &Path, operation_id: &str) -> Result<Value> {
    if !local_backend::business_path(path)?.exists() {
        return Ok(json!([]));
    }
    let db = database(path, false)?;
    let mut q = db.prepare("SELECT value FROM meta WHERE key LIKE 'selection_adoption:%' AND json_extract(value,'$.request.operationId')=? ORDER BY rowid DESC").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([operation_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for row in rows {
        let v: Value =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|_| "采用回执损坏")?;
        out.push(json!({"requestId":v["requestId"],"revision":v["request"]["revision"],"savedAt":v["savedAt"],"accepted":v["accepted"],"blocked":v["blocked"],"skipped":v["skipped"]}));
    }
    Ok(json!(out))
}
fn plan(db: &Connection, record: &Value, candidates: &[Value]) -> Result<Value> {
    let source = format!("local-workbench:{}", local_store::identity_connection(db)?);
    if record["businessSource"] != source {
        return Err("名单属于另一份工作台，不能采用".into());
    }
    let mut items = vec![];
    for c in candidates {
        let mut item = json!({"key":c["key"],"handle":c["identity"]["handle"],"action":"blocked","reason":"平台稳定身份待核验","creatorId":null,"expectedRevision":null,"expectedProfile":null});
        if !c["identity"]["accountId"].is_null() {
            let id = creator_id(c);
            let matches: u64 = db
                .query_row(
                    "SELECT count(*) FROM creators WHERE id=? OR handle=?",
                    params![id, c["identity"]["handle"].as_str()],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if matches > 1 {
                item["reason"] = json!("账号编号与昵称指向不同档案，需要人工核验");
                items.push(item);
                continue;
            }
            let row: Option<(String, String, i64)> = db
                .query_row(
                    "SELECT id,profile,revision FROM creators WHERE id=? OR handle=? ORDER BY id",
                    params![id, c["identity"]["handle"].as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match row {
                None => {
                    item["action"] = json!("create");
                    item["creatorId"] = json!(id);
                    item["reason"] = json!("新增档案；合作条件、核验、文案与事实保持未确认");
                }
                Some((existing, profile, revision)) => {
                    let p: Value =
                        serde_json::from_str(&profile).map_err(|_| "已有档案格式异常")?;
                    if existing == id
                        && p["selectionIdentity"]
                            == json!({"platform":c["identity"]["platform"],"accountId":c["identity"]["accountId"]})
                    {
                        item["action"] = json!("update");
                        item["creatorId"] = json!(id);
                        item["expectedRevision"] = json!(revision);
                        item["expectedProfile"] = json!(digest(&p));
                        item["reason"] =
                            json!("保存新的选人资料快照，保留已有档案字段、人工合作设置及事实");
                        if p["selectionSnapshot"]["resultId"] == record["id"] {
                            item["action"] = json!("unchanged");
                            item["reason"] = json!("此版本资料已采用，本次跳过");
                        }
                    } else {
                        item["reason"] =
                            json!("已有同名账号但缺少可靠的稳定身份映射，保留待核验，不按昵称合并");
                    }
                }
            }
        }
        items.push(item);
    }
    let body = json!({"source":source,"operationId":record["operationId"],"resultId":record["id"],"revision":record["revision"],"items":items});
    Ok(json!({"plan":body,"fingerprint":digest(&body)}))
}
pub fn adoption(cmd: &str, input: Value, path: &Path) -> Result<Value> {
    if cmd == "selection-adoption-status" {
        let db = database(path, false)?;
        let id = identifier(&input, "requestId")?;
        let raw: Option<String> = db
            .query_row(
                "SELECT value FROM meta WHERE key=?",
                [format!("selection_adoption:{id}")],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        return Ok(
            json!({"receipt":raw.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(|_|"采用回执损坏")?}),
        );
    }
    let state = open_db(path, false)?.ok_or("选人任务不存在")?;
    let opid = identifier(&input, "operationId")?;
    selection::chat(&state, &opid)?;
    let rev = input["revision"]
        .as_u64()
        .filter(|r| *r > 0)
        .ok_or("请选择已保存的名单版本")?;
    let record = selection::version(&state, &opid, rev)?;
    let candidates = selected(&input, &record)?;
    let mut db = database(path, cmd == "selection-adopt")?;
    if cmd == "selection-preview-adoption" {
        db.execute_batch("BEGIN DEFERRED")
            .map_err(|e| e.to_string())?;
        return plan(&db, &record, &candidates);
    }
    if input["confirmed"] != true {
        return Err("采用前请确认预览中的新增、更新与待核验项".into());
    }
    let request = identifier(&input, "requestId")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let prior: Option<String> = tx
        .query_row(
            "SELECT value FROM meta WHERE key=?",
            [format!("selection_adoption:{request}")],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(raw) = prior {
        let r: Value = serde_json::from_str(&raw).map_err(|_| "回执损坏")?;
        if r["request"] != input {
            return Err("同一采用编号不能更换内容".into());
        }
        return Ok(json!({"receipt":r,"replayed":true}));
    }
    let preview = plan(&tx, &record, &candidates)?;
    if preview != input["expectedPlan"] {
        return Err("档案或采用范围自预览后发生变化，请重新预览".into());
    }
    let mut accepted = vec![];
    let mut blocked = vec![];
    let mut skipped = vec![];
    for (c, item) in candidates
        .iter()
        .zip(preview["plan"]["items"].as_array().unwrap())
    {
        if item["action"] == "blocked" {
            blocked.push(item.clone());
            continue;
        }
        if item["action"] == "unchanged" {
            skipped.push(item.clone());
            continue;
        }
        let id = required(item, "creatorId")?;
        let snapshot = json!({"operationId":opid,"resultId":record["id"],"revision":rev,"savedAt":record["savedAt"],"candidate":c});
        let old: Option<String> = tx
            .query_row("SELECT profile FROM creators WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        let mut profile: Value = if let Some(raw) = old.as_ref() {
            serde_json::from_str(raw).map_err(|_| "档案损坏")?
        } else {
            json!({"id":id,"handle":c["identity"]["handle"],"tiktok_url":c["identity"]["url"],"rank":null,"pet_gmv_share_pct":null,"history":null,"prior_invite":null,"kalodata_window":null,"anchor1":null,"anchor2":null,"topic":c["content"]["categories"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>().join("、"),"followers":null,"affiliate_gmv_usd":null,"priority":"待核验","selectionIdentity":{"platform":c["identity"]["platform"],"accountId":c["identity"]["accountId"]}})
        };
        profile["selectionSnapshot"] = snapshot;
        if old.is_none() {
            let mut settings = local_store::default_settings();
            settings["fee"] = Value::Null;
            tx.execute(
                "INSERT INTO creators(id,handle,profile,settings,revision) VALUES(?,?,?,?,0)",
                params![
                    id,
                    c["identity"]["handle"].as_str(),
                    profile.to_string(),
                    settings.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
            for channel in ["comment", "dm", "email", "affiliate", "followup"] {
                tx.execute(
                    "INSERT INTO drafts(creator,channel,subject,body,revision) VALUES(?,?,'','',0)",
                    params![id, channel],
                )
                .map_err(|e| e.to_string())?;
            }
        } else {
            tx.execute(
                "UPDATE creators SET profile=?,revision=revision+1 WHERE id=?",
                params![profile.to_string(), id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO audit(at,kind,creator,previous,current) VALUES(?,?,?,?,?)",
            params![
                now(),
                "选人资料采用",
                id,
                old.unwrap_or_default(),
                profile.to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        accepted.push(item.clone());
    }
    if accepted.is_empty() && skipped.is_empty() {
        return Err("所选名单暂无身份明确且可采用的达人，待核验项继续保留".into());
    }
    let receipt = json!({"requestId":request,"request":input,"source":preview["plan"]["source"],"savedAt":now(),"accepted":accepted,"blocked":blocked,"skipped":skipped});
    tx.execute(
        "INSERT INTO meta(key,value) VALUES(?,?)",
        params![format!("selection_adoption:{request}"), receipt.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"receipt":receipt,"replayed":false}))
}
