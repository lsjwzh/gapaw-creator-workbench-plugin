//! 旧工作台数据库的只读预览、SQLite 一致性备份和不可覆盖的原子迁入。
use crate::{local_store, now, required, Result};
use rusqlite::{
    backup::{Backup, StepResult},
    types::ValueRef,
    Connection, OpenFlags,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const IDENTITY_KEY: &str = "gapaw_local_business_id";
const RECEIPTS: &str = "gapaw_local_migration_receipts";
type RequiredColumn = (&'static str, &'static str, i64);
type RequiredTable = (&'static str, &'static [RequiredColumn]);
const REQUIRED: &[RequiredTable] = &[
    (
        "creators",
        &[
            ("id", "TEXT", 1),
            ("handle", "TEXT", 0),
            ("profile", "TEXT", 0),
            ("settings", "TEXT", 0),
            ("revision", "INTEGER", 0),
        ],
    ),
    (
        "drafts",
        &[
            ("creator", "TEXT", 1),
            ("channel", "TEXT", 2),
            ("subject", "TEXT", 0),
            ("body", "TEXT", 0),
            ("revision", "INTEGER", 0),
        ],
    ),
    (
        "events",
        &[
            ("id", "TEXT", 1),
            ("creator", "TEXT", 0),
            ("channel", "TEXT", 0),
            ("type", "TEXT", 0),
            ("at", "TEXT", 0),
            ("proof", "TEXT", 0),
            ("note", "TEXT", 0),
            ("created", "TEXT", 0),
            ("void_reason", "TEXT", 0),
            ("request_id", "TEXT", 0),
        ],
    ),
    (
        "audit",
        &[
            ("id", "INTEGER", 1),
            ("at", "TEXT", 0),
            ("kind", "TEXT", 0),
            ("creator", "TEXT", 0),
            ("previous", "TEXT", 0),
            ("current", "TEXT", 0),
        ],
    ),
    ("meta", &[("key", "TEXT", 1), ("value", "TEXT", 0)]),
    (
        "messages",
        &[
            ("id", "TEXT", 1),
            ("creator", "TEXT", 0),
            ("channel", "TEXT", 0),
            ("direction", "TEXT", 0),
            ("at", "TEXT", 0),
            ("sender", "TEXT", 0),
            ("subject", "TEXT", 0),
            ("body", "TEXT", 0),
            ("zh", "TEXT", 0),
            ("kind", "TEXT", 0),
            ("source", "TEXT", 0),
            ("created", "TEXT", 0),
        ],
    ),
    (
        "negotiations",
        &[
            ("creator", "TEXT", 1),
            ("status", "TEXT", 0),
            ("our_offer", "TEXT", 0),
            ("their_ask", "TEXT", 0),
            ("next_step", "TEXT", 0),
            ("updated", "TEXT", 0),
        ],
    ),
];

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn add(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
fn plain(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|_| "数据库文件不存在或无法读取")?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("数据库必须是普通文件，不能使用符号链接".into());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let side = PathBuf::from(format!("{}{suffix}", path.display()));
        if let Ok(m) = fs::symlink_metadata(side) {
            if !m.is_file() || m.file_type().is_symlink() {
                return Err("数据库附属文件不是普通文件".into());
            }
        }
    }
    Ok(())
}
fn destination_parent(parent: &Path) -> Result<()> {
    for directory in parent.ancestors() {
        match fs::symlink_metadata(directory) {
            Ok(metadata) => {
                // macOS 自带 /tmp、/var 别名不属于用户配置的目录重定向。
                let system_alias = (directory == Path::new("/tmp")
                    && directory.canonicalize().ok().as_deref() == Some(Path::new("/private/tmp")))
                    || (directory == Path::new("/var")
                        && directory.canonicalize().ok().as_deref()
                            == Some(Path::new("/private/var")));
                if (metadata.file_type().is_symlink() && !system_alias)
                    || (!metadata.is_dir() && !system_alias)
                {
                    return Err("插件业务目录及其父目录不能使用符号链接或普通文件".into());
                }
                let resolved = directory
                    .canonicalize()
                    .map_err(|_| "无法定位插件业务目录")?;
                if crate::in_worktree(&resolved) {
                    return Err("业务库不能放在任务工作区".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法核对插件业务目录".into()),
        }
    }
    Ok(())
}
fn read_only(path: &Path) -> Result<Connection> {
    plain(path)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "无法只读打开数据库")?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| "无法设置数据库等待时间")?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;")
        .map_err(|_| "无法建立数据库只读快照")?;
    Ok(db)
}
fn integrity(db: &Connection) -> Result<()> {
    let check: String = db
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| "数据库完整性检查失败")?;
    if check != "ok" {
        return Err("数据库完整性检查未通过，未执行迁入".into());
    }
    let mut stmt = db
        .prepare("PRAGMA foreign_key_check")
        .map_err(|_| "数据库关系检查失败")?;
    if stmt
        .query([])
        .map_err(|_| "数据库关系检查失败")?
        .next()
        .map_err(|_| "数据库关系检查失败")?
        .is_some()
    {
        return Err("数据库存在失效的关联记录，未执行迁入".into());
    }
    Ok(())
}
fn columns(db: &Connection, table: &str) -> Result<Vec<Value>> {
    let mut stmt = db
        .prepare(&format!("PRAGMA table_xinfo({})", quote(table)))
        .map_err(|_| "无法读取表结构")?;
    let rows = stmt.query_map([], |r| Ok(json!({"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"notNull":r.get::<_,i64>(3)? != 0,"primaryKeyPosition":r.get::<_,i64>(5)?,"hidden":r.get::<_,i64>(6)?})))
        .map_err(|_| "无法读取表结构")?;
    rows.map(|r| r.map_err(|_| "无法读取表结构".into()))
        .collect()
}
fn validate_schema(db: &Connection) -> Result<()> {
    for (name, expected) in REQUIRED {
        let actual = columns(db, name)?;
        for (column, kind, pk) in *expected {
            let found = actual
                .iter()
                .find(|v| v["name"] == *column)
                .ok_or_else(|| format!("旧库结构不兼容：{name} 缺少必要字段"))?;
            if found["type"].as_str().unwrap_or("").to_ascii_uppercase() != *kind
                || found["primaryKeyPosition"] != *pk
                || found["hidden"] != 0
            {
                return Err(format!("旧库结构不兼容：{name} 的字段类型或主键不符"));
            }
        }
        if actual
            .iter()
            .filter(|v| v["primaryKeyPosition"].as_i64().unwrap_or(0) > 0)
            .count()
            != expected.iter().filter(|(_, _, p)| *p > 0).count()
        {
            return Err(format!("旧库结构不兼容：{name} 的主键不符"));
        }
        let nonnull: &[&str] = match *name {
            "creators" => &["profile", "settings", "revision"],
            "drafts" => &["subject", "body", "revision"],
            _ => &[],
        };
        if nonnull.iter().any(|field| {
            !actual
                .iter()
                .any(|c| c["name"] == *field && c["notNull"] == true)
        }) {
            return Err(format!("旧库结构不兼容：{name} 缺少必要非空约束"));
        }
    }
    // 本地写入依赖这些唯一约束；只核对结构，不输出任何业务值。
    for (table, field) in [
        ("creators", "handle"),
        ("events", "request_id"),
        ("messages", "source"),
    ] {
        let mut stmt = db
            .prepare(&format!("PRAGMA index_list({})", quote(table)))
            .map_err(|_| "无法核对唯一索引")?;
        let indexes = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(|_| "无法核对唯一索引")?;
        let mut found = false;
        for row in indexes {
            let (name, unique, partial) = row.map_err(|_| "无法核对唯一索引")?;
            if unique != 1 || partial != 0 {
                continue;
            }
            let mut detail = db
                .prepare(&format!("PRAGMA index_info({})", quote(&name)))
                .map_err(|_| "无法核对唯一索引")?;
            let fields = detail
                .query_map([], |r| r.get::<_, Option<String>>(2))
                .map_err(|_| "无法核对唯一索引")?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| "无法核对唯一索引")?;
            if fields == vec![Some(field.to_string())] {
                found = true;
            }
        }
        if !found {
            return Err(format!("旧库结构不兼容：{table} 缺少必要唯一约束"));
        }
    }
    Ok(())
}

// 对类型和长度分别编码，保留 NULL、空文本、BLOB、整数、浮点及所有隐藏/额外列的区别。
fn table_summary(db: &Connection, table: &str, skip_identity: bool) -> Result<Value> {
    let cols = columns(db, table)?;
    let names: Vec<_> = cols
        .iter()
        .map(|c| quote(c["name"].as_str().unwrap()))
        .collect();
    let suffix = if table == "meta" && skip_identity {
        " WHERE key IS NOT 'gapaw_local_business_id'"
    } else {
        ""
    };
    let mut stmt = db
        .prepare(&format!(
            "SELECT {} FROM {}{suffix}",
            names.join(","),
            quote(table)
        ))
        .map_err(|_| "无法读取表内容摘要")?;
    let mut rows = stmt.query([]).map_err(|_| "无法读取表内容摘要")?;
    let mut hashes = Vec::<[u8; 32]>::new();
    while let Some(row) = rows.next().map_err(|_| "无法读取表内容摘要")? {
        let mut h = Sha256::new();
        for i in 0..cols.len() {
            match row.get_ref(i).map_err(|_| "无法核对数据库字段")? {
                ValueRef::Null => h.update([0]),
                ValueRef::Integer(n) => {
                    h.update([1]);
                    h.update(n.to_be_bytes());
                }
                ValueRef::Real(n) => {
                    h.update([2]);
                    h.update(n.to_bits().to_be_bytes());
                }
                ValueRef::Text(s) => {
                    h.update([3]);
                    add(&mut h, s);
                }
                ValueRef::Blob(s) => {
                    h.update([4]);
                    add(&mut h, s);
                }
            }
        }
        hashes.push(h.finalize().into());
    }
    hashes.sort_unstable();
    let mut hash = Sha256::new();
    add(&mut hash, serde_json::to_string(&cols).unwrap().as_bytes());
    for value in &hashes {
        hash.update(value);
    }
    let mut primary: Vec<_> = cols
        .iter()
        .filter(|c| c["primaryKeyPosition"].as_i64().unwrap_or(0) > 0)
        .collect();
    primary.sort_by_key(|c| c["primaryKeyPosition"].as_i64().unwrap());
    Ok(
        json!({"name":table,"count":hashes.len(),"sha256":format!("{:x}",hash.finalize()),"columns":cols,"primaryKey":primary.iter().map(|c| c["name"].clone()).collect::<Vec<_>>()}),
    )
}
fn snapshot(db: &Connection, skip_identity: bool) -> Result<Value> {
    integrity(db)?;
    validate_schema(db)?;
    let mut stmt = db
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name")
        .map_err(|_| "无法读取数据库结构")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|_| "无法读取数据库结构")?;
    let mut definitions = vec![];
    let mut tables = vec![];
    for row in rows {
        let (kind, name, table, sql) = row.map_err(|_| "无法读取数据库结构")?;
        if table == RECEIPTS {
            continue;
        }
        definitions.push(json!([kind, name, table, sql]));
        if kind == "table" {
            tables.push(table_summary(db, &name, skip_identity)?);
        }
    }
    tables.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| "无法读取数据库版本")?;
    let application: i64 = db
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(|_| "无法读取数据库标识")?;
    let schema =
        json!({"definitions":definitions,"userVersion":version,"applicationId":application});
    Ok(
        json!({"schemaDigest":digest(schema.to_string().as_bytes()),"tables":tables,"totalRows":tables.iter().map(|t|t["count"].as_u64().unwrap()).sum::<u64>()}),
    )
}
fn source_digest(path: &Path, summary: &Value) -> String {
    digest(json!({"format":"gapaw-sqlite-migration-v1","sourcePath":path.to_string_lossy(),"snapshot":summary}).to_string().as_bytes())
}
pub(crate) fn receipt(destination: &Path) -> Result<Option<Value>> {
    destination_parent(destination.parent().ok_or("插件业务目录无效")?)?;
    if fs::symlink_metadata(destination).is_err() {
        return Ok(None);
    }
    let db = read_only(destination)?;
    integrity(&db)?;
    validate_schema(&db)?;
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name=?",
            [RECEIPTS],
            |r| r.get(0),
        )
        .map_err(|_| "目标业务库结构不可读")?;
    if count == 0 {
        return Ok(None);
    }
    let value: String = db
        .query_row(
            &format!("SELECT receipt FROM {RECEIPTS} WHERE id=1"),
            [],
            |r| r.get(0),
        )
        .map_err(|_| "目标业务库已存在且没有可匹配的迁入回执；不会覆盖")?;
    let mut receipt: Value =
        serde_json::from_str(&value).map_err(|_| "目标迁入回执损坏；不会覆盖")?;
    if receipt["schemaVersion"] != 1
        || receipt["status"] != "imported"
        || receipt["destinationPath"] != destination.to_string_lossy().as_ref()
        || receipt["databaseId"] != local_store::identity_connection(&db)?
    {
        return Err("目标业务库已存在，迁入来源或数据库身份不匹配；不会覆盖".into());
    }
    let checksum = receipt["receiptDigest"]
        .as_str()
        .ok_or("目标迁入回执缺少校验；不会覆盖")?
        .to_string();
    receipt.as_object_mut().unwrap().remove("receiptDigest");
    if digest(receipt.to_string().as_bytes()) != checksum {
        return Err("目标迁入回执校验失败；不会覆盖".into());
    }
    receipt["receiptDigest"] = json!(checksum);
    Ok(Some(receipt))
}
fn existing(destination: &Path, source: &str, expected: &str) -> Result<Value> {
    let mut receipt =
        receipt(destination)?.ok_or("目标业务库已存在且没有可匹配的迁入回执；不会覆盖")?;
    if receipt["sourcePath"] != source || receipt["sourceDigest"] != expected {
        return Err("目标业务库已存在，迁入来源不匹配；不会覆盖".into());
    }
    receipt["replay"] = json!(true);
    Ok(receipt)
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}
fn backup(source: &Connection, target: &mut Connection) -> Result<()> {
    let backup = Backup::new(source, target).map_err(|_| "无法启动 SQLite 一致性备份")?;
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(30) {
            return Err("SQLite 备份超时；目标库尚未创建，可重试".into());
        }
        match backup.step(256).map_err(|_| "SQLite 一致性备份失败")? {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            StepResult::Busy | StepResult::Locked => thread::sleep(Duration::from_millis(20)),
            _ => return Err("SQLite 备份返回未知状态".into()),
        }
    }
}

