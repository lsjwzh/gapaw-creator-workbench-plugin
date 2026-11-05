#!/usr/bin/env python3
"""正式开工页：隔离宿主、真实 Rust、浏览器操作；不连接生产任务。"""
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
SHOTS = Path(os.environ.get('GAPAW_SHOT_DIR', '/tmp/gapaw-onboarding-shots'))


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gapaw-onboarding-ui-') as temp, tempfile.TemporaryDirectory(prefix='.gapaw-onboarding-ui-', dir=Path.home()) as work:
        root = Path(temp).resolve()
        workspace = str(Path(work).resolve())
        env = {k: v for k, v in os.environ.items() if not k.startswith('MULTICC_PLUGIN_')}
        env['GAPAW_CREATOR_DATA_DIR'] = str(root)
        roles, cron, messages, commands = {}, [], {}, []
        flags = {'delivery': False}

        def cli(command, payload=None):
            p = subprocess.run([BINARY, command], input=json.dumps(payload or {}), capture_output=True, text=True, env=env, timeout=20, check=True)
            return json.loads(p.stdout)

        def run(command, payload=None):
            r = cli(command, payload)
            assert r['ok'], r
            return r['data']

        def sql(query, values=()):
            with sqlite3.connect(root / 'workbench.sqlite') as db:
                return db.execute(query, values).fetchall()

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
                parts = url.path.split('/')
                if url.path == '/api/directories':
                    return self.reply([{'id': 'fixture-dir', 'path': workspace}])
                if url.path == '/api/cron':
                    return self.reply(cron)
                if url.path.startswith('/api/air/tasks/'):
                    task = parts[4]
                    return self.reply({'task': {'id': task}, 'roleBindings': roles[task], 'readOnly': False, 'execution': {'busy': False, 'pending': False, 'queue': {'active': None, 'queued': []}}})
                if '/deliveries' in url.path:
                    return self.reply({'items': []} if flags['delivery'] else {'ok': False}, 200 if flags['delivery'] else 404)
                if url.path.startswith('/ui/'):
                    file = (ROOT / url.path.lstrip('/')).resolve()
                    if file.is_file() and file.is_relative_to(ROOT / 'ui'):
                        mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'}[file.suffix]
                        return self.reply(file.read_bytes(), mime=mime + '; charset=utf-8')
                return self.reply({'error': '隔离测试未提供此接口'}, 404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path == '/api/plugins/gapaw-creator-workbench/run':
                    commands.append(body['command'])
                    r = cli(body['command'], body.get('input', {}))
                    return self.reply(r['data'] if r['ok'] else r, 200 if r['ok'] else 400)
                if self.path.endswith('/roles'):
                    task = self.path.split('/')[4]
                    if roles[task]['version'] != body['expectedVersion']:
                        return self.reply({'ok': False}, 409)
                    roles[task] = {'taskId': task, 'version': body['expectedVersion'] + 1, 'bindings': body['bindings']}
                    return self.reply(roles[task])
                if self.path == '/api/cron':
                    cron.append({'id': 'cron-fixture', **body})
                    return self.reply(cron[-1])
                if self.path.endswith('/messages'):
                    key = body['clientMsgId']
                    messages.setdefault(key, {'ok': True, 'taskId': self.path.split('/')[3], 'receiptId': 'receipt-' + key})
                    return self.reply(messages[key])
                return self.reply({'error': '隔离测试未提供此接口'}, 404)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Host)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env['GAPAW_OFFICE_HOST_URL'] = 'http://127.0.0.1:' + str(server.server_address[1])
        base = env['GAPAW_OFFICE_HOST_URL'] + '/ui/onboarding.html'
        try:
            run('local-workbench-init', {'confirmed': True})
            for i in range(2):
                sql('INSERT INTO creators(id,handle,profile,settings) VALUES(?,?,?,?)', (f'C{i}', f'隔离达人{i}', json.dumps({'products': '宠物护理', 'topic': '养犬', 'anchor1': '已核实来源'}), json.dumps({'product_checked': True})))
            run('team-configure', {'expectedVersion': 0, 'workspace': {'dirId': 'fixture-dir', 'path': workspace}, 'runtime': {'cli': 'codex-exp', 'model': '隔离测试', 'provider': '隔离线路'}})
            for r in run('team-prepare')['staff']:
                task = 'tsk_' + r['key']
                roles[task] = {'taskId': task, 'version': 0, 'bindings': [{'name': '隔离角色', 'prompt': r['plan']['rolePrompt']}]}
                run('team-record-task', {'staffKey': r['key'], 'response': {'ok': True, 'taskId': task, 'sessionId': 'session_' + r['key'], 'shellId': 'shell_' + r['key']}})

            with sync_playwright() as p:
                options = {'headless': True}
                chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
                if chrome.exists():
                    options['executable_path'] = str(chrome)
                browser = p.chromium.launch(**options)
                page = browser.new_page(viewport={'width': 1440, 'height': 1050})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base)
                page.wait_for_timeout(1200)
                assert not errors, errors
                assert page.get_by_role('button', name='开始开工设置', exact=True).count(), page.locator('body').inner_text()
                page.get_by_role('button', name='开始开工设置', exact=True).click()
                page.locator('#product').fill('隔离验收产品')
                page.locator('#market').fill('英语市场')
                page.locator('#criteria').fill('真实内容与可核对来源')
                page.locator('#candidate-list input').first.check()
                page.get_by_role('button', name='保存目标，认识团队', exact=True).click()
                expect(page.locator('#role-prompt')).to_be_visible()
                page.locator('#role-prompt').fill(page.locator('#role-prompt').input_value() + '\n说明不确定项。')
                page.get_by_role('button', name='保存并确认，下一位', exact=True).click()
                expect(page.locator('#dialogue')).to_contain_text('2 / 8')
                page.get_by_role('button', name='其余采用当前提示词，统一同步开工协议', exact=True).click()
                expect(page.locator('#strategy')).to_be_visible()
                assert len(roles) == 8 and '说明不确定项' in roles['tsk_dispatcher']['bindings'][0]['prompt']
                page.get_by_role('button', name='保存约定，检查开工条件', exact=True).click()
                expect(page.locator('.preflight')).to_contain_text('宿主交付验收接口尚未就绪')
                expect(page.get_by_role('button', name='按这些设置开工', exact=True)).to_have_count(0)
                assert not cron and not messages
                page.screenshot(path=str(SHOTS / 'onboarding-preflight.png'), full_page=True)
                flags['delivery'] = True
                page.get_by_role('button', name='重新检查', exact=True).click()
                page.get_by_role('button', name='按这些设置开工', exact=True).click()
                expect(page.locator('#live-badge')).to_have_text('已允许团队运行')
                expect(page.locator('.work-stream li')).to_have_count(1)
                assert len(cron) == len(messages) == 1
                page.reload()
                expect(page.locator('#scene-title')).to_have_text('团队在工作，你掌握方向。')
                page.get_by_role('button', name='随时调整工作约定', exact=True).click()
                page.locator('#edit-tone').fill('未保存的输入')
                # 触发真正的页面轮询，编辑框不能被重画。
                page.wait_for_timeout(6500)
                expect(page.locator('#edit-tone')).to_have_value('未保存的输入')
                page.get_by_role('button', name='取消', exact=True).click()
                assert run('team-onboarding-status')['config']['values']['tone'] != '未保存的输入'
                page.get_by_role('button', name='随时调整工作约定', exact=True).click()
                page.locator('#edit-tone').fill('并发编辑内容')
                s = run('team-onboarding-status')['config']
                run('team-onboarding-save', {'requestId': 'concurrent', 'expectedRevision': s['revision'], 'step': 'preflight', 'values': s['values'], 'reviewedRoles': s['reviewedRoles']})
                page.get_by_role('button', name='保存并用于后续工作', exact=True).click()
                expect(page.locator('#global-notice')).to_contain_text('其他页面')
                expect(page.locator('#edit-tone')).to_have_value('并发编辑内容')
                page.get_by_role('button', name='关闭', exact=True).click()
                c = run('work-next', {'taskId': 'tsk_dispatcher'})['item']
                run('work-dispatched', {'workId': c['id'], 'taskId': 'tsk_dispatcher', 'claimId': c['claim']['id'], 'response': {'ok': True, 'taskId': 'tsk_sel', 'receiptId': 'isolated-dispatch'}})
                ctx = run('work-context', {'workId': c['id'], 'taskId': 'tsk_sel'})
                run('work-report-blocker', {'workId': c['id'], 'taskId': 'tsk_sel', 'expectedVersion': ctx['item']['version'], 'basis': ctx['item']['basis'], 'reason': '缺少原始内容链接', 'missing': ['原始内容链接'], 'suggestion': '补齐后再核验；其他候选继续'})
                page.get_by_role('button', name='刷新状态', exact=True).click()
                page.get_by_role('button', name='查看卡点并决定', exact=True).click()
                page.locator('#boss-note').fill('等老板补充，不丢这段输入')
                page.wait_for_timeout(6500)
                expect(page.locator('#boss-note')).to_have_value('等老板补充，不丢这段输入')
                page.screenshot(path=str(SHOTS / 'onboarding-blocker.png'), full_page=True)
                page.get_by_role('button', name='保存这个决定', exact=True).click()
                expect(page.locator('#dialogue')).to_contain_text('已挂起等补充')
                page.get_by_role('button', name='暂停领取新工作', exact=True).click()
                expect(page.locator('#live-badge')).to_have_text('已暂停领取新工作')
                page.screenshot(path=str(SHOTS / 'onboarding-runtime.png'), full_page=True)
                for width in [390, 320]:
                    page.set_viewport_size({'width': width, 'height': 844})
                    page.reload()
                    expect(page.locator('#live-badge')).to_have_text('已暂停领取新工作')
                    assert page.evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth') <= 0
                    page.screenshot(path=str(SHOTS / f'onboarding-mobile-{width}.png'), full_page=True)
                assert not errors, errors
                assert sql('SELECT count(*) FROM drafts')[0][0] == 0
                assert sql("SELECT count(*) FROM messages WHERE direction='out'")[0][0] == 0
                browser.close()
        finally:
            server.shutdown()
    print('正式开工页浏览器验收通过：引导、角色写回、开工门禁、后台时钟、卡点与编辑保留、并发冲突、暂停和手机布局。')


if __name__ == '__main__':
    main()
