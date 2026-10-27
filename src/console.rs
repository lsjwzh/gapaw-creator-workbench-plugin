//! 工作台首页：经现有达人工作台的正式接口读取总览、档案与往来对话，人工编辑文案按 revision 写回。
use crate::drafts::{
    annotate_draft, annotate_negotiation, channel_label, check_placeholders, draft_of,
    mark_own_adoptions, negotiation_proposals, only_keys, pick, proposals, regex_like_fixed_fee,
    revision, Outreach,
};
use crate::{identifier, open_db, required, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

const LIST_KEYS: &[&str] = &[
    "id",
    "rank",
    "handle",
    "priority",
    "followers",
    "topic",
    "stage",
    "gates",
    "msg_count",
    "last_in",
    "negotiation_status",
    "prior_invite",
    "history",
];

fn drafts_operations(db: &Connection) -> Result<Vec<Value>> {
    let mut stmt = db
        .prepare("SELECT value FROM operations ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        let v: Value =
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if v["kind"] == "drafts" {
            out.push(v);
        }
    }
    Ok(out)
}
fn in_scope(op: &Value, creator: &str) -> bool {
    op["draftScope"]["creators"]
        .as_array()
        .is_some_and(|a| a.iter().any(|c| c["creatorId"] == creator))
}
fn op_summary(op: &Value) -> Value {
    json!({"id":op["id"],"mode":op["mode"].as_str().unwrap_or("drafts"),"status":op["status"],"task":op["task"],"error":op["error"],"createdAt":op["createdAt"],
        "channels":op["draftScope"]["channels"],
        "creators":op["draftScope"]["creators"].as_array().map(|a|a.iter().map(|c|json!({"creatorId":c["creatorId"],"handle":c["profile"]["handle"]})).collect::<Vec<_>>())})
}
/// 每个“达人＋文案位置”只看最新版本；该位置没有任何版本被采用时算待处理。
fn pending_by_creator(db: Option<&Connection>) -> Result<HashMap<String, usize>> {
    let mut pending: HashMap<String, usize> = HashMap::new();
    let Some(db) = db else { return Ok(pending) };
    for op in drafts_operations(db)? {
        let id = op["id"].as_str().unwrap_or("");
        let mut groups: HashMap<(String, String), bool> = HashMap::new();
        for p in proposals(db, id)? {
            let key = (
                p["creatorId"].as_str().unwrap_or("").to_string(),
                p["channel"].as_str().unwrap_or("").to_string(),
            );
            let adopted = p["adoption"]["status"] == "adopted";
            *groups.entry(key).or_insert(false) |= adopted;
        }
        for p in negotiation_proposals(db, id)? {
            let key = (
                p["creatorId"].as_str().unwrap_or("").to_string(),
                "negotiation".to_string(),
            );
            let adopted = p["adoption"]["status"] == "adopted";
            *groups.entry(key).or_insert(false) |= adopted;
        }
        for ((creator, _), adopted) in groups {
            if !adopted {
                *pending.entry(creator).or_default() += 1;
            }
        }
    }
    Ok(pending)
}
/// 对方最后一条真实来信之后我方还没有登记回复。
fn awaiting_reply(messages: &[Value]) -> Option<Value> {
    let mut real: Vec<&Value> = messages.iter().filter(|m| m["kind"] == "正常").collect();
    real.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
    let last = real.last()?;
    (last["direction"] == "in")
        .then(|| json!({"at":last["at"],"channel":last["channel"],"zh":last["zh"]}))
}

fn home(path: &Path) -> Result<Value> {
    let db = open_db(path, false)?;
    let client = Outreach::required(db.as_ref())?;
    let list = client.get("/api/creators")?;
    let items = list["items"].as_array().ok_or("工作台达人列表格式不兼容")?;
    let conversations = client.get("/api/conversations")?;
    let mut waiting: HashMap<String, Value> = HashMap::new();
    for c in conversations["items"].as_array().into_iter().flatten() {
        if let (Some(id), Some(msgs)) = (c["id"].as_str(), c["messages"].as_array()) {
            if let Some(w) = awaiting_reply(msgs) {
                waiting.insert(id.to_string(), w);
            }
        }
    }
    let pending = pending_by_creator(db.as_ref())?;
    let today = chrono::Local::now().date_naive().to_string();
    let mut out = vec![];
    let (mut due, mut reply, mut adopt) = (vec![], vec![], vec![]);
    for c in items {
        let id = c["id"].as_str().unwrap_or("").to_string();
        let mut v = pick(c, LIST_KEYS);
        let next = c["settings"]["next_followup"].as_str().unwrap_or("");
        v["next_followup"] = json!(next);
        v["owner"] = c["settings"]["owner"].clone();
        let is_due = !next.is_empty() && next <= today.as_str() && c["stage"] != "明确拒绝";
        v["due"] = json!(is_due);
        v["awaitingReply"] = waiting.get(&id).cloned().unwrap_or(Value::Null);
        v["pendingProposals"] = json!(pending.get(&id).copied().unwrap_or(0));
        let brief = json!({"id":id,"handle":c["handle"],"stage":c["stage"]});
        if is_due {
            let mut b = brief.clone();
            b["next_followup"] = json!(next);
            due.push(b);
        }
        if let Some(w) = waiting.get(&id) {
            let mut b = brief.clone();
            b["since"] = w["at"].clone();
            b["channel"] = w["channel"].clone();
            reply.push(b);
        }
        if let Some(n) = pending.get(&id) {
            let mut b = brief.clone();
            b["count"] = json!(n);
            adopt.push(b);
        }
        out.push(v);
    }
    reply.sort_by(|a, b| a["since"].as_str().cmp(&b["since"].as_str()));
    Ok(json!({"today":today,"summary":list["summary"],"items":out,
        "todo":{"awaitingReply":reply,"due":due,"pendingAdoption":adopt}}))
}

fn creator(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["creatorId"], "workbench-creator")?;
    let id = identifier(input, "creatorId")?;
    let db = open_db(path, false)?;
    let client = Outreach::required(db.as_ref())?;
    let d = client.detail(&id)?;
    let drafts: Vec<Value> = d["drafts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|x| {
            let ch = x["channel"].as_str().unwrap_or("");
            let manual = check_placeholders(&format!(
                "{}\n{}",
                x["subject"].as_str().unwrap_or(""),
                x["body"].as_str().unwrap_or("")
            ))
            .unwrap_or_default();
            json!({"channel":ch,"label":channel_label(ch),"subject":x["subject"],"body":x["body"],"rendered":x["rendered"],"rendered_subject":x["rendered_subject"],"revision":x["revision"],"manualPlaceholders":manual})
        })
        .collect();
    let (mut ops, mut draft_props, mut nego_props) = (vec![], vec![], vec![]);
    if let Some(db) = db.as_ref() {
        for op in drafts_operations(db)? {
            if !in_scope(&op, &id) {
                continue;
            }
            let op_id = op["id"].as_str().unwrap_or("");
            let mut items: Vec<Value> = proposals(db, op_id)?
                .into_iter()
                .filter(|p| p["creatorId"] == id.as_str())
                .collect();
            for p in items.iter_mut() {
                annotate_draft(p, &d);
            }
            mark_own_adoptions(&mut items);
            draft_props.extend(items);
            for mut p in negotiation_proposals(db, op_id)? {
                if p["creatorId"] == id.as_str() {
                    annotate_negotiation(&mut p, &d["negotiation"]);
                    nego_props.push(p);
                }
            }
            ops.push(op_summary(&op));
        }
    }
    Ok(
        json!({"profile":d["profile"],"settings":d["settings"],"revision":d["revision"],"stage":d["stage"],"gates":d["gates"],
        "drafts":drafts,"events":d["events"],"messages":d["messages"],"negotiation":d["negotiation"],
        "operations":ops,"proposals":draft_props,"negotiationProposals":nego_props}),
    )
}

