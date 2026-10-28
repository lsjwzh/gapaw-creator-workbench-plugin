#!/usr/bin/env python3
"""工作台首页浏览器验收：页面 → 真实 Rust 程序 → 工作台副本；宿主任务接口为本地替身。

需要：GAPAW_TEST_BINARY（插件二进制）；自行建立合成源库并迁入本地模式，不启动旧服务。
"""
import json
import hashlib
from contextlib import contextmanager, suppress
import os
import subprocess
import tempfile
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BINARY = os.environ["GAPAW_TEST_BINARY"]
SOURCE = Path(os.environ.get("GAPAW_OUTREACH_SOURCE", "/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach"))
SHOTS = Path(os.environ.get("GAPAW_SHOT_DIR") or tempfile.mkdtemp(prefix="gapaw-browser-shots-", dir="/tmp"))
ENV = {k: v for k, v in os.environ.items() if not k.startswith("MULTICC_PLUGIN_")}
TASK = {"ok": True, "taskId": "tsk_wb", "sessionId": "s_wb", "shellId": "shell_wb", "url": "/air?task=tsk_wb&dir=fixture-dir"}


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
        if self.path == "/api/task-shells/shell_wb":
            return self.reply({"receipts": []})
        name = self.path.split("?")[0].split("#")[0].removeprefix("/ui/")
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
        if self.path == "/api/task-shell-tasks/tsk_wb/messages":
            return self.reply({"ok": True, "taskId": "tsk_wb", "receiptId": "rcpt_wb"})
        self.reply({"error": "unexpected"}, 404)


def wb(path):
    if path == "/api/conversations":
        return ok("workbench-conversations", {})
    assert path.startswith("/api/creators/")
    return ok("workbench-creator", {"creatorId": path.rsplit("/", 1)[1]})


