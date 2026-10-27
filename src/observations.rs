//! 离线平台响应的保守投影；不访问平台，也不证明身份、完整性或真实费用。
use super::{identifier, now, open_db, platform::bound_operation, Result};
use chrono::{DateTime, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

const AFFILIATE: &str = "affiliate-marketplace-v1";
const KALODATA: &str = "kalodata-creator-videos-v1";
const MAX_BYTES: usize = 512 * 1024;
const MAX_ITEMS: usize = 100;
const MAX_SNAPSHOTS: usize = 100;
const WARNING_SOURCE: &str =
    "离线导入响应；来源、账号权限、采集时间与请求上下文均未核验，不代表实时采集。";
const WARNING_COVERAGE: &str =
    "仅保留当前响应的观测；页码、条数及 has_more=false 均不证明完整覆盖，空数组不证明实际零结果。";
const WARNING_ROI: &str =
    "来源身份不等同 TikTok 统一身份；不合并昵称，不自动生成回本率，未知费用不得补零。";
const WARNING_KALO: &str =
    "Kalodata 指标是第三方估算；ad 仅是平台广告标记，不是广告消耗；发布时间类型与时区未核验。";

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS source_observations(observation_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,task_id TEXT NOT NULL,input_hash TEXT NOT NULL,snapshot TEXT NOT NULL,saved_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS source_observations_operation ON source_observations(operation_id,saved_at,observation_id);")
        .map_err(|_| "无法初始化来源观测表".to_string())
}
fn keys(v: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let o = v.as_object().ok_or("观测结构必须是对象")?;
    if required.iter().any(|k| !o.contains_key(*k))
        || o.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err("观测结构含缺失或不支持的字段".into());
    }
    Ok(())
}
fn safe_text(v: &Value, max: usize) -> Result<&str> {
    v.as_str()
        .filter(|s| s.len() <= max && !s.chars().any(char::is_control))
        .ok_or_else(|| "观测文本类型或长度无效".into())
}
fn source_id(v: &Value) -> Result<String> {
    let text = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) if n.is_u64() => n.to_string(),
        _ => return Err("来源身份必须是字符串或非负整数，不能推测身份".into()),
    };
    identifier(&json!({"sourceId":text}), "sourceId")
}
fn adapter_meta(adapter: &str) -> Result<(&'static str, &'static str, &'static str)> {
    match adapter {
        AFFILIATE => Ok((
            "affiliate",
            "/api/v1/oec/affiliate/creator/marketplace/find",
            "affiliate_oec",
        )),
        KALODATA => Ok((
            "kalodata",
            "/creator/detail/video/queryList",
            "kalodata_video",
        )),
        _ => Err("不支持的离线来源适配器".into()),
    }
}
fn context(v: &Value, adapter: &str) -> Result<()> {
    keys(
        v,
        &[
            "country",
            "currency",
            "period",
            "creatorSourceId",
            "pageNo",
            "pageSize",
        ],
        &[],
    )?;
    let country = safe_text(&v["country"], 2)?;
    if country.len() != 2 || !country.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("country 必须是两位大写国家代码".into());
    }
    if !v["currency"].is_null() {
        let currency = safe_text(&v["currency"], 3)?;
        if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err("currency 必须是三位大写币种或 null".into());
        }
    }
    if adapter == KALODATA {
        safe_text(&v["creatorSourceId"], 200)?;
        source_id(&v["creatorSourceId"])?;
    } else if !v["creatorSourceId"].is_null() {
        return Err("达人广场响应不能声明单一达人上下文".into());
    }
    let page = v["pageNo"].as_u64().ok_or("pageNo 必须是非负整数")?;
    let size = v["pageSize"].as_u64().ok_or("pageSize 必须是整数")?;
    if page > 1_000_000 || !(1..=100).contains(&size) {
        return Err("分页上下文超出限制".into());
    }
    let period = &v["period"];
    if !period.is_null() {
        keys(period, &["start", "end", "timeZone"], &[])?;
        let mut dates = Vec::new();
        for key in ["start", "end"] {
            let date = if period[key].is_null() || period[key] == "unknown" {
                None
            } else {
                let raw = safe_text(&period[key], 10)?;
                let d = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                    .map_err(|_| "日期必须为 YYYY-MM-DD 或 unknown/null")?;
                if d.format("%Y-%m-%d").to_string() != raw {
                    return Err("日期必须为 YYYY-MM-DD".into());
                }
                Some(d)
            };
            dates.push(date);
        }
        if matches!((dates[0],dates[1]), (Some(a),Some(b)) if a>b) {
            return Err("统计区间开始日期不能晚于结束日期".into());
        }
        if !period["timeZone"].is_null() && period["timeZone"] != "unknown" {
            safe_text(&period["timeZone"], 100)?
                .parse::<chrono_tz::Tz>()
                .map_err(|_| "时区必须是 IANA 时区或 unknown/null")?;
        }
    }
    Ok(())
}
fn plain_decimal(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let mut parts = s.split('.');
    let int = parts.next().unwrap_or("");
    let fraction = parts.next();
    !int.is_empty()
        && int.len() <= 30
        && int.bytes().all(|b| b.is_ascii_digit())
        && (int == "0" || !int.starts_with('0'))
        && fraction
            .is_none_or(|p| !p.is_empty() && p.len() <= 18 && p.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}
fn value_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "missing",
        Value::String(_) => "string",
        Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        _ => "invalid",
    }
}
fn scalar(v: &Value) -> Result<(Value, Value)> {
    match v {
        Value::Null => Ok((Value::Null, Value::Null)),
        Value::String(s) => {
            safe_text(v, 500)?;
            Ok((
                json!(s),
                if plain_decimal(s) {
                    json!(s)
                } else {
                    Value::Null
                },
            ))
        }
        Value::Number(n) => {
            let s = n.to_string();
            Ok((
                json!(s),
                if (n.is_i64() || n.is_u64()) && plain_decimal(&s) {
                    json!(s)
                } else {
                    Value::Null
                },
            ))
        }
        Value::Bool(b) => Ok((json!(b.to_string()), Value::Null)),
        _ => Err("来源字段结构已变化：预期标量，未投影响应内容".into()),
    }
}
#[derive(Clone, Copy)]
struct Field {
    name: &'static str,
    path: &'static str,
    unit: &'static str,
    scope: &'static str,
    numeric: bool,
}
const AFF_FIELDS: &[Field] = &[
    Field {
        name: "handle",
        path: "handle.value",
        unit: "text",
        scope: "creator_identity",
        numeric: false,
    },
    Field {
        name: "nickname",
        path: "nickname.value",
        unit: "text",
        scope: "creator_identity",
        numeric: false,
    },
    Field {
        name: "followers",
        path: "follower_cnt.value",
        unit: "count",
        scope: "creator_aggregate_unknown_period",
        numeric: true,
    },
    Field {
        name: "videoGmv",
        path: "video_gmv.value.value",
        unit: "source_currency",
        scope: "creator_cross_shop_video_aggregate_unknown_period",
        numeric: true,
    },
    Field {
        name: "videoGmvCurrencySymbol",
        path: "video_gmv.value.symbol",
        unit: "text",
        scope: "source_display_unit",
        numeric: false,
    },
    Field {
        name: "liveGmv",
        path: "live_gmv.value.value",
        unit: "source_currency",
        scope: "creator_cross_shop_live_aggregate_unknown_period",
        numeric: true,
    },
    Field {
        name: "liveGmvCurrencySymbol",
        path: "live_gmv.value.symbol",
        unit: "text",
        scope: "source_display_unit",
        numeric: false,
    },
    Field {
        name: "medGmv",
        path: "med_gmv_revenue.value.value",
        unit: "source_currency",
        scope: "creator_aggregate_unknown_period",
        numeric: true,
    },
    Field {
        name: "medGmvCurrencySymbol",
        path: "med_gmv_revenue.value.symbol",
        unit: "text",
        scope: "source_display_unit",
        numeric: false,
    },
    Field {
        name: "unitsSold",
        path: "units_sold.value",
        unit: "count",
        scope: "creator_aggregate_unknown_period",
        numeric: true,
    },
    Field {
        name: "averageViews",
        path: "ec_video_avg_view_cnt.value",
        unit: "count",
        scope: "creator_aggregate_unknown_period",
        numeric: true,
    },
    Field {
        name: "engagement",
        path: "ec_video_engagement.value",
        unit: "ratio_unknown",
        scope: "creator_aggregate_unknown_period",
        numeric: true,
    },
];
const KALO_FIELDS: &[Field] = &[
    Field {
        name: "publishedAt",
        path: "create_time",
        unit: "date_unknown",
        scope: "video_publication_unknown_timezone",
        numeric: false,
    },
    Field {
        name: "sales",
        path: "sale",
        unit: "count",
        scope: "video_requested_period_estimate",
        numeric: true,
    },
    Field {
        name: "revenue",
        path: "revenue",
        unit: "source_currency",
        scope: "video_requested_period_estimate",
        numeric: true,
    },
    Field {
        name: "advertisingFlag",
        path: "ad",
        unit: "flag",
        scope: "platform_advertising_marker_not_cost",
        numeric: false,
    },
    Field {
        name: "advertisingRevenueRatio",
        path: "ad_revenue_ratio",
        unit: "ratio_unknown",
        scope: "video_requested_period_estimate",
        numeric: true,
    },
];
fn field_defs(adapter: &str) -> &'static [Field] {
    if adapter == AFFILIATE {
        AFF_FIELDS
    } else {
        KALO_FIELDS
    }
}
fn projected_value<'a>(row: &'a Value, path: &str, affiliate: bool) -> Result<&'a Value> {
    let first = path.split('.').next().unwrap();
    if affiliate {
        if let Some(wrapper) = row.get(first) {
            if !wrapper.is_object() {
                return Err("Affiliate 字段包装结构已变化".into());
            }
            if let Some(authorized) = wrapper.get("is_authorized") {
                if !authorized.is_boolean() {
                    return Err("Affiliate 字段授权标记结构已变化".into());
                }
                if authorized == false {
                    return Ok(&Value::Null);
                }
            }
            if wrapper.get("value").is_none() {
                return Err("Affiliate 字段缺少 value 包装".into());
            }
        }
    }
    let mut current = row;
    for part in path.split('.') {
        if current.is_null() {
            return Ok(&Value::Null);
        }
        if !current.is_object() {
            return Err("来源字段嵌套结构已变化".into());
        }
        current = current.get(part).unwrap_or(&Value::Null);
    }
    Ok(current)
}
fn fields(row: &Value, adapter: &str, index: usize) -> Result<Value> {
    let affiliate = adapter == AFFILIATE;
    let mut out = Map::new();
    for f in field_defs(adapter) {
        let value = projected_value(row, f.path, affiliate)?;
        let (raw, decimal) = scalar(value)?;
        out.insert(f.name.into(), json!({"sourcePath":format!("{}[{index}].{}",if affiliate {"creator_profile_list"} else {"data"},f.path),"rawDisplay":raw,"valueType":value_type(value),"decimalValue":if f.numeric {decimal} else {Value::Null},"unit":f.unit,"scope":f.scope,"estimated":if affiliate {"unknown"} else {"third_party_estimate"},"verification":"unverified"}));
    }
    Ok(Value::Object(out))
}
fn warnings(adapter: &str) -> Vec<&'static str> {
    let mut out = vec![WARNING_SOURCE, WARNING_COVERAGE, WARNING_ROI];
    if adapter == KALODATA {
        out.push(WARNING_KALO);
    }
    out
}
fn normalize(input: &Value) -> Result<Value> {
    keys(
        input,
        &[
            "operationId",
            "taskId",
            "observationId",
            "adapter",
            "capturedAt",
            "context",
            "response",
        ],
        &[],
    )?;
    if input.to_string().len() > MAX_BYTES {
        return Err("来源观测输入超过 512 KiB 限制".into());
    }
    for key in ["operationId", "taskId", "observationId"] {
        identifier(input, key)?;
    }
    let adapter = safe_text(&input["adapter"], 80)?;
    let (provider, endpoint, namespace) = adapter_meta(adapter)?;
    DateTime::parse_from_rfc3339(safe_text(&input["capturedAt"], 50)?)
        .map_err(|_| "capturedAt 必须是 RFC3339 时间，且仍属于未核验用户声明")?;
    context(&input["context"], adapter)?;
    let response = input["response"].as_object().ok_or("平台响应必须是对象")?;
    let affiliate = adapter == AFFILIATE;
    if (affiliate && response.get("code") != Some(&json!(0)))
        || (!affiliate && response.get("success") != Some(&json!(true)))
    {
        return Err("平台响应未明确成功，拒绝导入；未回显响应正文".into());
    }
    let rows = response
        .get(if affiliate {
            "creator_profile_list"
        } else {
            "data"
        })
        .and_then(Value::as_array)
        .ok_or("平台响应列表缺失或结构已变化")?;
    if rows.len() > MAX_ITEMS {
        return Err("单次来源观测最多 100 条".into());
    }
    let has_more = if affiliate {
        match response.get("next_pagination") {
            None | Some(Value::Null) => Value::Null,
            Some(Value::Object(p)) => match p.get("has_more") {
                None | Some(Value::Null) => Value::Null,
                Some(Value::Bool(b)) => json!(b),
                _ => return Err("平台分页标记结构已变化".into()),
            },
            _ => return Err("平台分页结构已变化".into()),
        }
    } else {
        Value::Null
    };
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if !row.is_object() {
            return Err("平台列表项必须是对象".into());
        }
        let id = source_id(if affiliate {
            projected_value(row, "creator_oecuid.value", true)?
        } else {
            &row["id"]
        })?;
        if !seen.insert(id.clone()) {
            return Err("同一响应存在重复来源身份，不能静默合并".into());
        }
        items.push(json!({"kind":if affiliate {"creator"} else {"video"},"sourceIdentity":{"namespace":namespace,"sourceId":id},"creatorIdentity":if affiliate {Value::Null} else {json!({"namespace":"kalodata_creator","sourceId":source_id(&input["context"]["creatorSourceId"])?})},"fields":fields(row,adapter,index)?}));
    }
    let hash = format!("{:x}", Sha256::digest(input.to_string().as_bytes()));
    let snapshot = json!({"schemaVersion":1,"observationId":input["observationId"],"operationId":input["operationId"],"taskId":input["taskId"],"adapter":adapter,"source":{"provider":provider,"endpoint":endpoint,"mode":"imported_response","verified":false},"capturedAt":input["capturedAt"],"context":input["context"],"inputHash":hash,"items":items,"coverage":{"status":if rows.is_empty() {"unknown"} else {"partial"},"complete":false,"itemCount":rows.len(),"reportedHasMore":has_more,"pageNo":input["context"]["pageNo"],"pageSize":input["context"]["pageSize"],"zeroResultsVerified":false},"warnings":warnings(adapter)});
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

