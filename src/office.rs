//! 像素办公室首页的只读汇总：业务库计数、谈判、未回复名单、演练与设置状态。
//! 只读取，不发送、不修改任何业务数据；不返回邮箱地址和邮件正文。
use crate::{drafts::only_keys, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

const DAY_LIMIT: usize = 60;
const LIST_LIMIT: usize = 200;

/// Prioritize only recorded, unanswered correspondence. Age changes visibility,
/// never business state; old negotiations and uncertain dates remain prominent.
fn attention(db: &Connection, now: i64) -> rusqlite::Result<Value> {
    let mut stmt = db.prepare(
        "WITH latest AS (
           SELECT m.*,row_number() OVER (PARTITION BY creator
             ORDER BY julianday(at) DESC,CASE WHEN direction='out' THEN 1 ELSE 0 END DESC,rowid DESC) AS position
           FROM messages m
         )
         SELECT c.id,c.handle,m.at,m.subject,n.creator,n.status,n.their_ask,unixepoch(m.at)
         FROM latest m JOIN creators c ON c.id=m.creator
         LEFT JOIN negotiations n ON n.creator=m.creator
         WHERE m.position=1 AND m.direction='in' AND coalesce(m.kind,'')<>'自动回复'
           AND (n.creator IS NULL OR (coalesce(n.status,'') NOT LIKE '%结案%'
                AND coalesce(n.status,'') NOT LIKE '%无真人%'))
         ORDER BY julianday(m.at) DESC,c.id",
    )?;
    let mut groups =
        json!({"negotiations":[],"recent":[],"earlier":[],"undated":[],"windowDays":7});
    for row in stmt.query_map([], |r| {
        let negotiation = r.get::<_, Option<String>>(4)?.is_some();
        Ok((
            r.get::<_, Option<i64>>(7)?,
            negotiation,
            json!({"id":r.get::<_,String>(0)?,"handle":r.get::<_,Option<String>>(1)?,
                "at":r.get::<_,Option<String>>(2)?,"subject":short(r.get(3)?,120),
                "kind":if negotiation {"negotiation"} else {"mail"},
                "status":short(r.get(5)?,80),"theirAsk":short(r.get(6)?,120)}),
        ))
    })? {
        let (at, negotiation, item) = row?;
        let group = match at {
            None => "undated",
            Some(at) if at > now => "undated",
            Some(_) if negotiation => "negotiations",
            Some(at) if at >= now - 7 * 24 * 60 * 60 => "recent",
            Some(_) => "earlier",
        };
        groups[group].as_array_mut().unwrap().push(item);
    }
    // Handle the longest-waiting negotiations first, regardless of their age.
    groups["negotiations"].as_array_mut().unwrap().reverse();
    Ok(groups)
}

fn short(s: Option<String>, max: usize) -> String {
    s.unwrap_or_default().chars().take(max).collect()
}

fn event_key(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "发送尝试" => "sent",
        "平台受理" => "accepted",
        "发送失败" => "failed",
        "有效回复" => "replies",
        "有意向" => "interested",
        "确认合作" => "confirmed",
        _ => return None,
    })
}

