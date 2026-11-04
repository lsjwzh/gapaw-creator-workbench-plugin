//! 影子演练：用历史记录提炼的问题和真实来信案例做一次模拟，记住你的倾向与输入。
//! 只读业务库，不发送任何消息，不修改达人档案。演练包导入后不可修改；回答只追加，以最新一次为准。
use crate::{drafts::only_keys, identifier, now, open_db, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

const SCHEMA: &str = "gapaw-rehearsal-pack-v1";
const ACTIVE_KEY: &str = "rehearsal_active";
const MAX_PACK: u64 = 1024 * 1024;
const QUESTION_DECISIONS: [&str; 4] = ["accept", "edit", "reject", "unsure"];
const CASE_DECISIONS: [&str; 4] = ["agree", "history", "custom", "skip"];
const ACTIONS: [&str; 10] = [
    "选人",
    "来信分类",
    "拒绝或退信后停止跟进",
    "自动回复处理",
    "更新谈判摘要",
    "发送跟进邮件",
    "发送首封邀约",
    "回复（不涉及条件变化）",
    "回复（涉及报价或条件变化）",
    "确认合作",
];

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS rehearsal_packs(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,imported_at TEXT NOT NULL,value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS rehearsal_answers(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,pack TEXT NOT NULL,item TEXT NOT NULL,decision TEXT NOT NULL,value TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS rehearsal_answers_item ON rehearsal_answers(pack,item,seq);",
    )
    .map_err(|e| e.to_string())
}

fn text<'a>(v: &'a Value, key: &str, max: usize, what: &str) -> Result<&'a str> {
    let s = v
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{what}缺少 {key}"))?;
    if s.chars().count() > max {
        return Err(format!("{what}的 {key} 超过 {max} 字"));
    }
    Ok(s)
}
fn opt_text(v: &Value, key: &str, max: usize, what: &str) -> Result<()> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(s)) if s.chars().count() <= max => Ok(()),
        _ => Err(format!("{what}的 {key} 必须是不超过 {max} 字的文字")),
    }
}
fn id_of(v: &Value, what: &str) -> Result<String> {
    identifier(v, "id").map_err(|e| format!("{what}：{e}"))
}

