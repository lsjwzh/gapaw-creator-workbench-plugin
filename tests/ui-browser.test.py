#!/usr/bin/env python3
"""隔离浏览器验收：全部请求拦截，不访问真实宿主或平台。"""
import json
import os
from copy import deepcopy
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = {"dirId": "fixture-dir", "path": "/fixture/persistent", "source": "plugin", "valid": True}
state = {"plugin": {"id": "gapaw-creator-workbench", "version": "0.3.0"}, "workspace": None,
         "template": {"text": "请按确认成本和未舍入回本率选人。"}, "operations": []}
calls = []
results = []
result_submissions = []
result_validations = []
validation_mode = "normal"
observations = []
adoptions = []
adoption_mode = "unknown"
workbench_ready = False
browser_commands = []
browser_source_available = True
bridge_mode = "normal"
page_text = '<script>window.bridgeXss = true</script>\n外部页面资料：单条视频成交和费用需要核验。'
browser_binding = {"revision": 0, "profile": None, "configuredAt": None}
environments = [{"id": ident, "name": name, "sourceRevision": {"profileCreatedAt": 100,
    "profileUpdatedAt": 200, "subscription": None, "confidence": "metadata_only"},
    "processState": "pid_alive" if ident == "alpha" else "not_running"}
    for ident, name in [("alpha", "选人专用身份"), ("beta", "备用身份")]]


def browser_status(payload):
    binding = browser_binding
    if payload.get("operationId"):
        binding = next(o for o in state["operations"] if o["id"] == payload["operationId"])["browser"]
    return {"source": {"installed": True, "version": "1.5.0", "supported": True,
        "available": browser_source_available, "message": "测试来源，只读检测"},
        "environments": environments if browser_source_available else [], "binding": deepcopy(binding),
        "bindingState": ("bound" if binding["profile"] else "unbound") if browser_source_available else "unavailable",
        "checkedAt": "2026-10-25T01:00:00Z", "scope": "operation" if payload.get("operationId") else "default",
        "checks": [{"id": "egress", "label": "网络出口", "status": "not_checked", "message": "未实测出口"},
                   {"id": "bridge", "label": "只读桥接", "status": "available", "message": "只读桥接已发现，连接仍需检测"}],
        "fieldRequirements": [{"id": "sales", "label": "逐视频成交", "source": "TikTok Affiliate / Kalodata", "status": "not_checked"}],
        "canDispatchTask": True, "canCollectPlatforms": False}


def result_input(result_id="result_fixture", expected=0):
    candidate = {"platform": "tiktok", "creatorId": "fixture", "handle": "隔离候选（非真实达人）",
                 "profileUrl": "https://example.invalid/creator", "reason": "仅用于浏览器验收",
                 "sources": [{"url": "https://example.invalid/source", "capturedAt": "2026-10-02T00:00:00Z", "note": "测试来源"}],
                 "missingFields": [], "videos": []}
    for n in range(328):
        candidate["videos"].append({"videoId": f"video_{n}", "url": f"https://example.invalid/video/{n}",
                                    "publishedAt": "2026-10-01T00:00:00Z", "contributionRate": "0.5",
                                    "sales": [{"kind": "total", "gmv": "2" if n == 0 else "0", "commissionRate": "0"}],
                                    "adSpend": "0", "fixedFee": "0", "sampleCost": "0"})
    return {"operationId": "op_fixture", "taskId": "tsk_fixture", "resultId": result_id, "expectedRevision": expected,
            "report": {"schemaVersion": 1, "methodVersion": "roi-selection-v1", "generatedAt": "2026-10-02T00:00:00Z",
                       "period": {"start": "2026-10-01", "end": "2026-10-01", "timeZone": "UTC"},
                       "currency": "USD", "coverage": "隔离浏览器测试，不是真实平台采集", "missingFields": [], "candidates": [candidate]}}


def result_summary(record):
    return {"resultId": record["resultId"], "revision": record["revision"], "savedAt": record["savedAt"],
            "candidateCount": 1, "incompleteCount": 0, "adoptionStatus": "pending"}