/// A compact, local snapshot of recent real outreach. Test mail and mail bodies
/// are deliberately excluded; an absent reply is not a live inbox check.
fn recent_outreach(db: &Connection) -> rusqlite::Result<Vec<Value>> {
    if !crate::outbox::has_table(db) {
        return Ok(vec![]);
    }
    let mut st = db.prepare(
        "SELECT o.id,o.creator,c.handle,o.state,coalesce(nullif(o.sent_at,''),o.attempt_at),
         (SELECT m.at FROM messages m WHERE m.creator=o.creator AND m.channel='email'
          AND m.direction='in' AND coalesce(m.kind,'')<>'自动回复'
          AND julianday(m.at)>julianday(coalesce(nullif(o.sent_at,''),o.attempt_at))
          ORDER BY julianday(m.at) DESC LIMIT 1),
         EXISTS(SELECT 1 FROM events e WHERE e.creator=o.creator AND e.type='确认合作'
                AND coalesce(e.void_reason,'')='')
         FROM outbox o LEFT JOIN creators c ON c.id=o.creator
         WHERE o.mode='live' AND o.state IN ('sending','unknown','accepted','delivered','bounced','blocked')
         ORDER BY julianday(coalesce(nullif(o.sent_at,''),o.attempt_at)) DESC,o.id LIMIT 3",
    )?;
    let rows = st.query_map([], |r| {
        Ok(
            json!({"id":r.get::<_,String>(0)?,"creatorId":r.get::<_,String>(1)?,
            "handle":r.get::<_,Option<String>>(2)?,"state":r.get::<_,String>(3)?,
            "sentAt":r.get::<_,Option<String>>(4)?,"replyAt":r.get::<_,Option<String>>(5)?,
            "cooperationConfirmed":r.get::<_,bool>(6)?}),
        )
    })?;
    rows.collect()
}

