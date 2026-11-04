#!/usr/bin/env python3
"""影子演练页验收：页面 → 真实 Rust → 合成业务库；只读业务库，不发送任何消息。"""
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
PACK = ROOT / 'tests' / 'fixtures' / 'rehearsal-pack.json'
SHOTS = Path(os.environ.get('GAPAW_SHOT_DIR', '/tmp/gapaw-rehearsal-shots'))
ALLOWED = {'rehearsal-status', 'rehearsal-item', 'rehearsal-answer'}


def business(state):
    state.mkdir(parents=True)
    db = sqlite3.connect(state / 'workbench.sqlite')
    db.executescript("""
    CREATE TABLE creators(id TEXT PRIMARY KEY,handle TEXT UNIQUE,profile TEXT NOT NULL,settings TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages(id TEXT PRIMARY KEY,creator TEXT,channel TEXT,direction TEXT,at TEXT,sender TEXT,subject TEXT,body TEXT,zh TEXT,kind TEXT,source TEXT UNIQUE,created TEXT);
    CREATE TABLE negotiations(creator TEXT PRIMARY KEY,status TEXT,our_offer TEXT,their_ask TEXT,next_step TEXT,updated TEXT);
    INSERT INTO creators VALUES('GW1','cat.home','{}','{}',0);
    INSERT INTO messages VALUES('m-in-1','GW1','email','in','2026-10-11T14:45:00Z','a@x.test','Rates','Rate card body','模板报价单','自动回复','s1','');
    INSERT INTO messages VALUES('m-out-1','GW1','email','out','2026-10-16T08:59:00Z','','Re','We can do $100','提议两条合计 $100','正常','s2','');
    INSERT INTO negotiations VALUES('GW1','等对方回复','$100','$450','','2026-10-16');
    """)
    db.commit()
    db.close()


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gapaw-reh-ui-') as temp:
        root = Path(temp).resolve()
        state = root / 'state'
        business(state)
        env = {k: v for k, v in os.environ.items() if not k.startswith('MULTICC_PLUGIN_')}
        env.update({'GAPAW_CREATOR_DATA_DIR': str(state), 'GAPAW_LARK_CLI': str(root / 'no-lark')})
        commands = []

        def cli(command, payload):
            out = subprocess.run([BINARY, command], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=60, check=True)
            return json.loads(out.stdout)

        biz_before = (state / 'workbench.sqlite').read_bytes()

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
                if self.path != '/api/plugins/gapaw-creator-workbench/run':
                    return self.reply({'error': 'unexpected fixture request'}, 404)
                commands.append(body['command'])
                result = cli(body['command'], body.get('input', {}))
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

                # 未导入时如实提示。
                page.goto(base + 'rehearsal.html')
                expect(page.locator('#reh-notice')).to_contain_text('还没有导入演练包')
                assert cli('rehearsal-import', {'path': str(PACK)})['ok']

                page.reload()
                expect(page.locator('#reh-notice')).to_contain_text('不会发送任何消息')
                expect(page.locator('#reh-summary')).to_contain_text('客观数值待确认')
                expect(page.locator('.reh-step[aria-current=step]')).to_contain_text('合作条件')

                # 客观数值：显示预填、冲突和依据；改成自己的值。
                page.locator('#reh-offer-fee .reh-head').click()
                card = page.locator('#reh-offer-fee')
                expect(card).to_contain_text('AI 预填（从历史提炼）：25')
                expect(card).to_contain_text('需要你拍板：后来普遍升到 $100/条')
                expect(card).to_contain_text('fee=50 覆盖 100 位')
                card.locator('input.reh-number').fill('25')
                card.get_by_role('button', name='按我改的保存').click()
                expect(page.locator('#reh-notice')).to_contain_text('和预填一样')
                card.locator('input.reh-number').fill('100')
                card.get_by_role('button', name='按我改的保存').click()
                expect(page.locator('#reh-profile')).to_contain_text('首封每条固定费给多少？')
                expect(page.locator('#reh-profile')).to_contain_text('100')
                expect(page.locator('#reh-offer-fee .tag').last).to_have_text('已修改')
                page.screenshot(path=str(SHOTS / 'rehearsal-question.png'), full_page=True)

                # 来信分类：同意偏好后，自动打开下一条（同一环节的案例）。
                page.locator('.reh-step', has_text='来信分类').click()
                page.locator('#reh-classify-auto .reh-head').click()
                page.locator('#reh-classify-auto').get_by_role('button', name='同意预填').click()
                case = page.locator('#reh-case-auto')
                expect(case).to_contain_text('模板报价单')
                expect(case).to_contain_text('提议两条合计 $100')
                expect(case).to_contain_text('秒回的报价单算不算回复？（不算，按自动回复处理）')
                case.get_by_role('button', name='我会这样做').click()
                expect(page.locator('#reh-notice')).to_contain_text('请先写下你的做法')
                case.locator('textarea.reh-note').fill('先查是否真人再定')
                case.get_by_role('button', name='我会这样做').click()
                expect(page.locator('#reh-diff')).to_contain_text('先查是否真人再定')

                # 找不到来信的案例如实说明；条件变化标记可见。
                page.locator('.reh-step', has_text='议价').click()
                page.locator('#reh-case-missing .reh-head').click()
                miss = page.locator('#reh-case-missing')
                expect(miss).to_contain_text('业务库里找不到这封来信')
                expect(miss).to_contain_text('涉及条件变化，永远由你确认')
                page.screenshot(path=str(SHOTS / 'rehearsal-case.png'), full_page=True)

                # 手机宽度不横向溢出。
                mobile = browser.new_page(viewport={'width': 390, 'height': 844})
                mobile.on('pageerror', lambda e: errors.append(str(e)))
                mobile.goto(base + 'rehearsal.html')
                expect(mobile.locator('#reh-summary')).to_contain_text('已记住的倾向')
                mobile.locator('.reh-step', has_text='来信分类').click()
                mobile.locator('#reh-case-auto .reh-head').click()
                expect(mobile.locator('#reh-case-auto')).to_contain_text('模板报价单')
                overflow = mobile.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
                assert overflow <= 1, f'手机横向溢出 {overflow}px'
                mobile.screenshot(path=str(SHOTS / 'rehearsal-mobile.png'), full_page=True)

                assert not errors, errors
                assert set(commands) <= ALLOWED, commands
                assert (state / 'workbench.sqlite').read_bytes() == biz_before, '业务库被修改'
                assert not (root / 'calls.jsonl').exists()
                browser.close()
        finally:
            server.shutdown()
    print('rehearsal browser: ok')


if __name__ == '__main__':
    main()
