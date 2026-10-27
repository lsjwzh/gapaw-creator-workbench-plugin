//! 平台读取职责契约：只读声明，不探测或推断真实账号能力。
use super::{identifier, open_db, operation, Result};
use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;

pub fn bound_operation(db: &Connection, id: &str, task_id: &str) -> Result<Value> {
    let op = operation(db, id)?;
    if op["kind"] == "drafts" {
        return Err("邀约草稿任务不接受选人报告或平台观测".into());
    }
    if op["task"]["taskId"].as_str() != Some(task_id)
        || !["task_created", "accepted", "delivery_failed"]
            .contains(&op["status"].as_str().unwrap_or(""))
    {
        return Err("taskId 必须匹配原操作已创建的宿主任务".into());
    }
    Ok(op)
}

pub fn execute(input: Value, path: &Path) -> Result<Value> {
    let keys = ["operationId", "taskId"];
    if input
        .as_object()
        .is_none_or(|o| o.len() != keys.len() || o.keys().any(|k| !keys.contains(&k.as_str())))
    {
        return Err("platform-contract 仅接受 operationId 和 taskId".into());
    }
    let id = identifier(&input, "operationId")?;
    let task_id = identifier(&input, "taskId")?;
    let db = open_db(path, false)?.ok_or("操作单不存在")?;
    bound_operation(&db, &id, &task_id)?;
    let mut contract: Value =
        serde_json::from_str(include_str!("../resources/platform-contract.json"))
            .map_err(|_| "内置平台字段契约无效")?;
    contract["operationId"] = Value::String(id);
    contract["taskId"] = Value::String(task_id);
    Ok(contract)
}