/// 校验演练包结构；只接受已知字段类型，引用必须闭合。
fn validate(pack: &Value) -> Result<()> {
    if pack["schema"] != SCHEMA {
        return Err(format!("演练包格式必须是 {SCHEMA}"));
    }
    id_of(pack, "演练包")?;
    text(pack, "title", 200, "演练包")?;
    text(pack, "generatedAt", 40, "演练包")?;
    text(pack, "generatedBy", 300, "演练包")?;
    let mut sources = HashSet::new();
    for s in pack["sources"].as_array().ok_or("演练包缺少 sources")? {
        let id = id_of(s, "来源")?;
        text(s, "label", 200, "来源")?;
        opt_text(s, "ref", 300, "来源")?;
        if !sources.insert(id.clone()) {
            return Err(format!("来源编号重复：{id}"));
        }
    }
    let mut steps = HashSet::new();
    let step_list = pack["steps"].as_array().ok_or("演练包缺少 steps")?;
    if step_list.is_empty() || step_list.len() > 20 {
        return Err("steps 数量必须在 1–20 之间".into());
    }
    for s in step_list {
        let id = id_of(s, "环节")?;
        text(s, "title", 40, "环节")?;
        if !steps.insert(id.clone()) {
            return Err(format!("环节编号重复：{id}"));
        }
    }
    let mut ids = HashSet::new();
    let mut question_ids = HashSet::new();
    let questions = pack["questions"].as_array().ok_or("演练包缺少 questions")?;
    let cases = pack["cases"].as_array().ok_or("演练包缺少 cases")?;
    if questions.len() + cases.len() > 300 {
        return Err("问题与案例合计不能超过 300 项".into());
    }
    for q in questions {
        let id = id_of(q, "问题")?;
        let what = format!("问题 {id} ");
        if !steps.contains(q["step"].as_str().unwrap_or("")) {
            return Err(format!("{what}引用了不存在的环节"));
        }
        if !["hard", "preference"].contains(&q["kind"].as_str().unwrap_or("")) {
            return Err(format!("{what}的 kind 只能是 hard 或 preference"));
        }
        text(q, "question", 200, &what)?;
        text(q, "why", 400, &what)?;
        opt_text(q, "conflict", 400, &what)?;
        for f in q["feeds"].as_array().ok_or(format!("{what}缺少 feeds"))? {
            if !ACTIONS.contains(&f.as_str().unwrap_or("")) {
                return Err(format!("{what}引用了未知动作：{f}"));
            }
        }
        let answer = &q["answer"];
        let kind = answer["type"].as_str().unwrap_or("");
        match kind {
            "choice" => {
                let opts = answer["options"]
                    .as_array()
                    .filter(|a| (2..=8).contains(&a.len()))
                    .ok_or(format!("{what}的选项必须有 2–8 个"))?;
                if opts.iter().any(|o| {
                    o.as_str()
                        .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 80)
                }) {
                    return Err(format!("{what}的选项必须是不超过 80 字的文字"));
                }
            }
            "number" | "money" | "text" => {}
            _ => return Err(format!("{what}的答案类型不支持")),
        }
        let prefill = &q["prefill"];
        text(prefill, "text", 400, &format!("{what}预填"))?;
        if !["high", "medium", "low"].contains(&prefill["confidence"].as_str().unwrap_or("")) {
            return Err(format!("{what}预填的 confidence 只能是 high、medium、low"));
        }
        check_value(q, &prefill["value"]).map_err(|e| format!("{what}预填值无效：{e}"))?;
        let evidence = q["evidence"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 10)
            .ok_or(format!("{what}必须附 1–10 条依据"))?;
        for e in evidence {
            if !sources.contains(e["source"].as_str().unwrap_or("")) {
                return Err(format!("{what}的依据引用了不存在的来源"));
            }
            text(e, "text", 300, &format!("{what}依据"))?;
        }
        if !ids.insert(id.clone()) {
            return Err(format!("编号重复：{id}"));
        }
        question_ids.insert(id);
    }
    for c in cases {
        let id = id_of(c, "案例")?;
        let what = format!("案例 {id} ");
        if !steps.contains(c["step"].as_str().unwrap_or("")) {
            return Err(format!("{what}引用了不存在的环节"));
        }
        identifier(c, "messageId").map_err(|e| format!("{what}{e}"))?;
        text(c, "title", 120, &what)?;
        let s = &c["suggestion"];
        text(s, "classification", 60, &what)?;
        if !ACTIONS.contains(&s["action"].as_str().unwrap_or("")) {
            return Err(format!("{what}的建议动作未知"));
        }
        if !s["conditionChange"].is_boolean() {
            return Err(format!("{what}缺少 conditionChange"));
        }
        let points = s["points"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 8)
            .ok_or(format!("{what}建议要点必须有 1–8 条"))?;
        if points.iter().any(|p| {
            p.as_str()
                .is_none_or(|t| t.trim().is_empty() || t.chars().count() > 200)
        }) {
            return Err(format!("{what}建议要点必须是不超过 200 字的文字"));
        }
        for r in c["rules"].as_array().ok_or(format!("{what}缺少 rules"))? {
            if !question_ids.contains(r.as_str().unwrap_or("")) {
                return Err(format!("{what}引用了不存在的问题：{r}"));
            }
        }
        if !ids.insert(id.clone()) {
            return Err(format!("编号重复：{id}"));
        }
    }
    Ok(())
}

