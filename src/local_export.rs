//! 本地一致快照的 XLSX / ZIP 导出，不调用旧服务或脚本。
use crate::{local_store, Result};
use serde_json::{json, Value};
use std::{
    io::{Cursor, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipWriter};

type Sheet = (&'static str, Vec<Vec<Value>>);
const NOTE: &str = "这是本地工作台的导出快照。修改导出文件不会回写；草稿不代表已发送。包含资料、文案、商品证据、触达记录和历史快照，不含完整往来消息、谈判与审计；不能替代 SQLite 完整备份。";
fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        _ => v.to_string(),
    }
}
fn safe(v: &Value) -> String {
    let s = text(v);
    if s.trim_start().starts_with(['=', '+', '-', '@']) {
        format!("'{s}")
    } else {
        s
    }
}
fn xml(s: &str) -> String {
    s.chars()
        .filter(|c| {
            matches!(c, '\t' | '\r' | '\n') || *c >= ' ' && *c != '\u{fffe}' && *c != '\u{ffff}'
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn label(s: &str) -> &str {
    match s {
        "comment" => "评论",
        "dm" => "私信",
        "email" => "邮件",
        "affiliate" => "联盟邀请",
        "followup" => "跟进",
        _ => s,
    }
}
fn header(name: &'static str, columns: &[&str]) -> Sheet {
    (name, vec![columns.iter().map(|s| json!(s)).collect()])
}
fn row(v: &Value, columns: &[&str]) -> Vec<Value> {
    columns.iter().map(|c| v[*c].clone()).collect()
}
fn add(zip: &mut ZipWriter<Cursor<Vec<u8>>>, name: &str, data: &[u8]) -> Result<()> {
    zip.start_file(
        name,
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
    .map_err(|_| "无法创建导出文件条目")?;
    zip.write_all(data).map_err(|_| "无法写入导出文件".into())
}
fn finish(zip: ZipWriter<Cursor<Vec<u8>>>) -> Result<Vec<u8>> {
    let bytes = zip.finish().map_err(|_| "无法完成导出压缩包")?.into_inner();
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("导出文件超过 8 MiB".into());
    }
    Ok(bytes)
}
fn col(mut n: usize) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    s
}
fn xlsx(sheets: &[Sheet]) -> Result<Vec<u8>> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    add(&mut zip,"_rels/.rels",br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#)?;
    let mut types = String::from(
        r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>"#,
    );
    let mut book = String::from(
        r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>"#,
    );
    let mut rels = String::from(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for (idx, (name, rows)) in sheets.iter().enumerate() {
        let id = idx + 1;
        types.push_str(&format!(r#"<Override PartName="/xl/worksheets/sheet{id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#));
        book.push_str(&format!(
            r#"<sheet name="{}" sheetId="{id}" r:id="rId{id}"/>"#,
            xml(name)
        ));
        rels.push_str(&format!(r#"<Relationship Id="rId{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{id}.xml"/>"#));
        let mut sheet = String::from(
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" state="frozen"/></sheetView></sheetViews><sheetData>"#,
        );
        for (r, values) in rows.iter().enumerate() {
            sheet.push_str(&format!("<row r=\"{}\">", r + 1));
            for (c, v) in values.iter().enumerate() {
                let reference = format!("{}{}", col(c), r + 1);
                if v.is_number() {
                    sheet.push_str(&format!("<c r=\"{reference}\"><v>{v}</v></c>"));
                } else {
                    sheet.push_str(&format!("<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",xml(&safe(v))));
                }
            }
            sheet.push_str("</row>");
        }
        sheet.push_str("</sheetData></worksheet>");
        add(
            &mut zip,
            &format!("xl/worksheets/sheet{id}.xml"),
            sheet.as_bytes(),
        )?;
    }
    types.push_str("</Types>");
    book.push_str("</sheets></workbook>");
    rels.push_str("</Relationships>");
    add(&mut zip, "[Content_Types].xml", types.as_bytes())?;
    add(&mut zip, "xl/workbook.xml", book.as_bytes())?;
    add(&mut zip, "xl/_rels/workbook.xml.rels", rels.as_bytes())?;
    finish(zip)
}
pub fn download(path: &Path, format: &str) -> Result<Vec<u8>> {
    if !["xlsx", "zip"].contains(&format) {
        return Err("导出格式只支持 xlsx 或 zip".into());
    }
    let details = local_store::export_details(path)?;
    let mut sheets = vec![
        header(
            "达人主表",
            &[
                "编号",
                "账号",
                "原排名",
                "原优先级",
                "粉丝数_历史",
                "联盟全类目成交额_美元_历史",
                "宠物成交占比_历史",
                "数据统计期",
                "历史触达快照",
                "本轮状态",
                "两条合计固定费",
                "佣金比例",
                "负责人",
                "下次跟进",
                "待核验项目",
                "个性化选题",
                "资料依据一",
                "资料依据二",
                "主页",
                "联盟详情",
                "商务邮箱_待核实",
                "邮箱来源",
                "备注",
            ],
        ),
        header(
            "个性化文案",
            &[
                "编号",
                "账号",
                "渠道",
                "标题",
                "正文",
                "编辑版本",
                "复制或导出不代表发送",
            ],
        ),
        header(
            "商品证据",
            &[
                "编号",
                "账号",
                "商品编号",
                "商品原始名称",
                "用品分类",
                "估算销量_原值",
                "来源统计期",
            ],
        ),
        header(
            "本轮触达记录",
            &[
                "编号",
                "账号",
                "渠道",
                "事件",
                "发生时间",
                "事实依据",
                "备注",
                "撤销原因",
            ],
        ),
        header(
            "历史快照",
            &[
                "编号",
                "账号",
                "核验结论",
                "快照日期",
                "历史消息时间_洛杉矶",
                "我方消息数",
                "历史回复数",
                "历史收样数",
                "历史发片数",
            ],
        ),
        header("使用说明", &["项目", "说明"]),
    ];
    let mut dossier = vec![];
    for (i, d) in details.iter().enumerate() {
        let p = &d["profile"];
        let s = &d["settings"];
        let mut main = row(
            p,
            &[
                "id",
                "handle",
                "rank",
                "priority",
                "followers",
                "affiliate_gmv_usd",
                "pet_gmv_share_pct",
                "kalodata_window",
                "history",
            ],
        );
        main.push(d["stage"].clone());
        main.extend(row(s, &["fee", "commission", "owner", "next_followup"]));
        main.push(json!(d["gates"]
            .as_array()
            .map(|a| a.iter().map(text).collect::<Vec<_>>().join("；"))
            .unwrap_or_default()));
        main.extend(row(
            p,
            &["angle", "anchor1", "anchor2", "tiktok_url", "affiliate_url"],
        ));
        main.extend(row(s, &["email", "email_source", "notes"]));
        sheets[0].1.push(main);
        let mut markdown = format!(
            "# {}｜{}\n\n统计期：{}（历史资料）\n\n依据：{}；{}\n\n拟定方向：{}\n",
            text(&p["id"]),
            text(&p["handle"]),
            text(&p["kalodata_window"]),
            text(&p["anchor1"]),
            text(&p["anchor2"]),
            text(&p["angle"])
        );
        for dr in d["drafts"].as_array().into_iter().flatten() {
            let channel = label(dr["channel"].as_str().unwrap_or(""));
            let mut r = row(p, &["id", "handle"]);
            r.push(json!(channel));
            r.extend(row(dr, &["rendered_subject", "rendered", "revision"]));
            r.push(json!("草稿，未自动发送"));
            sheets[1].1.push(r);
            markdown.push_str(&format!(
                "\n## {channel}\n\n{}\n\n{}\n",
                text(&dr["rendered_subject"]),
                text(&dr["rendered"])
            ));
        }
        for pr in p["products"].as_array().into_iter().flatten() {
            let mut r = row(p, &["id", "handle"]);
            r.extend(row(
                pr,
                &["id", "title_original", "type", "estimated_sales"],
            ));
            r.push(p["kalodata_window"].clone());
            sheets[2].1.push(r);
        }
        for e in d["events"].as_array().into_iter().flatten() {
            let mut r = row(p, &["id", "handle"]);
            r.push(json!(label(e["channel"].as_str().unwrap_or(""))));
            r.extend(row(e, &["type", "at", "proof", "note", "void_reason"]));
            sheets[3].1.push(r);
        }
        let mut r = row(p, &["id", "handle", "history", "history_snapshot"]);
        r.extend(row(
            &p["history_detail"],
            &[
                "消息时间（洛杉矶）",
                "我方消息/邀请卡片数",
                "达人回复数",
                "收样数",
                "视频数",
            ],
        ));
        sheets[4].1.push(r);
        // 文件名由顺序和安全字符组成，资料不能注入路径。
        let name = text(&p["id"])
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .take(60)
            .collect::<String>();
        dossier.push((format!("逐人草稿/{:04}_{name}.md", i + 1), markdown));
    }
    let scope = format!(
        "{} 位达人；{} 条草稿；{} 条触达事件（含撤销记录）",
        details.len(),
        sheets[1].1.len() - 1,
        sheets[3].1.len() - 1
    );
    sheets[5].1.push(vec![json!("范围"), json!(scope)]);
    sheets[5].1.push(vec![json!("说明"), json!(NOTE)]);
    let workbook = xlsx(&sheets)?;
    if format == "xlsx" {
        return Ok(workbook);
    }
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    add(&mut zip, "达人触达工作簿.xlsx", &workbook)?;
    for (name, rows) in &sheets {
        let mut csv = String::from("\u{feff}");
        for r in rows {
            csv.push_str(
                &r.iter()
                    .map(|v| format!("\"{}\"", safe(v).replace('"', "\"\"")))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            csv.push_str("\r\n");
        }
        add(&mut zip, &format!("{name}.csv"), csv.as_bytes())?;
    }
    for (name, md) in dossier {
        add(&mut zip, &name, md.as_bytes())?;
    }
    add(&mut zip, "说明.txt", NOTE.as_bytes())?;
    finish(zip)
}
