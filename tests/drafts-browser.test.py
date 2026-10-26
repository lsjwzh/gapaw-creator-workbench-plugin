#!/usr/bin/env python3
"""草稿页浏览器验收：页面 → 真实 Rust 程序 → 工作台副本；宿主任务接口为本地替身。

需要：GAPAW_TEST_BINARY（插件二进制）与 GAPAW_OUTREACH_URL（隔离工作台副本，切勿指向生产服务）。
"""
import json
import os
import subprocess
import tempfile
import threading
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BINARY = os.environ["GAPAW_TEST_BINARY"]
OUTREACH = os.environ["GAPAW_OUTREACH_URL"]
SHOTS = Path(os.environ.get("GAPAW_SHOT_DIR", tempfile.mkdtemp()))
STATE = tempfile.mkdtemp(prefix="gapaw-drafts-browser-")
WORKSPACE = os.path.realpath(tempfile.mkdtemp(prefix=".gapaw-drafts-ws-", dir=os.path.expanduser("~")))
ENV = {k: v for k, v in os.environ.items() if not k.startswith("MULTICC_PLUGIN_")}
ENV["GAPAW_CREATOR_DATA_DIR"] = STATE
TASK = {"ok": True, "taskId": "tsk_browser", "sessionId": "s_browser", "shellId": "shell_browser", "url": "/air?task=tsk_browser&dir=fixture-dir"}


def plugin(command, payload):
    out = subprocess.run([BINARY, command], input=json.dumps(payload), capture_output=True, text=True, env=ENV, check=True)
    return json.loads(out.stdout)


def ok(command, payload):
    r = plugin(command, payload)
    assert r["ok"], r
    return r["data"]