/// 按问题的答案类型校验一个值。
fn check_value(q: &Value, v: &Value) -> Result<()> {
    let a = &q["answer"];
    match a["type"].as_str().unwrap_or("") {
        "choice" => {
            let s = v.as_str().ok_or("必须选择一个选项")?;
            if a["options"]
                .as_array()
                .is_some_and(|o| o.iter().any(|x| x == s))
            {
                Ok(())
            } else {
                Err("不在选项中".into())
            }
        }
        "number" | "money" => {
            let n = v.as_f64().filter(|n| n.is_finite()).ok_or("必须是数字")?;
            let lo = a["min"].as_f64().unwrap_or(0.0);
            let hi = a["max"].as_f64().unwrap_or(100000.0);
            if n < lo || n > hi {
                return Err(format!("必须在 {lo}–{hi} 之间"));
            }
            Ok(())
        }
        "text" => {
            let s = v
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("不能为空")?;
            if s.chars().count() > 500 {
                return Err("不能超过 500 字".into());
            }
            Ok(())
        }
        _ => Err("答案类型不支持".into()),
    }
}

fn active(db: &Connection) -> Result<Option<Value>> {
    let id: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key=?",
            [ACTIVE_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(id) = id else { return Ok(None) };
    let raw: Option<String> = db
        .query_row("SELECT value FROM rehearsal_packs WHERE id=?", [&id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| "演练包已损坏".to_string()))
        .transpose()
}
fn tables_ready(db: &Connection) -> bool {
    db.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='rehearsal_answers'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .is_ok_and(|n| n == 1)
}
fn revision(db: &Connection, pack: &str) -> Result<i64> {
    db.query_row(
        "SELECT coalesce(max(seq),0) FROM rehearsal_answers WHERE pack=?",
        [pack],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn answer_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let value: String = r.get(4)?;
    Ok(
        json!({"seq":r.get::<_,i64>(0)?,"item":r.get::<_,String>(1)?,"requestId":r.get::<_,String>(2)?,"decision":r.get::<_,String>(3)?,
        "value":serde_json::from_str::<Value>(&value).unwrap_or(Value::Null),"note":r.get::<_,String>(5)?,"at":r.get::<_,String>(6)?}),
    )
}
fn latest(db: &Connection, pack: &str) -> Result<HashMap<String, Value>> {
    let mut q = db
        .prepare("SELECT seq,item,request_id,decision,value,note,at FROM rehearsal_answers WHERE pack=? ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([pack], answer_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|a| (a["item"].as_str().unwrap_or_default().to_string(), a))
        .collect())
}

/// 问题的当前结论：同意 → 预填值；改后同意 → 你的值；驳回/暂不确定 → 无值。
fn resolved(q: &Value, a: Option<&Value>) -> Value {
    match a.map(|a| a["decision"].as_str().unwrap_or("")) {
        Some("accept") => {
            json!({"state":"confirmed","value":q["prefill"]["value"],"source":"你确认了历史提炼的做法"})
        }
        Some("edit") => {
            json!({"state":"edited","value":a.unwrap()["value"],"source":"你在演练中修改"})
        }
        Some("reject") => json!({"state":"rejected","value":null,"source":"你认为不适用"}),
        Some("unsure") => json!({"state":"unsure","value":null,"source":"暂不确定，之后再问"}),
        _ => json!({"state":"open","value":null,"source":null}),
    }
}
fn case_state(a: Option<&Value>) -> &'static str {
    match a.map(|a| a["decision"].as_str().unwrap_or("")) {
        Some("agree") => "agreed",
        Some("history") => "history",
        Some("custom") => "custom",
        Some("skip") => "skipped",
        _ => "open",
    }
}

fn status(path: &Path) -> Result<Value> {
    let db = open_db(path, false)?;
    let Some(db) = db.filter(tables_ready) else {
        return Ok(json!({"pack":null,"message":"还没有导入演练包。"}));
    };
    let Some(pack) = active(&db)? else {
        return Ok(json!({"pack":null,"message":"还没有导入演练包。"}));
    };
    let pid = pack["id"].as_str().unwrap_or_default();
    let answers = latest(&db, pid)?;
    let mut steps: Vec<Value> = pack["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| json!({"id":s["id"],"title":s["title"],"total":0,"done":0}))
        .collect();
    let mut bump = |step: &Value, done: bool| {
        if let Some(s) = steps.iter_mut().find(|s| &s["id"] == step) {
            s["total"] = json!(s["total"].as_i64().unwrap_or(0) + 1);
            if done {
                s["done"] = json!(s["done"].as_i64().unwrap_or(0) + 1);
            }
        }
    };
    let mut items = vec![];
    let mut profile = vec![];
    let (mut hard_open, mut open) = (0, 0);
    for q in pack["questions"].as_array().unwrap() {
        let a = answers.get(q["id"].as_str().unwrap_or(""));
        let r = resolved(q, a);
        let done = !["open", "unsure"].contains(&r["state"].as_str().unwrap_or(""));
        bump(&q["step"], done);
        if !done {
            open += 1;
            if q["kind"] == "hard" {
                hard_open += 1;
            }
        }
        if !r["value"].is_null() {
            profile.push(json!({"id":q["id"],"step":q["step"],"kind":q["kind"],"question":q["question"],"value":r["value"],"source":r["source"],"at":a.map(|a|a["at"].clone())}));
        }
        items.push(json!({"type":"question","id":q["id"],"step":q["step"],"kind":q["kind"],"title":q["question"],"state":r["state"],"value":r["value"]}));
    }
    let (mut agreed, mut decided) = (0, 0);
    let mut differences = vec![];
    for c in pack["cases"].as_array().unwrap() {
        let a = answers.get(c["id"].as_str().unwrap_or(""));
        let st = case_state(a);
        bump(&c["step"], st != "open");
        if st == "open" {
            open += 1;
        } else if st != "skipped" {
            decided += 1;
            if st == "agreed" {
                agreed += 1;
            } else {
                differences.push(json!({"id":c["id"],"title":c["title"],"action":c["suggestion"]["action"],"decision":st,"note":a.map(|a|a["note"].clone())}));
            }
        }
        items.push(json!({"type":"case","id":c["id"],"step":c["step"],"title":c["title"],"state":st,"action":c["suggestion"]["action"],"conditionChange":c["suggestion"]["conditionChange"]}));
    }
    Ok(json!({
        "pack":{"id":pack["id"],"title":pack["title"],"generatedAt":pack["generatedAt"],"generatedBy":pack["generatedBy"],"sources":pack["sources"]},
        "revision":revision(&db,pid)?,"steps":steps,"items":items,"profile":profile,
        "summary":{"open":open,"hardOpen":hard_open,"remembered":profile.len(),"casesDecided":decided,"casesAgreed":agreed,"differences":differences},
        "message":"模拟演练：不会发送任何消息，也不会修改达人档案。"
    }))
}

/// 案例的来信与当时做法从业务库只读获取；业务库缺失时如实说明。
fn case_context(path: &Path, message_id: &str) -> Value {
    let Ok(bp) = crate::local_backend::business_path(path) else {
        return json!({"available":false,"reason":"无法确定业务库位置"});
    };
    if !bp.exists() {
        return json!({"available":false,"reason":"本地工作台尚未建立，无法读取这封来信。"});
    }
    let read = || -> rusqlite::Result<Value> {
        let db = Connection::open_with_flags(&bp, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let m = db
            .query_row(
                "SELECT m.creator,c.handle,m.channel,m.at,m.kind,m.sender,m.subject,m.body,m.zh FROM messages m LEFT JOIN creators c ON c.id=m.creator WHERE m.id=? AND m.direction='in'",
                [message_id],
                |r| Ok(json!({"creator":r.get::<_,Option<String>>(0)?,"handle":r.get::<_,Option<String>>(1)?,"channel":r.get::<_,Option<String>>(2)?,"at":r.get::<_,Option<String>>(3)?,"kind":r.get::<_,Option<String>>(4)?,"sender":r.get::<_,Option<String>>(5)?,"subject":r.get::<_,Option<String>>(6)?,"body":r.get::<_,Option<String>>(7)?,"zh":r.get::<_,Option<String>>(8)?})),
            )
            .optional()?;
        let Some(m) = m else {
            return Ok(
                json!({"available":false,"reason":"业务库里找不到这封来信，可能来自另一份工作台。"}),
            );
        };
        let creator = m["creator"].as_str().unwrap_or_default().to_string();
        let at = m["at"].as_str().unwrap_or_default().to_string();
        let reply = db
            .query_row(
                "SELECT at,channel,subject,body,zh FROM messages WHERE creator=? AND direction='out' AND at>? ORDER BY at LIMIT 1",
                params![creator, at],
                |r| Ok(json!({"at":r.get::<_,Option<String>>(0)?,"channel":r.get::<_,Option<String>>(1)?,"subject":r.get::<_,Option<String>>(2)?,"body":r.get::<_,Option<String>>(3)?,"zh":r.get::<_,Option<String>>(4)?})),
            )
            .optional()?;
        let negotiation = db
            .query_row(
                "SELECT status,our_offer,their_ask,next_step,updated FROM negotiations WHERE creator=?",
                [&creator],
                |r| Ok(json!({"status":r.get::<_,Option<String>>(0)?,"ourOffer":r.get::<_,Option<String>>(1)?,"theirAsk":r.get::<_,Option<String>>(2)?,"nextStep":r.get::<_,Option<String>>(3)?,"updated":r.get::<_,Option<String>>(4)?})),
            )
            .optional()?;
        Ok(
            json!({"available":true,"message":m,"history":{"reply":reply,"negotiation":negotiation}}),
        )
    };
    read().unwrap_or_else(|_| json!({"available":false,"reason":"读取业务库失败，请稍后重试。"}))
}

fn item(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["itemId"], "演练项")?;
    let id = identifier(input, "itemId")?;
    let db = open_db(path, false)?
        .filter(tables_ready)
        .ok_or("还没有导入演练包")?;
    let pack = active(&db)?.ok_or("还没有导入演练包")?;
    let pid = pack["id"].as_str().unwrap_or_default();
    let answers = latest(&db, pid)?;
    let mut q = db
        .prepare("SELECT seq,item,request_id,decision,value,note,at FROM rehearsal_answers WHERE pack=? AND item=? ORDER BY seq DESC LIMIT 20")
        .map_err(|e| e.to_string())?;
    let history = q
        .query_map(params![pid, id], answer_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let sources: HashMap<&str, &Value> = pack["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["id"].as_str().unwrap_or_default(), s))
        .collect();
    let questions = pack["questions"].as_array().unwrap();
    if let Some(qv) = questions.iter().find(|q| q["id"] == id) {
        let mut v = qv.clone();
        for e in v["evidence"].as_array_mut().unwrap() {
            e["label"] = sources
                .get(e["source"].as_str().unwrap_or(""))
                .map(|s| s["label"].clone())
                .unwrap_or(Value::Null);
        }
        return Ok(
            json!({"type":"question","item":v,"resolved":resolved(qv,answers.get(&id)),"history":history,"revision":revision(&db,pid)?}),
        );
    }
    let c = pack["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .ok_or("找不到这个演练项")?;
    let rules: Vec<Value> = c["rules"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| questions.iter().find(|q| &q["id"] == r))
        .map(|q| json!({"id":q["id"],"question":q["question"],"kind":q["kind"],"resolved":resolved(q,answers.get(q["id"].as_str().unwrap_or("")))}))
        .collect();
    Ok(
        json!({"type":"case","item":c,"rules":rules,"context":case_context(path,c["messageId"].as_str().unwrap_or("")),"state":case_state(answers.get(&id)),"history":history,"revision":revision(&db,pid)?}),
    )
}

fn answer(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &[
            "itemId",
            "decision",
            "value",
            "note",
            "requestId",
            "expectedRevision",
        ],
        "演练回答",
    )?;
    let id = identifier(input, "itemId")?;
    let request = identifier(input, "requestId")?;
    let decision = input["decision"].as_str().unwrap_or("");
    let note = match &input["note"] {
        Value::Null => String::new(),
        Value::String(s) if s.chars().count() <= 1000 => s.trim().to_string(),
        _ => return Err("备注不能超过 1000 字".into()),
    };
    let mut db = open_db(path, true)?.ok_or("无法打开状态库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let pack = active(&tx)?.ok_or("还没有导入演练包")?;
    let pid = pack["id"].as_str().unwrap_or_default().to_string();
    // 同一请求重放：内容相同返回原回执，不同则拒绝。
    let existing = tx
        .query_row(
            "SELECT seq,item,request_id,decision,value,note,at FROM rehearsal_answers WHERE request_id=?",
            [&request],
            answer_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(a) = existing {
        let same = a["item"] == id.as_str()
            && a["decision"] == decision
            && a["note"] == note.as_str()
            && (input["value"].is_null() || a["value"] == input["value"]);
        if !same {
            return Err("这个请求编号已用于另一条回答".into());
        }
        return Ok(json!({"receipt":a,"replayed":true}));
    }
    if input.get("expectedRevision").and_then(Value::as_i64) != Some(revision(&tx, &pid)?) {
        return Err("已有更新的回答，请刷新后再保存".into());
    }
    let question = pack["questions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["id"] == id.as_str());
    let case = pack["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id.as_str());
    let value = match (question, case) {
        (Some(q), _) => {
            if !QUESTION_DECISIONS.contains(&decision) {
                return Err("问题的回答只能是同意、修改、不适用或暂不确定".into());
            }
            if decision == "edit" {
                check_value(q, &input["value"]).map_err(|e| format!("修改后的值无效：{e}"))?;
                if input["value"] == q["prefill"]["value"] {
                    return Err("修改后的值与预填相同，请直接选“同意”".into());
                }
                input["value"].clone()
            } else {
                if !input["value"].is_null() {
                    return Err("只有“修改”需要填写值".into());
                }
                Value::Null
            }
        }
        (None, Some(_)) => {
            if !CASE_DECISIONS.contains(&decision) {
                return Err("案例的回答只能是同意建议、按当时做法、我会这样做或跳过".into());
            }
            if decision == "custom" && note.is_empty() {
                return Err("选择“我会这样做”时，请写下你的做法".into());
            }
            if !input["value"].is_null() {
                return Err("案例回答不需要填写值".into());
            }
            Value::Null
        }
        _ => return Err("找不到这个演练项".into()),
    };
    tx.execute(
        "INSERT INTO rehearsal_answers(request_id,pack,item,decision,value,note,at) VALUES(?,?,?,?,?,?,?)",
        params![request, pid, id, decision, value.to_string(), note, now()],
    )
    .map_err(|e| e.to_string())?;
    let seq = tx.last_insert_rowid();
    let receipt = tx
        .query_row(
            "SELECT seq,item,request_id,decision,value,note,at FROM rehearsal_answers WHERE seq=?",
            [seq],
            answer_row,
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"receipt":receipt,"replayed":false}))
}

fn import(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["path"], "导入演练包")?;
    let file = Path::new(input["path"].as_str().ok_or("缺少演练包路径")?);
    if !file.is_absolute() {
        return Err("演练包路径必须是绝对路径".into());
    }
    let meta = fs::metadata(file).map_err(|_| "找不到演练包文件")?;
    if !meta.is_file() || meta.len() > MAX_PACK {
        return Err("演练包必须是不超过 1 MiB 的文件".into());
    }
    let bytes = fs::read(file).map_err(|e| format!("无法读取演练包：{e}"))?;
    let pack: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("演练包不是合法 JSON：{e}"))?;
    validate(&pack)?;
    let sha = format!("{:x}", Sha256::digest(&bytes));
    let id = pack["id"].as_str().unwrap().to_string();
    let mut db = open_db(path, true)?.ok_or("无法打开状态库")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let old: Option<String> = tx
        .query_row(
            "SELECT sha256 FROM rehearsal_packs WHERE id=?",
            [&id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let created = match old {
        Some(s) if s == sha => false,
        Some(_) => return Err("已有同一编号、内容不同的演练包；新版本请使用新编号".into()),
        None => {
            tx.execute(
                "INSERT INTO rehearsal_packs(id,sha256,imported_at,value) VALUES(?,?,?,?)",
                params![id, sha, now(), pack.to_string()],
            )
            .map_err(|e| e.to_string())?;
            true
        }
    };
    tx.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![ACTIVE_KEY, id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let mut counts = Map::new();
    counts.insert(
        "questions".into(),
        json!(pack["questions"].as_array().unwrap().len()),
    );
    counts.insert(
        "cases".into(),
        json!(pack["cases"].as_array().unwrap().len()),
    );
    Ok(json!({"id":id,"sha256":sha,"created":created,"active":true,"counts":counts}))
}

pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    match command {
        "rehearsal-status" => {
            only_keys(&input, &[], "演练状态")?;
            status(path)
        }
        "rehearsal-item" => item(&input, path),
        "rehearsal-answer" => answer(&input, path),
        "rehearsal-import" => import(&input, path),
        _ => Err("不支持的插件命令".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use uuid::Uuid;

    fn pack() -> Value {
        json!({"schema":SCHEMA,"id":"pack-test","title":"合成演练","generatedAt":"2026-11-04T00:00:00Z","generatedBy":"测试",
            "sources":[{"id":"S1","label":"合成来源"}],
            "steps":[{"id":"offer","title":"合作条件"},{"id":"classify","title":"来信分类"}],
            "questions":[
              {"id":"offer.fee","step":"offer","kind":"hard","question":"首报价？","why":"首封必须写金额","feeds":["发送首封邀约"],
               "answer":{"type":"money","unit":"美元"},"prefill":{"value":50,"text":"上一轮 $50","confidence":"low"},"evidence":[{"source":"S1","text":"fee=50"}]},
              {"id":"classify.auto","step":"classify","kind":"preference","question":"秒回算不算？","why":"分类","feeds":["来信分类"],
               "answer":{"type":"choice","options":["不算","算"]},"prefill":{"value":"不算","text":"历史判定","confidence":"high"},"evidence":[{"source":"S1","text":"x"}]}],
            "cases":[{"id":"case.one","step":"classify","messageId":"m1","title":"秒回报价",
               "suggestion":{"classification":"自动回复","action":"自动回复处理","conditionChange":false,"points":["不算回复"]},"rules":["classify.auto"]}]})
    }
    struct F {
        root: std::path::PathBuf,
    }
    impl F {
        fn new() -> Self {
            let root = env::temp_dir().join(format!("gapaw-rehearsal-{}", Uuid::new_v4().simple()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn db(&self) -> std::path::PathBuf {
            self.root.join("state.sqlite")
        }
        fn import(&self, v: &Value) -> Result<Value> {
            let f = self.root.join(format!("{}.json", Uuid::new_v4().simple()));
            fs::write(&f, v.to_string()).unwrap();
            execute("rehearsal-import", json!({"path":f}), &self.db())
        }
        fn answer(&self, v: Value) -> Result<Value> {
            execute("rehearsal-answer", v, &self.db())
        }
        fn status(&self) -> Value {
            execute("rehearsal-status", json!({}), &self.db()).unwrap()
        }
    }
    impl Drop for F {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn validation_rejects_broken_references_and_values() {
        let mut p = pack();
        p["cases"][0]["rules"] = json!(["missing"]);
        assert!(validate(&p).unwrap_err().contains("不存在的问题"));
        let mut p = pack();
        p["questions"][1]["prefill"]["value"] = json!("也许");
        assert!(validate(&p).unwrap_err().contains("不在选项中"));
        let mut p = pack();
        p["questions"][0]["evidence"] = json!([]);
        assert!(validate(&p).unwrap_err().contains("依据"));
        let mut p = pack();
        p["questions"][0]["feeds"] = json!(["自动付款"]);
        assert!(validate(&p).unwrap_err().contains("未知动作"));
        assert!(validate(&pack()).is_ok());
    }

    #[test]
    fn import_is_idempotent_and_immutable() {
        let f = F::new();
        assert_eq!(f.status()["pack"], Value::Null);
        assert_eq!(f.import(&pack()).unwrap()["created"], true);
        assert_eq!(f.import(&pack()).unwrap()["created"], false);
        let mut changed = pack();
        changed["title"] = json!("改过");
        assert!(f.import(&changed).unwrap_err().contains("新编号"));
    }

    #[test]
    fn answers_append_and_build_profile() {
        let f = F::new();
        f.import(&pack()).unwrap();
        assert_eq!(f.status()["summary"]["hardOpen"], 1);
        // 修改值必须合法，且不能与预填相同。
        assert!(f.answer(json!({"itemId":"offer.fee","decision":"edit","value":-1,"requestId":"r1","expectedRevision":0})).is_err());
        assert!(f.answer(json!({"itemId":"offer.fee","decision":"edit","value":50,"requestId":"r1","expectedRevision":0})).unwrap_err().contains("同意"));
        let r = f.answer(json!({"itemId":"offer.fee","decision":"edit","value":100,"requestId":"r1","expectedRevision":0})).unwrap();
        assert_eq!(r["replayed"], false);
        // 重放返回原回执；同编号不同内容拒绝；过期版本拒绝。
        assert_eq!(f.answer(json!({"itemId":"offer.fee","decision":"edit","value":100,"requestId":"r1","expectedRevision":0})).unwrap()["replayed"], true);
        assert!(f.answer(json!({"itemId":"offer.fee","decision":"accept","requestId":"r1","expectedRevision":1})).is_err());
        assert!(f.answer(json!({"itemId":"classify.auto","decision":"accept","requestId":"r2","expectedRevision":0})).unwrap_err().contains("刷新"));
        f.answer(json!({"itemId":"classify.auto","decision":"accept","requestId":"r2","expectedRevision":1})).unwrap();
        assert!(f.answer(json!({"itemId":"case.one","decision":"custom","requestId":"r3","expectedRevision":2})).unwrap_err().contains("做法"));
        f.answer(json!({"itemId":"case.one","decision":"custom","note":"我会直接忽略","requestId":"r3","expectedRevision":2})).unwrap();
        let s = f.status();
        assert_eq!(s["summary"]["hardOpen"], 0);
        assert_eq!(s["summary"]["remembered"], 2);
        assert_eq!(s["profile"][0]["value"], 100);
        assert_eq!(s["profile"][0]["source"], "你在演练中修改");
        assert_eq!(s["profile"][1]["value"], "不算");
        assert_eq!(s["summary"]["differences"][0]["note"], "我会直接忽略");
        // 改主意：以最新一次为准，历史保留。
        f.answer(
            json!({"itemId":"offer.fee","decision":"unsure","requestId":"r4","expectedRevision":3}),
        )
        .unwrap();
        let s = f.status();
        assert_eq!(s["summary"]["hardOpen"], 1);
        assert_eq!(s["summary"]["remembered"], 1);
        let detail = execute("rehearsal-item", json!({"itemId":"offer.fee"}), &f.db()).unwrap();
        assert_eq!(detail["history"].as_array().unwrap().len(), 2);
        assert_eq!(detail["item"]["evidence"][0]["label"], "合成来源");
        let case = execute("rehearsal-item", json!({"itemId":"case.one"}), &f.db()).unwrap();
        assert_eq!(case["context"]["available"], false);
        assert_eq!(case["rules"][0]["resolved"]["value"], "不算");
    }
}