fn business(path: &Path) -> rusqlite::Result<Value> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut days: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut bump = |day: String, key: String, n: i64| {
        let e = days.entry(day).or_default();
        let cur = e.get(&key).and_then(Value::as_i64).unwrap_or(0);
        e.insert(key, json!(cur + n));
    };
    let mut st = db.prepare("SELECT substr(at,1,10),coalesce(channel,''),type,count(*) FROM events WHERE coalesce(void_reason,'')='' AND at IS NOT NULL GROUP BY 1,2,3")?;
    for r in st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })? {
        let (d, ch, ty, n) = r?;
        if let Some(k) = event_key(&ty) {
            bump(d.clone(), k.into(), n);
            if !ch.is_empty() {
                bump(d, format!("{ch}_{k}"), n);
            }
        }
    }
    let mut st = db.prepare(
        "SELECT substr(at,1,10),direction,count(*) FROM messages WHERE at IS NOT NULL GROUP BY 1,2",
    )?;
    for r in st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, i64>(2)?,
        ))
    })? {
        let (d, di, n) = r?;
        if di == "in" || di == "out" {
            bump(d, format!("msg_{di}"), n);
        }
    }
    let keep = days.len().saturating_sub(DAY_LIMIT);
    let days: Map<String, Value> = days
        .into_iter()
        .skip(keep)
        .map(|(k, v)| (k, Value::Object(v)))
        .collect();

    let set = |sql: &str| -> rusqlite::Result<HashSet<String>> {
        let mut st = db.prepare(sql)?;
        let v = st
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        Ok(v)
    };
    let creators: i64 = db.query_row("SELECT count(*) FROM creators", [], |r| r.get(0))?;
    let contacted = set("SELECT DISTINCT creator FROM events WHERE type='平台受理' AND coalesce(void_reason,'')='' AND creator IS NOT NULL")?;
    // 回复：登记过有效回复/有意向，或同步到了真人来信（非自动回复）。
    let replied = set("SELECT DISTINCT creator FROM events WHERE type IN ('有效回复','有意向') AND coalesce(void_reason,'')='' AND creator IS NOT NULL UNION SELECT creator FROM messages WHERE direction='in' AND coalesce(kind,'')<>'自动回复' AND creator IS NOT NULL")?;
    let interested = set("SELECT DISTINCT creator FROM events WHERE type='有意向' AND coalesce(void_reason,'')='' AND creator IS NOT NULL")?;
    let confirmed = set("SELECT DISTINCT creator FROM events WHERE type='确认合作' AND coalesce(void_reason,'')='' AND creator IS NOT NULL")?;

    let mut st = db.prepare(
        "SELECT n.creator,c.handle,n.status,n.our_offer,n.their_ask,n.next_step,n.updated,
           (SELECT max(at) FROM messages m WHERE m.creator=n.creator AND m.direction='in'),
           (SELECT max(at) FROM messages m WHERE m.creator=n.creator AND m.direction='out'),
           (SELECT count(*) FROM messages m WHERE m.creator=n.creator AND m.direction='in' AND coalesce(m.kind,'')<>'自动回复')
         FROM negotiations n LEFT JOIN creators c ON c.id=n.creator ORDER BY n.updated DESC LIMIT ?",
    )?;
    let negotiations = st
        .query_map([LIST_LIMIT as i64], |r| {
            let last_in: Option<String> = r.get(7)?;
            let last_out: Option<String> = r.get(8)?;
            let real_in: i64 = r.get(9)?;
            // 只有最近一条往来是对方来信时才轮到我们；一封来信都没有的是在等对方。
            let ball = match (&last_in, &last_out) {
                (Some(i), Some(o)) if i > o => "us",
                (Some(_), None) => "us",
                _ => "them",
            };
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "handle": r.get::<_, Option<String>>(1)?,
                "status": short(r.get(2)?, 80),
                "ourOffer": short(r.get(3)?, 120),
                "theirAsk": short(r.get(4)?, 120),
                "nextStep": short(r.get(5)?, 120),
                "updated": r.get::<_, Option<String>>(6)?,
                "lastIn": last_in, "lastOut": last_out, "ball": ball, "talking": real_in > 0
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let negotiating = negotiations
        .iter()
        // 谈判中：有过真人来信且未结案；只发了首触的占位记录不算。
        .filter(|n| {
            let s = n["status"].as_str().unwrap_or("");
            n["talking"] == true && !s.contains("无真人") && !s.contains("结案")
        })
        .count();

    let mut st = db.prepare(
        "SELECT e.creator,c.handle,max(e.at) FROM events e LEFT JOIN creators c ON c.id=e.creator
         WHERE e.type='平台受理' AND coalesce(e.void_reason,'')='' AND e.creator IS NOT NULL
         AND e.creator NOT IN (SELECT creator FROM events WHERE type IN ('有效回复','有意向') AND coalesce(void_reason,'')='' AND creator IS NOT NULL)
         AND e.creator NOT IN (SELECT creator FROM messages WHERE direction='in' AND coalesce(kind,'')<>'自动回复' AND creator IS NOT NULL)
         GROUP BY e.creator ORDER BY 3 ASC LIMIT ?",
    )?;
    let silent = st
        .query_map([LIST_LIMIT as i64], |r| {
            Ok(json!({"id": r.get::<_, String>(0)?, "handle": r.get::<_, Option<String>>(1)?, "lastTouch": r.get::<_, Option<String>>(2)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // 新来信：最近一条往来是对方的真人来信，且还没有谈判记录（有谈判的走谈判卡片）。
    let mut st = db.prepare(
        "SELECT m.creator,c.handle,m.at,m.subject FROM messages m JOIN creators c ON c.id=m.creator
         WHERE m.direction='in' AND coalesce(m.kind,'')<>'自动回复'
         AND m.at=(SELECT max(at) FROM messages x WHERE x.creator=m.creator)
         AND m.creator NOT IN (SELECT creator FROM negotiations WHERE creator IS NOT NULL)
         GROUP BY m.creator ORDER BY m.at DESC LIMIT ?",
    )?;
    let new_mail = st
        .query_map([LIST_LIMIT as i64], |r| {
            Ok(
                json!({"id": r.get::<_, String>(0)?, "handle": r.get::<_, Option<String>>(1)?,
                      "at": r.get::<_, Option<String>>(2)?, "subject": short(r.get(3)?, 120)}),
            )
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(json!({
        "attention": attention(&db, now_secs() as i64)?,
        "newMail": new_mail,
        "days": days,
        "funnel": {"creators": creators, "contacted": contacted.len(), "replied": replied.len(),
                   "interested": interested.len(), "negotiating": negotiating, "confirmed": confirmed.len()},
        "negotiations": negotiations,
        "silent": silent,
        "silentTotal": contacted.difference(&replied).count(),
        "outbox": crate::outbox::counts(&db).unwrap_or_else(|_| json!({})),
        "recentOutreach": recent_outreach(&db)?
    }))
}

fn rehearsal(path: &Path) -> Value {
    match crate::rehearsal::execute("rehearsal-status", json!({}), path) {
        Ok(r) if !r["pack"].is_null() => {
            let open: Vec<Value> = r["items"]
                .as_array()
                .map(|v| v.as_slice())
                .unwrap_or_default()
                .iter()
                .filter(|i| ["open", "unsure"].contains(&i["state"].as_str().unwrap_or("")))
                .map(|i| json!({"id":i["id"],"step":i["step"],"title":i["title"],"type":i["type"],"kind":i["kind"]}))
                .collect();
            let mut summary = r["summary"].clone();
            if let Some(m) = summary.as_object_mut() {
                m.remove("differences");
            }
            json!({"available": true, "steps": r["steps"], "summary": summary, "open": open})
        }
        Ok(_) => json!({"available": false, "steps": [], "summary": {}, "open": []}),
        Err(e) => json!({"available": false, "error": e, "steps": [], "summary": {}, "open": []}),
    }
}

fn setup(path: &Path) -> Value {
    match crate::setup::execute("setup-status", json!({"brief": true}), path) {
        Ok(s) => json!({
            "available": true,
            "mode": s["values"]["mode"].as_str().unwrap_or("test"),
            "mailSyncReady": s["features"]["mailSync"]["ready"] == true,
            "syncEnabled": s["values"]["sync"]["enabled"] == true,
            "lastSyncAt": s["mailSync"]["lastRunAt"],
            "items": s["items"].as_array().map(|v| v.iter().map(|i| json!({"id":i["id"],"title":i["title"],"state":i["state"],"summary":i["summary"]})).collect::<Vec<_>>()).unwrap_or_default()
        }),
        Err(e) => json!({"available": false, "error": e, "mode": "test", "items": []}),
    }
}

fn status(path: &Path) -> Result<Value> {
    let local = crate::local_backend::status(path)?;
    let bp = crate::local_backend::business_path(path)?;
    let mut out = if local["initialized"] == true {
        business(&bp).map_err(|_| "读取本地工作台失败，请稍后重试")?
    } else {
        json!({"days":{}, "funnel":{"creators":0,"contacted":0,"replied":0,"interested":0,"negotiating":0,"confirmed":0},
               "negotiations":[], "silent":[], "silentTotal":0, "newMail":[], "outbox":{}, "recentOutreach":[],
               "attention":{"negotiations":[],"recent":[],"earlier":[],"undated":[],"windowDays":7}})
    };
    out["workbench"] = json!({"initialized": local["initialized"], "active": local["active"]});
    out["rehearsal"] = rehearsal(path);
    out["setup"] = setup(path);
    let team = crate::workforce::status(path)?;
    out["team"] = json!({"configured":team["configured"],"initialized":team["initialized"],"counts":team["counts"],"wakeWorkId":team["wakeWorkId"],
        "staff":team["staff"].as_array().map(|a|a.iter().map(|s|json!({"key":s["key"],"task":s["task"]})).collect::<Vec<_>>()).unwrap_or_default(),
        "items":team["items"].as_array().map(|a|a.iter().map(|w|json!({"id":w["id"],"staffKey":w["staffKey"],"state":w["state"],"updatedAt":w["updatedAt"],"dispatchRecorded":w["dispatchRecorded"],"claim":if w["claim"].is_null(){Value::Null}else{json!({"id":w["claim"]["id"]})}})).collect::<Vec<_>>()).unwrap_or_default()});
    out["generatedAt"] = json!(now_secs());
    out["message"] = json!("只读汇总：不会发送任何消息，也不会修改业务数据。");
    Ok(out)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 单个达人的谈判与最近往来，供首页抽屉查看；只读，正文最多 1500 字、最多 8 条。
fn creator(input: &Value, path: &Path) -> Result<Value> {
    only_keys(input, &["creatorId"], "office-creator")?;
    let id = input["creatorId"].as_str().unwrap_or_default();
    if id.is_empty() || id.len() > 64 || id.chars().any(char::is_control) {
        return Err("达人编号不合法".into());
    }
    let bp = crate::local_backend::business_path(path)?;
    if !bp.exists() {
        return Err("还没有业务数据".into());
    }
    let read = || -> rusqlite::Result<Option<Value>> {
        let db = Connection::open_with_flags(&bp, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let Ok(handle) = db.query_row("SELECT handle FROM creators WHERE id=?", [id], |r| {
            r.get::<_, Option<String>>(0)
        }) else {
            return Ok(None);
        };
        let negotiation = db
            .query_row(
                "SELECT status,our_offer,their_ask,next_step,updated FROM negotiations WHERE creator=?",
                [id],
                |r| Ok(json!({"status": short(r.get(0)?, 200), "ourOffer": short(r.get(1)?, 300), "theirAsk": short(r.get(2)?, 300), "nextStep": short(r.get(3)?, 300), "updated": r.get::<_, Option<String>>(4)?})),
            )
            .ok();
        let mut st = db.prepare(
            "SELECT channel,direction,at,subject,body,zh,kind FROM messages WHERE creator=? ORDER BY at DESC LIMIT 8",
        )?;
        let messages = st
            .query_map([id], |r| {
                Ok(json!({"channel": r.get::<_, Option<String>>(0)?, "direction": r.get::<_, Option<String>>(1)?,
                          "at": r.get::<_, Option<String>>(2)?, "subject": short(r.get(3)?, 200),
                          "body": short(r.get(4)?, 1500), "zh": short(r.get(5)?, 1500), "kind": r.get::<_, Option<String>>(6)?}))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let settings: String =
            db.query_row("SELECT settings FROM creators WHERE id=?", [id], |r| {
                r.get(0)
            })?;
        let settings: Value = serde_json::from_str(&settings).unwrap_or_default();
        let has_email = settings["email"].as_str().is_some_and(|e| e.contains('@'));
        let draft = db
            .query_row(
                "SELECT subject,body FROM drafts WHERE creator=? AND channel='email'",
                [id],
                |r| Ok(json!({"subject": r.get::<_, Option<String>>(0)?, "body": r.get::<_, Option<String>>(1)?})),
            )
            .ok();
        let reply = db
            .query_row(
                "SELECT subject FROM messages WHERE creator=? AND direction='in' AND channel='email' AND coalesce(kind,'')<>'自动回复' ORDER BY at DESC LIMIT 1",
                [id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .map(|s| json!({"subject": short(s, 200)}));
        Ok(Some(
            json!({"id": id, "handle": handle, "negotiation": negotiation, "messages": messages,
                   "hasEmail": has_email, "emailDraft": draft, "lastInbound": reply}),
        ))
    };
    read()
        .map_err(|_| "读取业务库失败，请稍后重试".to_string())?
        .ok_or_else(|| "找不到这位达人".into())
}

pub fn execute(command: &str, input: Value, path: &Path) -> Result<Value> {
    match command {
        "office-creator" => creator(&input, path),
        "office-status" => {
            only_keys(&input, &[], command)?;
            status(path)
        }
        _ => Err("未知办公室命令".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};
    use uuid::Uuid;

    struct F {
        root: std::path::PathBuf,
    }
    impl F {
        fn new() -> Self {
            let root = env::temp_dir().join(format!("gapaw-office-{}", Uuid::new_v4().simple()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn state(&self) -> std::path::PathBuf {
            self.root.join("state.sqlite")
        }
    }
    impl Drop for F {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn empty_workbench_reports_zero_without_creating_files() {
        let f = F::new();
        let r = execute("office-status", json!({}), &f.state()).unwrap();
        assert_eq!(r["workbench"]["initialized"], false);
        assert_eq!(r["funnel"]["creators"], 0);
        assert_eq!(r["silent"], json!([]));
        assert!(!f.root.join("workbench.sqlite").exists());
        assert!(execute("office-status", json!({"x":1}), &f.state()).is_err());
    }

    #[test]
    fn attention_groups_pending_mail_without_hiding_old_negotiations() {
        let f = F::new();
        execute_init(&f);
        let bp = crate::local_backend::business_path(&f.state()).unwrap();
        let db = Connection::open(&bp).unwrap();
        for id in [
            "old", "deal", "closed", "auto", "answered", "offset", "missing", "future", "boundary",
            "new",
        ] {
            db.execute(
                "INSERT INTO creators(id,handle,profile,settings) VALUES(?,?,'{}','{}')",
                [id, id],
            )
            .unwrap();
        }
        for (id, creator, direction, at, kind) in [
            ("1", "old", "in", "2026-10-01T04:00:00Z", "正常"),
            ("2", "deal", "in", "2026-10-01T04:00:00Z", "正常"),
            ("3", "closed", "in", "2026-11-06T04:00:00Z", "正常"),
            ("4", "auto", "in", "2026-11-05T04:00:00Z", "正常"),
            ("5", "auto", "in", "2026-11-06T04:00:00Z", "自动回复"),
            ("6", "answered", "in", "2026-11-05T04:00:00Z", "正常"),
            ("7", "answered", "out", "2026-11-06T04:00:00Z", "正常"),
            ("8", "offset", "in", "2026-11-06T12:00:00+08:00", "正常"),
            ("9", "offset", "out", "2026-11-06T05:00:00Z", "正常"),
            ("10", "missing", "in", "not-a-date", "正常"),
            ("11", "future", "in", "2026-11-08T04:00:00Z", "正常"),
            ("12", "boundary", "in", "2026-10-31T12:00:00+08:00", "正常"),
            ("13", "new", "in", "2026-11-06T04:00:00Z", "正常"),
        ] {
            db.execute("INSERT INTO messages(id,creator,direction,at,kind,subject,body) VALUES(?,?,?,?,?,'Fixture subject','private body')", [id, creator, direction, at, kind]).unwrap();
        }
        db.execute("INSERT INTO negotiations(creator,status) VALUES('deal','对方还价'),('closed','已结案')", []).unwrap();
        let before = fs::read(&bp).unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-07T04:00:00Z")
            .unwrap()
            .timestamp();
        let result = attention(&db, now).unwrap();
        let ids = |key: &str| {
            result[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x["id"].as_str().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("negotiations"), vec!["deal"]);
        assert_eq!(ids("recent"), vec!["new", "boundary"]);
        assert_eq!(ids("earlier"), vec!["old"]);
        assert_eq!(ids("undated"), vec!["future", "missing"]);
        assert!(!result.to_string().contains("private body"));
        assert_eq!(before, fs::read(&bp).unwrap());
    }

    #[test]
    fn recent_outreach_excludes_tests_and_requires_actual_reply_and_confirmation() {
        let f = F::new();
        execute_init(&f);
        let bp = crate::local_backend::business_path(&f.state()).unwrap();
        let db = Connection::open(&bp).unwrap();
        db.execute("INSERT INTO creators(id,handle,profile,settings) VALUES('c1','fixture_creator','{}','{}')", []).unwrap();
        assert_eq!(recent_outreach(&db).unwrap(), Vec::<Value>::new());
        for (key, mode, state, at) in [
            ("real", "live", "delivered", "2026-11-07T04:45:30Z"),
            ("test", "test", "delivered", "2026-11-08T04:45:30Z"),
            ("cancelled", "live", "cancelled", "2026-11-09T04:45:30Z"),
        ] {
            let r = crate::outbox::execute("outbox-save", json!({"clientId":key,"creatorId":"c1","subject":"private subject","body":"private body","asReply":false}), &f.state()).unwrap();
            db.execute(
                "UPDATE outbox SET mode=?,state=?,sent_at=? WHERE id=?",
                [mode, state, at, r["id"].as_str().unwrap()],
            )
            .unwrap();
        }
        db.execute("INSERT INTO messages(id,creator,channel,direction,at,kind) VALUES('old','c1','email','in','2026-11-07T03:00:00Z','正常'),('auto','c1','email','in','2026-11-07T06:00:00Z','自动回复')", []).unwrap();
        db.execute("INSERT INTO events(id,creator,type,void_reason) VALUES('void','c1','确认合作','录错了')", []).unwrap();
        let before = fs::read(&bp).unwrap();
        let rows = recent_outreach(&db).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["state"], "delivered");
        assert!(rows[0]["replyAt"].is_null());
        assert_eq!(rows[0]["cooperationConfirmed"], false);
        assert!(!json!(rows).to_string().contains("private"));
        assert_eq!(fs::read(&bp).unwrap(), before);
        // Equivalent timestamps with different offsets must compare chronologically.
        db.execute("INSERT INTO messages(id,creator,channel,direction,at,kind) VALUES('reply','c1','email','in','2026-11-07T13:00:00+08:00','正常')", []).unwrap();
        let rows = recent_outreach(&db).unwrap();
        assert_eq!(rows[0]["replyAt"], "2026-11-07T13:00:00+08:00");
        assert_eq!(rows[0]["cooperationConfirmed"], false);
        db.execute(
            "INSERT INTO events(id,creator,type) VALUES('confirmed','c1','确认合作')",
            [],
        )
        .unwrap();
        assert_eq!(
            recent_outreach(&db).unwrap()[0]["cooperationConfirmed"],
            true
        );
    }

    #[test]
    fn summarises_business_data_read_only() {
        let f = F::new();
        execute_init(&f);
        let bp = crate::local_backend::business_path(&f.state()).unwrap();
        {
            let db = Connection::open(&bp).unwrap();
            for (id, h) in [("c1", "alpha"), ("c2", "beta"), ("c3", "gamma")] {
                db.execute(
                    "INSERT INTO creators(id,handle,profile,settings) VALUES(?,?,'{}','{}')",
                    [id, h],
                )
                .unwrap();
            }
            let ev = |id: &str, c: &str, ty: &str, at: &str, void: &str| {
                db.execute("INSERT INTO events(id,creator,channel,type,at,void_reason) VALUES(?,?,'email',?,?,?)", [id, c, ty, at, void]).unwrap();
            };
            ev("e1", "c1", "平台受理", "2026-11-01T10:00:00Z", "");
            ev("e2", "c2", "平台受理", "2026-11-01T11:00:00Z", "");
            ev("e3", "c3", "平台受理", "2026-11-02T09:00:00Z", "");
            ev("e4", "c1", "有效回复", "2026-11-02T12:00:00Z", "");
            ev("e5", "c2", "有效回复", "2026-11-02T12:00:00Z", "录错了");
            ev("e6", "c1", "确认合作", "2026-11-03T12:00:00Z", "");
            db.execute("INSERT INTO messages(id,creator,channel,direction,at,body) VALUES('m1','c1','email','in','2026-11-02T12:00:00Z','secret body')", []).unwrap();
            db.execute("INSERT INTO messages(id,creator,channel,direction,at,body) VALUES('m2','c1','email','out','2026-11-02T13:00:00Z','x')", []).unwrap();
            db.execute("INSERT INTO negotiations(creator,status,our_offer,their_ask,next_step,updated) VALUES('c1','对方还价','$50','$120','回复','2026-11-02')", []).unwrap();
        }
        let before = fs::read(&bp).unwrap();
        let r = execute("office-status", json!({}), &f.state()).unwrap();
        assert_eq!(fs::read(&bp).unwrap(), before);
        assert_eq!(r["funnel"]["creators"], 3);
        assert_eq!(r["funnel"]["contacted"], 3);
        assert_eq!(r["funnel"]["replied"], 1);
        assert_eq!(r["funnel"]["confirmed"], 1);
        assert_eq!(r["silentTotal"], 2);
        assert_eq!(r["silent"][0]["handle"], "beta");
        assert_eq!(r["days"]["2026-11-01"]["accepted"], 2);
        assert_eq!(r["days"]["2026-11-02"]["replies"], 1);
        assert_eq!(r["days"]["2026-11-02"]["msg_in"], 1);
        assert_eq!(r["negotiations"][0]["ball"], "them");
        assert!(!r.to_string().contains("secret body"));
    }

    #[test]
    fn placeholder_negotiations_wait_for_them_and_drawer_reads_thread() {
        let f = F::new();
        execute_init(&f);
        let bp = crate::local_backend::business_path(&f.state()).unwrap();
        {
            let db = Connection::open(&bp).unwrap();
            for (id, h) in [("p1", "placeholder"), ("t1", "talking"), ("n1", "newmail")] {
                db.execute(
                    "INSERT INTO creators(id,handle,profile,settings) VALUES(?,?,'{}','{}')",
                    [id, h],
                )
                .unwrap();
            }
            // 只发了首触的占位谈判：没有来信，不算谈判中，也不轮到我们。
            db.execute(
                "INSERT INTO negotiations(creator,status) VALUES('p1','已发首触邮件，待回复')",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO messages(id,creator,channel,direction,at,body) VALUES('o1','p1','email','out','2026-11-01T10:00:00Z','hi')", []).unwrap();
            // 真人来信晚于我们的回复：轮到我们。
            db.execute(
                "INSERT INTO negotiations(creator,status) VALUES('t1','对方还价')",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO messages(id,creator,channel,direction,at,body) VALUES('o2','t1','email','out','2026-11-01T10:00:00Z','offer')", []).unwrap();
            db.execute("INSERT INTO messages(id,creator,channel,direction,at,subject,body,kind) VALUES('i2','t1','email','in','2026-11-02T10:00:00Z','Re','ask more','正常')", []).unwrap();
            // 没有谈判记录的新来信。
            db.execute("INSERT INTO messages(id,creator,channel,direction,at,subject,body,kind) VALUES('i3','n1','email','in','2026-11-03T10:00:00Z','Hello','interested','正常')", []).unwrap();
        }
        let r = execute("office-status", json!({}), &f.state()).unwrap();
        let ball = |id: &str| {
            r["negotiations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["id"] == id)
                .unwrap()["ball"]
                .clone()
        };
        assert_eq!(ball("p1"), "them");
        assert_eq!(ball("t1"), "us");
        assert_eq!(r["funnel"]["negotiating"], 1);
        assert_eq!(r["funnel"]["replied"], 2);
        assert_eq!(r["newMail"].as_array().unwrap().len(), 1);
        assert_eq!(r["newMail"][0]["handle"], "newmail");
        assert!(!r.to_string().contains("ask more"));
        let c = execute("office-creator", json!({"creatorId": "t1"}), &f.state()).unwrap();
        assert_eq!(c["negotiation"]["status"], "对方还价");
        assert_eq!(c["messages"][0]["body"], "ask more");
        assert!(execute("office-creator", json!({"creatorId": "none"}), &f.state()).is_err());
        assert!(execute(
            "office-creator",
            json!({"creatorId": "t1", "x": 1}),
            &f.state()
        )
        .is_err());
    }

    fn execute_init(f: &F) {
        crate::local_backend::execute(
            "local-workbench-init",
            json!({"confirmed": true}),
            &f.state(),
        )
        .unwrap();
    }
}
