'use strict';
// 真实 Rust 程序与隔离 Unix socket；所有身份、页面和敏感标记均为虚构。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFile } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const protocol = 'gapaw-browser-read-v1';
const secret = 'SOURCE_SECRET_SENTINEL';

async function fixture(t) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序');
  // macOS Unix socket 路径只有104字节，专门使用短隔离测试目录。
  const root = fs.mkdtempSync('/tmp/gwb-');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-bridge-test-')));
  const source = path.join(root, 'p'), data = path.join(root, 'd'), state = path.join(root, 's');
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(data, 'run'), { recursive: true, mode: 0o700 });
  fs.chmodSync(data, 0o700); fs.chmodSync(path.join(data, 'run'), 0o700);
  const marker = path.join(root, 'unexpected-launch');
  fs.writeFileSync(path.join(source, 'bin', 'launcher'), '#!/bin/sh\necho called > ' + marker + '\nexit 97\n', { mode: 0o755 });
  const manifest = { id: 'chrome-proxy-launcher', version: '1.5.0', engine: { type: 'command', binary: 'bin/launcher' }, readOnlyBridge: { protocol } };
  const saveManifest = () => fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest));
  saveManifest();
  const profiles = ['alpha', 'beta'].map(id => ({ id, name: '隔离测试身份', createdAt: 100, updatedAt: 200, proxy: { scheme: 'http', host: secret, port: 8080, username: secret, password: secret } }));
  const saveProfiles = () => fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify(profiles));
  saveProfiles();
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state, GAPAW_CHROME_PLUGIN_DIR: source, GAPAW_CHROME_DATA_DIR: data };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const raw = async (command, input = {}) => {
    const child = execFile(binary, [command], { env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15000 });
    child.stdin.end(JSON.stringify(input));
    return new Promise((resolve, reject) => { let stdout = ''; child.stdout.on('data', x => stdout += x); child.on('error', reject); child.on('close', (code, signal) => { if (code !== 0) return reject(new Error('子进程异常终止：' + signal)); try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } }); });
  };
  const run = async (command, input) => { const result = await raw(command, input); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
  const inventory = await run('browser-status');
  const bind = (id, revision) => run('bind-browser', { profileId: id, expectedRevision: revision, expectedSourceRevision: inventory.environments.find(p => p.id === id).sourceRevision });
  await bind('alpha', 0);
  await run('configure', { workspace: { dirId: 'fixture-dir', path: workspace } });
  let next = 0;
  const prepare = async (create = true) => {
    const operation = (await run('prepare-operation', { requestId: 'request-' + (++next), prompt: '请核验页面资料', runtime: { cli: 'codex' } })).operation;
    const taskId = 'task-' + next;
    if (create) await run('record-dispatch', { operationId: operation.id, stage: 'created', response: { taskId, sessionId: 'session-' + next, shellId: 'shell-' + next, url: '/air?task=' + taskId } });
    return { operationId: operation.id, taskId };
  };
  const owner = await prepare();
  const instanceId = crypto.randomUUID();
  const requests = [], sockets = new Set(), servers = [];
  const page = { targetId: 'target-one', title: '达人资料', url: 'https://kalodata.com/creator/one', platform: 'kalodata' };
  const response = req => ({ ok: true, data: { protocol, requestId: req.requestId, profileId: req.profileId, sourceRevision: req.sourceRevision, action: req.action, instanceId, ...(req.action === 'pages' ? { pages: [{ ...page, proxy: secret }] } : req.action === 'read-page' ? { page: { ...page, text: '虚构页面资料，不代表结构化平台采集', truncated: false, cookies: secret } } : {}), privatePath: secret } });
  async function listen(handler = (req, socket) => socket.end(JSON.stringify(response(req)) + '\n'), id = 'alpha') {
    const socketPath = path.join(data, 'run', 'read-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 16) + '.sock');
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      let text = ''; socket.on('data', chunk => { text += chunk; if (text.includes('\n')) { socket.removeAllListeners('data'); const req = JSON.parse(text.trim()); requests.push(req); handler(req, socket); } });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600); servers.push(server);
    return { server, socketPath };
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { root, source, data, state, marker, raw, run, manifest, saveManifest, profiles, saveProfiles, owner, prepare, bind, instanceId, response, requests, page, listen };
}
function safeFailure(response, f) { assert.equal(response.ok, false); assert.ok(!JSON.stringify(response).includes(secret)); assert.ok(!JSON.stringify(response).includes(f.root)); }
function dbDigest(f) { return crypto.createHash('sha256').update(fs.readFileSync(path.join(f.state, 'state.sqlite'))).digest('hex'); }

test('只读探测、页面清单与页面正文成功，投影脱敏且不写数据库', async t => {
  const f = await fixture(t); await f.listen(); const before = dbDigest(f);
  const probe = await f.run('browser-probe');
  assert.equal(probe.status, 'connected'); assert.equal(probe.scope, 'default'); assert.equal(probe.bindingRevision, 1); assert.equal(probe.profileId, 'alpha');
  assert.equal(probe.canCollectPlatforms, false);
  const pages = await f.run('browser-pages', f.owner);
  assert.equal(pages.scope, 'operation'); assert.equal(pages.operationId, f.owner.operationId); assert.equal(pages.taskId, f.owner.taskId); assert.equal(pages.bindingRevision, 1); assert.equal(pages.instanceId, f.instanceId);
  assert.deepEqual(pages.pages, [f.page]); assert.equal(pages.untrustedContent, true);
  const read = await f.run('browser-read-page', { ...f.owner, targetId: 'target-one', expectedInstanceId: pages.instanceId });
  assert.match(read.page.text, /虚构页面资料/); assert.equal(read.page.truncated, false); assert.equal(read.canCollectPlatforms, false);
  assert.ok(!JSON.stringify(read).includes(secret)); assert.equal(f.requests[2].expectedInstanceId, f.instanceId);
  assert.equal(dbDigest(f), before); assert.equal(fs.existsSync(f.marker), false);
});

test('页面读取必须归属原任务，默认身份切换不改变旧任务', async t => {
  const f = await fixture(t); await f.listen(); await f.bind('beta', 1);
  const old = await f.run('browser-pages', f.owner); assert.equal(old.profileId, 'alpha'); assert.equal(old.bindingRevision, 1);
  safeFailure(await f.raw('browser-pages', { ...f.owner, taskId: 'another-task' }), f);
  safeFailure(await f.raw('browser-pages'), f);
  const pending = await f.prepare(false); safeFailure(await f.raw('browser-pages', pending), f);
  assert.equal(f.requests.length, 1);
});

test('文件检测绝不探测，旧来源明确需要升级且禁止连接', async t => {
  const f = await fixture(t); await f.listen();
  const status = await f.run('browser-status'); assert.equal(status.checks.find(c => c.id === 'bridge').status, 'probe_available'); assert.equal(f.requests.length, 0);
  delete f.manifest.readOnlyBridge; f.saveManifest();
  const old = await f.run('browser-status'); assert.equal(old.checks.find(c => c.id === 'bridge').status, 'requires_upgrade');
  safeFailure(await f.raw('browser-probe'), f); assert.equal(f.requests.length, 0);
  f.manifest.readOnlyBridge = { protocol: 'unsupported' }; f.saveManifest(); safeFailure(await f.raw('browser-pages', f.owner), f); assert.equal(f.requests.length, 0);
});

test('协议、请求、身份、版本、动作和实例不匹配均拒绝且隐藏对端错误', async t => {
  const f = await fixture(t); let mode;
  await f.listen((req, socket) => { const out = f.response(req); if (mode === 'error') { out.ok = false; out.error = secret + f.root; } else out.data[mode] = mode === 'instanceId' ? crypto.randomUUID() : secret; socket.end(JSON.stringify(out) + '\n'); });
  for (mode of ['protocol', 'requestId', 'profileId', 'sourceRevision', 'action', 'instanceId', 'error']) {
    safeFailure(await f.raw('browser-read-page', { ...f.owner, targetId: 'target-one', expectedInstanceId: f.instanceId }), f);
  }
});

test('非法页面地址、平台、页面ID与重复页面不能流出', async t => {
  const f = await fixture(t); let mode;
  await f.listen((req, socket) => { const out = f.response(req); if (mode === 'target') out.data.page.targetId = 'different'; else if (mode === 'platform') out.data.page.platform = 'affiliate'; else if (mode === 'duplicate') out.data.pages.push(out.data.pages[0]); else out.data.page.url = mode; socket.end(JSON.stringify(out) + '\n'); });
  for (mode of ['https://kalodata.com/?secret=' + secret, 'https://user:secret@kalodata.com/', 'https://kalodata.com/#secret', 'https://kalodata.com:9876/', 'https://evil.invalid/', 'http://kalodata.com/', 'target', 'platform']) {
    safeFailure(await f.raw('browser-read-page', { ...f.owner, targetId: 'target-one', expectedInstanceId: f.instanceId }), f);
  }
  mode = 'duplicate'; safeFailure(await f.raw('browser-pages', f.owner), f);
});

test('任意路径、CDP动作和多余输入字段不会发往来源', async t => {
  const f = await fixture(t); await f.listen();
  for (const extra of [{ socketPath: '/tmp/evil.sock' }, { action: 'Runtime.evaluate' }, { targetId: 'target-one' }, { cdp: { method: 'Network.getAllCookies' } }]) safeFailure(await f.raw('browser-pages', { ...f.owner, ...extra }), f);
  safeFailure(await f.raw('browser-read-page', { ...f.owner, targetId: '../unsafe', expectedInstanceId: f.instanceId }), f);
  safeFailure(await f.raw('browser-read-page', { ...f.owner, targetId: 'target-one' }), f);
  assert.equal(f.requests.length, 0);
});

test('来源元数据变化阻止连接，读取期间原字节变化丢弃正文', async t => {
  const f = await fixture(t);
  await f.listen((req, socket) => { f.profiles[0].proxy.password = 'changed-without-timestamp'; f.saveProfiles(); socket.end(JSON.stringify(f.response(req)) + '\n'); });
  f.profiles[0].updatedAt++; f.saveProfiles(); safeFailure(await f.raw('browser-pages', f.owner), f); assert.equal(f.requests.length, 0);
  f.profiles[0].updatedAt--; f.saveProfiles(); safeFailure(await f.raw('browser-read-page', { ...f.owner, targetId: 'target-one', expectedInstanceId: f.instanceId }), f); assert.equal(f.requests.length, 1);
});

test('不安全权限、符号链接和非socket端点不连接', async t => {
  const f = await fixture(t); const { socketPath } = await f.listen();
  fs.chmodSync(socketPath, 0o666); safeFailure(await f.raw('browser-probe'), f); fs.chmodSync(socketPath, 0o600);
  fs.chmodSync(path.join(f.data, 'run'), 0o777); safeFailure(await f.raw('browser-probe'), f); fs.chmodSync(path.join(f.data, 'run'), 0o700);
  const moved = socketPath + '.actual'; fs.renameSync(socketPath, moved); fs.symlinkSync(moved, socketPath); safeFailure(await f.raw('browser-probe'), f);
  fs.unlinkSync(socketPath); fs.writeFileSync(socketPath, secret, { mode: 0o600 }); safeFailure(await f.raw('browser-probe'), f); fs.unlinkSync(socketPath); fs.renameSync(moved, socketPath);
  assert.equal(f.requests.length, 0);
});

test('超大和格式错误回应被限制，逐字节慢响应也受总deadline约束', async t => {
  const f = await fixture(t); let mode = 'large';
  await f.listen((req, socket) => { if (mode === 'large') socket.end('x'.repeat(512 * 1024 + 1)); else if (mode === 'invalid') socket.end(secret + '\n'); else if (mode === 'extra') socket.end(JSON.stringify(f.response(req)) + '\n' + secret); else { const timer = setInterval(() => socket.write(' '), 50); socket.once('close', () => clearInterval(timer)); } });
  safeFailure(await f.raw('browser-probe'), f); mode = 'invalid'; safeFailure(await f.raw('browser-probe'), f); mode = 'extra'; safeFailure(await f.raw('browser-probe'), f);
  mode = 'slow'; const started = Date.now(); const result = await f.raw('browser-probe'); safeFailure(result, f); assert.match(result.error, /超时/); assert.ok(Date.now() - started < 13000);
});