def validation_summary(payload):
    missing = []
    for candidate in payload["report"]["candidates"]:
        for video in candidate["videos"]:
            fields = [field for field in ("contributionRate", "adSpend", "fixedFee", "sampleCost") if video.get(field) is None]
            if fields:
                missing.append({"creatorKey": candidate["platform"] + ":" + candidate["creatorId"], "videoId": video["videoId"], "fields": fields})
    return {"candidateCount": 1, "totalVideos": 328, "completeCandidates": 0 if missing else 1,
            "incompleteCandidates": 1 if missing else 0, "knownPositiveVideos": 0 if missing else 1,
            "checks": [{"id": "costs", "label": "数值与费用完整性", "status": "unknown" if missing else "passed", "message": "未知费用保持未知，不能补零。" if missing else "报告数值可计算，选人结论仍需核验。"}],
            "missingFields": missing, "sourceReview": {"status": "unverified", "message": "<img src=x onerror=alert(1)> 来源与样本覆盖尚未实际核验。"}}


def respond(route):
    global browser_binding
    request = route.request
    url = request.url.split("https://plugin.test", 1)[-1]
    body = request.post_data_json if request.method == "POST" else {}
    calls.append((request.method, url))
    if url.startswith("/plugins/gapaw-creator-workbench/ui/"):
        name = url.rsplit("/", 1)[-1]
        types = {"selection.html": "text/html; charset=utf-8", "app.js": "application/javascript", "data-workflow.js": "application/javascript", "candidates.js": "application/javascript", "candidates.html": "text/html; charset=utf-8", "connection-help.html": "text/html; charset=utf-8", "style.css": "text/css"}
        route.fulfill(status=200, body=(ROOT / "ui" / name).read_text(), content_type=types[name])
        return
    if url == "/api/directories":
        value = [{"id": WORKSPACE["dirId"], "path": WORKSPACE["path"], "name": "隔离测试目录"}]
    elif url == "/api/plugins":
        value = {"plugins": [{"id": "chrome-proxy-launcher", "uiUrl": "/plugins/chrome-proxy-launcher/ui/index.html"}]}
    elif url.endswith("/run"):
        command, payload = body["command"], body.get("input", {})
        if command == "status":
            value = state
        elif command == "browser-status":
            browser_commands.append((command, payload))
            value = browser_status(payload)
        elif command == "bind-browser":
            browser_commands.append((command, payload))
            assert payload["expectedRevision"] == browser_binding["revision"]
            selected = next((e for e in environments if e["id"] == payload["profileId"]), None)
            if selected:
                assert payload["expectedSourceRevision"] == selected["sourceRevision"]
            browser_binding = {"revision": browser_binding["revision"] + 1,
                "profile": {k: deepcopy(selected[k]) for k in ("id", "name", "sourceRevision")} if selected else None,
                "configuredAt": "2026-10-25T01:00:00Z"}
            value = {"binding": deepcopy(browser_binding)}
        elif command in ("browser-probe", "browser-pages", "browser-read-page"):
            browser_commands.append((command, payload))
            binding = browser_binding
            selected = None
            if payload.get("operationId"):
                selected = next(o for o in state["operations"] if o["id"] == payload["operationId"])
                assert payload["taskId"] == selected["task"]["taskId"]
                binding = selected["browser"]
            value = {"scope": "operation" if selected else "default", "bindingRevision": binding["revision"],
                "profileId": binding["profile"]["id"], "instanceId": "instance-fixture", "checkedAt": "2026-10-25T04:00:00Z"}
            if selected:
                value.update(operationId=selected["id"], taskId=selected["task"]["taskId"])
            platform_page = {"targetId": "fixture-target", "title": "<img src=x onerror=alert(1)>",
                "url": "https://affiliate.tiktok.com/connection/creator", "platform": "affiliate"}
            if command == "browser-probe":
                assert payload == {}
                value.update(status="connected", message="连接已核对")
            elif command == "browser-pages":
                value["pages"] = [platform_page]
                if bridge_mode == "wrong_task":
                    value["taskId"] = "tsk_other"
                if bridge_mode == "unsafe_url":
                    value["pages"][0]["url"] = "https://affiliate.tiktok.com/?token=DO_NOT_DISPLAY"
            else:
                assert payload["expectedInstanceId"] == "instance-fixture"
                assert payload["targetId"] == "fixture-target"
                value["page"] = {**platform_page, "text": page_text, "truncated": True}
                if bridge_mode == "restarted":
                    value["instanceId"] = "instance-restarted"
            if bridge_mode == "error":
                value = {"ok": False, "error": "读取连接已断开，请重新读取平台页面列表。"}
        elif command == "configure":
            state["workspace"] = WORKSPACE
            value = {"workspace": WORKSPACE}
        elif command == "prepare-operation":
            operation = {"id": "op_fixture", "requestId": payload["requestId"], "status": "prepared",
                         "task": None, "receipt": None, "error": None, "workspace": WORKSPACE,
                         "browser": deepcopy(browser_binding),
                         "prompt": payload["prompt"], "runtime": payload["runtime"], "createdAt": "2026-10-23T00:00:00Z",
                         "dispatch": {"create": {"dirId": "fixture-dir", "title": "隔离测试选人任务", "clientMsgId": "op_fixture_create"},
                                      "message": {"clientMsgId": "op_fixture_message", "text": payload["prompt"], "intent": "work", "lang": "zh"}}}
            state["operations"] = [operation]
            value = {"operation": operation}
        elif command == "record-dispatch":
            operation = state["operations"][0]
            if payload["stage"] == "created":
                operation.update(task=payload["response"], status="task_created")
            else:
                operation.update(receipt=payload["response"], status="accepted")
            value = {"operation": operation}
        elif command == "platform-contract":
            assert payload == {"operationId": "op_fixture", "taskId": "tsk_fixture"}
            value = {**payload, "contractVersion": "platform-fields-v1", "canCollectPlatforms": False,
                "sources": [{"id": "affiliate", "label": "TikTok Affiliate", "purpose": "核验同期逐视频成交与佣金。",
                    "requirements": [{"id": "gmv", "label": "逐视频成交额", "scope": "video", "requiredForRoi": True, "note": "保持零成交与未知值的区别。"}], "limitations": ["字段可读性尚未实测。"]},
                    {"id": "kalodata", "label": "Kalodata", "purpose": "补充达人和内容证据。", "requirements": [{"id": "coverage", "label": "样本覆盖", "scope": "period", "requiredForRoi": True, "note": "平台估计值需标记来源。"}], "limitations": ["不能把估计值当成确认成本。"]},
                    {"id": "confirmed_inputs", "label": "用户确认成本", "purpose": "确认固定合作费与寄样分摊。", "requirements": [{"id": "fixedFee", "label": "固定合作费", "scope": "video", "requiredForRoi": True, "note": "未知费用保持未知。"}], "limitations": []}],
                "notes": ["需要按统计区间核验完整视频清单。"]}
        elif command == "validate-result":
            result_validations.append(payload["resultId"])
            replay = any(r["resultId"] == payload["resultId"] for r in results)
            value = {key: payload[key] for key in ("operationId", "taskId", "resultId", "expectedRevision")}
            value.update(currentRevision=len(results), canSubmit=True, replay=replay, validation=validation_summary(payload),
                computed={"candidates": []}, canCollectPlatforms=False, adoptionStatus="pending")
            if validation_mode == "wrong_task":
                value["taskId"] = "tsk_other"
        elif command == "workbench-status":
            value = {"configured": workbench_ready, "available": workbench_ready, "ready": workbench_ready, "businessStoreId": "store-fixture", "message": "合成工作台"}
        elif command in ("preview-observation", "submit-observation"):
            payload = json.loads(payload["rawJson"])
            snapshot = {**payload, "schemaVersion": 1, "source": {"provider": "affiliate", "mode": "imported_response", "verified": False},
                "inputHash": "hash-" + payload["observationId"], "items": [{"kind": "creator", "sourceIdentity": {"namespace": "affiliate_oec", "sourceId": "9007199254740993"},
                "creatorIdentity": None, "fields": {"videoGmv": {"sourcePath": "creator_profile_list[0].video_gmv", "rawDisplay": "$1.2K", "decimalValue": None, "unit": "source_currency", "scope": "creator_aggregate_unknown_period", "estimated": "unknown", "verification": "unverified"},
                "nickname": {"sourcePath": "creator_profile_list[0].nickname", "rawDisplay": "<img src=x onerror=alert(1)>", "decimalValue": None, "unit": "text", "scope": "creator_identity", "estimated": "unknown", "verification": "unverified"}}}],
                "coverage": {"status": "partial", "complete": False, "itemCount": 1}, "warnings": ["导入平台响应，未核验来源"]}
            replay = any(item["observationId"] == payload["observationId"] for item in observations)
            if command == "submit-observation" and not replay:
                observations.append(snapshot)
            value = {"snapshot": snapshot, "replay": replay, "canCollectPlatforms": False}
        elif command == "get-observations":
            value = {"operationId": payload["operationId"], "taskId": payload["taskId"], "snapshots": observations}
        elif command == "prepare-adoption":
            assert payload["resultId"] == results[-1]["resultId"]
            plan = {**payload, "resultRevision": results[-1]["revision"], "payloadHash": "payload-fixture", "businessStoreId": "store-fixture", "status": "prepared", "receipt": None}
            preview = {"businessStoreId": "store-fixture", "payloadHash": "payload-fixture", "candidateCount": 1, "canAdopt": True, "verification": "unverified", "warnings": ["来源和身份待核验"], "handleConflicts": []}
            plan["preview"] = preview
            adoptions.append(plan)
            value = {"plan": plan, "preview": preview}
        elif command == "adopt-result":
            plan = next(item for item in adoptions if item["adoptionId"] == payload["adoptionId"])
            assert payload["expectedPayloadHash"] == plan["payloadHash"]
            plan.update(status="submission_unknown")
            value = {"ok": False, "error": "写入结果未知"} if adoption_mode == "unknown" else {"plan": plan}
        elif command == "reconcile-adoption":
            plan = next(item for item in adoptions if item["adoptionId"] == payload["adoptionId"])
            plan.update(status="verified", receipt={"status": "candidate_pending_verification"})
            value = {"plan": plan}
        elif command == "get-adoption":
            value = {"plans": adoptions}
        elif command in ("workbench-list", "workbench-batch"):
            batch = {"batchId": "batch-fixture", "businessStoreId": "store-fixture", "adoptionId": "adoption-fixture", "payloadHash": "payload-fixture", "operationId": "op_fixture", "taskId": "tsk_fixture", "resultId": results[-1]["resultId"], "resultRevision": results[-1]["revision"], "candidateCount": 1, "status": "candidate_pending_verification", "createdAt": "2026-10-26T01:00:00Z"}
            if command == "workbench-list":
                value = {"items": [batch], "total": 1, "offset": 0, "limit": 20, "nextOffset": None}
            else:
                value = {"batch": batch, "candidates": [{"candidateId": "candidate-fixture", "batchId": batch["batchId"], "reportedIdentity": {"platform": "tiktok", "creatorId": "fixture", "handle": "<img src=x onerror=alert(1)>", "profileUrl": "javascript:alert(1)"}, "reason": "<script>window.candidateXss=true</script>", "computed": {}, "missingFields": ["费用来源"], "sources": [], "verification": "unverified", "status": "candidate_pending_verification"}], "total": 1, "offset": 0, "limit": 20, "nextOffset": None}
        elif command == "submit-result":
            result_submissions.append(payload["resultId"])
            record = next((r for r in results if r["resultId"] == payload["resultId"]), None)
            if record is None:
                assert payload["expectedRevision"] == len(results)
                record = {"operationId": payload["operationId"], "taskId": payload["taskId"], "resultId": payload["resultId"],
                          "revision": len(results) + 1, "savedAt": "2026-10-25T00:00:00Z", "adoptionStatus": "pending",
                          "report": payload["report"], "validation": validation_summary(payload), "computed": {"candidates": [{"creatorKey": "tiktok:fixture",
                          "summary": {"status": "complete", "totalVideos": 328, "evaluatedVideos": 328,
                                      "knownPositiveVideos": 1, "breakEvenCount": 1,
                                      "breakEvenRate": "0.0030487804878048780487804878", "averageSurplus": "0.0030487804878048780487804878"},
                          "videos": [{"videoId": f"video_{n}", "surplus": "1" if n == 0 else "0", "missingFields": []} for n in range(328)]}]}}
                results.append(record)
            state["operations"][0]["resultSummary"] = result_summary(results[-1])
            value = {"record": record, "resultSummary": result_summary(record)}
        elif command == "get-result":
            record = next((r for r in results if r["resultId"] == payload.get("resultId")), None) if payload.get("resultId") else (results[-1] if results else None)
            value = {"record": record, "history": [result_summary(r) for r in reversed(results)]}
        else:
            raise AssertionError("意外命令：" + command)
    elif url == "/api/air/tasks":
        value = {"ok": True, "taskId": "tsk_fixture", "sessionId": "fixture-session", "shellId": "fixture-shell",
                 "url": "/air?task=tsk_fixture&dir=fixture-dir"}
    elif url == "/api/task-shells/fixture-shell":
        value = {"receipts": []}
    elif url == "/api/task-shell-tasks/tsk_fixture/messages":
        value = {"ok": True, "taskId": "tsk_fixture", "receiptId": "fixture-receipt", "decision": "continue"}
    else:
        raise AssertionError("未允许的网络请求：" + url)
    route.fulfill(status=200, body=json.dumps(value), content_type="application/json")