/// 附件只接受保守投影，不接受任意对象、未知字段或提升可信度的标记。
pub(crate) fn validate_snapshot(v: &Value) -> Result<()> {
    keys(
        v,
        &[
            "schemaVersion",
            "observationId",
            "operationId",
            "taskId",
            "adapter",
            "source",
            "capturedAt",
            "context",
            "inputHash",
            "items",
            "coverage",
            "warnings",
        ],
        &[],
    )?;
    if v.to_string().len() > 1024 * 1024 || v["schemaVersion"] != 1 {
        return Err("来源观测版本或大小不支持".into());
    }
    for key in ["observationId", "operationId", "taskId"] {
        identifier(v, key)?;
    }
    let adapter = safe_text(&v["adapter"], 80)?;
    let (provider, endpoint, namespace) = adapter_meta(adapter)?;
    if v["source"]
        != json!({"provider":provider,"endpoint":endpoint,"mode":"imported_response","verified":false})
    {
        return Err("来源观测不能提升可信度或改写来源".into());
    }
    DateTime::parse_from_rfc3339(safe_text(&v["capturedAt"], 50)?)
        .map_err(|_| "来源观测采集时间格式无效")?;
    context(&v["context"], adapter)?;
    let hash = safe_text(&v["inputHash"], 64)?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("来源观测输入摘要格式无效".into());
    }
    if v["warnings"] != json!(warnings(adapter)) {
        return Err("来源观测风险说明不完整".into());
    }
    let items = v["items"].as_array().ok_or("来源观测 items 必须是数组")?;
    if items.len() > MAX_ITEMS {
        return Err("来源观测条数超出限制".into());
    }
    let coverage = &v["coverage"];
    keys(
        coverage,
        &[
            "status",
            "complete",
            "itemCount",
            "reportedHasMore",
            "pageNo",
            "pageSize",
            "zeroResultsVerified",
        ],
        &[],
    )?;
    if coverage["status"]
        != if items.is_empty() {
            "unknown"
        } else {
            "partial"
        }
        || coverage["complete"] != false
        || coverage["zeroResultsVerified"] != false
        || coverage["itemCount"] != json!(items.len())
        || coverage["pageNo"] != v["context"]["pageNo"]
        || coverage["pageSize"] != v["context"]["pageSize"]
        || !(coverage["reportedHasMore"].is_null() || coverage["reportedHasMore"].is_boolean())
        || adapter == KALODATA && !coverage["reportedHasMore"].is_null()
    {
        return Err("来源观测覆盖状态不合法，不能认定完整或实际零结果".into());
    }
    let mut ids = HashSet::new();
    for (index, item) in items.iter().enumerate() {
        keys(
            item,
            &["kind", "sourceIdentity", "creatorIdentity", "fields"],
            &[],
        )?;
        keys(&item["sourceIdentity"], &["namespace", "sourceId"], &[])?;
        let id = source_id(&item["sourceIdentity"]["sourceId"])?;
        if item["sourceIdentity"]["sourceId"] != json!(id)
            || !ids.insert(id)
            || item["sourceIdentity"]["namespace"] != namespace
            || item["kind"]
                != if adapter == AFFILIATE {
                    "creator"
                } else {
                    "video"
                }
        {
            return Err("来源身份结构不合法或重复".into());
        }
        let expected_creator = if adapter == AFFILIATE {
            Value::Null
        } else {
            json!({"namespace":"kalodata_creator","sourceId":source_id(&v["context"]["creatorSourceId"])?})
        };
        if item["creatorIdentity"] != expected_creator {
            return Err("来源达人身份不能改写或跨来源合并".into());
        }
        let defs = field_defs(adapter);
        let names = defs.iter().map(|f| f.name).collect::<Vec<_>>();
        keys(&item["fields"], &names, &[])?;
        for f in defs {
            let field = &item["fields"][f.name];
            keys(
                field,
                &[
                    "sourcePath",
                    "rawDisplay",
                    "valueType",
                    "decimalValue",
                    "unit",
                    "scope",
                    "estimated",
                    "verification",
                ],
                &[],
            )?;
            let expected_path = format!(
                "{}[{index}].{}",
                if adapter == AFFILIATE {
                    "creator_profile_list"
                } else {
                    "data"
                },
                f.path
            );
            if field["sourcePath"] != expected_path
                || field["unit"] != f.unit
                || field["scope"] != f.scope
                || field["estimated"]
                    != if adapter == AFFILIATE {
                        "unknown"
                    } else {
                        "third_party_estimate"
                    }
                || field["verification"] != "unverified"
            {
                return Err("来源字段路径、单位或核验标记不合法".into());
            }
            let raw = if field["rawDisplay"].is_null() {
                None
            } else {
                Some(safe_text(&field["rawDisplay"], 500)?)
            };
            let kind = field["valueType"].as_str().ok_or("来源字段原始类型缺失")?;
            let valid = match kind {
                "missing" => raw.is_none(),
                "string" => raw.is_some(),
                "integer" => raw.is_some_and(|s| {
                    !s.contains('.')
                        && plain_decimal(s)
                        && (s.parse::<i64>().is_ok() || s.parse::<u64>().is_ok())
                }),
                "number" => raw.is_some_and(|s| {
                    serde_json::from_str::<Value>(s)
                        .ok()
                        .and_then(|v| v.as_number().map(|n| n.is_f64()))
                        .unwrap_or(false)
                }),
                "boolean" => matches!(raw, Some("true" | "false")),
                _ => false,
            };
            if !valid {
                return Err("来源字段原始类型与显示值不一致".into());
            }
            let expected_decimal = if f.numeric
                && ["string", "integer"].contains(&kind)
                && raw.is_some_and(plain_decimal)
            {
                field["rawDisplay"].clone()
            } else {
                Value::Null
            };
            if field["decimalValue"] != expected_decimal {
                return Err("来源字段不能把浮点、显示金额或未知值冒充精确十进制".into());
            }
        }
    }
    Ok(())
}
fn has_table(db: &Connection) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_observations')",[],|r|r.get(0)).map_err(|_|"无法读取来源观测结构".into())
}
fn saved(db: &Connection, snapshot: &Value) -> Result<Option<Value>> {
    if !has_table(db)? {
        return Ok(None);
    }
    let row:Option<(String,String,String,String)>=db.query_row("SELECT operation_id,task_id,input_hash,snapshot FROM source_observations WHERE observation_id=?",[snapshot["observationId"].as_str().unwrap()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_|"无法读取来源观测".to_string())?;
    if let Some((op, task, hash, raw)) = row {
        if snapshot["operationId"] != op
            || snapshot["taskId"] != task
            || snapshot["inputHash"] != hash
        {
            return Err("observationId 已用于不同载荷或任务，不能覆盖".into());
        }
        let old: Value = serde_json::from_str(&raw).map_err(|_| "已保存来源观测损坏")?;
        validate_snapshot(&old)?;
        if old != *snapshot {
            return Err("已保存来源观测与当前安全投影不一致".into());
        }
        return Ok(Some(old));
    }
    Ok(None)
}
fn contract(input: &Value) -> Value {
    let context = json!({"country":"US","currency":null,"period":{"start":"unknown","end":"unknown","timeZone":"unknown"},"creatorSourceId":null,"pageNo":0,"pageSize":10});
    let affiliate = json!({"code":0,"creator_profile_list":[{"creator_oecuid":{"value":"synthetic_oec_001"},"handle":{"value":"synthetic_creator"},"nickname":{"value":"合成示例，非真实达人"},"follower_cnt":{"value":100},"video_gmv":{"value":{"value":"0","symbol":"$"}},"live_gmv":{"value":{"value":null,"symbol":"$"}},"med_gmv_revenue":{"value":{"value":"$1.2K","symbol":"$"}},"units_sold":{"value":null},"ec_video_avg_view_cnt":{"value":"12.5"},"ec_video_engagement":{"value":null}}],"next_pagination":{"has_more":false}});
    let kalo = json!({"success":true,"data":[{"id":"synthetic_video_001","create_time":"2026-10-01","sale":"0","revenue":"$1.2K","ad":1,"ad_revenue_ratio":null}]});
    let templates=[(AFFILIATE,"Affiliate 达人广场响应",affiliate),(KALODATA,"Kalodata 达人视频响应",kalo)].into_iter().map(|(adapter,label,response)|{
        let mut ctx=context.clone();if adapter==KALODATA {ctx["creatorSourceId"]=json!("synthetic_kalodata_creator_001");ctx["pageNo"]=json!(1);}
        json!({"adapter":adapter,"label":label,"description":"完整合成示例，仅用于理解离线导入格式；请替换为获准取得的响应与实际声明上下文。示例不证明实时采集。","submissionTemplate":{"operationId":input["operationId"],"taskId":input["taskId"],"observationId":format!("obs_{}",uuid::Uuid::new_v4().simple()),"adapter":adapter,"capturedAt":now(),"context":ctx,"response":response}})
    }).collect::<Vec<_>>();
    json!({"schemaVersion":1,"contractVersion":"source-observations-v1","operationId":input["operationId"],"taskId":input["taskId"],"canCollectPlatforms":false,"mode":"imported_response","limits":{"inputBytes":MAX_BYTES,"items":MAX_ITEMS,"snapshotsPerOperation":MAX_SNAPSHOTS},"templates":templates,"notes":[WARNING_SOURCE,WARNING_COVERAGE,WARNING_ROI,WARNING_KALO]})
}
pub fn execute(command: &str, mut input: Value, path: &Path) -> Result<Value> {
    let submit = command == "submit-observation";
    let preview = command == "preview-observation";
    if ![
        "observation-contract",
        "preview-observation",
        "submit-observation",
        "get-observations",
    ]
    .contains(&command)
    {
        return Err("不支持的来源观测命令".into());
    }
    if (submit || preview) && input.get("rawJson").is_some() {
        keys(&input, &["rawJson"], &[])?;
        let raw = input["rawJson"]
            .as_str()
            .ok_or("rawJson 必须是原始 JSON 文本")?;
        if raw.len() > MAX_BYTES {
            return Err("来源观测原文超过 512 KiB 限制".into());
        }
        input = serde_json::from_str(raw).map_err(|_| "来源观测原文不是有效 JSON，未回显原文")?;
    }
    if !submit && !preview {
        keys(
            &input,
            &["operationId", "taskId"],
            if command == "get-observations" {
                &["observationId"]
            } else {
                &[]
            },
        )?;
    }
    let id = identifier(&input, "operationId")?;
    let task = identifier(&input, "taskId")?;
    let snapshot = if submit || preview {
        Some(normalize(&input)?)
    } else {
        None
    };
    // 首轮只读归属检查：非法请求和不存在的操作不会创建目录或表。
    let db = open_db(path, false)?.ok_or("操作单不存在")?;
    bound_operation(&db, &id, &task)?;
    if command == "observation-contract" {
        return Ok(contract(&input));
    }
    if command == "get-observations" {
        let requested = if input.get("observationId").is_some() {
            Some(identifier(&input, "observationId")?)
        } else {
            None
        };
        let mut snapshots = Vec::new();
        if has_table(&db)? {
            let mut stmt=db.prepare("SELECT operation_id,task_id,snapshot FROM source_observations WHERE (?1 IS NULL AND operation_id=?2) OR observation_id=?1 ORDER BY saved_at,observation_id LIMIT 101").map_err(|_|"无法读取来源观测")?;
            let rows = stmt
                .query_map(params![requested, id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(|_| "无法读取来源观测")?;
            for row in rows {
                let (op, owner, raw) = row.map_err(|_| "无法读取来源观测")?;
                if op != id || owner != task {
                    return Err("来源观测不属于当前操作和任务".into());
                }
                let snapshot: Value =
                    serde_json::from_str(&raw).map_err(|_| "已保存来源观测损坏")?;
                validate_snapshot(&snapshot)?;
                if snapshot["operationId"] != id || snapshot["taskId"] != task {
                    return Err("已保存来源观测归属不一致".into());
                }
                snapshots.push(snapshot);
            }
        }
        if snapshots.len() > MAX_SNAPSHOTS {
            return Err("来源观测数量超出读取限制".into());
        }
        if requested.is_some() && snapshots.is_empty() {
            return Err("指定来源观测不存在".into());
        }
        return Ok(json!({"operationId":id,"taskId":task,"snapshots":snapshots}));
    }
    let snapshot = snapshot.unwrap();
    let replay = saved(&db, &snapshot)?.is_some();
    if preview {
        return Ok(json!({"snapshot":snapshot,"replay":replay,"canCollectPlatforms":false}));
    }
    drop(db);
    let mut db = open_db(path, true)?.ok_or("无法打开来源观测数据库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "无法开启来源观测事务")?;
    bound_operation(&tx, &id, &task)?;
    init(&tx)?;
    let replay = saved(&tx, &snapshot)?.is_some();
    if !replay {
        let count: u64 = tx
            .query_row(
                "SELECT COUNT(*) FROM source_observations WHERE operation_id=?",
                [&id],
                |r| r.get(0),
            )
            .map_err(|_| "无法读取来源观测数量")?;
        if count >= MAX_SNAPSHOTS as u64 {
            return Err("每个操作最多保存 100 份来源观测".into());
        }
        tx.execute(
            "INSERT INTO source_observations VALUES(?,?,?,?,?,?)",
            params![
                input["observationId"].as_str().unwrap(),
                id,
                task,
                snapshot["inputHash"].as_str().unwrap(),
                snapshot.to_string(),
                now()
            ],
        )
        .map_err(|_| "无法保存来源观测")?;
    }
    tx.commit().map_err(|_| "无法提交来源观测事务")?;
    Ok(json!({"snapshot":snapshot,"replay":replay,"canCollectPlatforms":false}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(adapter: &str) -> Value {
        contract(&json!({"operationId":"op_test","taskId":"task_test"}))["templates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["adapter"] == adapter)
            .unwrap()["submissionTemplate"]
            .clone()
    }

    #[test]
    fn decimal_projection_preserves_only_plain_strings_and_integers() {
        for (raw, expected) in [
            (json!("0"), json!("0")),
            (json!(0), json!("0")),
            (json!(-42), json!("-42")),
            (json!("-0.0001"), json!("-0.0001")),
            (json!("12.3400"), json!("12.3400")),
            (json!("1e3"), Value::Null),
            (json!("$1.2K"), Value::Null),
            (json!("2万"), Value::Null),
            (json!(1.25), Value::Null),
            (json!("01"), Value::Null),
            (Value::Null, Value::Null),
            (json!("1-2"), Value::Null),
            (json!("+1"), Value::Null),
            (json!("1,000"), Value::Null),
        ] {
            assert_eq!(scalar(&raw).unwrap().1, expected, "{raw}");
        }
    }

    #[test]
    fn source_projection_discards_unlisted_fields_and_retains_namespaces() {
        for adapter in [AFFILIATE, KALODATA] {
            let mut input = sample(adapter);
            input["response"]["token"] = json!("SYNTHETIC_PRIVATE");
            let snapshot = normalize(&input).unwrap();
            assert!(!snapshot.to_string().contains("SYNTHETIC_PRIVATE"));
            assert_eq!(snapshot["source"]["verified"], false);
            assert_eq!(
                snapshot["items"][0]["sourceIdentity"]["namespace"],
                if adapter == AFFILIATE {
                    "affiliate_oec"
                } else {
                    "kalodata_video"
                }
            );
            validate_snapshot(&snapshot).unwrap();
        }
    }

    #[test]
    fn snapshot_validator_rejects_trust_escalation_unknown_keys_and_forged_units() {
        let snapshot = normalize(&sample(AFFILIATE)).unwrap();
        for (path, value) in [
            ("/source/verified", json!(true)),
            ("/coverage/complete", json!(true)),
            ("/coverage/zeroResultsVerified", json!(true)),
            ("/items/0/sourceIdentity/namespace", json!("tiktok")),
            ("/items/0/fields/followers/verification", json!("verified")),
            ("/items/0/fields/followers/unit", json!("USD")),
            (
                "/items/0/fields/followers/rawDisplay",
                json!({"secret":"hidden"}),
            ),
            ("/items/0/fields/medGmv/decimalValue", json!("1200")),
        ] {
            let mut bad = snapshot.clone();
            *bad.pointer_mut(path).unwrap() = value;
            assert!(validate_snapshot(&bad).is_err(), "{path}");
        }
        let mut bad = snapshot.clone();
        bad["unexpected"] = json!(true);
        assert!(validate_snapshot(&bad).is_err());
        let mut bad = snapshot;
        bad["items"][0]["fields"]["followers"]["authorization"] = json!("hidden");
        assert!(validate_snapshot(&bad).is_err());
    }

    #[test]
    fn incomplete_and_empty_responses_cannot_prove_full_coverage_or_zero_results() {
        let mut input = sample(AFFILIATE);
        let snapshot = normalize(&input).unwrap();
        assert_eq!(snapshot["coverage"]["reportedHasMore"], false);
        assert_eq!(snapshot["coverage"]["complete"], false);
        input["response"]
            .as_object_mut()
            .unwrap()
            .remove("next_pagination");
        let snapshot = normalize(&input).unwrap();
        assert!(snapshot["coverage"]["reportedHasMore"].is_null());
        input["response"]["creator_profile_list"] = json!([]);
        let snapshot = normalize(&input).unwrap();
        assert_eq!(snapshot["coverage"]["status"], "unknown");
        assert_eq!(snapshot["coverage"]["zeroResultsVerified"], false);
    }

    #[test]
    fn unknown_and_unauthorized_fields_stay_unknown_and_changed_shapes_fail() {
        let mut input = sample(AFFILIATE);
        input["response"]["creator_profile_list"][0]["follower_cnt"] =
            json!({"is_authorized":false,"value":999});
        assert!(
            normalize(&input).unwrap()["items"][0]["fields"]["followers"]["rawDisplay"].is_null()
        );
        input["response"]["creator_profile_list"][0]["follower_cnt"] = json!(12);
        assert!(normalize(&input).is_err());
        input["response"]["creator_profile_list"][0]["follower_cnt"] =
            json!({"value":{"unexpected":12}});
        assert!(normalize(&input).is_err());
        input["response"] = json!({"code":99,"message":"SYNTHETIC_PRIVATE"});
        assert!(!normalize(&input).unwrap_err().contains("SYNTHETIC_PRIVATE"));
    }
}
