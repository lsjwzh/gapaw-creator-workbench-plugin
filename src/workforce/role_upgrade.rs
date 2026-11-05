//! 只读生成宿主角色升级计划；版本和生效快照仍由 MultiCC 管理。
use super::*;

pub(super) fn plan(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["roles"], "team-role-upgrade-plan")?;
    let current = input["roles"].as_array().ok_or("缺少宿主角色快照")?;
    let mut db = open(path, false)?.ok_or("办公室尚未初始化")?;
    let tx = db.transaction().map_err(err)?;
    let rows = staff(&tx)?;
    if rows.len() != 8 || current.len() != 8 {
        return Err("必须先核对完整的 8 个角色任务".into());
    }
    let mut seen = std::collections::HashSet::new();
    for value in current {
        if !seen.insert(identifier(value, "taskId")?) {
            return Err("宿主角色快照存在重复任务".into());
        }
    }
    let mut updates = Vec::new();
    for row in rows {
        let key = required(&row, "key")?;
        let (_, label, description) = ROLES.iter().find(|r| r.0 == key).ok_or("未知员工角色")?;
        let task = identifier(&row["task"], "taskId")?;
        let old = current
            .iter()
            .find(|v| v["taskId"] == task)
            .ok_or("宿主任务与办公室绑定不一致")?;
        let version = old["version"]
            .as_u64()
            .filter(|v| *v < 1_000_000_000)
            .ok_or("宿主角色版本无效")?;
        let bindings = old["bindings"].as_array().ok_or("宿主角色快照缺失")?;
        let desired = prompt(key, label, description);
        if bindings.len() != 1 {
            return Err(format!("{label}已自定义角色组合，请在原任务中核对后更新"));
        }
        let current_prompt = required(&bindings[0], "prompt")?;
        if current_prompt == desired {
            continue;
        }
        if current_prompt != required(&row["plan"], "rolePrompt")? {
            return Err(format!("{label}的角色提示词已自行修改，不能覆盖"));
        }
        let name = required(&bindings[0], "name")?;
        updates.push(json!({"staffKey":key,"taskId":task,"before":old,
            "path":format!("/api/air/tasks/{task}/roles"),
            "body":{"expectedVersion":version,"clientMsgId":format!("gapaw_delivery_roles_v1_{task}_{version}"),
                "bindings":[{"name":name,"prompt":desired}]}}));
    }
    Ok(json!({"protocolVersion":1,"updates":updates,"taskCount":8,
        "boundary":"只生成角色更新请求，不改冻结创建计划，不创建任务、不启动模型；宿主按角色版本校验并从后续新消息生效。"}))
}
