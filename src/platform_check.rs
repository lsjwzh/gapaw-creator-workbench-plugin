//! 平台登录判定放在达人插件；浏览器只提供通用、受控的页面观察。
use crate::{browser_catalog, now, Result};
use serde_json::{json, Value};
pub const ORIGINS: &[&str] = &[
    "https://kalodata.com",
    "https://www.kalodata.com",
    "https://affiliate.tiktok.com",
    "https://affiliate-us.tiktok.com",
    "https://affiliate.tiktokshopglobalselling.com",
    "https://seller-us.tiktok.com",
    "https://seller.tiktok.com",
    "https://seller-uk.tiktok.com",
];

pub fn session(profile: &Value) -> Result<Value> {
    browser_catalog::read(profile, "status", json!({"origins":ORIGINS}))
}
pub fn open(profile: &Value, key: &str) -> Result<Value> {
    let url = match key {
        "kalodata" => "https://www.kalodata.com/creator",
        "shop" => "https://affiliate.tiktok.com/",
        _ => return Err("未知平台".into()),
    };
    let status = session(profile)?;
    browser_catalog::read(
        profile,
        "open-page",
        json!({"origins":ORIGINS,"expectedInstanceId":status["instanceId"],"url":url}),
    )
}
fn empty(state: &str, message: &str) -> Value {
    json!({"state":state,"message":message,"account":null,"accountId":null,"market":null,"loginVerified":false,"permissions":"unknown","readableFields":[],"checkedAt":now()})
}
fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control) => {
            Some(s.clone())
        }
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
fn market(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| s.len() == 2 && s.bytes().all(|b| b.is_ascii_alphabetic()))
        .map(str::to_ascii_uppercase)
}
fn rules(key: &str) -> Value {
    if key == "kalodata" {
        json!([{"id":"identity","path":"/user/queryProfile","fields":["/success","/code","/data/username","/data/secId"]},
            {"id":"creatorList","path":"/creator/queryList","fields":["/success","/code"]}])
    } else {
        json!([{"id":"identity","path":"/api/v1/affiliate/account/info_v2","fields":["/code","/data/account/account_id","/data/shop/shop_id","/data/shop/shop_name","/data/shop/region"]}])
    }
}
fn belongs(key: &str, url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if !ORIGINS.contains(&u.origin().ascii_serialization().as_str()) {
        return false;
    }
    if key == "kalodata" {
        matches!(u.host_str(), Some("kalodata.com" | "www.kalodata.com"))
    } else {
        u.host_str().is_some_and(|h| {
            h.ends_with(".tiktok.com") || h == "affiliate.tiktokshopglobalselling.com"
        })
    }
}
pub fn classify(key: &str, result: &Value) -> Value {
    let page = &result["page"];
    let raw = page["url"].as_str().unwrap_or("");
    if !belongs(key, raw) {
        return empty("unverified", "页面跳转到了尚不支持的来源，未判定登录状态");
    }
    let text = page["text"].as_str().unwrap_or("").to_lowercase();
    let path = url::Url::parse(raw)
        .ok()
        .map(|u| u.path().to_owned())
        .unwrap_or_default();
    let obs = &result["observations"]["identity"];
    let f = &obs["fields"];
    // 验证/登录页面优先于其他旧响应，防止有效期内出现假绿。
    if [
        "verify you are human",
        "security verification",
        "complete the captcha",
        "安全验证",
        "请完成验证",
        "滑动验证",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        return empty(
            "challenge",
            "平台要求安全验证，请在绑定实例中完成后重新检查",
        );
    }
    if path.contains("/login")
        || path.contains("/signup")
        || (key == "shop" && path == "/account/register")
        || obs["httpStatus"] == 401
        || (key == "shop" && f["/code"] == 98001002)
    {
        return empty("signed_out", "请在绑定实例中登录平台，然后重新检查");
    }
    if obs["httpStatus"] == 403
        || (key == "shop" && matches!(f["/code"].as_u64(), Some(98001008 | 16201001)))
    {
        return empty(
            "permission_denied",
            "平台拒绝访问，请在绑定实例检查账号权限",
        );
    }
    if obs["httpStatus"].as_u64().is_some_and(|n| n >= 500) {
        return empty("service_error", "平台暂时不可用，未据此判定账号退出");
    }
    // Kalodata 访客榜单仍返回 HTTP 200 和 success=true；身份响应与登录入口
    // 必须共同核对，不能把公开榜单或被遮罩的数字当成已登录和字段可读。
    let login_entry = ["log in", "sign in", "登录"]
        .iter()
        .any(|s| text.contains(s));
    let signup_entry = ["sign up", "注册"].iter().any(|s| text.contains(s));
    if key == "kalodata"
        && page["truncated"] == false
        && obs["httpStatus"] == 200
        && obs["bodyState"] == "json"
        && (f["/success"] == false || f["/data/username"] == "visitor")
        && scalar(&f["/data/secId"]).is_none()
        && login_entry
        && signup_entry
    {
        return empty(
            "signed_out",
            "Kalodata 当前为访客状态，请在绑定实例中登录后重新检查",
        );
    }
    let mut out = empty(
        "unverified",
        "尚未获得有效身份响应；请打开平台业务页面后重试",
    );
    if page["truncated"] != false || obs["bodyState"] != "json" || obs["httpStatus"] != 200 {
        return out;
    }
    let identity = if key == "kalodata" {
        if f["/success"] != true {
            return out;
        }
        let Some(account) = scalar(&f["/data/username"]).filter(|s| s != "visitor") else {
            return out;
        };
        let Some(id) = scalar(&f["/data/secId"]) else {
            return out;
        };
        (id, account, market(&obs["metadata"]["country"]))
    } else {
        if f["/code"] != 0 {
            return out;
        }
        let Some(id) = scalar(&f["/data/shop/shop_id"]) else {
            return out;
        };
        let Some(account_id) = scalar(&f["/data/account/account_id"]) else {
            return out;
        };
        out["operatorId"] = json!(account_id);
        (
            id,
            scalar(&f["/data/shop/shop_name"]).unwrap_or_else(|| "已登录店铺".into()),
            market(&f["/data/shop/region"]),
        )
    };
    out["accountId"] = json!(identity.0);
    out["account"] = json!(identity.1);
    out["market"] = json!(identity.2);
    out["loginVerified"] = json!(true);
    out["state"] = json!(if out["market"].is_null() {
        "market_unknown"
    } else {
        "signed_in"
    });
    out["message"] = json!(if out["market"].is_null() {
        "已核验登录，尚不能确认当前市场，请在平台选择市场后重试"
    } else {
        "已核验登录与当前市场；具体筛选字段仍需在本轮读取时核验"
    });
    out["evidence"] = json!({"source":raw,"method":"observed_page_response","identityResponse":rules(key)[0]["path"],"checkedAt":now()});
    out
}
pub fn inspect(profile: &Value, choices: &Value) -> Value {
    let mut proof = json!({"method":"automatic","checkedAt":now(),"profile":profile,"instanceId":null,"kalodata":empty("unchecked","尚未检查"),"shop":empty("unchecked","尚未检查")});
    let result = (|| -> Result<()> {
        let status = session(profile)?;
        proof["instanceId"] = status["instanceId"].clone();
        let list = browser_catalog::read(
            profile,
            "pages",
            json!({"origins":ORIGINS,"expectedInstanceId":status["instanceId"]}),
        )?;
        let pages = list["pages"]
            .as_array()
            .filter(|a| a.len() <= 100)
            .ok_or("页面清单无效")?;
        for key in ["kalodata", "shop"] {
            let targets: Vec<_> = pages
                .iter()
                .filter(|p| belongs(key, p["url"].as_str().unwrap_or("")))
                .collect();
            if targets.is_empty() {
                proof[key] = empty(
                    "page_missing",
                    "此实例中尚未打开平台页面，请在此实例打开后登录",
                );
                continue;
            }
            // 多页可能属于不同市场/店铺，交由用户选择平台当前页，不能任取第一项。
            let options: Vec<_> = targets
                .iter()
                .map(|p| json!({"targetId":p["targetId"],"title":p["title"],"url":p["url"]}))
                .collect();
            let selected = if let Some(id) = choices[key].as_str() {
                targets.iter().find(|p| p["targetId"] == id).copied()
            } else if targets.len() == 1 {
                Some(targets[0])
            } else {
                None
            };
            let Some(page) = selected else {
                proof[key] = empty(
                    "multiple_pages",
                    "请选择本次使用的平台页面；账号和店铺由该页面自动检测",
                );
                proof[key]["pages"] = json!(options);
                continue;
            };
            proof["targetSelections"][key] = page["targetId"].clone();
            let result = browser_catalog::read(
                profile,
                "inspect-page",
                json!({"origins":ORIGINS,"expectedInstanceId":status["instanceId"],"targetId":page["targetId"],"observations":rules(key)}),
            );
            proof[key] = match result {
                Ok(r) => classify(key, &r),
                Err(_) => empty(
                    "read_failed",
                    "页面检查未完成；可能加载超时、页面跳转或实例变化，请重试",
                ),
            };
            proof[key]["pages"] = json!(options);
        }
        if session(profile)?["instanceId"] != proof["instanceId"] {
            return Err("检测过程中浏览器已重启，本次结果作废".into());
        }
        Ok(())
    })();
    if let Err(e) = result {
        for key in ["kalodata", "shop"] {
            proof[key] = empty("bridge_unavailable", &e);
        }
    }
    proof
}
pub fn same_identity(a: &Value, b: &Value) -> bool {
    ["kalodata", "shop"].iter().all(|k| {
        ["accountId", "operatorId", "market"]
            .iter()
            .all(|f| a[*k][*f] == b[*k][*f])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"page":{"url":"https://www.kalodata.com/creator","text":"达人","truncated":false},"observations":{"identity":{"httpStatus":200,"bodyState":"json","metadata":{"country":"US"},"fields":{"/success":true,"/data/username":"test-account","/data/secId":"u1"}}}})
    }
    #[test]
    fn authenticated_response_required_not_cookie_or_http_200() {
        let mut p = fixture();
        assert_eq!(classify("kalodata", &p)["state"], "signed_in");
        p["observations"]["identity"]["fields"]["/data/secId"] = Value::Null;
        assert_eq!(classify("kalodata", &p)["state"], "unverified");
        p = fixture();
        p["observations"]["identity"]["metadata"] = Value::Null;
        assert_eq!(classify("kalodata", &p)["state"], "market_unknown");
        p = fixture();
        p["page"]["url"] = json!("https://www.kalodata.com/login");
        assert_eq!(classify("kalodata", &p)["state"], "signed_out");
        p = fixture();
        p["page"]["text"] = json!("Security verification");
        assert_eq!(classify("kalodata", &p)["state"], "challenge");
        p = fixture();
        p["observations"]["identity"]["httpStatus"] = json!(503);
        assert_eq!(classify("kalodata", &p)["state"], "service_error");
        p = fixture();
        assert_eq!(classify("shop", &p)["state"], "unverified");
    }
    #[test]
    fn shop_identity_is_separate_from_operator_and_permissions() {
        let p = json!({"page":{"url":"https://affiliate.tiktok.com/connection","text":"Home","truncated":false},"observations":{"identity":{"httpStatus":200,"bodyState":"json","fields":{"/code":0,"/data/account/account_id":"a1","/data/shop/shop_id":"s1","/data/shop/shop_name":"合成店铺","/data/shop/region":"US"}}}});
        let r = classify("shop", &p);
        assert_eq!(r["state"], "signed_in");
        assert_eq!(r["operatorId"], "a1");
        assert_eq!(r["permissions"], "unknown");
    }
    #[test]
    fn cross_border_shop_requires_identity_and_exact_origin() {
        let mut p = json!({"page":{"url":"https://affiliate.tiktokshopglobalselling.com/affiliate/sample/sample-request","text":"联盟中心 US","truncated":false},"observations":{"identity":{"httpStatus":200,"bodyState":"json","fields":{"/code":0,"/data/account/account_id":"a1","/data/shop/shop_id":"s1","/data/shop/shop_name":"合成店铺","/data/shop/region":"US"}}}});
        assert_eq!(classify("shop", &p)["state"], "signed_in");
        assert_eq!(classify("kalodata", &p)["state"], "unverified");
        p["observations"] = json!({});
        assert_eq!(classify("shop", &p)["state"], "unverified");
        for url in [
            "https://affiliate.tiktokshopglobalselling.com.evil.example/",
            "https://unknown.tiktokshopglobalselling.com/",
            "http://affiliate.tiktokshopglobalselling.com/",
        ] {
            assert!(!belongs("shop", url));
        }
    }
    #[test]
    fn visitor_ranking_and_shop_registration_do_not_pass_login_checks() {
        let mut p = fixture();
        p["page"]["text"] = json!("Log in / Sign up Revenue $****");
        p["observations"]["identity"]["fields"] = json!({"/success":false,"/code":null});
        p["observations"]["creatorList"] = json!({"httpStatus":200,"fields":{"/success":true}});
        assert_eq!(classify("kalodata", &p)["state"], "signed_out");
        assert_eq!(classify("kalodata", &p)["readableFields"], json!([]));
        p["page"]["text"] = json!("Network error");
        assert_eq!(classify("kalodata", &p)["state"], "unverified");
        p["page"]["url"] = json!("https://seller-us.tiktok.com/account/register");
        assert_eq!(classify("shop", &p)["state"], "signed_out");
    }
}
