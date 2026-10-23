#!/usr/bin/env python3
"""隔离浏览器验收：全部请求拦截，不访问真实宿主或平台。"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = {"dirId": "fixture-dir", "path": "/fixture/persistent", "source": "plugin", "valid": True}
state = {"plugin": {"id": "gapaw-creator-workbench", "version": "0.1.0"}, "workspace": None,
         "template": {"text": "请按确认成本和未舍入回本率选人。"}, "operations": []}
calls = []


def respond(route):
    request = route.request
    url = request.url.split("https://plugin.test", 1)[-1]
    body = request.post_data_json if request.method == "POST" else {}
    calls.append((request.method, url))
    if url.startswith("/plugins/gapaw-creator-workbench/ui/"):
        name = url.rsplit("/", 1)[-1]
        types = {"index.html": "text/html; charset=utf-8", "app.js": "application/javascript", "style.css": "text/css"}
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
        elif command == "configure":
            state["workspace"] = WORKSPACE
            value = {"workspace": WORKSPACE}
        elif command == "prepare-operation":
            operation = {"id": "op_fixture", "requestId": payload["requestId"], "status": "prepared",
                         "task": None, "receipt": None, "error": None, "workspace": WORKSPACE,
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
        page.goto("https://plugin.test/plugins/gapaw-creator-workbench/ui/index.html")
        page.get_by_text("请先选择专属工作目录。", exact=True).wait_for()
        assert page.locator("#send").is_disabled()
        assert not any(method == "POST" and url == "/api/air/tasks" for method, url in calls)
        page.locator("#directory").select_option("fixture-dir")
        page.locator("#save-workspace").click()
        page.get_by_text("配置已读取，可以编辑提示词并发起任务。", exact=True).wait_for()
        page.locator("#cli").select_option("codex-exp")
        page.locator("#prompt").fill("按回本率筛选候选，不发送私信。")
        page.locator("#send").click()
        page.get_by_text("任务已投递。请进入原任务查看执行进度。", exact=True).wait_for()
        assert page.get_by_role("link", name="进入原任务继续 ↗").get_attribute("href") == "/air?task=tsk_fixture&dir=fixture-dir"
        assert len([1 for method, url in calls if url == "/api/air/tasks"]) == 1
        page.reload()
        page.get_by_text("已投递", exact=True).wait_for()
        assert len([1 for method, url in calls if url == "/api/air/tasks"]) == 1
        page.set_viewport_size({"width": 390, "height": 844})
        page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        page.screenshot(path="/tmp/gapaw-plugin-mobile-test.png")
        page.locator("#operations").scroll_into_view_if_needed()
        page.screenshot(path="/tmp/gapaw-plugin-mobile-history-test.png")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "手机页面存在横向溢出"
        assert errors == [], errors
        print("浏览器验收通过：初始化、真实页面派发流程、刷新恢复、390px布局、无脚本错误；仅使用隔离接口。")
    finally:
        browser.close()