def run_browser():
    ok("configure", {"workspace": {"dirId": "fixture-dir", "path": WORKSPACE}})
    with running_host() as server:
        base = f"http://127.0.0.1:{server.server_address[1]}/ui/index.html"
        with sync_playwright() as p:
            options = {"headless": True}
            chrome = os.environ.get("GAPAW_TEST_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
            if Path(chrome).exists():
                options["executable_path"] = chrome
            browser = p.chromium.launch(**options)
            try:
                page = browser.new_page(viewport={"width": 1440, "height": 960})
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(base)
                # 已迁入的本地数据直接呈现，无需旧工作台服务。
                page.wait_for_selector(".wb-row")
                home = ok("workbench-home", {})
                assert page.locator(".wb-row").count() == len(home["items"])
                assert page.locator(".wb-stat").count() == 7
                target = home["todo"]["awaitingReply"][0]["id"] if home["todo"]["awaitingReply"] else next(c["id"] for c in home["items"] if c["msg_count"])
                # 待办 → 打开达人详情：对话、谈判摘要、文案、台账均在插件内显示。
                page.locator("#todo-reply .wb-todo-item", has_text=target).first.click()
                page.wait_for_selector(".wb-detail-head")
                detail = wb(f"/api/creators/{target}")
                assert page.locator(".wb-msg").count() == len(detail["messages"])
                assert page.locator(".wb-draft").count() == 5
                page.screenshot(path=str(SHOTS / "1-home-detail.png"), full_page=True)

                # 总结对话并拟回复：经对话框真实走 prepare → 宿主替身 → 回执。
                page.click("text=总结这段对话并拟回复")
                page.wait_for_selector("#task-dialog[open]")
                assert page.is_hidden("#task-channels") and page.is_visible("#task-slot")
                page.select_option("#task-cli", "claude")
                page.click("#task-send")
                page.wait_for_selector("text=已交给 MultiCC")
                assert page.locator("#wb-notice a", has_text="打开原任务").count() == 1
                op = next(o for o in ok("list-operations", {})["operations"] if o.get("mode") == "reply")
                assert op["status"] == "accepted" and op["draftScope"]["channels"] == ["followup"]

                # 模拟任务交回摘要与回复草稿。
                ctx = ok("draft-context", {"operationId": op["id"], "taskId": "tsk_wb"})
                conv = ctx["scope"]["creators"][0]["conversation"]
                negotiation = {"status": "[浏览器验收] 待我方回复", "our_offer": "50 美元两条", "their_ask": "", "next_step": "我方回复确认", "basis": [conv[-1]["messageId"]], "note": "隔离副本"}
                draft = {"creatorId": target, "channel": "followup", "subject": "", "body": "[browser fixture] Thanks! 【固定费】 —【姓名】", "note": "隔离副本"}
                ok("submit-drafts", {"operationId": op["id"], "taskId": "tsk_wb", "submissionId": "wb1", "negotiation": negotiation, "drafts": [draft]})

                page.reload()  # 刷新后 hash 保留当前达人，相关任务与候选可找回
                page.wait_for_selector(".wb-detail-head")
                page.locator('[data-module="reply"]').click()
                page.wait_for_selector("text=候选摘要 第 1 版")
                assert page.locator(".wb-op", has_text="总结对话并拟回复").count() == 1
                assert page.locator("#todo-adopt .wb-todo-item", has_text=target).count() == 1
                page.locator("button", has_text="采用此摘要").first.click()
                page.wait_for_selector("text=谈判摘要已写入工作台并读回一致")
                assert wb(f"/api/creators/{target}")["negotiation"]["status"] == negotiation["status"]
                page.locator('[data-module="followup"]').click()
                page.locator(".wb-draft", has_text="跟进").locator("button", has_text="采用此版本").first.click()
                page.wait_for_selector("text=跟进已写入工作台并读回一致")
                assert next(d for d in wb(f"/api/creators/{target}")["drafts"] if d["channel"] == "followup")["body"] == draft["body"]

                # 人工编辑一条文案。
                page.locator('[data-module="drafts"]').click()
                dm = page.locator(".wb-draft", has_text="普通私信").first
                dm.locator("button", has_text="编辑").click()
                dm.locator("textarea").fill("[browser fixture] 人工编辑 【固定费】")
                dm.locator("button", has_text="保存到工作台").click()
                page.wait_for_selector("text=已保存并读回一致")
                assert next(d for d in wb(f"/api/creators/{target}")["drafts"] if d["channel"] == "dm")["body"] == "[browser fixture] 人工编辑 【固定费】"
                assert len(wb(f"/api/creators/{target}")["events"]) == len(detail["events"]), "不登记触达事件"
                page.screenshot(path=str(SHOTS / "2-adopted.png"), full_page=True)

                # 批量生成草稿：多选后打开对话框。
                for row in page.locator(".wb-row input[type=checkbox]").all()[:3]:
                    row.check()
                page.click("#wb-batch-drafts")
                page.wait_for_selector("#task-dialog[open]")
                assert "3 位" in page.inner_text("#task-target") and page.is_visible("#task-channels")
                page.click("#task-cancel")

                # 谈判总览。
                page.click("#tab-conversations")
                page.wait_for_selector(".wb-conv")
                assert page.locator(".wb-conv").count() == len(wb("/api/conversations")["items"])
                page.screenshot(path=str(SHOTS / "3-conversations.png"), full_page=True)

                page.set_viewport_size({"width": 390, "height": 844})
                page.click("#tab-creators")
                page.wait_for_timeout(300)
                assert page.evaluate("document.documentElement.scrollWidth") <= 390, "手机宽度出现横向滚动"
                page.locator(".wb-detail-head").scroll_into_view_if_needed()
                page.screenshot(path=str(SHOTS / "4-mobile.png"))
                assert not errors, errors
            except Exception:
                with suppress(Exception):
                    page.screenshot(path=str(SHOTS / "failure.png"), full_page=True)
                raise
            finally:
                browser.close()
        print("workbench browser ok", SHOTS)


def seed_local_source(database):
    records = []
    for n in range(3):
        cid = 'GW90' + str(n + 1)
        profile = {'id': cid, 'rank': n + 1, 'handle': 'fixture_' + cid.lower(), 'priority': 'A',
            'followers': 1000, 'topic': '合成用品', 'angle': '合成角度', 'anchor1': '合成饮水机', 'anchor2': '',
            'history': '', 'prior_invite': False, 'kalodata_window': '合成区间', 'affiliate_gmv_usd': 1,
            'pet_gmv_share_pct': 1, 'products': [], 'warnings': [], 'history_detail': {}, 'history_snapshot': '',
            'tiktok_url': 'https://example.invalid/' + cid, 'affiliate_url': 'https://example.invalid/' + cid,
            'kalodata_url': 'https://example.invalid/' + cid}
        records.append({'profile': profile, 'drafts': [{'channel': channel, 'subject': '合成主题' if channel == 'email' else '',
            'body': '合成文案 【固定费】 【姓名】'} for channel in ['comment', 'dm', 'email', 'affiliate', 'followup']]})
    script = """import sys,json
sys.path.insert(0,sys.argv[1]);from store import Store
s=Store(sys.argv[2]);s.init(json.load(sys.stdin))
s.add_message('GW901',{'channel':'email','direction':'out','at':'2026-10-01T00:00:00Z','body':'Synthetic offer only.','source':'synthetic:out'})
s.add_message('GW901',{'channel':'email','direction':'in','at':'2026-10-02T00:00:00Z','body':'Synthetic reply only.','zh':'合成来信：有兴趣','source':'synthetic:in'})
s.add_message('GW902',{'channel':'email','direction':'in','at':'2026-10-02T00:00:00Z','body':'Synthetic automatic reply.','kind':'自动回复','source':'synthetic:auto'})
"""
    subprocess.run(['python3', '-B', '-c', script, str(SOURCE), str(database)],
        input=json.dumps({'source_sha256': 'synthetic-browser-only', 'records': records}),
        text=True, capture_output=True, env=ENV, check=True, timeout=15)


@contextmanager
def running_host():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Host)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        assert not thread.is_alive(), '测试服务未退出'


def main():
    global WORKSPACE, ENV
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gapaw-local-browser-') as temp, tempfile.TemporaryDirectory(prefix='.gapaw-browser-workspace-', dir=os.path.expanduser('~')) as workspace:
        root = Path(temp).resolve()
        WORKSPACE = str(Path(workspace).resolve())
        ENV = {k: v for k, v in os.environ.items() if not k.startswith('MULTICC_PLUGIN_')}
        ENV['GAPAW_CREATOR_DATA_DIR'] = str(root / 'plugin-state')
        ENV['PYTHONDONTWRITEBYTECODE'] = '1'
        source = root / 'synthetic-source.sqlite3'
        seed_local_source(source)
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        preview = ok('preview-workbench-import', {'sourcePath': str(source)})
        imported = ok('import-workbench', {'sourcePath': preview['sourcePath'], 'expectedSourceDigest': preview['sourceDigest'], 'confirmed': True})
        assert imported['status'] == 'imported'
        assert ok('local-workbench-status', {})['active'] is True
        run_browser()
        assert hashlib.sha256(source.read_bytes()).hexdigest() == before, '合成原库应保持不变'


if __name__ == "__main__":
    main()
