#!/usr/bin/env python3
"""像素办公室首页验收：页面 → 真实 Rust → 合成业务库；只读，不发送任何消息。"""
import json
import os
import sqlite3
import subprocess
import tempfile
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
BINARY = os.environ.get('GAPAW_TEST_BINARY', '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench')
SHOTS = Path(os.environ.get('GAPAW_SHOT_DIR', '/tmp/gapaw-office-shots'))
ALLOWED = {'office-status', 'office-creator'}
EVIL = '<img src=x onerror="window.__xss=1">'


def seed(cli, state):
    assert cli('local-workbench-init', {'confirmed': True})['ok']
    db = sqlite3.connect(state / 'workbench.sqlite')
    for i in range(6):
        db.execute("INSERT INTO creators(id,handle,profile,settings) VALUES(?,?,'{}','{}')", (f'C{i}', f'creator_{i}'))
        db.execute("INSERT INTO events(id,creator,channel,type,at,void_reason) VALUES(?,?,'email','平台受理','2026-10-20T10:00:00Z','')", (f'e{i}', f'C{i}'))
    db.execute("INSERT INTO creators(id,handle,profile,settings) VALUES('CX',?,'{}','{}')", (EVIL,))
    db.execute("INSERT INTO events(id,creator,channel,type,at,void_reason) VALUES('ex','CX','email','平台受理','2026-10-21T10:00:00Z','')")
    db.execute("INSERT INTO events(id,creator,channel,type,at,void_reason) VALUES('r0','C0','email','有效回复','2026-10-21T12:00:00Z','')")
    db.execute("INSERT INTO messages(id,creator,channel,direction,at,body) VALUES('m0','C0','email','in','2026-10-21T12:00:00Z','private body text')")
    db.execute("INSERT INTO negotiations(creator,status,our_offer,their_ask,next_step,updated) VALUES('C0','对方还价','$50','$120','回复','2026-10-21')")
    # C1 有新来信但还没有谈判记录；C2 只有自动回复，不算新来信。
    db.execute("INSERT INTO messages(id,creator,channel,direction,at,subject,body,kind) VALUES('m1','C1','email','in','2026-10-22T09:00:00Z','Re: rates','My rate is $80','正常')")
    db.execute("INSERT INTO messages(id,creator,channel,direction,at,subject,body,kind) VALUES('m2','C2','email','in','2026-10-22T09:00:00Z','Out of office','away','自动回复')")
    # More than one screen of current mail; original old mail must stay accessible.
    for i in range(7):
        db.execute("INSERT INTO creators(id,handle,profile,settings) VALUES(?,?,'{}','{}')", (f'R{i}', f'recent_{i}'))
        at = (datetime.now(timezone.utc) - timedelta(hours=i + 1)).isoformat()
        db.execute("INSERT INTO messages(id,creator,direction,at,subject,kind) VALUES(?,?,'in',?,'Current fixture','正常')", (f'recent{i}', f'R{i}', at))
    db.commit()
    db.close()
    # A migrated workspace with real outreach must land on progress even when
    # the separate onboarding wizard has never been completed. No real sends.
    for key, mode, date in [('live', 'live', '2026-11-07T04:45:30Z'), ('test', 'test', '2026-11-08T04:45:30Z')]:
        row = cli('outbox-save', {'clientId': key, 'creatorId': 'C3', 'subject': 'Isolated preview', 'body': 'Isolated preview body', 'asReply': False})['data']
        with sqlite3.connect(state / 'workbench.sqlite') as db:
            db.execute("UPDATE outbox SET mode=?,state='delivered',sent_at=? WHERE id=?", (mode, date, row['id']))


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gapaw-office-ui-') as temp:
        root = Path(temp).resolve()
        state = root / 'state'
        state.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith('MULTICC_PLUGIN_')}
        env.update({'GAPAW_CREATOR_DATA_DIR': str(state), 'GAPAW_LARK_CLI': str(root / 'no-lark')})
        commands = []
        flags = {'unavailable': False}

        def cli(command, payload):
            out = subprocess.run([BINARY, command], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=60, check=True)
            return json.loads(out.stdout)

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
                commands.append(body['command'])
                if body['command'] == 'office-status' and flags['unavailable']:
                    return self.reply({'error': '隔离验收：读取暂时失败'}, 503)
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

                # 空库：如实提示先准备数据，且不创建业务库。
                page.goto(base + 'index.html')
                expect(page.locator('#note')).to_contain_text('还没有业务数据')
                expect(page.locator('#asks')).to_contain_text('先准备业务数据')
                expect(page.locator('#home-title')).to_have_text('从第一位达人开始')
                assert not (state / 'workbench.sqlite').exists()

                seed(cli, state)
                biz_before = (state / 'workbench.sqlite').read_bytes()
                page.reload()
                expect(page.locator('#v-real')).to_have_attribute('aria-pressed', 'true')
                expect(page.locator('#note')).to_contain_text('按插件工单')
                expect(page.locator('#home-title')).to_have_text('已经联系，下一步看回复')
                expect(page.locator('#home-delivery')).to_have_text('邮件已送达')
                expect(page.locator('#home-overview')).to_contain_text('@creator_3')
                expect(page.locator('#home-freshness')).to_contain_text('最近同步：尚无记录')
                expect(page.locator('.home-steps .done')).to_have_count(1)
                assert '首次开工' not in page.locator('body').inner_text()
                page.screenshot(path=str(SHOTS / 'office-home.png'), full_page=True)
                page.locator('#decisions').screenshot(path=str(SHOTS / 'attention-groups.png'))
                page.get_by_role('link', name='业务记录').click()
                expect(page.locator('#business-history')).to_have_attribute('open', '')
                expect(page.locator('#funnel')).to_contain_text('触达7')
                expect(page.locator('#funnel')).to_contain_text('回复9')
                expect(page.locator('#asks')).to_contain_text('待查看来信 @creator_1')
                earlier = page.locator('[data-attention-group="earlier"]')
                expect(earlier).not_to_have_attribute('open', '')
                expect(page.locator('[data-attention-group="negotiations"] .ask')).to_be_visible()
                expect(page.locator('[data-attention-group="recent"] > .ask')).to_have_count(5)
                expect(page.locator('[data-attention-group="recent"] > .ask').first).to_contain_text('@recent_0')
                page.locator('[data-attention-key="recent-more"] > summary').click()
                expect(page.locator('.ask', has_text='@recent_6')).to_be_visible()
                earlier.locator(':scope > summary').click()
                # A refresh preserves the expanded groups without modifying facts.
                page.get_by_role('button', name='刷新进度', exact=True).click()
                expect(page.locator('[data-attention-key="recent-more"]')).to_have_attribute('open', '')
                expect(earlier).to_have_attribute('open', '')
                assert 'creator_2' not in page.locator('#asks').inner_text()
                # 正文只在打开抽屉后显示。
                assert 'private body text' not in page.content()
                page.locator('.ask', has_text='回复 @creator_0').get_by_role('button', name='查看往来').click()
                drawer = page.locator('#drawer')
                expect(drawer).to_be_visible()
                expect(drawer).to_contain_text('对方还价')
                expect(drawer).to_contain_text('private body text')
                page.keyboard.press('Escape')
                expect(drawer).to_be_hidden()
                page.locator('.ask', has_text='待查看来信 @creator_1').get_by_role('button', name='查看来信').click()
                expect(drawer).to_contain_text('My rate is $80')
                drawer.get_by_role('button', name='关闭').click()
                asks = page.locator('#asks')
                expect(asks).to_contain_text('连接待设置：')
                expect(asks).to_contain_text('发件邮箱')
                expect(page.locator('#cal .d')).to_have_count(14)
                expect(page.locator('#feed')).to_contain_text('真实状态')
                # 跳转按钮指向对应页面。
                asks.get_by_role('button', name='去连接与设置').click()
                page.wait_for_url('**/setup.html')
                page.go_back()
                expect(page.locator('#note')).to_contain_text('按插件工单')

                # 模拟一天：只改页面，名单含恶意昵称时按文本显示。
                page.locator('#demo-menu summary').click()
                page.locator('#v-demo').click()
                expect(page.locator('#v-demo')).to_have_attribute('aria-pressed', 'true')
                expect(page.locator('#note')).to_contain_text('不会发送任何东西')
                expect(page.locator('#home-overview')).to_contain_text('以下动画不代表真实进展')
                expect(page.locator('#home-delivery')).to_have_count(0)
                page.evaluate('OFFICE.speed(8)')
                page.wait_for_function('OFFICE.time() > 10 * 60', timeout=60000)
                expect(page.locator('#feed li').first).to_be_visible()
                page.screenshot(path=str(SHOTS / 'office-demo.png'))
                assert page.evaluate('window.__xss') is None
                assert page.evaluate("document.querySelectorAll('#overlay img, #feed img, #asks img').length") == 0


                # 手机宽度不横向溢出。
                mobile = browser.new_page(viewport={'width': 390, 'height': 844})
                mobile.on('pageerror', lambda e: errors.append(str(e)))
                mobile.goto(base + 'index.html')
                expect(mobile.locator('#note')).to_contain_text('按插件工单')
                expect(mobile.locator('#sync')).to_be_visible()
                assert mobile.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 0
                mobile.screenshot(path=str(SHOTS / 'office-mobile.png'))
                mobile.set_viewport_size({'width': 320, 'height': 844})
                assert mobile.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 0

                flags['unavailable'] = True
                mobile.reload()
                expect(mobile.locator('#home-title')).to_have_text('暂时无法读取进度')
                expect(mobile.locator('#home-delivery')).to_have_count(0)
                flags['unavailable'] = False
                mobile.get_by_role('button', name='重新读取进度').click()
                expect(mobile.locator('#home-delivery')).to_have_text('邮件已送达')

                assert (state / 'workbench.sqlite').read_bytes() == biz_before, '首页不得修改业务库'
                assert set(commands) == {'office-status', 'office-creator'}, commands
                assert not errors, errors
                browser.close()
        finally:
            server.shutdown()
    print('office browser test passed')


if __name__ == '__main__':
    main()
