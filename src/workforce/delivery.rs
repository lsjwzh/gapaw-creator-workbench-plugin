//! 首个业务交付契约：选人候选 → 文案准备。只读重建，不采信调用方自报核验。
use super::*;

fn contract() -> Value {
    json!({"pluginId":"gapaw-creator-workbench","type":"selection-brief","version":1})
}
fn payload(db: &Connection, id: &str) -> Result<Value> {
    let item = work(db, id)?;
    if item["kind"] != "selection" || item["state"] != "awaiting_review" {
        return Err("仅已交回的选人候选可交给文案员工；不代表老板已采用".into());
    }
    let creator = required(&item, "creatorId")?;
    if basis(db, creator)? != item["basis"] {
        return Err("业务数据已变化，请重新准备选人工单与交付物".into());
    }
    let submissions = read_json(db, "SELECT value FROM submissions WHERE work_id=?", [id])?;
    let submission = submissions.first().ok_or("选人工单尚无候选交回")?;
    let (handle, profile, settings, revision) = db
        .query_row(
            "SELECT handle,profile,settings,revision FROM creators WHERE id=?",
            [creator],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .map_err(err)?;
    let profile: Value = serde_json::from_str(&profile).map_err(|_| "达人档案格式无效")?;
    let settings: Value = serde_json::from_str(&settings).map_err(|_| "合作设置格式无效")?;
    if settings["product_checked"] != true
        || profile["products"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
    {
        return Err("交付缺少已核验的适配产品，请先补齐档案的 products 与 product_checked".into());
    }
    let mut facts = serde_json::Map::new();
    for k in [
        "topic",
        "products",
        "angle",
        "anchor1",
        "anchor2",
        "selectionIdentity",
        "selectionSnapshot",
        "warnings",
    ] {
        if let Some(value) = profile.get(k) {
            facts.insert(k.into(), value.clone());
        }
    }
    let mut conditions = serde_json::Map::new();
    let mut missing = Vec::new();
    for k in ["fee", "commission", "sender"] {
        let v = settings.get(k).cloned().unwrap_or(Value::Null);
        if v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()) {
            missing.push(k);
        }
        conditions.insert(k.into(), v);
    }
    Ok(
        json!({"sourceWorkId":id,"submissionId":submission["id"],"creatorId":creator,"basis":item["basis"],
        "creator":{"handle":handle,"revision":revision,"profile":facts},"conditions":conditions,
        "recommendation":submission["result"],"missingConditions":missing,
        "sourceRefs":[{"kind":"creator","id":creator,"revision":revision},{"kind":"submission","id":submission["id"]}],
        "boundary":"选人建议与现有档案的影子交付，仅供撰写候选。未填条件必须保留缺项，不得擅自补报价、承诺条件或发送。"}),
    )
}
fn bound(db: &Connection, key: &str) -> Result<String> {
    Ok(required(&assigned_task(db, key)?, "taskId")?.to_owned())
}
fn validate(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &["contract", "payload", "fromTaskId", "toTaskId"],
        "delivery-validate",
    )?;
    if input["contract"] != contract() {
        return Err("不支持的交付契约或版本".into());
    }
    let mut db = open(path, false)?.ok_or("办公室尚未初始化")?;
    let tx = db.transaction().map_err(err)?;
    if input["fromTaskId"] != bound(&tx, "sel")? || input["toTaskId"] != bound(&tx, "copy")? {
        return Err("该契约仅允许已绑定的选人员工交给文案员工".into());
    }
    let expected = payload(&tx, &identifier(&input["payload"], "sourceWorkId")?)?;
    if input["payload"] != expected {
        return Err("交付正文与业务库当前候选、档案或条件不一致，禁止自行改写来源事实".into());
    }
    Ok(json!({"valid":true,"issues":[],"basis":expected["basis"],"contract":contract()}))
}
pub(super) fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    if command == "delivery-validate" {
        return Ok(match validate(&input, path) {
            Ok(result) => result,
            Err(message) => json!({"valid":false,"issues":[message],"contract":contract()}),
        });
    }
    only_keys(&input, &["workId", "taskId"], command)?;
    let mut db = open(path, false)?.ok_or("办公室尚未初始化")?;
    let tx = db.transaction().map_err(err)?;
    check_task(&tx, "sel", &input)?;
    let payload = payload(&tx, &identifier(&input, "workId")?)?;
    let to = bound(&tx, "copy")?;
    Ok(
        json!({"action":"submit","input":{"requestId":format!("{}_selection_brief_1",required(&payload,"sourceWorkId")?),
        "toTaskId":to,"title":"选人候选交给文案准备","contract":contract(),"payload":payload},
        "instruction":"把 action 与 input 交给 MultiCC task_delivery 工具。由文案会话读取、检查、验收或退回；验收不代表老板采用。退回补充后用新工单准备正文，提交原 deliveryId 与 expectedVersion 生成新版本。"}),
    )
}
