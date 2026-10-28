#!/usr/bin/env python3
"""本地工作台验收：页面 → 真实 Rust → 新建合成业务库，不启动旧服务。"""
import hashlib
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
SOURCE = Path(os.environ.get('GAPAW_OUTREACH_SOURCE', '/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach'))
SHOTS = Path(os.environ.get('GAPAW_SHOT_DIR', '/tmp/gapaw-local-workbench-shots'))
MODULES = ['selection', 'verification', 'cooperation', 'drafts', 'outreach', 'messages', 'reply', 'followup', 'fulfilment', 'review']


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gapaw-local-ui-') as temp:
        root = Path(temp).resolve()
        source = root / 'source.sqlite3'
        records = []
        for n in range(3):
            cid = 'GW90' + str(n + 1)
            profile = {'id': cid, 'rank': n + 1, 'handle': 'synthetic_' + cid, 'priority': 'A', 'followers': 10,
                'topic': '合成用品', 'angle': '合成角度', 'anchor1': '合成锚点', 'anchor2': '', 'history': '',
                'prior_invite': False, 'kalodata_window': '', 'affiliate_gmv_usd': 1, 'pet_gmv_share_pct': 1,
                'products': [], 'tiktok_url': 'https://example.invalid/' + cid, 'affiliate_url': 'https://example.invalid/' + cid,
                'history_detail': {}, 'history_snapshot': ''}
            records.append({'profile': profile, 'drafts': [{'channel': c, 'subject': '', 'body': '合成文案 【固定费】 【佣金比例】'} for c in ['comment','dm','email','affiliate','followup']]})
        subprocess.run(['python3', '-B', '-c', 'import json,sys;sys.path.insert(0,sys.argv[1]);from store import Store;Store(sys.argv[2]).init(json.load(sys.stdin))', str(SOURCE), str(source)], input=json.dumps({'source_sha256': 'synthetic-only', 'records': records}), text=True, check=True, capture_output=True)
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        env = {k: v for k, v in os.environ.items() if not k.startswith('MULTICC_PLUGIN_')}
        env['GAPAW_CREATOR_DATA_DIR'] = str(root / 'empty-state')
        control = {'writes': [], 'fail_before': '', 'fail_after': '', 'conflict': False, 'fail_reads': False, 'registry_ok': False, 'registrations': []}

        def plugin(command, payload=None):
            out = subprocess.run([BINARY, command], input=json.dumps(payload or {}), capture_output=True, text=True, env=env, timeout=45, check=True)
            return json.loads(out.stdout)

        def ok(command, payload=None):
            result = plugin(command, payload)
            assert result['ok'], result
            return result['data']

        def detail():
            return ok('workbench-creator', {'creatorId': 'GW901'})

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
                if url.path == '/api/download':
                    file = Path(urllib.parse.parse_qs(url.query).get('path', [''])[0]).resolve()
                    if file.is_file() and file.is_relative_to(root):
                        return self.reply(file.read_bytes(), mime='application/octet-stream')
                    return self.reply({'error': 'outside fixture'}, 403)
                if url.path.startswith('/ui/'):
                    file = (ROOT / url.path.lstrip('/')).resolve()
                    if file.is_file() and file.is_relative_to(ROOT / 'ui'):
                        mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'}[file.suffix]
                        return self.reply(file.read_bytes(), mime=mime + '; charset=utf-8')
                return self.reply({'error': 'unexpected fixture request'}, 404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path == '/api/docs-registry':
                    control['registrations'].append(body)
                    return self.reply({'ok': control['registry_ok']}, 200 if control['registry_ok'] else 503)
                if self.path != '/api/plugins/gapaw-creator-workbench/run':
                    return self.reply({'error': 'unexpected fixture request'}, 404)
                command, value = body['command'], body.get('input', {})
                if control['fail_reads'] and command in ['outreach-status', 'workbench-home', 'local-workbench-status']:
                    return self.reply({'error': '合成读取失败'}, 503)
                if command in ['edit-settings','record-event','record-message','void-event','workbench-export','local-workbench-init','import-workbench']:
                    control['writes'].append({'command': command, 'input': value})
                if control['fail_before'] == command:
                    control['fail_before'] = ''
                    return self.reply({'error': '合成提交前断线'}, 400)
                if command == 'edit-settings' and control['conflict']:
                    control['conflict'] = False
                    c = ok('workbench-fact-contract', {'creatorId': 'GW901'})
                    result = ok('edit-settings', {'creatorId': 'GW901', 'expectedSource': c['expectedSource'], 'expectedRevision': c['settingsRevision'], 'requestId': 'synthetic_other_page', 'confirmed': True, 'basis': '合成另一页确认', 'settings': {'notes': '另一页合作备注'}})
                    assert result['receipt']['status'] == 'saved', result
                result = plugin(command, value)
                if control['fail_after'] == command:
                    control['fail_after'] = ''
                    return self.reply({'error': '合成写成功后丢回应'}, 503)
                self.reply(result['data'] if result['ok'] else result, 200 if result['ok'] else 400)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Host)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = 'http://127.0.0.1:' + str(server.server_address[1]) + '/ui/index.html'
        try:
            with sync_playwright() as p:
                options = {'headless': True}
                chrome = os.environ.get('GAPAW_TEST_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
                if Path(chrome).exists():
                    options['executable_path'] = chrome
                browser = p.chromium.launch(**options)
                try:
                    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.add_init_script("Object.defineProperty(Crypto.prototype, 'randomUUID', {value: undefined});")
                    page.goto(base)

                    def module(name):
                        page.locator('#wb-module-nav [data-module="' + name + '"]').click()
                        expect(page.locator('#wb-module-nav [data-module="' + name + '"]')).to_have_attribute('aria-current', 'step')
                        expect(page.locator('#wb-module-overview')).to_contain_text('可以做什么')
                        return page.locator('[data-module-panel="' + name + '"]')

                    def all_modules():
                        assert page.locator('#wb-module-nav [data-module]').count() == 10
                        for name in MODULES:
                            module(name)
                            assert page.locator('#wb-module-overview').is_visible()

                    # 未建立库时就有一级模块，不自动建库、不要求启动旧服务。
                    expect(page.locator('#wb-notice')).to_contain_text('尚无可用本地数据')
                    all_modules()
                    assert not control['writes']
                    assert page.locator('#wb-url').count() == 0
                    expect(page.locator('#wb-local-init')).to_be_enabled()
                    page.screenshot(path=str(SHOTS / '1-no-data-modules.png'), full_page=True)
                    page.locator('#wb-local-init').click()
                    expect(page.locator('#wb-notice')).to_contain_text('0 位达人')
                    all_modules()
                    assert ok('local-workbench-status')['counts']['creators'] == 0
                    expect(page.locator('#wb-local-init')).to_be_disabled()
                    print('通过：无库与空库均显示十模块，显式初始化本地库', flush=True)
                    context.close()

                    # 另一份全新状态库，通过真实预览与导入将合成业务搬入插件。
                    env['GAPAW_CREATOR_DATA_DIR'] = str(root / 'imported-state')
                    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                    page = context.new_page()
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.add_init_script("Object.defineProperty(Crypto.prototype, 'randomUUID', {value: undefined});")
                    page.goto(base)
                    expect(page.locator('#wb-import-path')).to_be_enabled()
                    page.locator('#wb-import-path').fill(str(source))
                    page.locator('#wb-import-preview').click()
                    expect(page.locator('#wb-import-result')).to_contain_text('达人：3')
                    expect(page.locator('#wb-import-result')).to_contain_text('文案：15')
                    expect(page.locator('#wb-import-result')).to_contain_text(str(source))
                    expect(page.locator('#wb-import-result')).to_contain_text('本地目标：')
                    expect(page.locator('#wb-import-save')).to_be_disabled()
                    assert not any(w['command'] == 'import-workbench' for w in control['writes'])
                    page.locator('#wb-import-confirm').check()
                    control['fail_after'] = 'import-workbench'
                    page.locator('#wb-import-save').click()
                    expect(page.locator('#wb-notice')).to_contain_text('3 位达人')
                    assert page.locator('.wb-row').count() == 3
                    assert len([w for w in control['writes'] if w['command'] == 'import-workbench']) == 1
                    assert 'local-workbench:' not in page.locator('body').inner_text()
                    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
                    page.locator('#wb-data summary').click()
                    module('verification')
                    page.locator('.wb-row-open', has_text='GW901').click()
                    page.wait_for_selector('[data-module-panel="verification"] [data-fact-field="account_checked"]')
                    print('通过：源文件只读预览、明确确认迁入、本地列表真实可见', flush=True)

                    def field(pane, name):
                        return pane.locator('[data-fact-field="' + name + '"]')

                    def confirm(pane, kind):
                        pane.locator('[data-fact-confirm="' + kind + '"]').check()

                    def submit(pane, label, status='saved'):
                        pane.get_by_role('button', name=label, exact=True).click()
                        if status == 'saved':
                            locator = pane.get_by_role('button', name='确认并保存人工设置', exact=True) if pane.locator('[data-fact-basis]').count() else pane.get_by_role('button', name='开始另一条人工登记', exact=True).first
                            expect(locator).to_be_enabled()
                            expect(page.locator('#wb-notice')).to_contain_text('已保存并读回核对')
                        elif status == 'conflict':
                            expect(pane.get_by_role('button', name='读取最新版本并保留我的输入', exact=True)).to_be_visible()
                        elif status == 'unknown':
                            expect(pane.get_by_role('button', name='使用原编号和内容重试', exact=True)).to_be_enabled()
                        elif status == 'rejected':
                            expect(page.locator('#wb-notice')).to_contain_text('未通过校验')
                        if status != 'unknown':
                            page.wait_for_function("!Array.from(document.querySelectorAll('[data-module-panel]:not([hidden]) [data-fact-field]')).some(e => e.disabled)")

                    pane = module('verification')
                    for key in ['account_checked','product_checked','history_checked','channel_ready.dm']:
                        field(pane, key).check()
                    pane.locator('[data-fact-basis]').fill('合成核验依据')
                    confirm(pane, 'verification')
                    submit(pane, '确认并保存人工设置')
                    assert detail()['settings']['account_checked'] is True
                    assert detail()['settings']['commission'] is None
                    pane = module('cooperation')
                    field(pane, 'notes').fill('我的本地合作备注')
                    field(pane, 'commission').fill('12.5')
                    pane.locator('[data-fact-basis]').fill('合成合作依据')
                    confirm(pane, 'cooperation')
                    control['conflict'] = True
                    submit(pane, '确认并保存人工设置', 'conflict')
                    expect(field(pane, 'notes')).to_have_value('我的本地合作备注')
                    pane.get_by_role('button', name='读取最新版本并保留我的输入', exact=True).click()
                    expect(pane).to_contain_text('已读取最新版本，保留你的输入')
                    confirm(pane, 'cooperation')
                    submit(pane, '确认并保存人工设置')
                    assert detail()['settings']['commission'] == 12.5
                    print('通过：本地核验、合作条件、真实冲突及保留输入重新确认', flush=True)

                    pane = module('outreach')
                    field(pane, 'type').select_option('平台受理')
                    field(pane, 'proof').fill('合成平台回执')
                    confirm(pane, 'outreach')
                    submit(pane, '确认并登记事实', 'rejected')
                    assert detail()['events'] == []
                    field(pane, 'type').select_option('发送尝试')
                    confirm(pane, 'outreach')
                    control['fail_after'] = 'record-event'
                    submit(pane, '确认并登记事实', 'unknown')
                    assert len(detail()['events']) == 1
                    count = len([r for r in control['writes'] if r['command'] == 'record-event'])
                    page.reload()
                    pane = module('outreach')
                    expect(pane.get_by_role('button', name='开始另一条人工登记', exact=True)).to_be_visible()
                    assert len([r for r in control['writes'] if r['command'] == 'record-event']) == count
                    pane = module('messages')
                    field(pane, 'body').fill('<script>合成自动回复</script>')
                    field(pane, 'source').fill('synthetic-local-message')
                    field(pane, 'kind').select_option('自动回复')
                    confirm(pane, 'message')
                    control['fail_before'] = 'record-message'
                    submit(pane, '确认并登记往来消息', 'unknown')
                    original = [r for r in control['writes'] if r['command'] == 'record-message'][-1]
                    page.reload()
                    pane = module('messages')
                    retry = pane.get_by_role('button', name='使用原编号和内容重试', exact=True)
                    expect(retry).to_be_enabled()
                    retry.click()
                    expect(pane.get_by_role('button', name='开始另一条人工登记', exact=True)).to_be_visible()
                    assert original == [r for r in control['writes'] if r['command'] == 'record-message'][-1]
                    assert len(detail()['events']) == 1 and len(detail()['messages']) == 1
                    print('通过：本地事件依赖、丢回应恢复、原编号重试与消息事实分离', flush=True)

                    def event(kind, name):
                        pane = module(kind)
                        again = pane.get_by_role('button', name='开始另一条人工登记', exact=True)
                        if again.count():
                            again.first.click()
                        field(pane, 'type').select_option(name)
                        field(pane, 'proof').fill('合成依据：' + name)
                        confirm(pane, kind)
                        submit(pane, '确认并登记事实')
                        return pane

                    for name in ['平台受理','明确已读','有效回复','有意向','确认合作']:
                        event('outreach', name)
                    pane = module('followup')
                    field(pane, 'next_followup').fill('2026-12-01')
                    pane.locator('[data-fact-basis]').fill('合成跟进安排')
                    confirm(pane, 'followup')
                    submit(pane, '确认并保存人工设置')
                    event('fulfilment', '寄样')
                    pane = event('fulfilment', '已发片')
                    pane.locator('.fact-void summary').click()
                    pane.get_by_role('button', name='选择这条记录并填写撤销原因', exact=True).click()
                    field(pane, 'reason').fill('合成错误事实撤销，保留审计')
                    confirm(pane, 'void')
                    submit(pane, '确认并撤销此事实')
                    assert detail()['events'][-1]['void_reason'] == '合成错误事实撤销，保留审计'
                    print('通过：本地完整触达链、跟进、履约与撤销', flush=True)

                    module('review')
                    pane = page.locator('#wb-module-overview')
                    control['fail_after'] = 'workbench-export'
                    pane.get_by_role('button', name='导出全部达人记录', exact=True).click()
                    expect(pane.get_by_role('button', name='用原编号继续导出', exact=True)).to_be_enabled()
                    request = [r for r in control['writes'] if r['command'] == 'workbench-export'][-1]
                    pane.get_by_role('button', name='用原编号继续导出', exact=True).click()
                    expect(pane.locator('.fact-export-link')).to_be_visible()
                    expect(pane.get_by_role('button', name='重试登记文件', exact=True)).to_be_visible()
                    assert request == [r for r in control['writes'] if r['command'] == 'workbench-export'][-1]
                    response = page.request.get(urllib.parse.urljoin(base, pane.locator('.fact-export-link').get_attribute('href')))
                    assert response.status == 200 and response.body().startswith(b'PK'), (response.status, response.body()[:120])
                    control['registry_ok'] = True
                    pane.get_by_role('button', name='重试登记文件', exact=True).click()
                    expect(pane).to_contain_text('已登记到 MultiCC')
                    module('verification')
                    page.screenshot(path=str(SHOTS / '2-local-desktop.png'), full_page=True)
                    print('通过：本地复盘导出、原编号重放、下载与登记恢复', flush=True)

                    # 错误时模块仍可用，恢复后来源不以HTTP地址显示。
                    control['fail_reads'] = True
                    page.locator('#wb-refresh').click()
                    expect(page.locator('#wb-notice')).to_contain_text('数据读取失败')
                    all_modules()
                    control['fail_reads'] = False
                    page.locator('#wb-refresh').click()
                    expect(page.locator('#wb-notice')).to_contain_text('3 位达人')
                    page.set_viewport_size({'width': 390, 'height': 844})
                    for name in MODULES:
                        module(name)
                        assert page.evaluate('document.documentElement.scrollWidth') <= 390, name + '手机横向溢出'
                    module('verification')
                    page.locator('#wb-module-heading').scroll_into_view_if_needed()
                    page.screenshot(path=str(SHOTS / '3-local-mobile.png'))
                    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
                    assert not errors, errors
                    print('通过：错误与恢复状态模块可见、390px十模块无横向溢出、源库未改', flush=True)
                    context.close()
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
    print('本地工作台真实浏览器验收通过：' + str(SHOTS), flush=True)


if __name__ == '__main__':
    main()
