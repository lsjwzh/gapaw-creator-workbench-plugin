'use strict';
// 真实 Rust 适配器＋隔离的 Chrome 1.5 存储。哨兵均为虚构字符串。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';

function fixture(t) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-browser-integration-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-browser-integration-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  const source = path.join(root, 'chrome-proxy-launcher'), data = path.join(root, 'chrome-data'), state = path.join(root, 'plugin-state');
  const platform = process.platform + '-' + process.arch;
  fs.mkdirSync(path.join(source, 'bin', platform), { recursive: true }); fs.mkdirSync(path.join(data, 'run'), { recursive: true });
  const marker = path.join(root, 'unexpected-launcher-call');
  const program = path.join(source, 'bin', platform, 'chrome-proxy-launcher');
  fs.writeFileSync(program, '#!/usr/bin/env python3\nfrom pathlib import Path\nPath(' + JSON.stringify(marker) + ').write_text("called")\nraise SystemExit(97)\n', { mode: 0o755 });
  const manifest = { schema: 1, id: 'chrome-proxy-launcher', version: '1.5.0', name: '测试出口插件',
    engine: { type: 'command', binary: 'bin/chrome-proxy-launcher', binaryPlatformDir: 'bin' }, commands: ['list'], ui: 'ui/index.html' };
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest));
  const profiles = ['alpha', 'beta'].map((id, i) => ({ id, name: '隔离测试身份' + i, createdAt: 100, updatedAt: 200,
    proxy: { scheme: 'http', host: 'proxy-host-sentinel.invalid', port: 12345, username: 'USERNAME_SENTINEL', password: 'PASSWORD_SENTINEL' },
    note: 'NOTE_SENTINEL', chromePath: '/CHROME_PATH_SENTINEL' }));
  const writeProfiles = () => fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify(profiles));
  writeProfiles();
  fs.writeFileSync(path.join(data, 'subscriptions.json'), '[]');
  fs.writeFileSync(path.join(data, 'run', 'alpha.pid'), String(process.pid));
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state, GAPAW_CHROME_PLUGIN_DIR: source, GAPAW_CHROME_DATA_DIR: data };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const raw = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  const run = (command, input = {}) => { const response = raw(command, input); assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };
  const bind = (id, revision, observed) => run('bind-browser', { profileId: id, expectedRevision: revision, ...(id ? { expectedSourceRevision: observed } : {}) }).binding;
  const configure = () => run('configure', { workspace: { dirId: 'fixture-dir', path: workspace } });
  const prepare = requestId => run('prepare-operation', { requestId, prompt: '按确认数据选人。', runtime: { cli: 'codex-exp' } }).operation;
  return { root, source, data, state, profiles, writeProfiles, manifest, marker, raw, run, bind, configure, prepare };
}

function snapshotFiles(directory) {
  const result = {};
  function walk(p) { for (const entry of fs.readdirSync(p, { withFileTypes: true })) { const file = path.join(p, entry.name); if (entry.isDirectory()) walk(file); else { const info = fs.statSync(file); result[path.relative(directory, file)] = { hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mode: info.mode, mtime: info.mtimeMs }; } } }
  walk(directory); return result;
}

test('环境检测只读脱敏：不运行来源程序、不创建状态库、不把PID存活当平台就绪', t => {
  const f = fixture(t), before = snapshotFiles(f.data);
  const status = f.run('browser-status');
  assert.equal(status.source.supported, true); assert.equal(status.environments.length, 2);
  assert.equal(status.environments[0].processState, 'pid_alive');
  assert.equal(status.bindingState, 'unbound'); assert.equal(status.canCollectPlatforms, false);
  assert.equal(status.canDispatchTask, true);
  for (const sentinel of ['PASSWORD_SENTINEL', 'USERNAME_SENTINEL', 'proxy-host-sentinel', 'CHROME_PATH_SENTINEL', 'NOTE_SENTINEL']) assert.ok(!JSON.stringify(status).includes(sentinel));
  assert.equal(fs.existsSync(f.state), false); assert.equal(fs.existsSync(f.marker), false);
  assert.deepEqual(snapshotFiles(f.data), before);
});

test('默认环境切换、改绑检测和解绑均不会重写原任务快照', t => {
  const f = fixture(t), status = f.run('browser-status');
  f.bind('alpha', 0, status.environments[0].sourceRevision); f.configure();
  const original = f.prepare('original');
  assert.equal(original.browser.profile.id, 'alpha');
  assert.match(original.dispatch.message.text, /browser-status/);
  assert.ok(!original.dispatch.message.text.includes('PASSWORD_SENTINEL'));
  f.bind('beta', 1, status.environments[1].sourceRevision);
  assert.deepEqual(f.prepare('original'), original);
  assert.equal(f.prepare('new').browser.profile.id, 'beta');
  assert.equal(f.run('browser-status', { operationId: original.id }).binding.profile.id, 'alpha');
  f.profiles[0].updatedAt++;
  f.writeProfiles();
  assert.equal(f.run('browser-status', { operationId: original.id }).bindingState, 'changed');
  assert.equal(f.raw('bind-browser', { profileId: 'alpha', expectedRevision: 2, expectedSourceRevision: status.environments[0].sourceRevision }).ok, false);
  assert.equal(f.run('browser-status').binding.profile.id, 'beta');
  f.profiles.shift(); f.writeProfiles();
  assert.equal(f.run('browser-status', { operationId: original.id }).bindingState, 'missing');
  f.bind(null, 2);
  assert.equal(f.prepare('unbound').browser.profile, null);
  assert.equal(f.run('browser-status', { operationId: original.id }).binding.profile.id, 'alpha');
});

test('来源损坏、版本不支持与路径穿越身份必须显示不可检测，仍允许发任务补资料', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.data, 'profiles.json'), '{PASSWORD_SENTINEL');
  const invalid = f.run('browser-status');
  assert.equal(invalid.bindingState, 'unavailable');
  assert.ok(!JSON.stringify(invalid).includes('PASSWORD_SENTINEL'));
  f.configure(); assert.equal(f.prepare('source-unavailable').browser.profile, null);
  f.writeProfiles(); f.manifest.version = '9.0.0';
  fs.writeFileSync(path.join(f.source, 'plugin.json'), JSON.stringify(f.manifest));
  assert.equal(f.run('browser-status').source.supported, false);
  f.manifest.version = '1.5.0'; fs.writeFileSync(path.join(f.source, 'plugin.json'), JSON.stringify(f.manifest));
  f.profiles[0].id = '../outside'; f.writeProfiles();
  assert.equal(f.run('browser-status').bindingState, 'unavailable');
  assert.equal(fs.existsSync(f.marker), false);
});
