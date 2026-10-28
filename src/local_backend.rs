//! 本地业务库生命周期；操作回执与达人业务数据使用独立持久数据库。
use crate::{drafts::only_keys, open_db, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn business_path(state_path: &Path) -> Result<PathBuf> {
    let root = state_path.parent().ok_or("插件持久目录无效")?;
    Ok(root.join("workbench.sqlite"))
}
pub fn activate(state_path: &Path) -> Result<()> {
    crate::local_store::identity(&business_path(state_path)?)?;
    crate::workbench_store::local("initialize", &json!({}), &business_path(state_path)?)?;
    let mut db = open_db(state_path, true)?.ok_or("无法保存本地工作台设置")?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO settings(key,value) SELECT 'legacy_outreach',value FROM settings WHERE key='outreach' AND json_extract(value,'$.mode') IS NOT 'local'",[]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO settings(key,value) VALUES('outreach',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[json!({"mode":"local"}).to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
pub fn status(state_path: &Path) -> Result<Value> {
    let path = business_path(state_path)?;
    let state = open_db(state_path, false)?;
    let active = match state.as_ref() {
        None => false,
        Some(db) => {
            let raw: Option<String> = db
                .query_row("SELECT value FROM settings WHERE key='outreach'", [], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())?;
            raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .is_some_and(|v| v["mode"] == "local")
        }
    };
    if !path.exists() {
        return Ok(
            json!({"mode":"local","initialized":false,"active":false,"available":false,"sourceUrl":null,"counts":{"creators":0,"drafts":0,"events":0,"messages":0,"negotiations":0},"migration":null,"message":"本地工作台尚无数据库，模块可以查看；迁入已有数据或建立空工作台后即可保存。"}),
        );
    }
    let identity = crate::local_store::identity(&path)?;
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "无法读取本地业务库")?;
    let mut counts = serde_json::Map::new();
    for table in [
        "creators",
        "drafts",
        "events",
        "audit",
        "messages",
        "negotiations",
    ] {
        let n: i64 = db
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|_| "本地业务表不完整")?;
        counts.insert(table.into(), json!(n));
    }
    Ok(
        json!({"mode":"local","initialized":true,"active":active,"available":true,"sourceUrl":format!("local-workbench:{identity}"),"counts":counts,"migration":crate::local_migration::receipt(&path)?,"message":if active{"本地工作台已就绪，无需启动旧服务。"}else{"本地工作台已存在，可启用；不会覆盖当前业务数据。"}}),
    )
}
pub fn execute(command: &str, input: Value, state_path: &Path) -> Result<Value> {
    match command {
        "local-workbench-status" => {
            only_keys(&input, &[], command)?;
            status(state_path)
        }
        "local-workbench-init" => {
            only_keys(&input, &["confirmed"], command)?;
            if input["confirmed"] != true {
                return Err("请确认建立或启用本地工作台".into());
            }
            crate::local_store::init(&business_path(state_path)?)?;
            activate(state_path)?;
            status(state_path)
        }
        _ => Err("未知本地工作台命令".into()),
    }
}
