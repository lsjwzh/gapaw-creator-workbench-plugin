'use strict';
// 合成宿主与真实 Rust 程序；只允许发现和 list 两种请求，不启动浏览器。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const secret = 'SYNTHETIC_SECRET_NEVER_RETURN';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-public-catalog-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-public-catalog-')));
  const config = { version: '1.6.3', commands: ['list'], available: true, response: 200, redirect: false,
    profiles: [{ id: 'alpha', name: '合成实例', createdAt: 1, updatedAt: 2, running: true, proxy: { password: secret }, note: secret, subscription: { id: 'sub', node: secret } }],
    subscriptions: [{ id: 'sub', updatedAt: 3, sourceBytes: 10, url: secret }] };
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    calls.push([req.method, req.url, Buffer.concat(chunks).toString()]);
    res.setHeader('Content-Type', 'application/json');
    if (config.redirect) { res.writeHead(302, { Location: '/must-not-follow' }); return res.end('{}'); }
    if (config.response !== 200) { res.statusCode = config.response; return res.end(JSON.stringify({ error: secret })); }
    if (req.method === 'GET' && req.url === '/api/plugins') return res.end(JSON.stringify({ plugins: [{ id: 'chrome-proxy-launcher', version: config.version, commands: config.commands, engine: { available: config.available } }] }));
    if (req.method === 'POST' && req.url === '/api/plugins/chrome-proxy-launcher/run') {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { command: 'list', input: {} });
      return res.end(JSON.stringify({ profiles: config.profiles, subscriptions: config.subscriptions, extra: secret }));
    }
    res.statusCode = 500; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: path.join(root, 'state'), GAPAW_BROWSER_HOST_URL: 'http://127.0.0.1:' + server.address().port,
    GAPAW_CHROME_PLUGIN_DIR: path.join(root, 'must-not-read'), GAPAW_CHROME_DATA_DIR: path.join(root, 'must-not-read') };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const raw = (command, input = {}) => new Promise((resolve, reject) => {
    const p = execFile(binary, [command], { env, encoding: 'utf8', timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      try { assert.equal(stderr, ''); assert.ok(!stdout.includes(secret)); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }); p.stdin.end(JSON.stringify(input));
  });
  const run = async (c, p) => { const r = await raw(c, p); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  return { config, calls, env, root, workspace, raw, run };
}

test('公开清单支持1.6.3及同契约的新产品版本，只返回安全字段且状态读取不落库', async t => {
  const f = await fixture(t);
  for (const version of ['1.6.3', '9.0.0']) {
    f.config.version = version;
    const s = await f.run('browser-status');
    assert.equal(s.source.version, version); assert.equal(s.source.available, true); assert.equal(s.source.catalogTransport, 'host-command');
    assert.equal(s.environments.length, 1); assert.equal(s.environments[0].processState, 'pid_alive');
    assert.equal(s.environments[0].sourceRevision.confidence, 'public_metadata');
    assert.deepEqual(Object.keys(s.environments[0]).sort(), ['id', 'name', 'processState', 'sourceRevision']);
    assert.equal(s.canCollectPlatforms, false); assert.equal(s.checks.find(c => c.id === 'bridge').status, 'not_integrated');
  }
  assert.equal(fs.existsSync(f.env.GAPAW_CREATOR_DATA_DIR), false);
  assert.equal(f.calls.length, 4);
});

test('公开绑定保留版本并发检查、原任务冻结身份和来源变更检查', async t => {
  const f = await fixture(t);
  const s = await f.run('browser-status'), revision = s.environments[0].sourceRevision;
  const payload = { profileId: 'alpha', expectedRevision: 0, expectedSourceRevision: revision };
  assert.equal((await f.run('bind-browser', payload)).binding.revision, 1);
  assert.equal((await f.raw('bind-browser', payload)).ok, false);
  await f.run('configure', { workspace: { dirId: 'synthetic-dir', path: f.workspace } });
  const op = (await f.run('prepare-operation', { requestId: 'synthetic-op', prompt: '仅合成选人', runtime: { cli: 'codex' } })).operation;
  await f.run('bind-browser', { profileId: null, expectedRevision: 1 });
  assert.equal((await f.run('browser-status', { operationId: op.id })).bindingState, 'bound');
  f.config.profiles[0].updatedAt++;
  assert.equal((await f.run('browser-status', { operationId: op.id })).bindingState, 'changed');
  assert.equal((await f.raw('bind-browser', { ...payload, expectedRevision: 2 })).ok, false);
  f.config.profiles = [];
  assert.equal((await f.run('browser-status', { operationId: op.id })).bindingState, 'missing');
});

test('缺命令、宿主拒绝、重定向和不可执行不回退私有文件，不泄漏来源错误', async t => {
  const f = await fixture(t);
  f.config.commands = [];
  assert.equal((await f.run('browser-status')).source.supported, false);
  assert.equal(f.calls.length, 1);
  f.config.commands = ['list']; f.config.available = false;
  assert.equal((await f.run('browser-status')).source.available, false);
  for (const code of [401, 403, 500]) {
    f.config.response = code;
    const status = await f.run('browser-status');
    assert.equal(status.bindingState, 'unavailable');
    assert.equal(status.source.installed, null); // 查询失败不能冒充未安装。
  }
  f.config.response = 200; f.config.redirect = true;
  assert.equal((await f.run('browser-status')).source.available, false);
  assert.ok(f.calls.every(c => c[1] !== '/must-not-follow'));
});

test('空清单与坏清单明确区分；未知新增字段可兼容，缺失身份版本或重复身份拒绝', async t => {
  const f = await fixture(t), p = f.config.profiles[0];
  f.config.profiles = []; assert.equal((await f.run('browser-status')).source.available, true);
  for (const profiles of [null, [p, p], [{ ...p, id: '../bad' }], [{ ...p, updatedAt: null }], [{ ...p, running: 'true' }]]) {
    f.config.profiles = profiles; const s = await f.run('browser-status'); assert.equal(s.source.available, false); assert.deepEqual(s.environments, []);
  }
  f.config.profiles = [{ ...p, futureField: secret }]; assert.equal((await f.run('browser-status')).source.available, true);
  f.config.subscriptions = []; assert.equal((await f.run('browser-status')).source.available, false);
});

test('公开模式不使用旧桥接控制管道，非本机地址在发请求前拒绝', async t => {
  const f = await fixture(t);
  for (const c of ['browser-probe', 'browser-pages', 'browser-read-page']) assert.equal((await f.raw(c)).ok, false);
  assert.equal(f.calls.length, 0);
  for (const url of ['https://example.invalid', 'http://127.0.0.1:3000/path', 'http://user:password@127.0.0.1:3000']) {
    f.env.GAPAW_BROWSER_HOST_URL = url; assert.equal((await f.run('browser-status')).source.available, false);
  }
  assert.equal(f.calls.length, 0);
});
