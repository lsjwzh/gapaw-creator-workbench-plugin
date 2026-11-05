#!/usr/bin/env python3
"""办公室角色与工单页面闭环：真实 Rust、合成业务库和宿主，禁止真实模型与邮箱。"""
import json
import os
import sqlite3
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
BINARY = os.environ.get('GAPAW_TEST_BINARY', '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench')
SHOTS = Path(os.environ.get('GAPAW_SHOT_DIR', '/tmp/gapaw-workforce-shots'))


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gapaw-team-ui-') as temp, tempfile.TemporaryDirectory(prefix='.gapaw-team-ui-', dir=Path.home()) as workspace:
        state = Path(temp) / 'state'
        env = {k: v for k, v in os.environ.items() if not k.startswith('MULTICC_PLUGIN_')}
        env.update(GAPAW_CREATOR_DATA_DIR=str(state), GAPAW_LARK_CLI=str(Path(temp) / 'no-lark'))
        tasks, messages = {}, {}
        lost = [True]

        def cli(command, payload=None):
            result = subprocess.run([BINARY, command], input=json.dumps(payload or {}), capture_output=True, text=True, env=env, check=True, timeout=20)
            return json.loads(result.stdout)

        def run(command, payload=None):
            r = cli(command, payload)
            assert r['ok'], r
            return r['data']

        run('local-workbench-init', {'confirmed': True})
        db = sqlite3.connect(state / 'workbench.sqlite')
        db.execute("INSERT INTO creators(id,handle,profile,settings) VALUES('C1','fixture_creator','{}','{}')")
        db.execute("INSERT INTO messages(id,creator,direction,channel,at,subject,body,kind) VALUES('mail1','C1','in','email','2026-11-04T09:00:00Z','合作咨询','请介绍合作条件','正常')")
        db.commit()
        db.close()

        class Host(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, value, status=200, mime='application/json'):
                raw = value if isinstance(value, bytes) else json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', mime + '; charset=utf-8')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path == '/api/directories':
                    return self.reply([{'id': 'team-dir', 'name': '隔离运营目录', 'path': str(Path(workspace).resolve())}])
                if self.path.startswith('/api/providers?'):
                    return self.reply({'providers': [{'id': 'fixture-line', 'name': '隔离模型线路', 'models': ['fixture-model']}]})
                if self.path.startswith('/ui/'):
                    p = (ROOT / self.path.split('?')[0].lstrip('/')).resolve()
                    if p.is_file() and p.is_relative_to(ROOT / 'ui'):
                        return self.reply(p.read_bytes(), mime={'.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css'}[p.suffix])
                self.reply({'error': '未知测试接口'}, 404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path.endswith('/run'):
                    r = cli(body['command'], body.get('input', {}))
                    return self.reply(r['data'] if r['ok'] else r, 200 if r['ok'] else 400)
                if self.path == '/api/air/tasks':
                    key = body['clientMsgId']
                    if key not in tasks:
                        n = len(tasks)
                        tasks[key] = {'ok': True, 'taskId': f'tsk_ui_{n}', 'sessionId': f'session_{n}', 'shellId': f'shell_{n}', 'url': f'/air?task=tsk_ui_{n}&dir=team-dir'}
                    if lost[0]:
                        lost[0] = False
                        return self.reply({'error': '模拟创建响应丢失，请继续初始化'}, 503)
                    return self.reply(tasks[key])
                if self.path.startswith('/api/task-shell-tasks/') and self.path.endswith('/messages'):
                    key = body['clientMsgId']
                    messages.setdefault(key, {'ok': True, 'taskId': self.path.split('/')[3], 'receiptId': 'wake-fixture'})
                    return self.reply(messages[key])
                self.reply({'error': '未知测试接口'}, 404)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Host)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{server.server_port}/ui/'
        try:
            with sync_playwright() as p:
                options = {'headless': True}
                chrome = Path(os.environ.get('GAPAW_TEST_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
                if chrome.exists():
                    options['executable_path'] = str(chrome)
                browser = p.chromium.launch(**options)
                page = browser.new_page(viewport={'width': 1366, 'height': 1000})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base + 'setup.html#team-panel')
                panel = page.locator('#team-panel')
                expect(panel).to_contain_text('办公室与员工任务')
                page.select_option('#team-directory', 'team-dir')
                page.select_option('#team-provider', 'fixture-line')
                page.fill('#team-model', 'fixture-model')
                panel.get_by_role('button', name='保存办公室配置').click()
                expect(panel.get_by_role('button', name='初始化办公室', exact=True)).to_be_visible()
                panel.get_by_role('button', name='初始化办公室', exact=True).click()
                expect(panel).to_contain_text('模拟创建响应丢失')
                expect(panel.get_by_role('button', name='继续初始化办公室')).to_be_visible()
                panel.get_by_role('button', name='继续初始化办公室').click()
                expect(panel.get_by_role('link', name='打开角色任务')).to_have_count(8)
                assert len(tasks) == 8 and len(messages) == 0
                panel.get_by_role('button', name='更新员工交接协议').click()
                expect(panel).to_contain_text('请先完成宿主更新')
                assert len(tasks) == 8 and len(messages) == 0
                assert run('setup-status', {'brief': True})['values']['testRecipient'] == ''
                page.screenshot(path=str(SHOTS / 'team-settings.png'), full_page=True)
                page.reload()
                expect(panel.get_by_role('link', name='打开角色任务')).to_have_count(8)
                assert len(tasks) == 8

                page.goto(base + 'index.html')
                expect(page.locator('#team-summary')).to_contain_text('7 个员工角色任务已创建')
                page.locator('.ask', has_text='新来信 @fixture_creator').get_by_role('button', name='查看来信').click()
                page.locator('#drawer').get_by_role('button', name='创建影子工单').click()
                expect(page.locator('#drawer')).to_contain_text('已创建工单')
                page.locator('#drawer').get_by_role('button', name='关闭', exact=True).click()
                page.locator('#team-summary').get_by_role('button', name='唤醒流转器').click()
                expect(page.locator('#team-summary')).to_contain_text('宿主已受理流转请求')
                assert len(messages) == 1

                # 模拟角色执行，业务命令仍由真实 Rust 处理。
                roles = {s['key']: s['task']['taskId'] for s in run('team-status')['staff']}
                claimed = run('work-next', {'taskId': roles['dispatcher']})
                w = claimed['item']
                run('work-dispatched', {'workId': w['id'], 'claimId': w['claim']['id'], 'taskId': roles['dispatcher'], 'response': {'ok': True, 'taskId': roles['sort'], 'receiptId': 'worker-fixture'}})
                ctx = run('work-context', {'workId': w['id'], 'taskId': roles['sort']})
                payload = ctx['submissionTemplate']
                payload['result'] = {'summary': '<img src=x onerror="window.__xss=1">对方咨询合作条件，建议先确认条款。', 'evidence': ['消息 mail1：对方询问合作条件']}
                run('work-submit', payload)
                page.locator('#team-summary').get_by_role('button', name='刷新工单').click()
                page.locator('#team-summary').get_by_role('button', name='小拣 · 来信分类 · 候选待你确认').click()
                expect(page.locator('#drawer')).to_contain_text('建议先确认条款')
                expect(page.locator('#drawer')).to_contain_text('尚未采用或发送')
                assert page.locator('#drawer img').count() == 0
                assert page.evaluate('window.__xss') is None
                page.locator('#drawer').get_by_role('button', name='关闭', exact=True).click()
                page.screenshot(path=str(SHOTS / 'team-office.png'), full_page=True)
                mobile = browser.new_page(viewport={'width': 390, 'height': 844})
                mobile.on('pageerror', lambda e: errors.append(str(e)))
                mobile.goto(base + 'setup.html#team-panel')
                expect(mobile.locator('#team-panel').get_by_role('link', name='打开角色任务')).to_have_count(8)
                assert mobile.evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth') <= 0
                mobile.screenshot(path=str(SHOTS / 'team-mobile.png'), full_page=True)
                assert not errors, errors
                assert len(tasks) == 8
                browser.close()
        finally:
            server.shutdown()
    print('办公室浏览器闭环检查通过；截图目录：', SHOTS)


if __name__ == '__main__':
    main()
