#!/usr/bin/env python3
"""连接与设置页验收：页面 → 真实 Rust → 合成飞书命令行；不访问真实邮箱、不发送邮件。"""
import json
import os
import subprocess
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
BINARY = os.environ.get('GAPAW_TEST_BINARY', '/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench')
FAKE = ROOT / 'tests' / 'fixtures' / 'fake-lark-cli.cjs'
SHOTS = Path(os.environ.get('GAPAW_SHOT_DIR', '/tmp/gapaw-setup-shots'))


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    FAKE.chmod(0o755)
    with tempfile.TemporaryDirectory(prefix='gapaw-setup-ui-') as temp:
        root = Path(temp).resolve()
        lark = root / 'lark.json'
        lark.write_text(json.dumps({'auth': 'ok', 'tip': True, 'mailboxes': ['shop@example.com', 'other@example.com'], 'delivery': 4}))
        env = {k: v for k, v in os.environ.items() if not k.startswith('MULTICC_PLUGIN_')}
        env.update({'GAPAW_CREATOR_DATA_DIR': str(root / 'state'), 'GAPAW_LARK_CLI': str(FAKE), 'FAKE_LARK_STATE': str(lark)})
        commands = []

        def set_lark(**patch):
            lark.write_text(json.dumps({**json.loads(lark.read_text()), **patch}))

        def sends():
            calls = root / 'calls.jsonl'
            return sum(1 for line in calls.read_text().splitlines() if json.loads(line)[1] == '+send') if calls.exists() else 0

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
                out = subprocess.run([BINARY, body['command']], input=json.dumps(body.get('input', {})), capture_output=True, text=True, env=env, timeout=60, check=True)
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
                page = browser.new_page(viewport={'width': 1280, 'height': 900})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                dialogs = []
                page.on('dialog', lambda d: (dialogs.append(d.message), d.accept()))

                # 首页（像素办公室）提示先准备数据，并能进入设置页。
                page.goto(base + 'index.html')
                expect(page.locator('#asks')).to_contain_text('先准备业务数据')
                page.locator('.ask', has_text='先准备业务数据').get_by_role('button', name='去连接与设置').click()
                expect(page).to_have_url(base + 'setup.html')

                # 打开即自动检测登录；未完成项与受影响功能分别显示。
                expect(page.locator('#setup-mailLogin .tag')).to_have_text('可用')
                expect(page.locator('#setup-mailLogin')).to_contain_text('合成用户')
                expect(page.locator('#setup-summary')).to_contain_text('业务数据、发件邮箱、测试收件邮箱')
                expect(page.locator('#setup-features')).to_contain_text('发送邮件')
                expect(page.locator('#setup-browser .tag')).to_have_text('可选')
                assert 'SECRET_ACCESS_TOKEN' not in page.content()
                page.screenshot(path=str(SHOTS / 'setup-initial.png'), full_page=True)

                # 选择发件邮箱。
                expect(page.locator('#setup-sender-mailbox option')).to_have_count(3)
                page.select_option('#setup-sender-mailbox', 'shop@example.com')
                page.fill('#setup-sender-name', 'Gapaw Team')
                page.locator('#setup-sender').get_by_role('button', name='保存').click()
                expect(page.locator('#setup-sender .tag')).to_have_text('可用')

                # 测试邮箱：保存 → 发送（确认框）→ 回信前后核对。
                send = page.locator('#setup-testRecipient').get_by_role('button', name='发送测试信')
                expect(send).to_be_disabled()
                page.fill('#setup-test-recipient', 'tester@test.example')
                page.locator('#setup-testRecipient').get_by_role('button', name='保存').click()
                expect(send).to_be_enabled()
                send.click()
                expect(page.locator('#setup-testRecipient')).to_contain_text('请登录 tester@test.example')
                assert dialogs and 'tester@test.example' in dialogs[-1], dialogs
                assert sends() == 1
                page.locator('#setup-testRecipient').get_by_role('button', name='检查回信').click()
                expect(page.locator('#setup-summary')).to_contain_text('还没有收到回信')
                set_lark(reply=True)
                page.locator('#setup-testRecipient').get_by_role('button', name='检查回信').click()
                expect(page.locator('#setup-testRecipient .tag')).to_have_text('可用')
                expect(page.locator('#setup-summary')).to_contain_text('收发测试通过')

                # 正式模式需确认；改测试邮箱后自动退回测试模式。
                page.locator('#setup-mode').get_by_role('button', name='切换到正式模式').click()
                expect(page.locator('#setup-mode')).to_contain_text('外发邮件发往达人真实邮箱')
                assert '真实邮箱' in dialogs[-1]

                # 参数校验与修改记录。
                page.fill('#setup-daily', '0')
                page.locator('#setup-limits').get_by_role('button', name='保存').click()
                expect(page.locator('#setup-summary')).to_have_class('notice error')
                expect(page.locator('#setup-summary')).to_contain_text('每日发送上限')
                page.fill('#setup-daily', '30')
                page.locator('#setup-limits').get_by_role('button', name='保存').click()
                expect(page.locator('#setup-limits')).to_contain_text('每日最多 30 封')
                expect(page.locator('#setup-history')).to_contain_text('发送上限')

                page.fill('#setup-test-recipient', 'tester2@test.example')
                page.locator('#setup-testRecipient').get_by_role('button', name='保存').click()
                expect(page.locator('#setup-summary')).to_contain_text('退回测试模式')
                expect(page.locator('#setup-mode')).to_contain_text('只发往测试收件邮箱')
                expect(page.locator('#setup-testRecipient .tag')).to_have_text('需要处理')
                page.screenshot(path=str(SHOTS / 'setup-configured.png'), full_page=True)

                # 登录过期时给出授权步骤，发送按钮不可用。
                set_lark(auth='expired')
                page.locator('#setup-mailLogin').get_by_role('button', name='重新检测').click()
                expect(page.locator('#setup-mailLogin .tag')).to_have_text('需要处理')
                expect(page.locator('#setup-mailLogin')).to_contain_text('lark-cli auth login')
                expect(send).to_be_disabled()

                # 业务数据：页面内新建空白工作台；之后不再显示迁入入口。
                data = page.locator('#setup-data')
                expect(data).to_contain_text('尚未建立业务库')
                data.get_by_role('button', name='新建空白工作台').click()
                expect(page.locator('#setup-data .tag')).to_have_text('可用')
                expect(page.locator('#setup-data')).to_contain_text('达人 0 位')
                expect(page.locator('#setup-data')).not_to_contain_text('预览迁入')

                mobile = browser.new_page(viewport={'width': 390, 'height': 844})
                mobile.goto(base + 'setup.html')
                expect(mobile.locator('#setup-mailLogin .tag')).to_be_visible()
                width = mobile.evaluate('document.documentElement.scrollWidth')
                assert width <= 390, width
                mobile.screenshot(path=str(SHOTS / 'setup-mobile.png'), full_page=True)
                assert sends() == 1, '整个流程只应发出一封测试信'
                assert not errors, errors
                browser.close()
        finally:
            server.shutdown()
    print('setup browser ok; shots in', SHOTS)


if __name__ == '__main__':
    main()