pub(crate) fn execute(command: &str, input: Value, state_path: &Path) -> Result<Value> {
    let allowed = match command {
        "preview-workbench-import" => vec!["sourcePath"],
        "import-workbench" => vec!["sourcePath", "expectedSourceDigest", "confirmed"],
        _ => return Err("不支持的本地迁入命令".into()),
    };
    let object = input.as_object().ok_or("迁入输入必须为对象")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("迁入输入含不支持的字段".into());
    }
    let raw = required(&input, "sourcePath")?;
    if raw.chars().any(char::is_control) || !Path::new(raw).is_absolute() {
        return Err("来源必须是明确的绝对数据库路径".into());
    }
    let parent = state_path.parent().ok_or("插件持久目录无效")?;
    if !state_path.is_absolute() || crate::in_worktree(parent) {
        return Err("业务库不能放在任务工作区".into());
    }
    let destination = parent.join("workbench.sqlite");
    destination_parent(parent)?;
    let importing = command == "import-workbench";
    let expected = if importing {
        if input["confirmed"] != true {
            return Err("迁入必须明确确认 confirmed=true".into());
        }
        let value = required(&input, "expectedSourceDigest")?;
        if value.len() != 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("来源摘要格式不合法，请重新预览".into());
        }
        value
    } else {
        ""
    };
    // 成功重试不依赖旧服务或原库继续存在，也不会将后来编辑过的新库覆盖回去。
    if importing && fs::symlink_metadata(&destination).is_ok() {
        return existing(&destination, raw, expected);
    }
    plain(Path::new(raw))?;
    let source_path = Path::new(raw)
        .canonicalize()
        .map_err(|_| "无法定位来源数据库")?;
    if source_path == destination || source_path == state_path {
        return Err("来源不能是插件自己的数据库".into());
    }
    let source = read_only(&source_path)?;
    let reserved: i64 = source
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name=?",
            [RECEIPTS],
            |r| r.get(0),
        )
        .map_err(|_| "来源数据库结构不可读")?;
    if reserved != 0 {
        return Err("来源已包含插件迁入回执，不能作为旧工作台再次迁入".into());
    }
    let summary = snapshot(&source, false)?;
    let identity_exists: i64 = source
        .query_row(
            "SELECT count(*) FROM meta WHERE key=?",
            [IDENTITY_KEY],
            |r| r.get(0),
        )
        .map_err(|_| "无法核对来源元数据")?;
    if identity_exists != 0 {
        return Err("来源已有插件业务身份，不能作为旧工作台迁入".into());
    }
    let source_hash = source_digest(&source_path, &summary);
    let checked_at = now();
    if !importing {
        return Ok(
            json!({"sourcePath":source_path,"destinationPath":destination,"sourceDigest":source_hash,"schemaDigest":summary["schemaDigest"],"tables":summary["tables"],"totalRows":summary["totalRows"],"checkedAt":checked_at,"destinationExists":fs::symlink_metadata(&destination).is_ok(),"canImport":fs::symlink_metadata(&destination).is_err(),"warnings":["迁入复制完整数据库快照并保留原库；不会发送消息。","迁入后新库独立保存，原工作台后续改动不会自动同步。"]}),
        );
    }
    if source_hash != expected {
        return Err("来源自预览后已变化，请重新预览后确认；尚未创建目标库".into());
    }
    fs::create_dir_all(parent).map_err(|_| "无法创建插件业务目录")?;
    destination_parent(parent)?;
    let directory = fs::symlink_metadata(parent).map_err(|_| "无法核对插件业务目录")?;
    if !directory.is_dir()
        || directory.file_type().is_symlink()
        || crate::in_worktree(&parent.canonicalize().map_err(|_| "无法定位插件业务目录")?)
    {
        return Err("插件业务目录不可使用符号链接或任务工作区".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护插件业务目录")?;
    }
    let temporary =
        Temporary(parent.join(format!(".workbench-migration-{}.sqlite", Uuid::new_v4())));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&temporary.0)
        .map_err(|_| "无法创建隔离迁入文件")?;
    let mut target = Connection::open_with_flags(&temporary.0, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| "无法打开隔离迁入库")?;
    backup(&source, &mut target)?;
    if snapshot(&target, false)? != summary {
        return Err("备份与来源的逐表内容不一致；未创建目标库".into());
    }
    local_store::init_connection(&target)
        .map_err(|_| "无法初始化迁入库的业务身份；未创建目标库")?;
    let database_id = local_store::identity_connection(&target)?;
    if snapshot(&target, true)? != summary {
        return Err("初始化后的业务内容不一致；未创建目标库".into());
    }
    let mut receipt = json!({"schemaVersion":1,"status":"imported","receiptId":Uuid::new_v4().to_string(),"sourcePath":source_path,"destinationPath":destination,"sourceDigest":source_hash,"schemaDigest":summary["schemaDigest"],"tables":summary["tables"],"totalRows":summary["totalRows"],"sourceCheckedAt":checked_at,"importedAt":now(),"databaseId":database_id,"replay":false,"verification":"sqlite-backup-and-typed-full-row-sha256"});
    receipt["receiptDigest"] = json!(digest(receipt.to_string().as_bytes()));
    target
        .execute_batch(&format!(
            "CREATE TABLE {RECEIPTS}(id INTEGER PRIMARY KEY CHECK(id=1),receipt TEXT NOT NULL)"
        ))
        .map_err(|_| "无法保存迁入回执")?;
    target
        .execute(
            &format!("INSERT INTO {RECEIPTS}(id,receipt) VALUES(1,?)"),
            [receipt.to_string()],
        )
        .map_err(|_| "无法保存迁入回执")?;
    // 独立连接在发布前重新观察最新已提交来源，避免只比较旧的 WAL 读事务。
    let latest = read_only(&source_path)?;
    if source_digest(&source_path, &snapshot(&latest, false)?) != expected {
        return Err("迁入期间来源已变化，请重新预览；未创建目标库".into());
    }
    target
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
        .map_err(|_| "无法封存迁入库")?;
    target.close().map_err(|_| "无法关闭完整迁入库")?;
    OpenOptions::new()
        .read(true)
        .open(&temporary.0)
        .and_then(|f| f.sync_all())
        .map_err(|_| "无法持久保存迁入库")?;
    // hard_link 的目标创建是原子的且绝不覆盖；并发成功者之外只重放其原回执。
    match fs::hard_link(&temporary.0, &destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return existing(
                &destination,
                source_path.to_string_lossy().as_ref(),
                expected,
            )
        }
        Err(_) => return Err("无法原子创建目标业务库；原库保持不变".into()),
    }
    let _ = fs::File::open(parent).and_then(|f| f.sync_all());
    existing(
        &destination,
        source_path.to_string_lossy().as_ref(),
        expected,
    )
    .map(|mut value| {
        value["replay"] = json!(false);
        value
    })
}
