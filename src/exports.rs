//! 工作台导出文件的受限下载与持久快照；浏览器只接收宿主同源下载链接。
use crate::{
    drafts::{only_keys, Outreach},
    now, open_db, required, Result,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const WARNING: &str =
    "工作台导出用于复盘快照；不含完整往来消息和谈判数据，不能替代 SQLite 完整备份。";

fn format_info(format: &str) -> Result<(&'static str, &'static str)> {
    match format {
        "xlsx" => Ok((
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )),
        "zip" => Ok(("zip", "application/zip")),
        _ => Err("导出格式只支持 xlsx 或 zip".into()),
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn ordinary(path: &Path, directory: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法核对导出快照路径")?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err("导出快照路径必须是普通文件或目录".into());
    }
    Ok(())
}
fn response(dir: &Path, id: &str, format: &str, endpoint: &str, replay: bool) -> Result<Value> {
    ordinary(dir, true)?;
    let metadata_path = dir.join("snapshot.json");
    ordinary(&metadata_path, false)?;
    if fs::metadata(&metadata_path)
        .map_err(|_| "无法读取导出说明")?
        .len()
        > 4096
    {
        return Err("导出说明超过限制".into());
    }
    let metadata: Value =
        serde_json::from_slice(&fs::read(&metadata_path).map_err(|_| "无法读取导出说明")?)
            .map_err(|_| "导出说明损坏")?;
    if metadata["schemaVersion"] != 1
        || metadata["exportId"] != id
        || metadata["format"] != format
        || metadata["endpoint"] != endpoint
    {
        return Err("此导出编号已属于其他格式或工作台地址，请保留原快照并使用新编号".into());
    }
    let (extension, mime) = format_info(format)?;
    let file_name = format!("gapaw-outreach-{id}.{extension}");
    let file = dir.join(&file_name);
    ordinary(&file, false)?;
    let size = fs::metadata(&file).map_err(|_| "无法核对导出文件")?.len();
    if size < 4 || size > MAX_BYTES as u64 || metadata["size"] != size {
        return Err("导出文件大小不一致".into());
    }
    let bytes = fs::read(&file).map_err(|_| "无法核对导出文件")?;
    if !bytes.starts_with(b"PK\x03\x04") || metadata["sha256"] != digest(&bytes) {
        return Err("导出快照内容已变化，不能作为原编号的文件下载".into());
    }
    let absolute = file.canonicalize().map_err(|_| "无法定位导出文件")?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", &absolute.to_string_lossy())
        .finish();
    Ok(
        json!({"status":"ready","exportId":id,"format":format,"fileName":file_name,"mimeType":mime,
        "downloadUrl":format!("/api/download?{query}"),"size":size,"sha256":metadata["sha256"],
        "createdAt":metadata["createdAt"],"replay":replay,"scope":"all_creators","warning":WARNING}),
    )
}
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| "无法创建导出快照")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法完整保存导出快照")
        .map_err(String::from)
}
pub fn execute(input: Value, path: &Path) -> Result<Value> {
    only_keys(
        &input,
        &["format", "exportId", "expectedSource"],
        "workbench-export",
    )?;
    let format = required(&input, "format")?;
    format_info(format)?;
    let id = required(&input, "exportId")?;
    if id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("exportId 必须是最多 100 位的字母、数字、下划线或短横线".into());
    }
    let db = open_db(path, false)?;
    let client = Outreach::required(db.as_ref())?;
    drop(db);
    if let Some(expected) = input.get("expectedSource") {
        if expected.as_str() != Some(crate::facts::source_fingerprint(&client).as_str()) {
            return Err("工作台地址已变化，请回到原工作台核对后导出".into());
        }
    }
    let root = path.parent().ok_or("插件持久目录无效")?.join("exports");
    if root.exists() || root.is_symlink() {
        ordinary(&root, true)?;
    }
    let target = root.join(id);
    if target.exists() || target.is_symlink() {
        return response(&target, id, format, &client.root, true);
    }
    let bytes = client.download(format)?;
    if bytes.len() > MAX_BYTES || !bytes.starts_with(b"PK\x03\x04") {
        return Err("工作台导出不是受支持的文件或超过 8 MiB".into());
    }
    fs::create_dir_all(&root).map_err(|_| "无法创建持久导出目录")?;
    ordinary(&root, true)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护导出目录")?;
    }
    let staging = Staging(root.join(format!(".{id}-{}", Uuid::new_v4())));
    fs::create_dir(&staging.0).map_err(|_| "无法创建临时导出目录")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staging.0, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护导出目录")?;
    }
    let metadata = json!({"schemaVersion":1,"exportId":id,"format":format,"endpoint":client.root,"size":bytes.len(),"sha256":digest(&bytes),"createdAt":now()});
    write_private(
        &staging.0.join(format!("gapaw-outreach-{id}.{format}")),
        &bytes,
    )?;
    write_private(
        &staging.0.join("snapshot.json"),
        metadata.to_string().as_bytes(),
    )?;
    match fs::rename(&staging.0, &target) {
        Ok(()) => response(&target, id, format, &client.root, false),
        Err(_) if target.exists() || target.is_symlink() => {
            response(&target, id, format, &client.root, true)
        }
        Err(_) => Err("导出快照未能完整落盘，请沿用原编号重试".into()),
    }
}