with sync_playwright() as p:
    options = {"headless": True}
    executable = os.environ.get("GAPAW_TEST_CHROME")
    if executable:
        options["executable_path"] = executable
    elif Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").exists():
        options["executable_path"] = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    browser = p.chromium.launch(**options)
    try:
        page = browser.new_page(viewport={"width": 1365, "height": 1000})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/*", respond)
        page.goto("https://plugin.test/plugins/gapaw-creator-workbench/ui/selection.html")
        page.get_by_text("请先选择专属工作目录。", exact=True).wait_for()
        assert page.locator("#send").is_disabled()
        assert not any(method == "POST" and url == "/api/air/tasks" for method, url in calls)
        page.locator("#directory").select_option("fixture-dir")
        page.locator("#save-workspace").click()
        page.get_by_text("配置已读取，可以编辑提示词并发起任务。", exact=True).wait_for()
        page.locator("#browser-profile").select_option("alpha")
        page.locator("#save-browser").click()
        page.get_by_text("专用浏览器绑定已保存并读回。新任务使用此身份，历史任务不变。", exact=True).wait_for()
        assert not any(command in ("browser-probe", "browser-pages", "browser-read-page") for command, _ in browser_commands)
        page.locator("#probe-browser").click()
        page.get_by_text("只读连接已核对：", exact=False).wait_for()
        assert not any(command in ("browser-pages", "browser-read-page") for command, _ in browser_commands)
        page.locator("#cli").select_option("codex-exp")
        page.locator("#prompt").fill("按回本率筛选候选，不发送私信。")
        page.locator("#send").click()
        page.get_by_text("任务已投递。请进入原任务查看执行进度。", exact=True).wait_for()
        assert page.get_by_role("link", name="进入原任务继续 ↗").get_attribute("href") == "/air?task=tsk_fixture&dir=fixture-dir"
        assert len([1 for method, url in calls if url == "/api/air/tasks"]) == 1
        assert state["operations"][0]["browser"]["profile"]["id"] == "alpha"
        page.get_by_role("button", name="读取平台页面列表", exact=True).click()
        page.get_by_text("页面列表读取时间：", exact=False).wait_for()
        assert browser_commands[-1] == ("browser-pages", {"operationId": "op_fixture", "taskId": "tsk_fixture"})
        page.get_by_role("button", name="读取页面文字", exact=True).click()
        page.locator(".page-text").get_by_text("外部页面资料：", exact=False).wait_for()
        assert browser_commands[-1] == ("browser-read-page", {"operationId": "op_fixture", "taskId": "tsk_fixture", "targetId": "fixture-target", "expectedInstanceId": "instance-fixture"})
        assert page.locator(".page-snapshot").get_by_text("已截断，资料不完整", exact=False).is_visible()
        assert page.evaluate("window.bridgeXss === undefined")
        assert page.locator(".page-reader img, .page-reader script").count() == 0
        assert result_submissions == []
        bridge_mode = "restarted"
        page.get_by_role("button", name="读取页面文字", exact=True).click()
        page.get_by_text("浏览器实例已变化", exact=False).wait_for()
        assert page.get_by_role("button", name="读取页面文字", exact=True).is_disabled()
        assert page.get_by_text("已过期的页面文字（上次读取）", exact=True).is_visible()
        bridge_mode = "wrong_task"
        page.get_by_role("button", name="读取平台页面列表", exact=True).click()
        page.get_by_text("页面资料不属于当前任务", exact=False).wait_for()
        bridge_mode = "unsafe_url"
        page.get_by_role("button", name="读取平台页面列表", exact=True).click()
        page.get_by_text("页面地址或来源不符合允许的平台范围", exact=False).wait_for()
        assert "DO_NOT_DISPLAY" not in page.locator("body").inner_text()
        bridge_mode = "normal"
        page.get_by_role("button", name="读取平台页面列表", exact=True).click()
        page.get_by_role("button", name="读取页面文字", exact=True).click()
        page.get_by_text("页面文字（待核验）", exact=True).wait_for()
        page.locator("#browser-profile").select_option("beta")
        page.locator("#save-browser").click()
        page.get_by_text("专用浏览器绑定已保存并读回。新任务使用此身份，历史任务不变。", exact=True).wait_for()
        assert browser_binding["profile"]["id"] == "beta"
        page.get_by_role("button", name="检查本次环境", exact=True).click()
        page.locator(".operation-browser").get_by_text("当前绑定：选人专用身份（alpha）", exact=True).wait_for()
        assert browser_commands[-1] == ("browser-status", {"operationId": "op_fixture"})
        assert state["operations"][0]["browser"]["profile"]["id"] == "alpha"
        page.get_by_text("尚无结果报告。任务已投递不代表结果已完成。", exact=True).wait_for()
        page.get_by_role("button", name="查看读取要求", exact=True).click()
        page.get_by_text("平台读取要求（字段可读性尚未实测）", exact=True).wait_for()
        assert page.locator(".platform-requirements").get_by_text("用户确认成本", exact=True).is_visible()
        def upload(payload):
            page.locator('.result-section input[type="file"]').set_input_files({"name": "result.json", "mimeType": "application/json", "buffer": json.dumps(payload).encode()})
        incomplete = result_input("incomplete"); incomplete["report"]["candidates"][0]["videos"][0]["fixedFee"] = None
        upload(incomplete)
        page.locator(".result-preflight").get_by_text("数值完整 0 位 · 资料未齐 1 位", exact=False).wait_for()
        assert page.get_by_role("button", name="保存报告", exact=True).is_enabled()
        assert result_submissions == []
        assert page.locator(".result-preflight img, .result-preflight script").count() == 0
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator(".result-preflight").scroll_into_view_if_needed()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "预检面板导致手机横向溢出"
        page.screenshot(path="/tmp/gapaw-plugin-mobile-preflight-test.png")
        page.set_viewport_size({"width": 1365, "height": 1000})
        upload(result_input())
        page.locator(".result-preflight").get_by_text("数值完整 1 位 · 资料未齐 0 位", exact=False).wait_for()
        assert result_submissions == []
        page.get_by_role("button", name="保存报告", exact=True).click()
        page.get_by_text("扣广回本率：0.3049%", exact=True).wait_for()
        assert page.get_by_text("回本命中 / 样本：1 / 328", exact=True).is_visible()
        validation_mode = "wrong_task"
        upload(result_input("bad_receipt", 1))
        page.locator(".result-preflight").get_by_text("预检回执不属于本次文件", exact=False).wait_for()
        assert page.get_by_role("button", name="保存报告", exact=True).is_disabled()
        assert "bad_receipt" not in result_submissions
        validation_mode = "normal"
        upload(result_input("result_second", 1))
        page.get_by_role("button", name="保存报告", exact=True).click()
        page.get_by_text("第 2 版 · 已保存报告，待采纳", exact=True).wait_for()
        page.get_by_role("button", name="第 1 版", exact=True).click()
        page.get_by_text("第 1 版 · 已保存报告，待采纳", exact=True).wait_for()
        upload(result_input())
        page.get_by_text("此文件对应已有结果。保存将确认原版本，不新建或覆盖版本。", exact=True).wait_for()
        page.get_by_role("button", name="保存报告", exact=True).click()
        page.get_by_text("第 2 版 · 已保存报告，待采纳", exact=True).wait_for()
        wrong = result_input("wrong", 2); wrong["taskId"] = "tsk_other"
        upload(wrong)
        page.locator(".result-preflight").get_by_text("结果文件不属于当前任务，已停止导入。", exact=False).wait_for()
        assert "wrong" not in result_submissions
        assert len(results) == 2
        page.get_by_role("button", name="预览工作台待核验候选", exact=True).click()
        page.get_by_text("工作台候选区尚未连接。", exact=False).wait_for()
        assert adoptions == []
        assert page.get_by_role("link", name="查看连接使用说明 ↗", exact=True).get_attribute("href") == "./connection-help.html"
        help_page = browser.new_page(viewport={"width": 390, "height": 844})
        help_page.route("**/*", respond)
        help_response = help_page.goto("https://plugin.test/plugins/gapaw-creator-workbench/ui/connection-help.html")
        assert help_response.status == 200
        help_page.get_by_role("heading", name="工作台候选区连接说明", exact=True).wait_for()
        help_page.get_by_role("heading", name="结果未知时如何恢复", exact=True).wait_for()
        assert help_page.locator("input, textarea, form, script").count() == 0
        assert help_page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
        help_page.close()
        workbench_ready = True
        observation_input = {"operationId": "op_fixture", "taskId": "tsk_fixture", "observationId": "obs_fixture", "adapter": "affiliate", "capturedAt": "2026-10-26T00:00:00Z", "context": {"country": "US", "currency": None, "period": None}, "response": {"code": 0}}
        page.locator('.data-workflow input[type="file"]').set_input_files({"name": "platform.json", "mimeType": "application/json", "buffer": json.dumps(observation_input).encode()})
        page.get_by_role("button", name="保存来源观测", exact=True).wait_for()
        assert observations == []
        page.locator(".observation-snapshot summary").click()
        page.locator(".observation-snapshot").get_by_text("标准数值：未知", exact=False).first.wait_for()
        assert page.locator(".data-workflow img").count() == 0
        page.get_by_role("button", name="保存来源观测", exact=True).click()
        page.get_by_role("button", name="已收到观测保存回执", exact=True).wait_for()
        assert len(observations) == 1
        page.get_by_role("button", name="预览工作台待核验候选", exact=True).click()
        page.get_by_role("button", name="保存为工作台待核验候选", exact=True).wait_for()
        assert adoptions[-1]["status"] == "prepared"
        assert adoptions[-1]["observationIds"] == ["obs_fixture"]
        page.get_by_role("button", name="保存为工作台待核验候选", exact=True).click()
        page.get_by_text("保存结果未知，待核对原回执", exact=False).wait_for()
        page.reload()
        page.get_by_text("已投递", exact=True).wait_for()
        page.get_by_role("button", name="查看工作台保存记录", exact=True).click()
        page.get_by_role("button", name="保存为工作台待核验候选", exact=True).wait_for()
        page.get_by_text("保存结果未知，待核对原回执", exact=False).wait_for()
        page.get_by_role("button", name="核对原回执", exact=True).click()
        page.get_by_text("已写入工作台待核验候选（未正式入选）", exact=False).wait_for()
        page.reload()
        page.get_by_text("已投递", exact=True).wait_for()
        assert len([1 for method, url in calls if url == "/api/air/tasks"]) == 1
        assert len(result_submissions) == 3
        page.get_by_role("button", name="刷新已保存观测", exact=True).click()
        page.get_by_text("已保存来源观测（1，最多附带 100 份）", exact=True).wait_for()
        page.get_by_role("button", name="查看工作台保存记录", exact=True).click()
        page.get_by_text("已写入工作台待核验候选（未正式入选）", exact=False).wait_for()
        candidate_page = browser.new_page(viewport={"width": 390, "height": 844})
        candidate_page.route("**/*", respond)
        candidate_page.goto("https://plugin.test/plugins/gapaw-creator-workbench/ui/candidates.html")
        candidate_page.get_by_role("button", name="查看此批次", exact=True).click()
        candidate_page.get_by_text("<img src=x onerror=alert(1)>", exact=True).wait_for()
        assert candidate_page.locator("#candidate-detail img, #candidate-detail script").count() == 0
        assert candidate_page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
        candidate_page.screenshot(path="/tmp/gapaw-candidates-mobile-test.png")
        candidate_page.close()
        before_refresh = len([1 for command, _ in browser_commands if command in ("browser-pages", "browser-read-page")])
        page.locator("#refresh-connections").click()
        page.locator("#probe-browser").click()
        page.get_by_text("只读连接已核对：", exact=False).wait_for()
        assert len([1 for command, _ in browser_commands if command in ("browser-pages", "browser-read-page")]) == before_refresh
        page.get_by_role("button", name="读取平台页面列表", exact=True).click()
        page.get_by_role("button", name="读取页面文字", exact=True).click()
        page.get_by_text("页面文字（待核验）", exact=True).wait_for()
        page.get_by_role("button", name="查看结果", exact=True).click()
        page.get_by_text("第 2 版 · 已保存报告，待采纳", exact=True).wait_for()
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator(".page-text").scroll_into_view_if_needed()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "页面文字导致手机横向溢出"
        page.screenshot(path="/tmp/gapaw-plugin-mobile-page-reader-test.png")
        page.locator("#browser-profile").scroll_into_view_if_needed()
        page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        page.screenshot(path="/tmp/gapaw-plugin-mobile-test.png")
        page.locator("#operations").scroll_into_view_if_needed()
        page.locator(".report-candidate").scroll_into_view_if_needed()
        page.screenshot(path="/tmp/gapaw-plugin-mobile-history-test.png")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "手机页面存在横向溢出"
        page.locator("#unbind-browser").click()
        page.get_by_text("默认浏览器绑定已解除，历史任务仍保留原绑定。", exact=True).wait_for()
        assert state["operations"][0]["browser"]["profile"]["id"] == "alpha"
        browser_source_available = False
        page.locator("#refresh-connections").click()
        page.get_by_text("来源不可读取", exact=True).wait_for()
        assert page.locator("#browser-profile").is_disabled()
        assert page.locator("#send").is_enabled(), "来源不可读不应阻止发任务补资料"
        page.locator("#prompt").fill("平台暂不可读取，先整理已提供资料。")
        page.locator("#send").click()
        page.get_by_text("任务已投递。请进入原任务查看执行进度。", exact=True).wait_for()
        assert len([1 for method, url in calls if url == "/api/air/tasks"]) == 2
        assert state["operations"][0]["browser"]["profile"] is None
        assert errors == [], errors
        print("浏览器验收通过：初始化、身份绑定与读回、旧任务身份冻结、手动只读页面、读取要求、保存前预检与缺项、显式保存、错归属预检拒绝、幂等重放、纯文本摘要、报告与历史恢复、来源观测显式保存、待核验候选预览与未知回执恢复、同库候选页及390px布局；仅使用隔离接口。")
    finally:
        browser.close()
