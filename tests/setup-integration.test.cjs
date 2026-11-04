'use strict';
// 连接与设置：真实 Rust 程序 + 合成飞书命令行，不访问真实邮箱，不发送任何邮件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const fake = path.join(__dirname, 'fixtures', 'fake-lark-cli.cjs');

function fixture(t, initial = {}) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'lark.json');
  const set = patch => fs.writeFileSync(stateFile, JSON.stringify({ ...(fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}), ...patch }));
  set({ auth: 'ok', mailboxes: ['shop@example.com', 'other@example.com'], ...initial });
  fs.chmodSync(fake, 0o755);
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: path.join(root, 'state'), GAPAW_LARK_CLI: fake, FAKE_LARK_STATE: stateFile, GAPAW_LARK_SEND_TIMEOUT_SECS: '3' };
  for (const k of Object.keys(env)) if (k.startsWith('MULTICC_PLUGIN_')) delete env[k];
  const run = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { input: JSON.stringify(input), env, timeout: 120000 }).toString());
  const ok = (command, input) => { const r = run(command, input); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const fail = (command, input) => { const r = run(command, input); assert.equal(r.ok, false, JSON.stringify(r)); return r.error; };
  const calls = () => fs.existsSync(path.join(root, 'calls.jsonl')) ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const sends = () => calls().filter(a => a[1] === '+send').length;
  const lark = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { root, set, run, ok, fail, calls, sends, lark };
}
function configure(f) {
  f.ok('mail-status');
  const v = f.ok('setup-status', { brief: true }).version;
  return f.ok('setup-save', { expectedVersion: v, values: { senderMailbox: 'shop@example.com', testRecipient: 'tester@test.example' } });
}

test('检测登录只返回安全字段，可访问邮箱用于选择发件邮箱', t => {
  const f = fixture(t, { tip: true });
  const s = f.ok('mail-status');
  assert.equal(s.login.state, 'signed_in');
  assert.equal(s.login.userName, '合成用户');
  assert.deepEqual(s.mailboxes.map(m => m.address), ['shop@example.com', 'other@example.com']);
  const text = JSON.stringify(f.ok('setup-status', { brief: true }));
  for (const secret of ['SECRET_ACCESS_TOKEN', 'ou_secret_open_id']) {
    assert.ok(!JSON.stringify(s).includes(secret) && !text.includes(secret), '不得外泄 ' + secret);
    const db = fs.readFileSync(path.join(f.root, 'state', 'state.sqlite'));
    assert.ok(!db.includes(Buffer.from(secret)), '状态库不得保存 ' + secret);
  }
  assert.equal(f.ok('setup-status', { brief: true }).items.find(i => i.id === 'mailLogin').state, 'ok');
  assert.match(f.fail('setup-save', { expectedVersion: 0, values: { senderMailbox: 'nobody@example.com' } }), /不在/);
});

test('登录过期、缺少邮件权限、命令行缺失或输出异常时给出可处理的状态', t => {
  const f = fixture(t, { auth: 'expired' });
  let s = f.ok('mail-status');
  assert.equal(s.login.state, 'expired');
  assert.deepEqual(s.mailboxes, []);
  assert.equal(f.ok('setup-status', { brief: true }).items.find(i => i.id === 'mailLogin').state, 'action');
  f.set({ auth: 'ok', scope: 'mail:user_mailbox.message:readonly' });
  s = f.ok('mail-status');
  assert.equal(s.login.canSend, false);
  assert.match(s.message, /缺少邮件读取或发送权限/);
  f.set({ auth: 'garbage' });
  assert.equal(f.ok('mail-status').login.state, 'error');
  const missing = JSON.parse(execFileSync(binary, ['mail-status'], { input: '{}', env: { ...process.env, GAPAW_CREATOR_DATA_DIR: path.join(f.root, 'state2'), GAPAW_LARK_CLI: path.join(f.root, 'absent') } }).toString());
  assert.equal(missing.data.installed, false);
});