fn conversations(path: &Path) -> Result<Value> {
    let db = open_db(path, false)?;
    let client = Outreach::required(db.as_ref())?;
    let v = client.get("/api/conversations")?;
    let mut items: Vec<Value> = v["items"]
        .as_array()
        .ok_or("工作台对话格式不兼容")?
        .iter()
        .map(|c| {
            let msgs = c["messages"].as_array().cloned().unwrap_or_default();
            let last = msgs
                .iter()
                .filter_map(|m| m["at"].as_str())
                .max()
                .map(String::from);
            json!({"id":c["id"],"handle":c["handle"],"priority":c["priority"],"stage":c["stage"],"negotiation":c["negotiation"],
                "messages":msgs,"lastAt":last,"awaitingReply":awaiting_reply(&msgs)})
        })
        .collect();
    items.sort_by(|a, b| b["lastAt"].as_str().cmp(&a["lastAt"].as_str()));
    Ok(json!({"items":items}))
}

/// 人工编辑：与工作台保存规则一致，并且只以写后读回判断结果。
fn edit(input: &Value, path: &Path) -> Result<Value> {
    only_keys(
        input,
        &["creatorId", "channel", "subject", "body", "revision"],
        "edit-draft",
    )?;
    let id = identifier(input, "creatorId")?;
    let channel = required(input, "channel")?;
    if channel_label(channel).is_none() {
        return Err("渠道不受支持".into());
    }
    let subject = input["subject"].as_str().unwrap_or("");
    let body = required(input, "body")?;
    let expected = input["revision"]
        .as_i64()
        .filter(|r| *r >= 0)
        .ok_or("revision 必须是非负整数")?;
    if subject.chars().count() > 300 || body.chars().count() > 10000 {
        return Err("文案超过长度限制".into());
    }
    if regex_like_fixed_fee(body) {
        return Err("请用【固定费】保留金额联动，避免改报价后遗留旧金额".into());
    }
    check_placeholders(&format!("{subject}\n{body}"))?;
    let db = open_db(path, false)?;
    let client = Outreach::required(db.as_ref())?;
    let posted = client.edit_draft(&id, channel, subject, body, expected);
    if let Ok(Err(msg)) = posted {
        let status = if msg.contains("已更新") {
            "conflict"
        } else {
            "rejected"
        };
        return Ok(json!({"status":status,"message":msg}));
    }
    match client.detail(&id) {
        Ok(after) => {
            let d = draft_of(&after, channel)?;
            let rev = revision(d)?;
            let same = d["subject"] == subject && d["body"] == body;
            let status = if same && rev == expected + 1 {
                "saved"
            } else if rev == expected {
                "not_applied"
            } else {
                "conflict"
            };
            Ok(json!({"status":status,"revision":rev}))
        }
        Err(e) => {
            Ok(json!({"status":"unknown","message":format!("保存结果未知：{e}；请刷新后核对")}))
        }
    }
}

pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    match command {
        "workbench-home" => home(path),
        "workbench-creator" => creator(&input, path),
        "workbench-conversations" => conversations(path),
        "edit-draft" => edit(&input, path),
        _ => Err("不支持的插件命令".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn awaiting_reply_ignores_auto_replies_and_answered_threads() {
        let m = |at: &str, dir: &str, kind: &str| json!({"at":at,"direction":dir,"kind":kind,"channel":"email","zh":""});
        assert!(awaiting_reply(&[
            m("2026-10-01", "out", "正常"),
            m("2026-10-02", "in", "正常")
        ])
        .is_some());
        assert!(awaiting_reply(&[
            m("2026-10-02", "in", "正常"),
            m("2026-10-03", "out", "正常")
        ])
        .is_none());
        assert!(awaiting_reply(&[
            m("2026-10-01", "out", "正常"),
            m("2026-10-02", "in", "自动回复")
        ])
        .is_none());
        assert!(awaiting_reply(&[]).is_none());
    }
    #[test]
    fn placeholders_allow_known_and_flag_manual() {
        assert_eq!(
            check_placeholders("【固定费】 + 【佣金比例】 —【姓名】")
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            check_placeholders("see 【两款商品资料链接】").unwrap(),
            vec!["【两款商品资料链接】".to_string()]
        );
        assert!(check_placeholders("【寄样地址】").is_err());
        assert!(check_placeholders("未闭合【固定费").is_ok());
    }
}
