#!/usr/bin/env python3
"""发件箱首页验收：页面 → 真实 Rust → 合成飞书命令行；不访问真实邮箱、不发送真实邮件。"""
import json
import os
import sqlite3
import subprocess
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
BINARY = os.environ.get('GAPAW_TEST_BINARY', '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench')
FAKE = ROOT / 'tests' / 'fixtures' / 'fake-lark-cli.cjs'
SHOTS = Path(os.environ.get('GAPAW_SHOT_DIR', '/tmp/gapaw-outbox-shots'))
ALLOWED = {'office-status', 'office-creator', 'outbox-list', 'outbox-save', 'outbox-send', 'outbox-check', 'outbox-cancel'}
EVIL = '<img src=x onerror="window.__xss=1">'


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    FAKE.chmod(0o755)
    with tempfile.TemporaryDirectory(prefix='gapaw-outbox-ui-') as temp:
        root = Path(temp).resolve()
        state = root / 'state'
        state.mkdir()
        lark = root / 'lark.json'
        lark.write_text(json.dumps({'auth': 'ok', 'mailboxes': ['shop@example.com'], 'delivery': 4}))
        env = {k: v for k, v in os.environ.items() if not k.startswith('MULTICC_PLUGIN_')}
        env.update({'GAPAW_CREATOR_DATA_DIR': str(state), 'GAPAW_LARK_CLI': str(FAKE), 'FAKE_LARK_STATE': str(lark), 'GAPAW_LARK_SEND_TIMEOUT_SECS': '2'})

        def cli(command, payload):
            out = subprocess.run([BINARY, command], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=60, check=True)
            result = json.loads(out.stdout)
            assert result['ok'], result
            return result['data']

        def set_lark(**patch):
            lark.write_text(json.dumps({**json.loads(lark.read_text()), **patch}))

        def draft_sends():
            calls = root / 'calls.jsonl'
            return sum(1 for line in calls.read_text().splitlines() if json.loads(line)[1] == '+draft-send') if calls.exists() else 0

        # 设置发件箱：真实 Rust 读取合成登录状态，测试模式发往测试收件邮箱。
        cli('mail-status', {})
        version = cli('setup-status', {'brief': True})['version']
        cli('setup-save', {'expectedVersion': version, 'values': {'senderMailbox': 'shop@example.com', 'testRecipient': 'tester@test.example'}})
        cli('local-workbench-init', {'confirmed': True})
        db = sqlite3.connect(state / 'workbench.sqlite')
        # 达人档案故意不登记邮箱：测试模式下 liveOnly 规则只提示、不拦截。
        db.execute("INSERT INTO creators(id,handle,profile,settings) VALUES('C1','creator_one','{}',?)",
                   (json.dumps({'fee': '$100', 'sender': 'Gapaw Team'}),))
        db.execute("INSERT INTO messages(id,creator,channel,direction,at,subject,body,kind,source) "
                   "VALUES('m1','C1','email','in','2026-10-20T09:00:00Z','Re: rates','My rate is $80','正常','lark-mail:ORIG1')")
        db.commit()
        db.close()

        class Host(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, value, status=200, mime='application/json'):
                body = value if isinstance(value, bytes) else json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                url = urllib.parse.urlparse(self.path)
                if url.path.startswith('/ui/'):
                    file = (ROOT / url.path.lstrip('/')).resolve()
                    if file.is_file() and file.is_relative_to(ROOT / 'ui'):
                        mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'}[file.suffix]
                        return self.reply(file.read_bytes(), mime=mime + '; charset=utf-8')
                return self.reply({'error': 'unexpected fixture request'}, 404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path != '/api/plugins/gapaw-creator-workbench/run' or body['command'] not in ALLOWED:
                    return self.reply({'error': 'unexpected fixture request'}, 404)
                out = subprocess.run([BINARY, body['command']], input=json.dumps(body.get('input', {})), capture_output=True, text=True, env=env, timeout=60)
                result = json.loads(out.stdout)
                self.reply(result['data'] if result['ok'] else result, 200 if result['ok'] else 400)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Host)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = 'http://127.0.0.1:' + str(server.server_address[1]) + '/ui/'
        try:
            with sync_playwright() as p:
                options = {'headless': True}
                chrome = os.environ.get('GAPAW_TEST_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
                if Path(chrome).exists():
                    options['executable_path'] = chrome
                browser = p.chromium.launch(**options)
                page = browser.new_page(viewport={'width': 1366, 'height': 900})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))

                page.goto(base + 'index.html')
                expect(page.locator('#note')).to_contain_text('按插件工单')
                expect(page.locator('.ask', has_text='新来信 @creator_one')).to_be_visible()
                page.locator('.ask', has_text='新来信 @creator_one').get_by_role('button', name='查看来信').click()
                drawer = page.locator('#drawer')
                expect(drawer).to_be_visible()

                # 写邮件：预填最近来信主题（已带 Re: 不重复），默认作为回复。
                expect(drawer.locator('#compose-subject')).to_have_value('Re: rates')
                expect(drawer.locator('#compose-body')).to_have_value('')
                expect(drawer.locator('#compose-asreply')).to_be_checked()
                drawer.locator('#compose-body').fill('您好，想确认一下合作细节。' + EVIL)
                page.screenshot(path=str(SHOTS / 'v0134-compose.png'))

                # 保存草稿，再点发送：先确认后发送。
                drawer.get_by_role('button', name='保存草稿').click()
                expect(drawer.locator('#compose-note')).to_contain_text('草稿已保存')
                expect(drawer.locator('.ob-state')).to_contain_text('待发送')
                drawer.locator('#compose').get_by_role('button', name='发送').click()
                confirm = page.locator('#confirm')
                expect(confirm).to_be_visible()
                expect(confirm.locator('#confirm-mode')).to_contain_text('测试模式')
                expect(confirm.locator('#confirm-mode')).to_contain_text('tester@test.example')
                expect(confirm.locator('#confirm-mode')).to_contain_text('不会发给达人')
                expect(confirm.locator('#confirm-subject')).to_have_text('Re: rates')
                expect(confirm.locator('#confirm-body')).to_contain_text('合作细节')
                warn = confirm.locator('.rules li.warn')
                expect(warn.first).to_contain_text('正式模式下会被拦下')
                expect(confirm.locator('#confirm-send')).to_be_enabled()
                page.screenshot(path=str(SHOTS / 'v0134-confirm.png'))

                # 连点两次确认只应发送一次。
                page.evaluate("const b=document.getElementById('confirm-send'); b.click(); b.click();")
                expect(page.locator('#confirm')).to_have_count(0)
                expect(drawer).to_contain_text('已投递')
                expect(drawer.locator('.ob-state')).to_contain_text('已投递')
                assert draft_sends() == 1, draft_sends()
                assert page.evaluate('window.__xss') is None
                assert page.evaluate("document.querySelectorAll('#drawer img').length") == 0
                expect(page.locator('#outbox-badge')).to_be_hidden()

                # 保存后来了新来信：确认层出现“我已看过新来信”，确认发送不可点。
                expect(drawer.locator('#compose-subject')).to_have_value('Re: rates')
                drawer.locator('#compose-body').fill('补充一封，确认合作排期。')
                drawer.get_by_role('button', name='保存草稿').click()
                expect(drawer.locator('#compose-note')).to_contain_text('草稿已保存')
                conn = sqlite3.connect(state / 'workbench.sqlite')
                conn.execute("INSERT INTO messages(id,creator,channel,direction,at,subject,body,kind,source) "
                             "VALUES('m2','C1','email','in','2026-10-25T09:00:00Z','Re: rates 2','补充说明','正常','lark-mail:ORIG2')")
                conn.commit(); conn.close()
                drawer.locator('#compose').get_by_role('button', name='发送').click()
                expect(page.locator('#confirm')).to_be_visible()
                expect(page.locator('#confirm .rules li.bad')).to_contain_text('新来信')
                expect(page.locator('#confirm-send')).to_be_disabled()
                expect(page.locator('#confirm-ack')).to_be_visible()
                page.locator('#confirm-ack').click()
                expect(page.locator('#confirm')).to_have_count(0)
                expect(drawer.locator('.ob-state')).to_have_count(2)
                assert draft_sends() == 2, draft_sends()
                drawer.get_by_role('button', name='关闭').click()
                expect(drawer).to_be_hidden()

                # 顶部发件箱入口与全部记录面板。
                page.locator('#outbox-btn').click()
                panel = page.locator('#outbox-panel')
                expect(panel).to_be_visible()
                expect(panel).to_contain_text('发件箱')
                expect(panel).to_contain_text('Re: rates')
                panel.get_by_role('button', name='关闭').click()
                expect(panel).to_be_hidden()

                # 发送结果待核对的记录：角标与老板桌卡片。
                conn = sqlite3.connect(state / 'workbench.sqlite')
                conn.execute("UPDATE outbox SET state='unknown'")
                conn.commit()
                conn.close()
                page.reload()
                expect(page.locator('#note')).to_contain_text('按插件工单')
                expect(page.locator('#outbox-badge')).to_have_text('2')
                card = page.locator('#outbox-ask-card')
                expect(card).to_be_visible()
                expect(card).to_contain_text('2 封信结果待核对')
                card.get_by_role('button', name='打开发件箱').click()
                expect(page.locator('#outbox-panel')).to_contain_text('结果待核对')
                page.locator('#outbox-panel').get_by_role('button', name='关闭').click()

                page.goto(base + 'index.html#outbox')
                expect(page.locator('#outbox-panel')).to_be_visible()
                page.locator('#outbox-panel').get_by_role('button', name='关闭').click()

                # 390px 手机宽度：抽屉写信区不横向溢出。
                mobile = browser.new_page(viewport={'width': 390, 'height': 844})
                mobile.on('pageerror', lambda e: errors.append(str(e)))
                mobile.goto(base + 'index.html')
                expect(mobile.locator('#note')).to_contain_text('按插件工单')
                mobile.locator('.ask', has_text='新来信 @creator_one').get_by_role('button', name='查看来信').click()
                expect(mobile.locator('#drawer #compose')).to_be_visible()
                width = mobile.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
                assert width <= 0, width
                mobile.screenshot(path=str(SHOTS / 'v0134-mobile.png'))

                assert draft_sends() == 2, '两次确认各发一封；连点两次不会多发'
                assert not errors, errors
                browser.close()
        finally:
            server.shutdown()
    print('outbox browser test passed; shots in', SHOTS)


if __name__ == '__main__':
    main()
