//! 后台时钟只协调真实队列与回执；模型执行和内容验收由已绑定角色承担。
use super::*;
const STALLED: &str = "超过十五分钟未收到后续工作回执";

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))[..24].into()
}
fn create(
    db: &Connection,
    cfg: &Value,
    creator: &str,
    kind: &str,
    parent: Option<&str>,
    delivery: Option<&Value>,
    extra: &str,
) -> Result<String> {
    let rev = cfg["revision"].as_i64().ok_or("工作约定版本无效")?;
    // 保存相同约定只迁移版本；复用原根工单（包含已排除的记录），不重派。
    if extra.is_empty() {
        let existing: Option<String> = db.query_row(
            "SELECT w.id FROM work_items w JOIN office_run_work r ON r.work_id=w.id WHERE r.revision=? AND w.creator=? AND w.kind=? AND r.parent IS ? AND r.delivery_id IS ? AND r.delivery_version IS ? ORDER BY w.created LIMIT 1",
            params![rev, creator, kind, parent, delivery.and_then(|d|d["id"].as_str()), delivery.and_then(|d|d["version"].as_i64())],
            |r|r.get(0)).optional().map_err(err)?;
        if let Some(id) = existing {
            return Ok(id);
        }
    }
    let source = format!(
        "office_{rev}_{}",
        hash(&format!(
            "{creator}:{kind}:{}:{extra}:{}",
            parent.unwrap_or("root"),
            delivery.unwrap_or(&Value::Null)
        ))
    );
    let id = format!("work_{source}");
    if db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM work_items WHERE id=?)",
            [&id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(err)?
    {
        return Ok(id);
    }
    let key = role_for(kind)?;
    assigned_task(db, key)?;
    let instruction=format!("按已确认工作约定处理这一位候选。{}\n工作约定：{}\n仅准备候选；不得外发、改变报价或写正式合作事实。{}",if kind=="selection"{"核对现有档案与本轮硬条件；资料不足调用 work-report-blocker，禁止凭缺失指标推断合格。交回后通过原生交付交给小文。"}else{"先核对已验收交付，再按约定语气交回 draft.subject 与 draft.body；未确认条件留空并说明。"},cfg["values"],extra);
    let basis = basis(db, creator)?;
    let at = now();
    db.execute("INSERT INTO work_items(id,request_id,request,kind,source,creator,staff_key,state,version,basis,instruction,created,updated) VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?,?)",params![id,source,json!({"source":"onboarding","revision":rev,"creatorId":creator,"kind":kind,"parent":parent}).to_string(),kind,source,creator,key,basis,instruction,at,at]).map_err(err)?;
    db.execute("INSERT INTO office_run_work(work_id,revision,parent,delivery_id,delivery_version) VALUES(?,?,?,?,?)",params![id,rev,parent,delivery.and_then(|v|v["id"].as_str()),delivery.and_then(|v|v["version"].as_i64())]).map_err(err)?;
    event(
        db,
        "已准备待派发工单",
        json!({"workId":id,"creatorId":creator,"kind":kind,"revision":rev}),
    )?;
    Ok(id)
}
fn blocker(
    db: &Connection,
    id: &str,
    reason: &str,
    missing: Value,
    suggestion: &str,
) -> Result<Value> {
    let old = read_json(
        db,
        "SELECT value FROM office_blockers WHERE work_id=?",
        [id],
    )?
    .into_iter()
    .next();
    if let Some(ref v) = old {
        if v["reason"] == reason
            && v["missing"] == missing
            && ["pending", "waiting"].contains(&v["state"].as_str().unwrap_or(""))
        {
            return Ok(v.clone());
        }
    }
    let version = old
        .as_ref()
        .and_then(|v| v["version"].as_i64())
        .unwrap_or(0)
        + 1;
    let item = work(db, id)?;
    let v = json!({"workId":id,"staffKey":item["staffKey"],"creatorId":item["creatorId"],"version":version,"state":"pending","reason":reason,"missing":missing,"suggestion":suggestion,"observedVersion":item["version"],"observedState":item["state"],"at":now()});
    db.execute("INSERT INTO office_blockers VALUES(?,'pending',?,?) ON CONFLICT(work_id) DO UPDATE SET state='pending',version=excluded.version,value=excluded.value",params![id,version,v.to_string()]).map_err(err)?;
    event(db, "员工提出卡点", v.clone())?;
    Ok(v)
}
fn report(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &[
            "workId",
            "taskId",
            "expectedVersion",
            "basis",
            "reason",
            "missing",
            "suggestion",
        ],
        "报告卡点",
    )?;
    let id = identifier(input, "workId")?;
    let reason = bounded(input, "reason", 2000)?;
    let suggestion = bounded(input, "suggestion", 2000)?;
    let missing = input["missing"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 30)
        .ok_or("请列出具体缺项")?;
    if missing.iter().any(|v| {
        v.as_str()
            .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 1000)
    }) {
        return Err("缺项内容无效".into());
    }
    let mut db = open(path, true)?.ok_or("办公室未就绪")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let w = work(&tx, &id)?;
    check_task(&tx, required(&w, "staffKey")?, input)?;
    if context_values(&tx, &id)?.is_null() {
        return Err("此工单未接入办公室运行，请按原流程处理".into());
    }
    if !current_work(&tx, &id)?
        || basis(&tx, required(&w, "creatorId")?)? != w["basis"]
        || input["basis"] != w["basis"]
    {
        return Err("工作约定或业务依据已变化，请重新读取工单".into());
    }
    if w["state"] == "blocked" {
        let old = read_json(
            &tx,
            "SELECT value FROM office_blockers WHERE work_id=?",
            [&id],
        )?;
        if let Some(v) = old.first() {
            if v["reason"] == reason
                && v["missing"] == input["missing"]
                && v["suggestion"] == suggestion
            {
                return Ok(json!({"blocker":v,"replay":true}));
            }
        }
    }
    if w["version"] != input["expectedVersion"]
        || !["claimed", "dispatched", "processing"].contains(&w["state"].as_str().unwrap_or(""))
    {
        return Err("工单已变化，不能覆盖原处理结果".into());
    }
    tx.execute(
        "UPDATE work_items SET state='blocked',version=version+1,updated=? WHERE id=?",
        params![now(), id],
    )
    .map_err(err)?;
    let out = blocker(&tx, &id, &reason, input["missing"].clone(), &suggestion)?;
    tx.commit().map_err(err)?;
    Ok(json!({"blocker":out,"replay":false}))
}
pub(super) fn data_changed(db: &Connection, id: &str) -> Result<()> {
    blocker(
        db,
        id,
        "候选依据出现变化，需要重新核验",
        json!(["最新档案、消息、草稿或合作条件已与原工单不同"]),
        "原建议保留作历史；按最新资料重新核验后再准备候选",
    )?;
    Ok(())
}
fn accepted(
    host: &Host,
    db: &Connection,
    path: &Path,
    id: &str,
    version: Option<i64>,
) -> Result<Value> {
    let to = assigned_task(db, "copy")?;
    let from = assigned_task(db, "sel")?;
    let result = host.request(
        "GET",
        &format!(
            "/api/task-shell-tasks/{}/deliveries/{id}",
            required(&to, "taskId")?
        ),
        None,
    )?;
    let d = &result["item"];
    if d["id"] != id
        || d["state"] != "accepted"
        || d["fromTaskId"] != from["taskId"]
        || d["toTaskId"] != to["taskId"]
        || d["version"] != d["currentVersion"]
        || version.is_some_and(|v| d["version"] != v)
    {
        return Err("交付尚未由当前文案角色验收，或已经有更新版本".into());
    }
    let checked = super::super::delivery::execute(
        "delivery-validate",
        json!({"contract":d["contract"],"payload":d["payload"],"fromTaskId":d["fromTaskId"],"toTaskId":d["toTaskId"]}),
        path,
    )?;
    if checked["valid"] != true {
        return Err(format!("交付业务校验未通过：{}", checked["issues"]));
    }
    Ok(d.clone())
}
fn receive_checked(
    db: &mut Connection,
    host: &Host,
    path: &Path,
    id: &str,
    version: Option<i64>,
) -> Result<Value> {
    // 先读宿主，再进入短事务。宿主校验插件时不会被写锁阻塞。
    let d = accepted(host, db, path, id, version)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let cfg = config(&tx)?;
    if cfg["running"] != true {
        return Err("办公室已暂停，验收保留，恢复后再准备文案工单".into());
    }
    let parent = identifier(&d["payload"], "sourceWorkId")?;
    if !current_work(&tx, &parent)? || context_values(&tx, &parent)?.is_null() {
        return Err("来源工单不属于当前工作约定".into());
    }
    let w = work(&tx, &parent)?;
    if basis(&tx, required(&w, "creatorId")?)? != w["basis"] {
        return Err("业务依据已变化，拒绝旧交付".into());
    }
    let child = create(
        &tx,
        &cfg,
        required(&w, "creatorId")?,
        "copy",
        Some(&parent),
        Some(&d),
        "",
    )?;
    tx.execute(
        "UPDATE work_items SET state='handed_off',updated=? WHERE id=?",
        params![now(), parent],
    )
    .map_err(err)?;
    tx.execute("UPDATE office_blockers SET state='resolved',version=version+1,value=json_set(value,'$.state','resolved','$.version',version+1) WHERE work_id=? AND state IN ('pending','waiting')", [&parent]).map_err(err)?;
    let state = work(&tx, &child)?["state"].clone();
    tx.commit().map_err(err)?;
    Ok(json!({"workId":child,"deliveryId":id,"deliveryVersion":d["version"],"state":state}))
}
pub(super) fn check_upstream(db: &Connection, host: &Host, path: &Path, id: &str) -> Result<()> {
    let row:Option<(String,i64)>=db.query_row("SELECT delivery_id,delivery_version FROM office_run_work WHERE work_id=? AND delivery_id IS NOT NULL",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
    if let Some((d, v)) = row {
        accepted(host, db, path, &d, Some(v))?;
    }
    Ok(())
}
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}
fn schedule(db: &Connection, host: &Host, path: &Path) -> Result<Value> {
    let identity = crate::local_store::identity_connection(db)?;
    let owner = format!("gapaw-office-{identity}");
    let executable = std::env::current_exe().map_err(|_| "无法定位插件后台程序")?;
    let command = format!(
        "env GAPAW_CREATOR_DATA_DIR={} MULTICC_BASE_URL={} {} team-onboarding-tick < /dev/null",
        shell_quote(
            path.parent()
                .ok_or("持久目录无效")?
                .to_str()
                .ok_or("持久路径编码错误")?
        ),
        shell_quote(&host.base),
        shell_quote(executable.to_str().ok_or("程序路径编码错误")?)
    );
    let plan = json!({"name":"达人工作室 · 后台工单流转","kind":"script","dirId":read_config(db)?["workspace"]["dirId"],"command":command,"cron":"* * * * *","enabled":true,"scriptTimeoutMs":18000,"createdBy":owner});
    let all = host.request("GET", "/api/cron", None)?;
    let matches: Vec<_> = all
        .as_array()
        .ok_or("后台时钟清单无法读取")?
        .iter()
        .filter(|r| r["createdBy"] == owner)
        .collect();
    if matches.len() > 1 {
        return Err("发现重复的办公室时钟，请先在宿主定时任务页核对".into());
    }
    let row = if let Some(existing) = matches.first() {
        for k in ["kind", "dirId", "command", "cron"] {
            if existing[k] != plan[k] {
                return Err("原办公室时钟配置已改变，请先在宿主核对，不能覆盖".into());
            }
        }
        if existing["enabled"] != true {
            return Err("办公室时钟已在宿主停用，请在定时任务页明确恢复后再开工".into());
        }
        (*existing).clone()
    } else {
        let old = runtime_value(db, "scheduler")?;
        if old["pending"] == true {
            return Err("上次登记时钟结果未知，请先在宿主核对；不会重复创建".into());
        }
        put_runtime(db, "scheduler", &json!({"pending":true,"plan":plan}))?;
        host.request("POST", "/api/cron", Some(&plan))?
    };
    if !row["id"].is_string() || row["enabled"] != true || row["command"] != plan["command"] {
        return Err("时钟回执未核对成功".into());
    }
    put_runtime(db, "scheduler", &row)?;
    Ok(row)
}
fn control(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &[
            "requestId",
            "expectedRevision",
            "expectedControlVersion",
            "running",
        ],
        "控制办公室",
    )?;
    let req = identifier(input, "requestId")?;
    let running = input["running"].as_bool().ok_or("运行状态无效")?;
    let db = open(path, true)?.ok_or("办公室未就绪")?;
    let _guard = lock(path)?;
    let old_request: Option<String> = db
        .query_row(
            "SELECT request FROM office_history WHERE request_id=?",
            [&req],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if let Some(r) = old_request {
        if serde_json::from_str::<Value>(&r).map_err(|_| "控制记录损坏")? != *input {
            return Err("控制请求编号已使用".into());
        }
        return status(path);
    }
    let mut cfg = config(&db)?;
    if cfg["revision"] != input["expectedRevision"]
        || cfg["controlVersion"].as_i64().unwrap_or(0)
            != input["expectedControlVersion"]
                .as_i64()
                .ok_or("缺少控制版本")?
    {
        return Err("办公室状态已改变，请刷新后操作".into());
    }
    if running {
        let host = Host::new()?;
        let check = preflight_with_host(path, &host)?;
        if check["ready"] != true {
            return Err(format!("开工检查尚未通过：{}", check["checks"]));
        }
        schedule(&db, &host, path)?;
        cfg["completed"] = json!(true);
        cfg["step"] = json!("runtime");
    }
    let tx = db.unchecked_transaction().map_err(err)?;
    cfg["running"] = json!(running);
    cfg["controlVersion"] = json!(cfg["controlVersion"].as_i64().unwrap_or(0) + 1);
    put_config(&tx, &cfg)?;
    tx.execute("INSERT INTO office_history(request_id,request,value) VALUES(?,?,?)",params![req,input.to_string(),json!({"title":if running{"办公室已开始运行"}else{"办公室已暂停领取新工单"},"at":now(),"body":"已经在执行的员工可交回结果；暂停期间不继续创建下游工作。"}).to_string()]).map_err(err)?;
    tx.commit().map_err(err)?;
    status(path)
}
fn wake(db: &Connection, host: &Host) -> Result<()> {
    let pending:Option<String>=db.query_row("SELECT w.id FROM work_items w JOIN office_run_work r ON r.work_id=w.id WHERE w.state='pending' AND r.revision=? ORDER BY w.created,w.id LIMIT 1",[config(db)?["revision"].as_i64()],|r|r.get(0)).optional().map_err(err)?;
    let Some(id) = pending else {
        return Ok(());
    };
    let task = assigned_task(db, "dispatcher")?;
    let target = required(&task, "taskId")?;
    // 忙碌和排队时不重复唤醒；之后的时钟继续核对。
    let detail = host.request("GET", &format!("/api/air/tasks/{target}"), None)?;
    if detail["task"]["id"] != target
        || detail["readOnly"] == true
        || !detail["execution"]["queue"].is_object()
    {
        return Err("流转器任务不可运行".into());
    }
    if detail["execution"]["busy"] == true
        || detail["execution"]["pending"] == true
        || !detail["execution"]["queue"]["active"].is_null()
        || detail["execution"]["queue"]["queued"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
    {
        return Ok(());
    }
    let request_id = format!("{id}_office_wake");
    db.execute(
        "INSERT OR IGNORE INTO office_wakes(work_id,request_id) VALUES(?,?)",
        params![id, request_id],
    )
    .map_err(err)?;
    let receipt: Option<String> = db
        .query_row(
            "SELECT receipt FROM office_wakes WHERE work_id=?",
            [&id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if receipt.is_some() {
        return Ok(());
    }
    let sent=host.request("POST",&format!("/api/task-shell-tasks/{target}/messages"),Some(&json!({"clientMsgId":request_id,"intent":"work","text":"办公室有待处理工单。请重新读 team-onboarding-status，使用 work-next 按固定派发计划分配，work-dispatched 记回执。每轮最多五张。暂停就结束；只准备候选，不外发、不提交或合并代码。"})));
    match sent {
        Ok(r) => {
            if r["ok"] != true || r["taskId"] != target || !r["receiptId"].is_string() {
                return Err("唤醒回执不完整".into());
            }
            db.execute(
                "UPDATE office_wakes SET receipt=?,error=NULL WHERE work_id=?",
                params![r.to_string(), id],
            )
            .map_err(err)?;
        }
        Err(e) => {
            db.execute(
                "UPDATE office_wakes SET error=? WHERE work_id=?",
                params![e, id],
            )
            .map_err(err)?;
            return Err(e);
        }
    }
    Ok(())
}
fn tick(path: &Path) -> Result<Value> {
    let Some(mut db) = open(path, false)? else {
        return Ok(json!({"running":false,"message":"办公室尚未配置"}));
    };
    let cfg = config(&db)?;
    if cfg["running"] != true {
        return Ok(json!({"running":false,"message":"办公室已暂停，不派发新任务"}));
    }
    drop(db);
    db = open(path, true)?.ok_or("办公室未就绪")?;
    let _guard = lock(path)?;
    let cfg = config(&db)?;
    if cfg["running"] != true {
        return Ok(json!({"running":false}));
    }
    let host = Host::new()?;
    let result = (|| {
        host.directory(&db)?;
        {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(err)?;
            for id in cfg["values"]["creatorIds"]
                .as_array()
                .ok_or("本轮候选为空")?
            {
                create(
                    &tx,
                    &cfg,
                    id.as_str().ok_or("候选编号无效")?,
                    "selection",
                    None,
                    None,
                    "",
                )?;
            }
            tx.commit().map_err(err)?;
        }
        // 持续核对资料；已经准备的草稿遇到新来信后也不能继续显示为当前建议。
        {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(err)?;
            let mut statement = tx.prepare("SELECT w.id,w.creator,w.basis,w.state FROM work_items w JOIN office_run_work r ON r.work_id=w.id WHERE r.revision=? AND w.state NOT IN ('cancelled','stale') ORDER BY w.created DESC,w.id DESC").map_err(err)?;
            let rows = statement
                .query_map([cfg["revision"].as_i64()], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(err)?;
            drop(statement);
            let mut affected = std::collections::HashSet::new();
            for (id, creator, stored, state) in rows {
                if basis(&tx, &creator).is_ok_and(|b| b == stored) {
                    continue;
                }
                if state != "stale" {
                    tx.execute("UPDATE work_items SET state='stale',version=version+1,updated=? WHERE id=?", params![now(),id]).map_err(err)?;
                }
                if affected.insert(creator) {
                    data_changed(&tx, &id)?;
                }
            }
            tx.commit().map_err(err)?;
        }
        let mut st=db.prepare("SELECT w.id FROM work_items w JOIN office_run_work r ON r.work_id=w.id WHERE r.revision=? AND w.kind='selection' AND w.state='awaiting_review' ORDER BY w.created LIMIT 20").map_err(err)?;
        let ids = st
            .query_map([cfg["revision"].as_i64()], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        drop(st);
        if !ids.is_empty() {
            let task = assigned_task(&db, "sel")?;
            let cursor = runtime_value(&db, "deliveryScanBefore")?;
            let suffix = match cursor.as_str() {
                Some(value) => format!(
                    "&before={}",
                    identifier(&json!({"cursor":value}), "cursor")?
                ),
                None => String::new(),
            };
            let list = host.request(
                "GET",
                &format!(
                    "/api/task-shell-tasks/{}/deliveries?limit=100{suffix}",
                    required(&task, "taskId")?
                ),
                None,
            )?;
            if !list["items"].is_array() {
                return Err("宿主交付清单格式无法核对".into());
            }
            for id in ids {
                if let Some(d) = list["items"]
                    .as_array()
                    .and_then(|a| a.iter().find(|d| d["payload"]["sourceWorkId"] == id))
                {
                    if d["state"] == "accepted" {
                        if let Err(e) =
                            receive_checked(&mut db, &host, path, required(d, "id")?, None)
                        {
                            blocker(
                                &db,
                                &id,
                                &e,
                                json!(["当前版本交付核验失败"]),
                                "检查资料与工作约定后重新准备",
                            )?;
                        }
                    } else if d["state"] == "returned" {
                        blocker(
                            &db,
                            &id,
                            "接收员工退回了交付资料",
                            d["decision"]["issues"]
                                .as_array()
                                .filter(|a| !a.is_empty())
                                .map(|a| json!(a))
                                .unwrap_or_else(|| json!(["请在交付回执中查看接收员工列出的缺项"])),
                            d["decision"]["reason"]
                                .as_str()
                                .unwrap_or("补齐后重新准备这位候选，其他工作继续"),
                        )?;
                    }
                } else if let Err(e) = super::super::delivery::execute(
                    "delivery-prepare",
                    json!({"workId":id,"taskId":task["taskId"]}),
                    path,
                ) {
                    blocker(
                        &db,
                        &id,
                        &e,
                        json!(["选人资料未满足交付契约"]),
                        "补齐实际资料后重试，不自行补造事实",
                    )?;
                }
            }
            // 分页游标持久化，避免历史超过一页后永远读不到待接续的交付。
            put_runtime(&db, "deliveryScanBefore", &list["nextBefore"])?;
        }
        // 已交回的文案只是草稿候选；没有自动采用或外发。
        db.execute("UPDATE work_items SET state='draft_ready',updated=? WHERE state='awaiting_review' AND kind='copy' AND id IN(SELECT work_id FROM office_run_work WHERE revision=?)",params![now(),cfg["revision"].as_i64()]).map_err(err)?;
        // 超时仅提示核对，不改变工单状态，允许正常迟到的交回。
        db.execute("UPDATE office_blockers SET state='resolved',version=version+1,value=json_set(value,'$.state','resolved','$.version',version+1) WHERE state IN ('pending','waiting') AND json_extract(value,'$.reason')=? AND EXISTS(SELECT 1 FROM work_items w WHERE w.id=office_blockers.work_id AND (w.version != json_extract(value,'$.observedVersion') OR w.state != json_extract(value,'$.observedState')))", [STALLED]).map_err(err)?;
        let mut stalled = db.prepare("SELECT w.id FROM work_items w JOIN office_run_work r ON r.work_id=w.id WHERE r.revision=? AND w.state IN ('pending','claimed','dispatched','processing','awaiting_review') AND julianday(w.updated)<julianday('now','-15 minutes') AND NOT EXISTS(SELECT 1 FROM office_blockers b WHERE b.work_id=w.id AND b.state IN ('pending','waiting')) ORDER BY w.updated LIMIT 20").map_err(err)?;
        let stalled_ids = stalled
            .query_map([cfg["revision"].as_i64()], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        drop(stalled);
        for id in stalled_ids {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(err)?;
            blocker(
                &tx,
                &id,
                STALLED,
                json!(["需要核对原任务是否仍在执行、排队或等待资料"]),
                "先打开原角色任务核对，再决定等待或重新准备；不能把未收到回执当作已完成",
            )?;
            tx.commit().map_err(err)?;
        }
        wake(&db, &host)?;
        Ok::<_, String>(())
    })();
    let note = json!({"at":now(),"ok":result.is_ok(),"message":result.err().unwrap_or_else(||"已核对真实队列、交付与唤醒回执".into())});
    put_runtime(&db, "lastTick", &note)?;
    Ok(json!({"running":true,"tick":note}))
}
fn decide(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &["requestId", "workId", "expectedVersion", "action", "note"],
        "处理卡点",
    )?;
    let request = identifier(input, "requestId")?;
    let id = identifier(input, "workId")?;
    let action = required(input, "action")?;
    if !["hold", "exclude", "retry"].contains(&action) {
        return Err("卡点处理动作无效".into());
    }
    let note = input["note"].as_str().unwrap_or("").trim();
    if note.chars().count() > 2000 {
        return Err("补充说明过长".into());
    }
    let mut db = open(path, true)?.ok_or("办公室未就绪")?;
    let _guard = lock(path)?;
    if action == "retry" {
        // 原任务还在执行时不另起一轮；读取宿主不占业务库写锁。
        let w = work(&db, &id)?;
        let task = assigned_task(&db, required(&w, "staffKey")?)?;
        Host::new()?.role(required(&task, "taskId")?, true)?;
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let prior: Option<String> = tx
        .query_row(
            "SELECT request FROM office_history WHERE request_id=?",
            [&request],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if let Some(prior) = prior {
        if serde_json::from_str::<Value>(&prior).map_err(|_| "决定记录损坏")? != *input {
            return Err("决定编号已使用，不能更改内容".into());
        }
        drop(tx);
        return status(path);
    }
    if !current_work(&tx, &id)? {
        return Err("该卡点对应旧工作约定，请刷新".into());
    }
    let mut b = read_json(
        &tx,
        "SELECT value FROM office_blockers WHERE work_id=?",
        [&id],
    )?
    .into_iter()
    .next()
    .ok_or("卡点不存在")?;
    if b["version"] != input["expectedVersion"]
        || !["pending", "waiting"].contains(&b["state"].as_str().unwrap_or(""))
    {
        return Err("卡点已变化，请刷新".into());
    }
    b["state"] = json!(if action == "hold" {
        "waiting"
    } else {
        "resolved"
    });
    b["version"] = json!(b["version"].as_i64().unwrap() + 1);
    b["note"] = json!(note);
    b["action"] = json!(action);
    let w = work(&tx, &id)?;
    if b["reason"] == STALLED
        && (b["observedVersion"] != w["version"] || b["observedState"] != w["state"])
    {
        return Err("原工单已有新的进展，请刷新后核对".into());
    }
    if !(action == "hold" && b["reason"] == STALLED) {
        tx.execute(
            "UPDATE work_items SET state=?,version=version+1,updated=? WHERE id=?",
            params![
                if action == "hold" {
                    "blocked"
                } else {
                    "cancelled"
                },
                now(),
                id
            ],
        )
        .map_err(err)?;
    }
    if action == "retry" {
        let cfg = config(&tx)?;
        create(
            &tx,
            &cfg,
            required(&w, "creatorId")?,
            "selection",
            None,
            None,
            &format!(
                "老板要求重新核验。原卡点：{}。老板补充：{}。重试编号：{}",
                b["reason"], note, request
            ),
        )?;
    }
    tx.execute(
        "UPDATE office_blockers SET state=?,version=?,value=? WHERE work_id=?",
        params![
            b["state"].as_str(),
            b["version"].as_i64(),
            b.to_string(),
            id
        ],
    )
    .map_err(err)?;
    tx.execute(
        "INSERT INTO office_history(request_id,request,value) VALUES(?,?,?)",
        params![
            request,
            input.to_string(),
            json!({"title":"老板处理卡点","at":now(),"body":b}).to_string()
        ],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    status(path)
}
pub(super) fn execute(command: &str, input: &Value, path: &Path) -> Result<Value> {
    match command {
        "team-onboarding-control" => control(input, path),
        "team-onboarding-tick" => {
            only_keys(input, &[], command)?;
            tick(path)
        }
        "work-report-blocker" => report(input, path),
        "team-onboarding-decide" => decide(input, path),
        "team-onboarding-receive" => {
            only_keys(input, &["taskId", "deliveryId", "expectedVersion"], command)?;
            let id = identifier(input, "deliveryId")?;
            let version = input["expectedVersion"]
                .as_i64()
                .filter(|v| *v > 0)
                .ok_or("交付版本无效")?;
            let mut db = open(path, true)?.ok_or("办公室未就绪")?;
            let _guard = lock(path)?;
            check_task(&db, "copy", input)?;
            receive_checked(&mut db, &Host::new()?, path, &id, Some(version))
        }
        _ => Err("未知开工引导命令".into()),
    }
}
