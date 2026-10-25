//! 有界只读 IPC：不接受调用方路径，不启动浏览器，也不暴露通用 CDP。
use super::Result;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

pub const PROTOCOL: &str = "gapaw-browser-read-v1";
const MAX_REQUEST: usize = 16 * 1024;
const MAX_RESPONSE: usize = 512 * 1024;

fn socket_name(profile_id: &str) -> String {
    let digest = Sha256::digest(profile_id.as_bytes());
    let short: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("read-{short}.sock")
}

pub fn target_id(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 200
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
        .ok_or_else(|| "页面标识格式无效".into())
}
pub fn instance_id(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| Uuid::parse_str(s).is_ok() && s.len() == 36)
        .ok_or_else(|| "桥接实例标识格式无效".into())
}
fn page(value: &Value, body: bool) -> Result<Value> {
    let target = target_id(&value["targetId"])?;
    let title = value["title"]
        .as_str()
        .filter(|s| s.chars().count() <= 2000 && !s.chars().any(char::is_control))
        .ok_or("桥接页面标题格式无效")?;
    let raw_url = value["url"]
        .as_str()
        .filter(|s| s.len() <= 4096 && !s.chars().any(char::is_control))
        .ok_or("桥接页面地址格式无效")?;
    let url = url::Url::parse(raw_url).map_err(|_| "桥接页面地址格式无效")?;
    let platform = match url.host_str() {
        Some("affiliate.tiktok.com") => "affiliate",
        Some("kalodata.com" | "www.kalodata.com") => "kalodata",
        _ => return Err("桥接页面不属于支持的平台".into()),
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || raw_url.contains('@')
        || value["platform"] != platform
    {
        return Err("桥接页面地址或平台标记不受支持".into());
    }
    let mut result =
        json!({"targetId":target,"title":title,"url":url.as_str(),"platform":platform});
    if body {
        let text = value["text"]
            .as_str()
            .filter(|s| s.chars().count() <= 120_000)
            .ok_or("桥接正文格式或大小无效")?;
        let truncated = value["truncated"].as_bool().ok_or("桥接正文截断标记无效")?;
        result["text"] = json!(text);
        result["truncated"] = json!(truncated);
    }
    Ok(result)
}
fn validate(response: Value, request: &Value) -> Result<Value> {
    if response["ok"] != true {
        return Err("来源只读桥接拒绝本次请求，请检查浏览器与冻结身份".into());
    }
    let data = &response["data"];
    if !data.is_object()
        || [
            "protocol",
            "requestId",
            "profileId",
            "sourceRevision",
            "action",
        ]
        .iter()
        .any(|key| data[key] != request[key])
    {
        return Err("桥接回应与本次身份、版本或请求不一致".into());
    }
    instance_id(&data["instanceId"])?;
    if request
        .get("expectedInstanceId")
        .is_some_and(|expected| expected != &data["instanceId"])
    {
        return Err("浏览器桥接实例已变化，请重新列出页面".into());
    }
    let mut result = json!({"instanceId":data["instanceId"]});
    match request["action"].as_str() {
        Some("status") => {}
        Some("pages") => {
            let items = data["pages"]
                .as_array()
                .filter(|a| a.len() <= 100)
                .ok_or("桥接页面列表格式或数量无效")?;
            let mut ids = std::collections::HashSet::new();
            let mut pages = Vec::with_capacity(items.len());
            for item in items {
                let projected = page(item, false)?;
                if !ids.insert(projected["targetId"].as_str().unwrap().to_owned()) {
                    return Err("桥接页面列表包含重复标识".into());
                }
                pages.push(projected);
            }
            result["pages"] = json!(pages);
        }
        Some("read-page") => {
            let projected = page(&data["page"], true)?;
            if projected["targetId"] != request["targetId"] {
                return Err("桥接回应不属于请求页面".into());
            }
            result["page"] = projected;
        }
        _ => return Err("不支持的只读桥接动作".into()),
    }
    Ok(result)
}

pub fn request(
    root: &Path,
    profile_id: &str,
    revision: &Value,
    action: &str,
    target: Option<&str>,
    expected_instance: Option<&str>,
) -> Result<Value> {
    if !["status", "pages", "read-page"].contains(&action) {
        return Err("不支持的只读桥接动作".into());
    }
    let mut request = json!({"protocol":PROTOCOL,"requestId":Uuid::new_v4().to_string(),"profileId":profile_id,"sourceRevision":revision,"action":action});
    if let Some(target) = target {
        request["targetId"] = json!(target);
    }
    if let Some(instance) = expected_instance {
        request["expectedInstanceId"] = json!(instance);
    }
    let mut bytes = serde_json::to_vec(&request).map_err(|_| "无法编码桥接请求")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REQUEST {
        return Err("只读桥接请求超过上限".into());
    }
    let response = exchange(root, profile_id, &bytes)?;
    let decoded = serde_json::from_slice(&response).map_err(|_| "桥接回应不是有效 JSON")?;
    validate(decoded, &request)
}

#[cfg(unix)]
fn exchange(root: &Path, profile_id: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    use std::{
        fs,
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{FileTypeExt, MetadataExt, PermissionsExt},
                net::UnixStream,
            },
        },
        time::{Duration, Instant},
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    let uid = unsafe { libc::geteuid() };
    let parent = root.join("run");
    for directory in [root, parent.as_path()] {
        let meta = fs::symlink_metadata(directory).map_err(|_| "只读桥接目录不可用")?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != uid
            || meta.permissions().mode() & 0o022 != 0
        {
            return Err("只读桥接目录的类型、属主或权限不安全".into());
        }
    }
    let socket_path = parent.join(socket_name(profile_id));
    let original = fs::symlink_metadata(&socket_path)
        .map_err(|_| "只读桥接未运行，请在来源插件中启动支持桥接的专用身份")?;
    if !original.file_type().is_socket()
        || original.file_type().is_symlink()
        || original.uid() != uid
        || original.permissions().mode() & 0o777 != 0o600
    {
        return Err("只读桥接端点的类型、属主或权限不安全".into());
    }
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let encoded = socket_path.as_os_str().as_bytes();
    if encoded.contains(&0) || encoded.len() >= address.sun_path.len() {
        return Err("只读桥接端点路径超过系统上限，请缩短来源持久目录".into());
    }
    address.sun_family = libc::AF_UNIX as _;
    for (dst, src) in address.sun_path.iter_mut().zip(encoded) {
        *dst = *src as libc::c_char;
    }
    #[cfg(target_os = "macos")]
    {
        address.sun_len = std::mem::size_of::<libc::sockaddr_un>() as u8;
    }
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err("无法创建只读桥接连接".into());
    }
    let mut stream = unsafe { UnixStream::from_raw_fd(raw) };
    stream
        .set_nonblocking(true)
        .map_err(|_| "无法设置只读桥接超时")?;
    let result = unsafe {
        libc::connect(
            raw,
            &address as *const _ as *const libc::sockaddr,
            std::mem::size_of_val(&address) as libc::socklen_t,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error().raw_os_error();
        if !matches!(error, Some(libc::EINPROGRESS) | Some(libc::EAGAIN)) {
            return Err("无法连接来源只读桥接".into());
        }
        wait_fd(raw, libc::POLLOUT, deadline)?;
        if stream
            .take_error()
            .map_err(|_| "无法确认只读桥接连接")?
            .is_some()
        {
            return Err("无法连接来源只读桥接".into());
        }
    }
    verify_peer_uid(raw, uid)?;
    let current = fs::symlink_metadata(&socket_path).map_err(|_| "只读桥接端点已变化")?;
    if current.ino() != original.ino()
        || current.dev() != original.dev()
        || current.uid() != uid
        || current.permissions().mode() & 0o777 != 0o600
    {
        return Err("只读桥接端点已变化".into());
    }
    let mut written = 0;
    while written < bytes.len() {
        wait_fd(stream.as_raw_fd(), libc::POLLOUT, deadline)?;
        match stream.write(&bytes[written..]) {
            Ok(0) => return Err("只读桥接连接已关闭".into()),
            Ok(n) => written += n,
            Err(e)
                if [
                    std::io::ErrorKind::WouldBlock,
                    std::io::ErrorKind::Interrupted,
                ]
                .contains(&e.kind()) => {}
            Err(_) => return Err("只读桥接请求写入失败".into()),
        }
    }
    let mut output = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        wait_fd(stream.as_raw_fd(), libc::POLLIN, deadline)?;
        match stream.read(&mut chunk) {
            Ok(0) => return Err("只读桥接回应未完整结束".into()),
            Ok(n) => {
                output.extend_from_slice(&chunk[..n]);
                if output.len() > MAX_RESPONSE {
                    return Err("只读桥接回应超过大小上限".into());
                }
                if let Some(end) = output.iter().position(|b| *b == b'\n') {
                    if output[end + 1..].iter().any(|b| !b.is_ascii_whitespace()) {
                        return Err("只读桥接回应包含多余数据".into());
                    }
                    output.truncate(end);
                    return Ok(output);
                }
            }
            Err(e)
                if [
                    std::io::ErrorKind::WouldBlock,
                    std::io::ErrorKind::Interrupted,
                ]
                .contains(&e.kind()) => {}
            Err(_) => return Err("只读桥接回应读取失败".into()),
        }
    }
}
// 文件属主保护端点，内核返回的连接凭据再确认实际服务进程的用户。
#[cfg(unix)]
fn verify_peer_uid(fd: libc::c_int, expected: libc::uid_t) -> Result<()> {
    #[cfg(target_os = "macos")]
    let actual = {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
            return Err("无法核对只读桥接进程属主".into());
        }
        uid
    };
    #[cfg(target_os = "linux")]
    let actual = {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut credentials as *mut _ as *mut libc::c_void,
                &mut size,
            )
        } != 0
            || size as usize != std::mem::size_of_val(&credentials)
        {
            return Err("无法核对只读桥接进程属主".into());
        }
        credentials.uid
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (fd, expected);
        return Err("当前系统尚不支持只读桥接进程属主核验".into());
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if actual != expected {
        return Err("只读桥接进程属主与当前用户不一致".into());
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Ok(())
}
#[cfg(unix)]
fn wait_fd(fd: libc::c_int, events: libc::c_short, deadline: std::time::Instant) -> Result<()> {
    loop {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or("只读桥接请求超时")?;
        let mut descriptor = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let ready = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                remaining.as_millis().clamp(1, i32::MAX as u128) as i32,
            )
        };
        if ready > 0 {
            return Ok(());
        }
        if ready == 0 {
            return Err("只读桥接请求超时".into());
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err("只读桥接连接检测失败".into());
        }
    }
}
#[cfg(not(unix))]
fn exchange(_: &Path, _: &str, _: &[u8]) -> Result<Vec<u8>> {
    Err("当前系统尚不支持此只读桥接".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_socket_name_preserves_default_macos_path_budget() {
        assert_eq!(socket_name("alpha"), "read-8ed3f6ad685b959e.sock");
        assert_eq!(socket_name("beta"), "read-f44e64e75f3948e9.sock");
        let name = socket_name("12345678-1234-4234-8234-123456789012");
        let path = format!("/Users/Zhuanz/.multicc/plugins-data/chrome-proxy-launcher/run/{name}");
        assert!(path.len() < 104);
        assert_eq!(name.len(), 26);
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn connected_peer_uid_must_match_the_current_user() {
        use std::os::{fd::AsRawFd, unix::net::UnixStream};
        let (left, _right) = UnixStream::pair().unwrap();
        let uid = unsafe { libc::geteuid() };
        assert!(verify_peer_uid(left.as_raw_fd(), uid).is_ok());
        assert!(verify_peer_uid(left.as_raw_fd(), uid.wrapping_add(1)).is_err());
        assert!(verify_peer_uid(-1, uid).is_err());
    }
    #[test]
    fn unicode_text_limit_matches_the_ui_and_supplier() {
        let mut value = page_value();
        value["text"] = json!("😀".repeat(120_000));
        assert!(page(&value, true).is_ok());
        value["text"] = json!("😀".repeat(120_001));
        assert!(page(&value, true).is_err());
    }
    fn page_value() -> Value {
        json!({"targetId":"target-1","title":"页面标题","url":"https://kalodata.com/creator","platform":"kalodata","text":"不可信页面资料","truncated":false,"cookie":"DO_NOT_RETURN"})
    }
    #[test]
    fn safe_page_projection_drops_extra_fields() {
        let result = page(&page_value(), true).unwrap();
        assert!(result.get("cookie").is_none());
        assert_eq!(result["text"], "不可信页面资料");
    }
    #[test]
    fn unsafe_urls_and_platform_mismatches_are_rejected() {
        for url in [
            "http://kalodata.com/",
            "https://kalodata.com/?token=SECRET",
            "https://kalodata.com/#SECRET",
            "https://user:SECRET@kalodata.com/",
            "https://kalodata.com:123/",
            "https://evil.invalid/",
            "file:///SECRET",
            "https://kalodata.com.evil.invalid/",
        ] {
            let mut value = page_value();
            value["url"] = json!(url);
            let error = page(&value, false).unwrap_err();
            assert!(!error.contains("SECRET"));
        }
        let mut value = page_value();
        value["platform"] = json!("affiliate");
        assert!(page(&value, false).is_err());
    }
    #[test]
    fn replies_bind_all_request_identity_fields_and_instance() {
        let instance = Uuid::new_v4().to_string();
        let request = json!({"protocol":PROTOCOL,"action":"read-page","requestId":Uuid::new_v4().to_string(),"profileId":"one","sourceRevision":{"revision":1},"targetId":"target-1","expectedInstanceId":instance});
        let mut data = request.clone();
        data["instanceId"] = json!(instance);
        data["page"] = page_value();
        assert!(validate(json!({"ok":true,"data":data}), &request).is_ok());
        for key in [
            "protocol",
            "action",
            "requestId",
            "profileId",
            "sourceRevision",
            "instanceId",
        ] {
            let mut invalid = data.clone();
            invalid[key] = json!("WRONG_SECRET");
            let error = validate(json!({"ok":true,"data":invalid}), &request).unwrap_err();
            assert!(!error.contains("WRONG_SECRET"));
        }
        let error =
            validate(json!({"ok":false,"error":"PRIVATE_SOURCE_PATH"}), &request).unwrap_err();
        assert!(!error.contains("PRIVATE_SOURCE_PATH"));
    }
}