test('测试信：受理 → 投递 → 收到回信后通过，并解锁正式模式', t => {
  const f = fixture(t, { delivery: 1 });
  assert.match(f.fail('mail-test', { action: 'send' }), /先保存/);
  const saved = configure(f);
  const sent = f.ok('mail-test', { action: 'send', expectedVersion: saved.version });
  assert.equal(sent.state, 'accepted');
  assert.equal(sent.messageId, 'MID1');
  assert.match(sent.subject, /GW-[0-9A-F]{8}/);
  const sendArgs = f.calls().find(a => a[1] === '+send');
  assert.equal(sendArgs[sendArgs.indexOf('--to') + 1], 'tester@test.example', '只能发往测试收件邮箱');
  assert.ok(sendArgs.includes('--confirm-send') && sendArgs.includes('--plain-text'));
  f.set({ delivery: 4 });
  assert.equal(f.ok('mail-test', { action: 'check' }).state, 'delivered');
  assert.match(f.fail('setup-save', { expectedVersion: saved.version, values: { mode: 'live' }, confirmLive: true }), /收发测试/);
  f.set({ reply: true });
  const checked = f.ok('mail-test', { action: 'check' });
  assert.equal(checked.state, 'replied');
  const status = f.ok('setup-status', { brief: true });
  assert.equal(status.items.find(i => i.id === 'testRecipient').state, 'ok');
  assert.equal(status.features.mailSend.blockers.join(), 'data');
  assert.equal(f.ok('setup-save', { expectedVersion: saved.version, values: { mode: 'live' }, confirmLive: true }).values.mode, 'live');
  assert.equal(f.sends(), 1);
});

test('别人的回信不算；退信与禁止自动发送分别提示', t => {
  const f = fixture(t, { reply: true, replyFrom: 'stranger@else.example' });
  configure(f);
  f.ok('mail-test', { action: 'send' });
  assert.equal(f.ok('mail-test', { action: 'check' }).state, 'delivered');
  f.set({ delivery: 3 });
  f.ok('mail-test', { action: 'send' });
  assert.equal(f.ok('mail-test', { action: 'check' }).state, 'bounced');
  f.set({ send: 'blocked' });
  const blocked = f.ok('mail-test', { action: 'send' });
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.error, /禁止自动发送/);
  assert.equal(f.ok('setup-status', { brief: true }).items.find(i => i.id === 'sender').state, 'action');
});

test('发送结果未知时禁止重发，核对已发送文件夹后再决定', t => {
  const f = fixture(t, { send: 'error' });
  configure(f);
  const unknown = f.ok('mail-test', { action: 'send' });
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.error, /不会自动重发/);
  assert.match(f.fail('mail-test', { action: 'send' }), /先点“检查回信”/);
  assert.equal(f.sends(), 1);
  // 已发送文件夹里找不到，才允许重新发送。
  assert.equal(f.ok('mail-test', { action: 'check' }).state, 'not_sent');
  f.set({ send: 'ok', sentFolder: true, delivery: 1 });
  assert.equal(f.ok('mail-test', { action: 'send' }).state, 'accepted');
  assert.equal(f.sends(), 2);
});

test('结果未知但邮件其实已发出：核对后接回原邮件，不重发', t => {
  const f = fixture(t, { sentFolder: true });
  configure(f);
  f.ok('mail-test', { action: 'send' });
  // 模拟“发出后丢失回应”：把记录改回未知并去掉邮件编号。
  const Database = path.join(f.root, 'state', 'state.sqlite');
  execFileSync('sqlite3', [Database, "UPDATE settings SET value=json_set(json_set(value,'$.state','unknown'),'$.messageId',json('null')) WHERE key='setup_mail_test'"]);
  assert.match(f.fail('mail-test', { action: 'send' }), /先点“检查回信”/);
  const checked = f.ok('mail-test', { action: 'check' });
  assert.equal(checked.messageId, 'MID1');
  assert.equal(checked.state, 'delivered');
  assert.equal(f.sends(), 1);
});

test('发送超时按结果未知处理', t => {
  const f = fixture(t, { send: 'hang' });
  configure(f);
  const r = f.ok('mail-test', { action: 'send' });
  assert.equal(r.state, 'unknown');
  assert.match(r.error, /超时/);
});
