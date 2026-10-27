//! 操作附属报告快照：只接收与核算，正式业务采纳始终待接入。
use super::{identifier, now, open_db, operation, required, Result, METHOD_VERSION};
use bigdecimal::{BigDecimal, RoundingMode};
use chrono::{DateTime, NaiveDate};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, str::FromStr};

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS selection_results(result_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,revision INTEGER NOT NULL,request TEXT NOT NULL,record TEXT NOT NULL,summary TEXT NOT NULL,UNIQUE(operation_id,revision)); CREATE INDEX IF NOT EXISTS selection_results_operation ON selection_results(operation_id,revision DESC);")
        .map_err(|e|format!("无法初始化报告存储：{e}"))
}
fn has_table(db: &Connection) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='selection_results')",[],|r|r.get(0)).map_err(|e|e.to_string())
}
fn parse(raw: &str) -> Result<Value> {
    serde_json::from_str(raw).map_err(|e| format!("报告记录损坏：{e}"))
}
fn summaries(db: &Connection, id: &str) -> Result<Vec<Value>> {
    if !has_table(db)? {
        return Ok(vec![]);
    }
    let mut stmt = db
        .prepare(
            "SELECT summary FROM selection_results WHERE operation_id=? ORDER BY revision DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| parse(&row.map_err(|e| e.to_string())?))
        .collect()
}
pub fn annotate(db: Option<&Connection>, ops: &mut [Value]) -> Result<()> {
    for op in ops {
        op["resultSummary"] = if let Some(db) = db {
            summaries(db, required(op, "id")?)?
                .into_iter()
                .next()
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
    }
    Ok(())
}
fn exact_keys(value: &Value, keys: &[&str], at: &str) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{at} 必须是对象"))?;
    if object.len() != keys.len() || object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(format!("{at} 字段不完整或包含未定义字段"));
    }
    Ok(())
}
fn text<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let value = required(value, key)?;
    if value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(format!("{key} 过长或包含非法控制字符"));
    }
    Ok(value)
}
fn array<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a Vec<Value>> {
    v.get(key)
        .and_then(Value::as_array)
        .filter(|a| a.len() <= max)
        .ok_or_else(|| format!("{key} 必须为不超过 {max} 项的数组"))
}
fn missing_fields(v: &Value) -> Result<()> {
    for s in array(v, "missingFields", 100)? {
        if s.as_str()
            .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 500)
        {
            return Err("missingFields 必须为非空短文本数组".into());
        }
    }
    Ok(())
}
fn http_url(v: &Value, key: &str) -> Result<()> {
    let raw = text(v, key, 2048)?;
    let u = url::Url::parse(raw).map_err(|_| format!("{key} 不是合法链接"))?;
    if !["http", "https"].contains(&u.scheme())
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || raw.chars().any(char::is_whitespace)
    {
        return Err(format!("{key} 必须为不含认证信息的 HTTP(S) 链接"));
    }
    Ok(())
}
fn timestamp(v: &Value, key: &str) -> Result<DateTime<chrono::FixedOffset>> {
    DateTime::parse_from_rfc3339(text(v, key, 64)?)
        .map_err(|_| format!("{key} 必须为带时区的 RFC3339 时间"))
}
fn decimal(v: &Value, key: &str, kind: &str) -> Result<Option<BigDecimal>> {
    let item = v
        .get(key)
        .ok_or_else(|| format!("缺少 {key}；未知值须明确写 null"))?;
    if item.is_null() {
        return Ok(None);
    }
    let raw = item
        .as_str()
        .ok_or_else(|| format!("{key} 必须是十进制字符串或 null"))?;
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    let parts: Vec<_> = digits.split('.').collect();
    if raw.len() > 64
        || parts.len() > 2
        || parts[0].is_empty()
        || parts[0].len() > 18
        || parts[0].len() > 1 && parts[0].starts_with('0')
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
        || parts.get(1).is_some_and(|p| p.len() > 12)
    {
        return Err(format!(
            "{key} 须为普通十进制，最多18位整数与12位小数，不支持科学计数或多余前导零"
        ));
    }
    let number = BigDecimal::from_str(raw).map_err(|_| format!("{key} 不是有效十进制"))?;
    let zero = BigDecimal::from(0);
    let one = BigDecimal::from(1);
    if (kind != "contribution" && number < zero)
        || (["commission", "contribution"].contains(&kind) && number > one)
    {
        return Err(format!("{key} 超出允许范围"));
    }
    Ok(Some(number))
}
fn display(number: BigDecimal) -> String {
    number
        .with_scale_round(28, RoundingMode::HalfEven)
        .normalized()
        .to_plain_string()
}
pub(crate) fn compute(report: &Value, method: &str) -> Result<Value> {
    exact_keys(
        report,
        &[
            "schemaVersion",
            "methodVersion",
            "generatedAt",
            "period",
            "currency",
            "coverage",
            "missingFields",
            "candidates",
        ],
        "report",
    )?;
    if report["schemaVersion"].as_u64() != Some(1)
        || report["methodVersion"].as_str() != Some(method)
        || method != METHOD_VERSION
    {
        return Err("报告 schemaVersion 或方法版本与操作不匹配".into());
    }
    timestamp(report, "generatedAt")?;
    let period = &report["period"];
    exact_keys(period, &["start", "end", "timeZone"], "period")?;
    let parse_day = |key| -> Result<NaiveDate> {
        let raw = text(period, key, 10)?;
        let date = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .map_err(|_| format!("period.{key} 不是有效日期"))?;
        if date.format("%Y-%m-%d").to_string() != raw {
            return Err(format!("period.{key} 必须为 YYYY-MM-DD"));
        }
        Ok(date)
    };
    let start = parse_day("start")?;
    let end = parse_day("end")?;
    if start > end {
        return Err("统计区间的开始日期晚于结束日期".into());
    }
    let tz = text(period, "timeZone", 64)?
        .parse::<Tz>()
        .map_err(|_| "timeZone 必须是有效 IANA 时区，如 Asia/Shanghai 或 UTC")?;
    let currency = text(report, "currency", 3)?;
    if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("currency 必须为三位大写币种代码".into());
    }
    text(report, "coverage", 4000)?;
    missing_fields(report)?;
    let mut creator_ids = HashSet::new();
    let mut video_ids = HashSet::new();
    let mut candidates = vec![];
    for candidate in array(report, "candidates", 100)? {
        exact_keys(
            candidate,
            &[
                "platform",
                "creatorId",
                "handle",
                "profileUrl",
                "reason",
                "sources",
                "missingFields",
                "videos",
            ],
            "candidate",
        )?;
        if candidate["platform"] != "tiktok" {
            return Err("候选 platform 当前只支持 tiktok".into());
        }
        let creator_id = identifier(candidate, "creatorId")?;
        let creator_key = format!("tiktok:{creator_id}");
        if !creator_ids.insert(creator_key.clone()) {
            return Err("候选来源身份重复".into());
        }
        text(candidate, "handle", 200)?;
        http_url(candidate, "profileUrl")?;
        text(candidate, "reason", 4000)?;
        missing_fields(candidate)?;
        let sources = array(candidate, "sources", 50)?;
        if sources.is_empty() {
            return Err("每位候选必须提供至少一条来源".into());
        }
        for source in sources {
            exact_keys(source, &["url", "capturedAt", "note"], "source")?;
            http_url(source, "url")?;
            timestamp(source, "capturedAt")?;
            text(source, "note", 2000)?;
        }
        let videos = array(candidate, "videos", 2000)?;
        let total = videos.len();
        let mut evaluated = 0usize;
        let mut positive = 0usize;
        let mut sum = BigDecimal::from(0);
        let mut computed_videos = vec![];
        for video in videos {
            exact_keys(
                video,
                &[
                    "videoId",
                    "url",
                    "publishedAt",
                    "contributionRate",
                    "sales",
                    "adSpend",
                    "fixedFee",
                    "sampleCost",
                ],
                "video",
            )?;
            let video_id = identifier(video, "videoId")?;
            if !video_ids.insert(video_id.clone()) {
                return Err("视频编号在本批次中重复，不能跨候选重复计入".into());
            }
            if video_ids.len() > 2000 {
                return Err("报告视频总数超过 2000 条".into());
            }
            http_url(video, "url")?;
            let day = timestamp(video, "publishedAt")?
                .with_timezone(&tz)
                .date_naive();
            if day < start || day > end {
                return Err(format!("视频 {video_id} 发布时间不在指定时区的统计区间内"));
            }
            let contribution = decimal(video, "contributionRate", "contribution")?;
            let ad_spend = decimal(video, "adSpend", "money")?;
            let fixed_fee = decimal(video, "fixedFee", "money")?;
            let sample_cost = decimal(video, "sampleCost", "money")?;
            let mut missing = vec![];
            for (key, value) in [
                ("contributionRate", &contribution),
                ("adSpend", &ad_spend),
                ("fixedFee", &fixed_fee),
                ("sampleCost", &sample_cost),
            ] {
                if value.is_none() {
                    missing.push(key.to_string());
                }
            }
            let sales = array(video, "sales", 2)?;
            if sales.is_empty() {
                return Err("sales 必须至少包含一项成交口径".into());
            }
            let mut kinds = HashSet::new();
            let mut amount = BigDecimal::from(0);
            for (i, sale) in sales.iter().enumerate() {
                exact_keys(sale, &["kind", "gmv", "commissionRate"], "sale")?;
                let kind = text(sale, "kind", 10)?;
                if !["organic", "ads", "total"].contains(&kind) || !kinds.insert(kind) {
                    return Err("sales.kind 无效或重复".into());
                }
                let gmv = decimal(sale, "gmv", "money")?;
                let commission = decimal(sale, "commissionRate", "commission")?;
                if gmv.is_none() {
                    missing.push(format!("sales[{i}].gmv"));
                }
                if commission.is_none() {
                    missing.push(format!("sales[{i}].commissionRate"));
                }
                if let (Some(gmv), Some(commission), Some(contribution)) =
                    (gmv, commission, contribution.as_ref())
                {
                    amount += gmv * (contribution - commission);
                }
            }
            if kinds.contains("total") && kinds.len() > 1 {
                return Err("total 成交不能与 organic/ads 分拆同时出现".into());
            }
            let surplus = if missing.is_empty() {
                let value = amount - ad_spend.unwrap() - fixed_fee.unwrap() - sample_cost.unwrap();
                evaluated += 1;
                if value > 0 {
                    positive += 1;
                }
                sum += &value;
                json!(value.normalized().to_plain_string())
            } else {
                Value::Null
            };
            computed_videos
                .push(json!({"videoId":video_id,"surplus":surplus,"missingFields":missing}));
        }
        let status = if total == 0 {
            "no_sample"
        } else if evaluated == total {
            "complete"
        } else {
            "incomplete"
        };
        let complete = status == "complete";
        let summary = json!({"status":status,"totalVideos":total,"evaluatedVideos":evaluated,"knownPositiveVideos":positive,"breakEvenCount":if complete{json!(positive)}else{Value::Null},"breakEvenRate":if complete{json!(display(BigDecimal::from(positive as u64)/BigDecimal::from(total as u64)))}else{Value::Null},"averageSurplus":if complete{json!(display(sum/BigDecimal::from(total as u64)))}else{Value::Null}});
        candidates
            .push(json!({"creatorKey":creator_key,"summary":summary,"videos":computed_videos}));
    }
    Ok(json!({"candidates":candidates}))
}
fn validation(report: &Value, computed: &Value) -> Value {
    let candidates = computed["candidates"].as_array().unwrap();
    let mut total_videos = 0u64;
    let mut known_positive = 0u64;
    let mut complete = 0usize;
    let mut missing = Vec::new();
    let mut providers = [0usize; 3];
    if !report["missingFields"].as_array().unwrap().is_empty() {
        missing.push(json!({"creatorKey":"report","fields":report["missingFields"]}));
    }
    for (candidate, calculated) in report["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .zip(candidates)
    {
        total_videos += calculated["summary"]["totalVideos"].as_u64().unwrap();
        known_positive += calculated["summary"]["knownPositiveVideos"]
            .as_u64()
            .unwrap();
        if calculated["summary"]["status"] == "complete" {
            complete += 1;
        }
        if !candidate["missingFields"].as_array().unwrap().is_empty() {
            missing.push(
                json!({"creatorKey":calculated["creatorKey"],"fields":candidate["missingFields"]}),
            );
        }
        for video in calculated["videos"].as_array().unwrap() {
            if !video["missingFields"].as_array().unwrap().is_empty() {
                missing.push(json!({"creatorKey":calculated["creatorKey"],"videoId":video["videoId"],"fields":video["missingFields"]}));
            }
        }
        for source in candidate["sources"].as_array().unwrap() {
            let parsed = source["url"].as_str().and_then(|u| url::Url::parse(u).ok());
            let provider = match parsed.as_ref().and_then(|u| u.host_str()) {
                Some("affiliate.tiktok.com") => 0,
                Some("kalodata.com" | "www.kalodata.com") => 1,
                _ => 2,
            };
            providers[provider] += 1;
        }
    }
    let calculation_status = if total_videos > 0 && complete == candidates.len() {
        "passed"
    } else {
        "unknown"
    };
    let source_count: usize = providers.iter().sum();
    json!({
        "candidateCount":candidates.len(),"totalVideos":total_videos,"completeCandidates":complete,"incompleteCandidates":candidates.len()-complete,"knownPositiveVideos":known_positive,
        "checks":[
            {"id":"calculation","label":"报告内数学计算","status":calculation_status,"message":if calculation_status=="passed" {"报告内每条视频的数值均可计算；使用精确十进制及结余严格大于零判断，不代表来源、费用或全量已核实。"} else {"报告内存在未知数值或没有可计算样本；未知仍为 null，不补零，也不以部分视频计算完整回本率。"}},
            {"id":"identity","label":"达人与视频身份","status":"unknown","message":"已校验报告内身份格式和重复编号；未核对平台真实归属、主页对应关系或跨来源身份关联。"},
            {"id":"sample_coverage","label":"同期新视频与样本覆盖","status":if total_videos==0 {"warning"} else {"unknown"},"message":if total_videos==0 {"本报告没有视频样本，不能据此证明平台真实零结果或完整覆盖。"} else {"已校验所填视频发布时间落在指定时区的区间内；覆盖说明只是文本，无法验证同期新视频全量、分页结束或榜单截断。"}},
            {"id":"source_provenance","label":"来源与估算口径","status":"unknown","message":"仅校验来源链接和采集时间格式。现有 schema 1 没有字段级溯源或估算标记，不能验证来源内容、估算属性及跨来源一致性。"},
            {"id":"cost_confirmation","label":"成本与佣金确认","status":"unknown","message":"数值存在只说明能够代入算式；现有 schema 1 不含字段级确认记录，无法确认贡献率、佣金、广告消耗、固定费与寄样分摊是否为真实已确认成本。"}
        ],
        "missingFields":missing,
        "sourceReview":{"status":"unverified","message":"来源尚未核验；域名分类只作线索，不证明来源可读、费用真实或全量覆盖。","sourceCount":source_count,
            "providers":[{"id":"affiliate","label":"TikTok Affiliate","sourceCount":providers[0]},{"id":"kalodata","label":"Kalodata","sourceCount":providers[1]},{"id":"other","label":"其他来源","sourceCount":providers[2]}],
            "fieldLevelProvenance":false,"fullCoverageVerified":false,"estimatedMetricsVerified":false,"crossSourceConsistencyVerified":false},
        "coverageStatement":report["coverage"],
        "note":"完整候选仅指报告内数学输入齐全；预检不是保存锁、采集成功或正式业务采纳，提交时仍会原子重校验。"
    })
}
fn enrich_record(mut record: Value) -> Result<Value> {
    // 只为已实现的方法派生摘要，并保持已保存结余原样；不一致时停止展示。
    let calculated = compute(&record["report"], METHOD_VERSION)?;
    if record["computed"] != calculated {
        return Err("历史报告已保存计算与当前方法核算不一致，无法派生预检摘要".into());
    }
    if record.get("validation").is_none() {
        record["validation"] = validation(&record["report"], &calculated);
    }
    Ok(record)
}
fn submission_shape(input: &Value) -> Result<()> {
    exact_keys(
        input,
        &[
            "operationId",
            "taskId",
            "resultId",
            "expectedRevision",
            "report",
        ],
        "结果提交",
    )?;
    for key in ["operationId", "taskId", "resultId"] {
        identifier(input, key)?;
    }
    input["expectedRevision"]
        .as_u64()
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or("expectedRevision 必须为非负整数")?;
    Ok(())
}
struct CheckedSubmission {
    current: u64,
    computed: Value,
    validation: Value,
    replay: Option<Value>,
}
fn check_submission(db: &Connection, input: &Value) -> Result<CheckedSubmission> {
    submission_shape(input)?;
    let id = required(input, "operationId")?;
    let task_id = required(input, "taskId")?;
    let result_id = required(input, "resultId")?;
    let expected = input["expectedRevision"].as_u64().unwrap();
    let op = super::platform::bound_operation(db, id, task_id)?;
    let exists = has_table(db)?;
    let current = if exists {
        db.query_row(
            "SELECT COALESCE(MAX(revision),0) FROM selection_results WHERE operation_id=?",
            [id],
            |r| r.get::<_, u64>(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        0
    };
    let old: Option<(String, String)> = if exists {
        db.query_row(
            "SELECT request,record FROM selection_results WHERE result_id=?",
            [result_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    } else {
        None
    };
    if let Some((request, record)) = old {
        if parse(&request)? != *input {
            return Err("resultId 已用于不同载荷，不允许覆盖报告".into());
        }
        // 历史重投不要求成为最新版本，但继续校验原操作与输入结构。
        compute(&input["report"], required(&op, "methodVersion")?)?;
        let record = enrich_record(parse(&record)?)?;
        return Ok(CheckedSubmission {
            current,
            computed: record["computed"].clone(),
            validation: record["validation"].clone(),
            replay: Some(record),
        });
    }
    if expected != current {
        return Err("报告版本已更新，请重新获取契约后提交新版本".into());
    }
    if current == i64::MAX as u64 {
        return Err("报告版本已达到存储上限".into());
    }
    let computed = compute(&input["report"], required(&op, "methodVersion")?)?;
    let validation = validation(&input["report"], &computed);
    Ok(CheckedSubmission {
        current,
        computed,
        validation,
        replay: None,
    })
}
fn preflight(input: &Value, path: &Path) -> Result<Value> {
    submission_shape(input)?;
    let db = open_db(path, false)?.ok_or("操作单不存在")?;
    // 只读事务给同一次预检一致视图；事务结束后不保留锁或提交凭据。
    db.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let checked = check_submission(&db, input)?;
    let output = json!({"operationId":input["operationId"],"taskId":input["taskId"],"resultId":input["resultId"],"expectedRevision":input["expectedRevision"],"currentRevision":checked.current,"canSubmit":true,"replay":checked.replay.is_some(),"validation":checked.validation,"computed":checked.computed,"canCollectPlatforms":false,"adoptionStatus":"pending"});
    db.execute_batch("ROLLBACK").map_err(|e| e.to_string())?;
    Ok(output)
}
fn summary(record: &Value) -> Value {
    let candidates = record["computed"]["candidates"].as_array().unwrap();
    json!({"resultId":record["resultId"],"revision":record["revision"],"savedAt":record["savedAt"],"candidateCount":candidates.len(),"incompleteCount":candidates.iter().filter(|c|c["summary"]["status"]!="complete").count(),"adoptionStatus":"pending"})
}
pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    let id = identifier(&input, "operationId")?;
    if command == "validate-result" {
        return preflight(&input, path);
    }
    if command != "submit-result" {
        let db = open_db(path, false)?;
        let Some(db) = db else {
            return if command == "get-result" && input.get("resultId").is_none() {
                Ok(json!({"record":null,"history":[]}))
            } else {
                Err("操作单不存在".into())
            };
        };
        let op = operation(&db, &id)?;
        let history = summaries(&db, &id)?;
        if command == "get-result" {
            let raw: Option<(String, String)> = if let Some(result_id) = input.get("resultId") {
                let requested = identifier(&json!({"resultId":result_id}), "resultId")?;
                if !has_table(&db)? {
                    return Err("指定报告不存在".into());
                }
                db.query_row(
                    "SELECT operation_id,record FROM selection_results WHERE result_id=?",
                    [requested],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?
            } else if has_table(&db)? {
                db.query_row("SELECT operation_id,record FROM selection_results WHERE operation_id=? ORDER BY revision DESC LIMIT 1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?
            } else {
                None
            };
            if input.get("resultId").is_some() && raw.is_none() {
                return Err("指定报告不存在".into());
            }
            let record = if let Some((operation_id, raw)) = raw {
                if operation_id != id {
                    return Err("指定报告不属于本操作".into());
                }
                enrich_record(parse(&raw)?)?
            } else {
                Value::Null
            };
            return Ok(json!({"record":record,"history":history}));
        }
        let task_id = required(&op["task"], "taskId")?;
        let revision = history
            .first()
            .map(|s| s["revision"].clone())
            .unwrap_or(json!(0));
        let template = json!({"operationId":id,"taskId":task_id,"resultId":format!("result_{}",uuid::Uuid::new_v4().simple()),"expectedRevision":revision,"report":{"schemaVersion":1,"methodVersion":op["methodVersion"],"generatedAt":"请填写 RFC3339 时间","period":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD","timeZone":"请填写 IANA 时区"},"currency":"请填写三位币种","coverage":"请填写采样覆盖和限制，空候选不得冒充已读取结果","missingFields":[],"candidates":[]}});
        return Ok(
            json!({"operationId":id,"taskId":task_id,"expectedRevision":revision,"methodVersion":op["methodVersion"],"platformContractVersion":"platform-fields-v1","submissionTemplate":template,"schema":serde_json::from_str::<Value>(include_str!("../resources/selection-result.schema.json")).map_err(|e|format!("内置契约无效：{e}"))?,"limits":{"inputBytes":1048576,"candidates":100,"totalVideos":2000,"decimalIntegerDigits":18,"decimalFractionDigits":12},"calculationNote":"回本判断使用精确十进制结余严格大于零；比例与平均值最多保留28位小数供展示，筛选应使用命中数与样本数。正式业务采纳尚未接入。"}),
        );
    }
    submission_shape(&input)?;
    let task_id = required(&input, "taskId")?;
    let result_id = required(&input, "resultId")?;
    let mut db = open_db(path, true)?.ok_or("无法打开报告数据库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let checked = check_submission(&tx, &input)?;
    if let Some(record) = checked.replay {
        return Ok(json!({"resultSummary":summary(&record),"record":record}));
    }
    let revision = checked.current + 1;
    let record = json!({"operationId":id,"taskId":task_id,"resultId":result_id,"revision":revision,"savedAt":now(),"adoptionStatus":"pending","report":input["report"],"computed":checked.computed,"validation":checked.validation});
    let result_summary = summary(&record);
    tx.execute("INSERT INTO selection_results(result_id,operation_id,revision,request,record,summary) VALUES(?,?,?,?,?,?)",params![result_id,id,revision,input.to_string(),record.to_string(),result_summary.to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"record":record,"resultSummary":result_summary}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            Self {
                root: std::env::temp_dir()
                    .join(format!("gapaw-results-test-{}", uuid::Uuid::new_v4())),
            }
        }
        fn path(&self) -> PathBuf {
            self.root.join("state.sqlite")
        }
        fn seed(&self, id: &str, task: Option<&str>) {
            let db = open_db(&self.path(), true).unwrap().unwrap();
            let op = json!({"id":id,"methodVersion":METHOD_VERSION,"status":"task_created","task":task.map(|id|json!({"taskId":id}))});
            db.execute(
                "INSERT INTO operations VALUES(?,?,?,?,?)",
                params![id, id, "{}", op.to_string(), now()],
            )
            .unwrap();
        }
        fn run(&self, command: &str, input: Value) -> Result<Value> {
            super::super::execute(command, input, &self.path(), None)
        }
        fn submit(&self, result_id: &str, revision: u64, report: Value) -> Value {
            json!({"operationId":"op_one","taskId":"tsk_one","resultId":result_id,"expectedRevision":revision,"report":report})
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn video(id: &str) -> Value {
        json!({"videoId":id,"url":format!("https://example.com/video/{id}"),"publishedAt":"2026-10-01T04:00:00Z","contributionRate":"0.5","sales":[{"kind":"total","gmv":"100","commissionRate":"0.1"}],"adSpend":"2","fixedFee":"1","sampleCost":"1"})
    }
    fn candidate(id: &str, videos: Vec<Value>) -> Value {
        json!({"platform":"tiktok","creatorId":id,"handle":format!("test_{id}"),"profileUrl":format!("https://example.com/{id}"),"reason":"测试候选依据","sources":[{"url":"https://example.com/source","capturedAt":"2026-10-02T00:00:00Z","note":"仅测试来源"}],"missingFields":[],"videos":videos})
    }
    fn report(videos: Vec<Value>) -> Value {
        json!({"schemaVersion":1,"methodVersion":METHOD_VERSION,"generatedAt":"2026-10-02T00:00:00Z","period":{"start":"2026-10-01","end":"2026-10-01","timeZone":"Asia/Shanghai"},"currency":"USD","coverage":"仅测试样本，不是生产采集","missingFields":[],"candidates":[candidate("creator_one",videos)]})
    }
    #[test]
    fn exact_decimal_counts_preserve_tiny_positive_zero_and_negative() {
        let mut tiny = video("tiny");
        tiny["contributionRate"] = json!("0.300000000001");
        tiny["sales"] = json!([{"kind":"total","gmv":"0.1","commissionRate":"0.3"}]);
        for key in ["adSpend", "fixedFee", "sampleCost"] {
            tiny[key] = json!("0");
        }
        let mut zero = tiny.clone();
        zero["videoId"] = json!("zero");
        zero["sales"][0]["gmv"] = json!("0");
        let mut negative = zero.clone();
        negative["videoId"] = json!("negative");
        negative["fixedFee"] = json!("1");
        let computed = compute(&report(vec![tiny, zero, negative]), METHOD_VERSION).unwrap();
        let c = &computed["candidates"][0];
        assert_eq!(c["summary"]["totalVideos"], 3);
        assert_eq!(c["summary"]["breakEvenCount"], 1);
        assert_eq!(c["videos"][0]["surplus"], "0.0000000000001");
        assert_eq!(c["videos"][1]["surplus"], "0");
        assert_eq!(c["videos"][2]["surplus"], "-1");
        assert_eq!(
            c["summary"]["breakEvenRate"],
            "0.3333333333333333333333333333"
        );
    }
    #[test]
    fn unknown_inputs_do_not_become_zero_or_partial_break_even_rates() {
        let mut unknown = video("unknown");
        unknown["adSpend"] = Value::Null;
        let c = compute(&report(vec![video("known"), unknown]), METHOD_VERSION).unwrap()
            ["candidates"][0]
            .clone();
        assert_eq!(c["summary"]["status"], "incomplete");
        assert_eq!(c["summary"]["evaluatedVideos"], 1);
        assert_eq!(c["summary"]["knownPositiveVideos"], 1);
        for field in ["breakEvenCount", "breakEvenRate", "averageSurplus"] {
            assert!(c["summary"][field].is_null());
        }
        assert_eq!(c["videos"][1]["missingFields"], json!(["adSpend"]));
        assert!(c["videos"][1]["surplus"].is_null());
        let empty = compute(&report(vec![]), METHOD_VERSION).unwrap();
        assert_eq!(empty["candidates"][0]["summary"]["status"], "no_sample");
        assert!(empty["candidates"][0]["summary"]["breakEvenRate"].is_null());
    }
    #[test]
    fn split_commissions_are_calculated_once_and_mixed_total_is_rejected() {
        let mut v = video("split");
        v["sales"] = json!([{"kind":"organic","gmv":"100","commissionRate":"0.1"},{"kind":"ads","gmv":"100","commissionRate":"0.2"}]);
        assert_eq!(
            compute(&report(vec![v.clone()]), METHOD_VERSION).unwrap()["candidates"][0]["videos"]
                [0]["surplus"],
            "66"
        );
        v["sales"][1]["kind"] = json!("total");
        assert!(compute(&report(vec![v.clone()]), METHOD_VERSION).is_err());
        v["sales"][1]["kind"] = json!("organic");
        assert!(compute(&report(vec![v]), METHOD_VERSION).is_err());
    }
    #[test]
    fn timezone_boundaries_dates_and_sources_are_checked() {
        let mut v = video("tz");
        v["publishedAt"] = json!("2026-09-30T16:00:00Z");
        assert!(compute(&report(vec![v.clone()]), METHOD_VERSION).is_ok());
        v["publishedAt"] = json!("2026-09-30T15:59:59Z");
        assert!(compute(&report(vec![v]), METHOD_VERSION).is_err());
        for (path, value) in [
            ("/period/timeZone", json!("Mars/City")),
            ("/period/start", json!("2026-02-30")),
            ("/generatedAt", json!("2026-10-02")),
            (
                "/candidates/0/profileUrl",
                json!("https://user:password@example.com"),
            ),
            ("/candidates/0/sources", json!([])),
            ("/candidates/0/sources/0/capturedAt", json!("invalid")),
        ] {
            let mut r = report(vec![video("v")]);
            *r.pointer_mut(path).unwrap() = value;
            assert!(compute(&r, METHOD_VERSION).is_err(), "{path}");
        }
    }
    #[test]
    fn duplicates_unknown_fields_and_invalid_decimal_forms_are_rejected() {
        let mut r = report(vec![video("v")]);
        let duplicate = r["candidates"][0].clone();
        r["candidates"].as_array_mut().unwrap().push(duplicate);
        assert!(compute(&r, METHOD_VERSION).is_err());
        let mut r = report(vec![video("v")]);
        r["candidates"]
            .as_array_mut()
            .unwrap()
            .push(candidate("other", vec![video("v")]));
        assert!(compute(&r, METHOD_VERSION).is_err());
        for value in [
            json!("1e1000000"),
            json!("0.0000000000001"),
            json!("1234567890123456789"),
            json!("01"),
            json!(-1),
            json!("-1"),
        ] {
            let mut v = video("v");
            v["adSpend"] = value;
            assert!(compute(&report(vec![v]), METHOD_VERSION).is_err());
        }
        let mut v = video("v");
        v.as_object_mut().unwrap().remove("sampleCost");
        assert!(compute(&report(vec![v]), METHOD_VERSION).is_err());
        let mut v = video("v");
        v["contributionRate"] = json!("-0.5");
        assert!(compute(&report(vec![v]), METHOD_VERSION).is_ok());
        let mut v = video("v");
        v["sales"][0]["commissionRate"] = json!("1.1");
        assert!(compute(&report(vec![v]), METHOD_VERSION).is_err());
        let mut r = report(vec![]);
        r["computed"] = json!({});
        assert!(compute(&r, METHOD_VERSION).is_err());
    }
    #[test]
    fn readonly_commands_do_not_create_or_migrate_old_databases() {
        let f = Fixture::new();
        assert_eq!(
            f.run("get-result", json!({"operationId":"op_one"}))
                .unwrap(),
            json!({"record":null,"history":[]})
        );
        assert!(f
            .run("result-contract", json!({"operationId":"op_one"}))
            .is_err());
        assert!(!f.root.exists());
        f.seed("op_one", Some("tsk_one"));
        let db = Connection::open(f.path()).unwrap();
        db.execute("DROP TABLE selection_results", []).unwrap();
        assert!(f
            .run("get-result", json!({"operationId":"op_one"}))
            .unwrap()["record"]
            .is_null());
        assert_eq!(
            f.run("result-contract", json!({"operationId":"op_one"}))
                .unwrap()["expectedRevision"],
            0
        );
        let ops = f.run("list-operations", json!({})).unwrap();
        assert!(ops["operations"][0]["resultSummary"].is_null());
        assert!(!has_table(&db).unwrap());
    }
    #[test]
    fn reports_are_idempotent_versioned_and_bound_to_the_original_task() {
        let f = Fixture::new();
        f.seed("op_one", Some("tsk_one"));
        let first = f.submit("res_one", 0, report(vec![video("v")]));
        let first_record = f.run("submit-result", first.clone()).unwrap();
        assert_eq!(first_record["record"]["adoptionStatus"], "pending");
        assert_eq!(first_record["record"]["revision"], 1);
        let second = f.submit("res_two", 1, report(vec![]));
        f.run("submit-result", second).unwrap();
        assert_eq!(f.run("submit-result", first.clone()).unwrap(), first_record);
        let mut changed = first.clone();
        changed["report"]["coverage"] = json!("changed");
        assert!(f.run("submit-result", changed).is_err());
        assert!(f
            .run("submit-result", f.submit("res_stale", 0, report(vec![])))
            .is_err());
        let mut wrong = f.submit("res_wrong", 2, report(vec![]));
        wrong["taskId"] = json!("tsk_wrong");
        assert!(f.run("submit-result", wrong).is_err());
        let mut wrong = f.submit("res_method", 2, report(vec![]));
        wrong["report"]["methodVersion"] = json!("different");
        assert!(f.run("submit-result", wrong).is_err());
        let latest = f
            .run("get-result", json!({"operationId":"op_one"}))
            .unwrap();
        assert_eq!(latest["record"]["resultId"], "res_two");
        assert_eq!(latest["history"].as_array().unwrap().len(), 2);
        assert_eq!(
            f.run(
                "get-result",
                json!({"operationId":"op_one","resultId":"res_one"})
            )
            .unwrap()["record"],
            first_record["record"]
        );
        f.seed("op_two", Some("tsk_two"));
        assert!(f
            .run(
                "get-result",
                json!({"operationId":"op_two","resultId":"res_one"})
            )
            .is_err());
        let ops = f.run("list-operations", json!({})).unwrap();
        let one = ops["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["id"] == "op_one")
            .unwrap();
        assert_eq!(one["resultSummary"]["revision"], 2);
        assert!(one.get("report").is_none());
        assert!(one.get("computed").is_none());
    }
    #[test]
    fn unbound_operation_and_oversized_input_are_rejected() {
        let f = Fixture::new();
        f.seed("op_one", None);
        assert!(f
            .run("submit-result", f.submit("r", 0, report(vec![])))
            .is_err());
        assert!(f
            .run("result-contract", json!({"operationId":"op_one"}))
            .is_err());
        let oversized = json!({"operationId":"op_one","padding":"x".repeat(1024*1024)});
        assert!(f.run("submit-result", oversized).is_err());
    }
    #[test]
    fn concurrent_same_id_submissions_return_the_same_snapshot() {
        let f = Fixture::new();
        f.seed("op_one", Some("tsk_one"));
        let request = f.submit("concurrent", 0, report(vec![video("v")]));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let p = f.path();
                let r = request.clone();
                std::thread::spawn(move || super::execute("submit-result", r, &p).unwrap())
            })
            .collect();
        let records: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(records.iter().all(|r| r == &records[0]));
        assert_eq!(
            f.run("get-result", json!({"operationId":"op_one"}))
                .unwrap()["history"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
