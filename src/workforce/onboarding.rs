//! 开工引导、版本化工作约定与真实工单运行。只新增办公室表，不修改旧业务事实。
use super::*;
use std::{fs::OpenOptions, io::Read, os::fd::AsRawFd, time::Instant};

mod runtime;
const MARKER: &str = "\n\n【办公室开工协议 v1】\n";
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS office_onboarding(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT UNIQUE,request TEXT,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_run_work(work_id TEXT PRIMARY KEY REFERENCES work_items(id),revision INTEGER NOT NULL,parent TEXT,delivery_id TEXT,delivery_version INTEGER);
CREATE TABLE IF NOT EXISTS office_blockers(work_id TEXT PRIMARY KEY REFERENCES work_items(id),state TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_wakes(work_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,receipt TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS office_runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS office_run_revision ON office_run_work(revision,work_id);";

pub(super) fn init(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(err)
}
fn exists(db: &Connection) -> bool {
    db.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name='office_onboarding'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .is_ok_and(|n| n == 1)
}
fn defaults() -> Value {
    json!({"revision":0,"step":"mission","completed":false,"running":false,"values":{"product":"","market":"","criteria":"","strategy":"内容适配优先","tone":"亲切自然","creatorIds":[]},"reviewedRoles":[]})
}
fn config(db: &Connection) -> Result<Value> {
    if !exists(db) {
        return Ok(defaults());
    }
    Ok(
        read_json(db, "SELECT value FROM office_onboarding WHERE id=1", [])?
            .into_iter()
            .next()
            .unwrap_or_else(defaults),
    )
}
fn put_config(db: &Connection, v: &Value) -> Result<()> {
    db.execute("INSERT INTO office_onboarding VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",[v.to_string()]).map_err(err)?;
    Ok(())
}
fn event(db: &Connection, title: &str, body: Value) -> Result<()> {
    db.execute(
        "INSERT INTO office_history(value) VALUES(?)",
        [json!({"title":title,"body":body,"at":now()}).to_string()],
    )
    .map_err(err)?;
    Ok(())
}
fn runtime_value(db: &Connection, key: &str) -> Result<Value> {
    Ok(
        read_json(db, "SELECT value FROM office_runtime WHERE key=?", [key])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null),
    )
}
fn put_runtime(db: &Connection, key: &str, v: &Value) -> Result<()> {
    db.execute("INSERT INTO office_runtime VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,v.to_string()]).map_err(err)?;
    Ok(())
}
fn bounded(v: &Value, k: &str, max: usize) -> Result<String> {
    let label = match k {
        "product" => "本轮产品与目标",
        "market" => "市场与内容语言",
        "criteria" => "筛选条件",
        "strategy" => "选人顺序与偏好",
        "tone" => "文案语气",
        "prompt" => "角色提示词",
        "reason" => "卡点说明",
        "suggestion" => "处理建议",
        _ => "内容",
    };
    let s = v[k]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("请填写{label}"))?;
    if s.chars().count() > max {
        return Err(format!("{label}内容过长"));
    }
    Ok(s.into())
}
fn validate(values: &Value) -> Result<()> {
    only_keys(
        values,
        &[
            "product",
            "market",
            "criteria",
            "strategy",
            "tone",
            "creatorIds",
        ],
        "工作约定",
    )?;
    for (k, max) in [
        ("product", 300),
        ("market", 300),
        ("criteria", 2000),
        ("strategy", 1500),
        ("tone", 300),
    ] {
        bounded(values, k, max)?;
    }
    let ids = values["creatorIds"]
        .as_array()
        .ok_or("请选择本轮处理的已有候选")?;
    if ids.is_empty() || ids.len() > 20 {
        return Err("每轮请选择 1–20 位已有候选；当前开工范围不包含新来源发现".into());
    }
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let id = identifier(&json!({"id":id}), "id")?;
        if !seen.insert(id) {
            return Err("候选编号重复".into());
        }
    }
    Ok(())
}
struct Guard(std::fs::File);
impl Drop for Guard {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn lock(path: &Path) -> Result<Guard> {
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("office.lock"))
        .map_err(|_| "无法取得办公室操作锁")?;
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("办公室正在处理另一个操作，请稍后重试".into());
    }
    Ok(Guard(f))
}
struct Host {
    base: String,
    agent: ureq::Agent,
    until: Instant,
}
impl Host {
    fn new() -> Result<Self> {
        let base = std::env::var("GAPAW_OFFICE_HOST_URL")
            .or_else(|_| std::env::var("MULTICC_BASE_URL"))
            .unwrap_or_else(|_| "http://127.0.0.1:3000".into());
        let u = url::Url::parse(&base).map_err(|_| "宿主地址无效")?;
        if u.scheme() != "http"
            || !matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            || u.path() != "/"
            || !u.username().is_empty()
            || u.password().is_some()
            || u.query().is_some()
            || u.fragment().is_some()
        {
            return Err("办公室只连接本机 MultiCC HTTP 地址".into());
        }
        Ok(Self {
            base: base.trim_end_matches('/').into(),
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .build(),
            until: Instant::now() + Duration::from_secs(16),
        })
    }
    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let remaining = self
            .until
            .checked_duration_since(Instant::now())
            .ok_or("本轮核对时间已用尽，请重试恢复")?;
        let request = self
            .agent
            .request(method, &format!("{}{path}", self.base))
            .timeout(remaining.min(Duration::from_secs(4)))
            .set("Content-Type", "application/json");
        let response = match body {
            Some(v) => request.send_string(&v.to_string()),
            None => request.call(),
        }
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("宿主接口暂不可用（{code}）：{path}"),
            _ => "宿主响应未确认，请重试核对原操作，不能视为成功".into(),
        })?;
        let mut text = String::new();
        response
            .into_reader()
            .take(2 * 1024 * 1024 + 1)
            .read_to_string(&mut text)
            .map_err(|_| "无法读取宿主响应")?;
        if text.len() > 2 * 1024 * 1024 {
            return Err("宿主响应过大".into());
        }
        let v: Value = serde_json::from_str(&text).map_err(|_| "宿主返回内容无法读取")?;
        if v["ok"] == false {
            return Err("宿主尚未确认操作成功，请回读原记录".into());
        }
        Ok(v)
    }
    fn role(&self, task: &str, idle: bool) -> Result<Value> {
        let v = self.request("GET", &format!("/api/air/tasks/{task}"), None)?;
        if v["task"]["id"] != task || v["roleBindings"]["taskId"] != task || v["readOnly"] == true {
            return Err("角色任务身份不一致或已只读".into());
        }
        if !v["execution"]["queue"].is_object() {
            return Err("无法核对角色任务运行状态".into());
        }
        if idle
            && (v["execution"]["busy"] == true
                || v["execution"]["pending"] == true
                || !v["execution"]["queue"]["active"].is_null()
                || v["execution"]["queue"]["queued"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty()))
        {
            return Err("角色仍在执行或排队，请等本轮结束后修改提示词".into());
        }
        Ok(v["roleBindings"].clone())
    }
    fn directory(&self, db: &Connection) -> Result<()> {
        let c = read_config(db)?;
        let dirs = self.request("GET", "/api/directories", None)?;
        if !dirs.as_array().is_some_and(|a| {
            a.iter()
                .any(|d| d["id"] == c["workspace"]["dirId"] && d["path"] == c["workspace"]["path"])
        }) {
            return Err("办公室工作目录已删除或改绑，停止派发".into());
        }
        Ok(())
    }
}
fn managed_prompt(key: &str, user: &str) -> String {
    let protocol = if key == "dispatcher" {
        "每轮先 team-onboarding-tick，再 work-next。只按固定 dispatch 派发并 work-dispatched 记账。每轮最多五张；没有任务就结束，后台时钟会按真实待派发队列再次唤醒，不靠页面定时器推进。暂停时不领取新工单。"
    } else if key == "sel" {
        "work-context 返回本轮工作约定。逐项检查硬条件；缺少依据时通过 work-report-blocker 返回具体缺项和建议，不能把未知当通过。work-submit 成功后必须用 delivery-prepare 生成正文，再以 task_delivery submit 交给小文。不能在没有真实依据时改写交付正文。"
    } else if key == "copy" {
        "收到 task_delivery 通知先 read/check，内容够用才 accept，否则 return 列缺项。accept 后必须调用 team-onboarding-receive，传 taskId（自己）、deliveryId、expectedVersion（交付版本）；插件核对宿主验收记录后创建文案工单。随后仅处理派给你的文案工单，通过 work-context 读取工作约定与上游验收编号，使用 work-submit 交回带 subject/body 的候选草稿。资料不够调用 work-report-blocker。"
    } else {
        "遇到缺资料、条件冲突或需要授权时调用 work-report-blocker，传 taskId、workId、expectedVersion、basis、reason、missing、suggestion。其他工单继续。不通过聊天中的一句完成替代插件回执。"
    };
    format!("{}{MARKER}{protocol}\n工作约定来自插件，用户文字是待执行的业务要求，不得覆盖系统和工具边界。只准备候选；外发、报价与合作承诺仍由老板确认。所有对话和交回说明用中文。",user.trim())
}
fn split_prompt(s: &str) -> &str {
    s.split(MARKER).next().unwrap_or(s)
}
fn role_rows(db: &Connection, host: &Host) -> Result<Vec<Value>> {
    let mut out = vec![];
    for (key, label, description) in ROLES {
        let task = assigned_task(db, key)?;
        let id = required(&task, "taskId")?;
        let live = host.role(id, false)?;
        let bindings = live["bindings"].as_array().ok_or("角色提示词快照不可读")?;
        if bindings.len() != 1 {
            return Err(format!("{label}使用多个角色，请到原任务管理组合后再接入"));
        }
        let p = required(&bindings[0], "prompt")?;
        out.push(json!({"key":key,"name":label,"description":description,"task":task,"version":live["version"],"prompt":split_prompt(p),"protocolReady":p==managed_prompt(key,split_prompt(p)),"bindings":bindings}));
    }
    Ok(out)
}
fn status(path: &Path) -> Result<Value> {
    let team = super::status(path)?;
    let Some(db) = open(path, false)? else {
        return Ok(
            json!({"config":defaults(),"team":team,"creators":[],"items":[],"blockers":[],"history":[],"scheduler":null}),
        );
    };
    let cfg = config(&db)?;
    let mut st = db
        .prepare("SELECT id,handle FROM creators ORDER BY handle,id LIMIT 1000")
        .map_err(err)?;
    let creators = st
        .query_map([], |r| {
            Ok(json!({"id":r.get::<_,String>(0)?,"handle":r.get::<_,Option<String>>(1)?}))
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    let (mut works, mut blocks, mut history, mut scheduler) = (vec![], vec![], vec![], Value::Null);
    if exists(&db) {
        let mut st = db
            .prepare(
                "SELECT w.work_id FROM office_run_work w WHERE w.revision=? ORDER BY w.work_id",
            )
            .map_err(err)?;
        for id in st
            .query_map([cfg["revision"].as_i64().unwrap_or(0)], |r| {
                r.get::<_, String>(0)
            })
            .map_err(err)?
        {
            let mut w = work(&db, &id.map_err(err)?)?;
            w["submissions"] = json!(read_json(
                &db,
                "SELECT value FROM submissions WHERE work_id=?",
                [required(&w, "id")?]
            )?);
            works.push(w);
        }
        blocks=read_json(&db,"SELECT b.value FROM office_blockers b JOIN office_run_work w ON w.work_id=b.work_id WHERE w.revision=? AND b.state IN ('pending','waiting')",[cfg["revision"].as_i64().unwrap_or(0)])?;
        history = read_json(
            &db,
            "SELECT value FROM office_history ORDER BY seq DESC LIMIT 100",
            [],
        )?;
        scheduler = runtime_value(&db, "scheduler")?;
    }
    Ok(
        json!({"config":cfg,"team":team,"creators":creators,"items":works,"blockers":blocks,"history":history,"scheduler":scheduler,"lastTick":if exists(&db){runtime_value(&db,"lastTick")?}else{Value::Null}}),
    )
}
fn save(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &[
            "requestId",
            "expectedRevision",
            "step",
            "values",
            "reviewedRoles",
        ],
        "开工设置",
    )?;
    let _guard = lock(path)?;
    let req = identifier(input, "requestId")?;
    validate(&input["values"])?;
    let step = required(input, "step")?;
    if !["mission", "roles", "rules", "preflight"].contains(&step) {
        return Err("引导步骤无效".into());
    }
    let reviewed = input["reviewedRoles"]
        .as_array()
        .ok_or("缺少角色审阅状态")?;
    let mut seen = std::collections::HashSet::new();
    for key in reviewed {
        if !ROLES.iter().any(|r| key == r.0) || !seen.insert(key.to_string()) {
            return Err("角色审阅状态无效".into());
        }
    }
    let mut db = open(path, true)?.ok_or("业务库未就绪")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let prior: Option<String> = tx
        .query_row(
            "SELECT request FROM office_history WHERE request_id=?",
            [&req],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if let Some(p) = prior {
        if serde_json::from_str::<Value>(&p).map_err(|_| "保存记录损坏")? != *input {
            return Err("请求编号已使用，内容不能改变".into());
        }
        drop(tx);
        return status(path);
    }
    let mut cfg = config(&tx)?;
    if cfg["revision"] != input["expectedRevision"] {
        return Err("工作约定已被其他页面修改，请刷新后重新编辑".into());
    }
    for id in input["values"]["creatorIds"].as_array().unwrap() {
        basis(&tx, id.as_str().unwrap())?;
    }
    let changed = cfg["values"] != input["values"];
    cfg["revision"] = json!(cfg["revision"].as_i64().unwrap_or(0) + 1);
    cfg["values"] = input["values"].clone();
    cfg["reviewedRoles"] = input["reviewedRoles"].clone();
    cfg["step"] = json!(step);
    cfg["updatedAt"] = json!(now());
    // 引导阶段版本也递增；运行中只有业务约定变化才使旧结果作废。
    if cfg["completed"] == true && changed {
        invalidate(&tx)?;
    } else {
        tx.execute(
            "UPDATE office_run_work SET revision=? WHERE revision=?",
            params![cfg["revision"].as_i64(), input["expectedRevision"].as_i64()],
        )
        .map_err(err)?;
    }
    put_config(&tx, &cfg)?;
    tx.execute("INSERT INTO office_history(request_id,request,value) VALUES(?,?,?)",params![req,input.to_string(),json!({"title":if changed{"工作约定已保存"}else{"引导进度已保存"},"at":now(),"revision":cfg["revision"],"body":cfg["values"]}).to_string()]).map_err(err)?;
    tx.commit().map_err(err)?;
    status(path)
}
fn invalidate(db: &Connection) -> Result<()> {
    db.execute("UPDATE work_items SET state='stale',version=version+1,updated=? WHERE id IN(SELECT work_id FROM office_run_work) AND state NOT IN ('cancelled','stale')",[now()]).map_err(err)?;
    db.execute(
        "UPDATE office_blockers SET state='superseded' WHERE state IN ('pending','waiting')",
        [],
    )
    .map_err(err)?;
    Ok(())
}
fn save_role(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &["staffKey", "expectedVersion", "prompt"],
        "保存角色",
    )?;
    let key = identifier(input, "staffKey")?;
    if !ROLES.iter().any(|r| r.0 == key) {
        return Err("角色不存在".into());
    }
    let user = bounded(input, "prompt", 18000)?;
    if user.contains(MARKER) {
        return Err("提示词中不能包含受管理协议标记".into());
    }
    let db = open(path, true)?.ok_or("办公室未就绪")?;
    let _guard = lock(path)?;
    let host = Host::new()?;
    host.directory(&db)?;
    let task = assigned_task(&db, &key)?;
    let id = required(&task, "taskId")?;
    let before = host.role(id, true)?;
    let bindings = before["bindings"]
        .as_array()
        .filter(|a| a.len() == 1)
        .ok_or("请先在原任务整理角色组合")?;
    let desired = managed_prompt(&key, &user);
    let old = required(&bindings[0], "prompt")?;
    if old != desired {
        if before["version"] != input["expectedVersion"] {
            return Err("角色提示词已变化，请刷新后再编辑".into());
        }
        let request = json!({"expectedVersion":before["version"],"clientMsgId":format!("gapaw_role_{}_{}_{}",key,before["version"],format!("{:x}",Sha256::digest(desired.as_bytes()))),"bindings":[{"name":bindings[0]["name"],"prompt":desired}]});
        host.request(
            "POST",
            &format!("/api/air/tasks/{id}/roles"),
            Some(&request),
        )?;
    }
    let after = host.role(id, false)?;
    if after["bindings"][0]["prompt"] != desired {
        return Err("角色写入尚未核对成功，请重试读取".into());
    }
    // 宿主响应丢失后，重试通过读回相同提示词完成记账，不重复改宿主版本。
    let sync_key = format!("role_{key}");
    let previous = runtime_value(&db, &sync_key)?;
    if previous["version"] != after["version"] {
        let tx = db.unchecked_transaction().map_err(err)?;
        let mut cfg = config(&tx)?;
        if cfg["completed"] == true {
            invalidate(&tx)?;
            cfg["revision"] = json!(cfg["revision"].as_i64().unwrap_or(0) + 1);
            put_config(&tx, &cfg)?;
        }
        put_runtime(&tx, &sync_key, &after)?;
        event(
            &tx,
            "角色提示词已同步",
            json!({"staffKey":key,"version":after["version"]}),
        )?;
        tx.commit().map_err(err)?;
    }
    Ok(json!({"staffKey":key,"version":after["version"],"prompt":user,"protocolReady":true}))
}
fn preflight_with_host(path: &Path, host: &Host) -> Result<Value> {
    let mut checks = vec![];
    let team = super::status(path)?;
    checks.push(json!({"key":"team","label":"流转器与七位员工","ready":team["initialized"]==true,"message":if team["initialized"]==true{"八个任务已绑定"}else{"请先在连接与设置中初始化办公室"}}));
    let mut roles = vec![];
    if team["initialized"] == true {
        let db = open(path, false)?.ok_or("办公室未就绪")?;
        let read = (|| {
            host.directory(&db)?;
            let rows = role_rows(&db, host)?;
            Ok::<_, String>(rows)
        })();
        match read {
            Ok(rows) => {
                let ready = rows.iter().all(|r| r["protocolReady"] == true);
                roles = rows;
                checks.push(json!({"key":"roles","label":"真实角色与开工协议","ready":ready,"message":if ready{"提示词已读回，协议已同步"}else{"请逐位确认或一键同步当前提示词与开工协议"}}));
            }
            Err(e) => checks.push(
                json!({"key":"roles","label":"真实角色与开工协议","ready":false,"message":e}),
            ),
        }
        let task = assigned_task(&db, "sel")?;
        let deliveries = host.request(
            "GET",
            &format!(
                "/api/task-shell-tasks/{}/deliveries?limit=1",
                required(&task, "taskId")?
            ),
            None,
        );
        checks.push(json!({"key":"delivery","label":"宿主交付与验收","ready":deliveries.as_ref().is_ok_and(|v|v["items"].is_array()),"message":if deliveries.is_ok(){"已读取宿主交付入口"}else{"宿主交付验收接口尚未就绪，需要完成 MultiCC 配套更新"}}));
        let cfg = config(&db)?;
        let valid = validate(&cfg["values"]).and_then(|_| {
            for id in cfg["values"]["creatorIds"].as_array().unwrap() {
                basis(&db, id.as_str().unwrap())
                    .map_err(|_| "候选档案无法读取，请调整本轮名单".to_string())?;
            }
            Ok(())
        });
        checks.push(json!({"key":"mission","label":"目标与本轮候选","ready":valid.is_ok(),"message":valid.err().unwrap_or_else(||"已有档案可读取；筛选硬条件仍由员工逐位核验，缺项将成为卡点".into())}));
        let cron = host.request("GET", "/api/cron", None);
        checks.push(json!({"key":"scheduler","label":"离开页面后继续运行","ready":cron.as_ref().is_ok_and(Value::is_array),"message":if cron.is_ok(){"后台调度接口可用；点击开工后登记本办公室专属时钟"}else{"后台调度接口不可用"}}));
    }
    Ok(
        json!({"ready":checks.len()==5&&checks.iter().all(|c|c["ready"]==true),"checks":checks,"roles":roles,"scope":"复核本轮选定的已有候选，再交接准备文案；不自动外发。邮箱测试和新平台采集不作为本轮已通过项目。"}),
    )
}
pub(super) fn current_work(db: &Connection, id: &str) -> Result<bool> {
    if !exists(db) {
        return Ok(true);
    }
    let rev: Option<i64> = db
        .query_row(
            "SELECT revision FROM office_run_work WHERE work_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    Ok(rev.is_none_or(|r| config(db).is_ok_and(|c| c["revision"] == r)))
}
pub(super) fn can_claim(db: &Connection, id: &str) -> Result<bool> {
    if !exists(db) {
        return Ok(true);
    }
    let mapped: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM office_run_work WHERE work_id=?)",
            [id],
            |r| r.get(0),
        )
        .map_err(err)?;
    Ok(!mapped || (config(db)?["running"] == true && current_work(db, id)?))
}
pub(super) fn data_changed(db: &Connection, id: &str) -> Result<()> {
    if !context_values(db, id)?.is_null() && current_work(db, id)? {
        runtime::data_changed(db, id)?;
    }
    Ok(())
}
pub(super) fn context_values(db: &Connection, id: &str) -> Result<Value> {
    if !exists(db) {
        return Ok(Value::Null);
    }
    let mapped: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM office_run_work WHERE work_id=?)",
            [id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if !mapped {
        return Ok(Value::Null);
    }
    let c = config(db)?;
    let upstream: Option<Value> = db.query_row("SELECT delivery_id,delivery_version,parent FROM office_run_work WHERE work_id=? AND delivery_id IS NOT NULL", [id], |r|Ok(json!({"id":r.get::<_,String>(0)?,"version":r.get::<_,i64>(1)?,"sourceWorkId":r.get::<_,String>(2)?}))).optional().map_err(err)?;
    Ok(
        json!({"revision":c["revision"],"values":c["values"],"running":c["running"],"upstreamDelivery":upstream}),
    )
}
pub(super) fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    match command {
        "team-onboarding-status" => {
            only_keys(&input, &[], command)?;
            status(path)
        }
        "team-onboarding-save" => save(&input, path),
        "team-onboarding-roles" => {
            only_keys(&input, &[], command)?;
            let db = open(path, false)?.ok_or("请先初始化办公室")?;
            let h = Host::new()?;
            h.directory(&db)?;
            Ok(json!({"roles":role_rows(&db,&h)?}))
        }
        "team-onboarding-role-save" => save_role(&input, path),
        "team-onboarding-preflight" => {
            only_keys(&input, &[], command)?;
            preflight_with_host(path, &Host::new()?)
        }
        _ => runtime::execute(command, &input, path),
    }
}

pub(super) fn upstream_current(path: &Path, id: &str) -> Result<()> {
    let Some(db) = open(path, false)? else {
        return Ok(());
    };
    if exists(&db) {
        runtime::check_upstream(&db, &Host::new()?, path, id)?;
    }
    Ok(())
}