class Host(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, value, status=200, ctype="application/json"):
        body = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/directories":
            return self.reply([{"id": "fixture-dir", "path": WORKSPACE}])
        if self.path == "/api/task-shells/shell_browser":
            return self.reply({"receipts": []})
        name = self.path.split("?")[0].removeprefix("/ui/")
        f = ROOT / "ui" / name
        if f.is_file():
            ctype = {"html": "text/html", "js": "text/javascript", "css": "text/css"}[f.suffix[1:]]
            return self.reply(f.read_bytes(), ctype=ctype + "; charset=utf-8")
        self.reply({"error": "not found"}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/plugins/gapaw-creator-workbench/run":
            r = plugin(body["command"], body.get("input", {}))
            return self.reply(r["data"] if r["ok"] else r, 200 if r["ok"] else 400)
        if self.path == "/api/air/tasks":
            return self.reply(TASK)
        if self.path == "/api/task-shell-tasks/tsk_browser/messages":
            return self.reply({"ok": True, "taskId": "tsk_browser", "receiptId": "rcpt_browser"})
        self.reply({"error": "unexpected"}, 404)


def workbench_draft(cid, channel):
    with urllib.request.urlopen(f"{OUTREACH}/api/creators/{cid}") as r:
        return next(d for d in json.load(r)["drafts"] if d["channel"] == channel)


def main():
    ok("configure", {"workspace": {"dirId": "fixture-dir", "path": WORKSPACE}})
    server = ThreadingHTTPServer(("127.0.0.1", 0), Host)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/ui/drafts.html"
    with urllib.request.urlopen(f"{OUTREACH}/api/creators") as r:
        picks = [c["id"] for c in json.load(r)["items"][:3]]
    with sync_playwright() as p:
        options = {"headless": True}
        chrome = os.environ.get("GAPAW_TEST_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        if Path(chrome).exists():
            options["executable_path"] = chrome
        browser = p.chromium.launch(**options)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base)
        page.fill("#outreach-url", OUTREACH)
        page.click("#outreach-save")
        page.wait_for_selector(".draft-creator")
        assert page.locator(".draft-creator").count() >= 3
        for cid in picks:
            page.locator(".draft-creator", has_text=cid).first.locator("input").check()
        page.select_option("#draft-cli", "claude")
        assert page.is_enabled("#draft-send")
        page.screenshot(path=str(SHOTS / "1-compose.png"), full_page=True)
        page.click("#draft-send")
        page.wait_for_selector("text=已交给 MultiCC")
        op = next(o for o in ok("list-operations", {})["operations"] if o.get("kind") == "drafts")
        assert op["status"] == "accepted"

        # 模拟任务交回第一版，然后用户补充条件后交回第二版。
        drafts = [{"creatorId": c, "channel": ch, "subject": f"Gapaw x {c}" if ch == "email" else "", "body": f"[browser fixture] {c} {ch} 【固定费】", "note": "浏览器验收"} for c in picks for ch in ("email", "dm")]
        ok("submit-drafts", {"operationId": op["id"], "taskId": "tsk_browser", "submissionId": "b1", "drafts": drafts})
        ok("submit-drafts", {"operationId": op["id"], "taskId": "tsk_browser", "submissionId": "b2", "drafts": [{"creatorId": picks[0], "channel": "email", "subject": f"Gapaw x {picks[0]} v2", "body": f"[browser fixture v2] {picks[0]} 先寄样，再谈【固定费】", "note": "按补充条件改写"}]})
        # 人工在工作台修改第二位达人的邮件。
        d = workbench_draft(picks[1], "email")
        req = urllib.request.Request(f"{OUTREACH}/api/creators/{picks[1]}/drafts/email", data=json.dumps({"subject": "人工主题", "body": "人工修改 【固定费】", "revision": d["revision"]}).encode(), headers={"X-Outreach-Request": "1", "Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req).read()

        page.reload()  # 刷新后仍能找回原任务
        page.wait_for_selector(".draft-group")
        page.wait_for_selector("text=已连接现有达人工作台", timeout=8000)
        assert page.locator("text=打开原任务补充条件").count() == 1
        g1 = page.locator(".draft-group", has_text=f"{picks[0]} ").filter(has_text="邮件").first
        assert g1.locator("text=第 2 版").count() == 1 and g1.locator("text=第 1 版").count() == 1
        g2 = page.locator(".draft-group", has_text=f"{picks[1]} ").filter(has_text="邮件").first
        if not g2.evaluate("e => e.open"):
            g2.locator("summary").click()
        assert g2.locator("text=工作台文案已在发起后修改").count() == 1
        page.screenshot(path=str(SHOTS / "2-versions.png"), full_page=True)

        before = workbench_draft(picks[0], "email")
        g1.locator(".draft-version", has_text="第 2 版").locator("button", has_text="采用此版本").click()
        page.wait_for_selector("text=已写入工作台并读回一致")
        after = workbench_draft(picks[0], "email")
        assert after["revision"] == before["revision"] + 1 and "v2" in after["subject"]
        # 有人工修改的达人：取消确认则不写入。
        page.once("dialog", lambda dlg: dlg.dismiss())
        g2 = page.locator(".draft-group", has_text=f"{picks[1]} ").filter(has_text="邮件").first
        if not g2.evaluate("e => e.open"):
            g2.locator("summary").click()
        g2.locator("button", has_text="替换已修改的文案").click()
        page.wait_for_timeout(500)
        assert workbench_draft(picks[1], "email")["body"] == "人工修改 【固定费】"
        page.wait_for_selector(".draft-version >> text=已采用")
        g1 = page.locator(".draft-group", has_text=f"{picks[0]} ").filter(has_text="邮件").first
        assert g1.locator("text=工作台文案已在发起后修改").count() == 0
        assert g1.locator("text=当前文案来自本任务已采用的版本").count() == 1
        page.screenshot(path=str(SHOTS / "3-adopted.png"), full_page=True)
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(300)
        page.locator(".draft-group").first.scroll_into_view_if_needed()
        assert page.evaluate("document.documentElement.scrollWidth") <= 390, "手机宽度出现横向滚动"
        page.screenshot(path=str(SHOTS / "4-mobile.png"))
        assert not errors, errors
        browser.close()
    server.shutdown()
    print("drafts browser ok", SHOTS)


if __name__ == "__main__":
    main()
