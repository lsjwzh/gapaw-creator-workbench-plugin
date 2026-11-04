'use strict';
// 发件箱：真实 Rust 程序 + 合成飞书命令行；不访问真实邮箱，不发送任何邮件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const fake = path.join(__dirname, 'fixtures', 'fake-lark-cli.cjs');

function fixture(t, initial = {}) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-outbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'lark.json');
  const set = patch => fs.writeFileSync(stateFile, JSON.stringify({ ...(fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}), ...patch }));
  set({ auth: 'ok', mailboxes: ['shop@example.com'], delivery: 5, ...initial });
  fs.chmodSync(fake, 0o755);
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: path.join(root, 'state'), GAPAW_LARK_CLI: fake, FAKE_LARK_STATE: stateFile, GAPAW_LARK_SEND_TIMEOUT_SECS: '1', GAPAW_OUTBOX_SETTLE_SECS: '0' };
  for (const k of Object.keys(env)) if (k.startsWith('MULTICC_PLUGIN_')) delete env[k];
  const run = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { input: JSON.stringify(input), env, timeout: 120000 }).toString());
  const ok = (command, input) => { const r = run(command, input); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const fail = (command, input) => { const r = run(command, input); assert.equal(r.ok, false, JSON.stringify(r)); return r.error; };
  const calls = () => fs.existsSync(path.join(root, 'calls.jsonl')) ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const lark = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const db = path.join(root, 'state', 'workbench.sqlite');
  const sql = text => execFileSync('sqlite3', [db, text]);
  const start = (command, input = {}) => {
    const child = spawn(binary, [command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve(signal ? { signal } : JSON.parse(output)));
    });
    child.stdin.end(JSON.stringify(input));
    return { child, done };
  };
  return { root, set, run, ok, fail, calls, lark, db, sql, start };
}

function configure(f) {
  f.ok('mail-status');
  const version = f.ok('setup-status', { brief: true }).version;
  return f.ok('setup-save', { expectedVersion: version, values: { senderMailbox: 'shop@example.com', testRecipient: 'tester@test.example' } });
}

function seed(f, { settings = '{"email":"creator@example.com","fee":"$100","sender":"Gapaw Team"}', subject = '合作咨询' } = {}) {
  f.ok('local-workbench-init', { confirmed: true });
  f.sql(`INSERT INTO creators(id,handle,profile,settings) VALUES('C1','creator_one','{}','${settings.replace(/'/g, "''")}')`);
  if (subject) f.sql(`INSERT INTO messages(id,creator,channel,direction,at,subject,body,kind,source) VALUES('m1','C1','email','in','2026-10-20T09:00:00Z','${subject}','您好，想了解一下合作。','正常','lark-mail:ORIG1')`);
}

function draftCount(f) { return f.calls().filter(a => a[1] === '+draft-create' || a[1] === '+reply').length; }
function draftSends(f) { return f.calls().filter(a => a[1] === '+draft-send').length; }

test('测试模式：保存 → 发送 → 核对 → 测试收件人回信被记录', t => {
  const f = fixture(t, { delivery: 5 });
  configure(f); seed(f);
  const saved = f.ok('outbox-save', { clientId: 'client-abc-1', creatorId: 'C1', subject: '合作报价', body: '您好，固定费是【固定费】，期待合作。', asReply: true });
  assert.equal(saved.state, 'draft');
  assert.equal(saved.reply_to, 'ORIG1', '默认作为最近一封来信的回复');
  assert.equal(saved.preview.subject, '合作报价');
  assert.equal(saved.preview.body, '您好，固定费是$100，期待合作。');
  assert.deepEqual(saved.blocking, []);

  // 重复保存同一 clientId 只更新/返回同一封，不新建。
  const again = f.ok('outbox-save', { clientId: 'client-abc-1', creatorId: 'C1', subject: '合作报价', body: '您好，固定费是【固定费】，期待合作。', asReply: true });
  assert.equal(again.id, saved.id);
  assert.equal(f.ok('outbox-list', { creatorId: 'C1' }).entries.length, 1);

  const sent = f.ok('outbox-send', { id: again.id, revision: again.revision });
  assert.equal(sent.state, 'accepted');
  assert.equal(sent.recipient, 'tester@test.example');
  assert.match(sent.final_subject, /^\[测试 GWT-[0-9A-F]{8}\] 合作报价$/);
  assert.match(sent.final_body, /【测试邮件】/);

  const calls = f.calls();
  assert.equal(draftCount(f), 1);
  assert.equal(draftSends(f), 1);
  assert.equal(calls.filter(a => a[1] === '+send').length, 0, '发件箱不得使用 +send');
  const createArgs = calls.find(a => a[1] === '+draft-create');
  assert.equal(createArgs[createArgs.indexOf('--to') + 1], 'tester@test.example', '测试模式只能发往测试收件邮箱');
  assert.ok(createArgs.includes('--plain-text') && createArgs.includes('--no-signature'));

  // 测试收件人回信只记在发件记录上。
  f.set({ reply: true, delivery: 4, replyBody: '收到，报价可以。' });
  const checked = f.ok('outbox-check', { id: again.id });
  assert.equal(checked.state, 'delivered');
  assert.equal(checked.reply_subject, 'Re: ' + sent.final_subject);
  assert.equal(checked.reply_at, '2026-11-04 10:00');
  assert.match(checked.reply_body, /收到，报价可以/);

  const listed = f.ok('outbox-list', { creatorId: 'C1' });
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].reply_body, '收到，报价可以。');
  assert.equal(listed.counts.draft, 0);
  assert.equal(listed.counts.delivered, 1);
  assert.equal(listed.gate.mode, 'test');
  assert.equal(listed.gate.canSend, true);

  assert.match(f.fail('outbox-send', { id: again.id, revision: checked.revision }), /已经发出|不能再发送/);
  assert.equal(draftSends(f), 1, '重复发送不得再次调用草稿发送');
});

test('重复点发送被拒且草稿发送只调用一次', t => {
  const f = fixture(t, { delivery: 4 });
  configure(f); seed(f);
  const saved = f.ok('outbox-save', { clientId: 'client-repeat', creatorId: 'C1', subject: '合作', body: '正文内容' });
  const sent = f.ok('outbox-send', { id: saved.id, revision: saved.revision });
  assert.equal(sent.state, 'delivered');
  assert.match(f.fail('outbox-send', { id: saved.id, revision: saved.revision }), /已经发出|不能再发送|刷新/);
  assert.equal(draftSends(f), 1);
});

test('写信后来了新来信：默认拦截，确认看过后才可发送', t => {
  const f = fixture(t, { delivery: 5 });
  configure(f); seed(f);
  const saved = f.ok('outbox-save', { clientId: 'client-fresh', creatorId: 'C1', subject: '合作', body: '正文内容' });
  assert.equal(saved.rules.find(r => r.key === 'fresh').ok, true);
  f.sql("INSERT INTO messages(id,creator,channel,direction,at,subject,body,kind,source) VALUES('m2','C1','email','in','2026-10-21T09:00:00Z','Re: 合作','补充说明','正常','lark-mail:ORIG2')");

  assert.match(f.fail('outbox-send', { id: saved.id, revision: saved.revision }), /新来信/);
  const listed = f.ok('outbox-list', { creatorId: 'C1' });
  assert.equal(listed.entries[0].state, 'draft');
  assert.deepEqual(listed.entries[0].blocking, ['写这封信之后达人又来信了，请先看过新来信']);
  const fresh = listed.entries[0].rules.find(r => r.key === 'fresh');
  assert.equal(fresh.ok, false);
  assert.equal(fresh.liveOnly, false);

  const sent = f.ok('outbox-send', { id: saved.id, revision: listed.entries[0].revision, acknowledgeNewInbound: true });
  assert.equal(sent.state, 'accepted');
  assert.equal(draftSends(f), 1);
});

test('发送超时：草稿仍在也保持待核对，禁止重发', t => {
  const f = fixture(t, { draftSend: 'hang' });
  configure(f); seed(f);
  const saved = f.ok('outbox-save', { clientId: 'client-hang', creatorId: 'C1', subject: '合作', body: '正文内容' });
  const sent = f.ok('outbox-send', { id: saved.id, revision: saved.revision });
  assert.equal(sent.state, 'unknown');
  assert.match(sent.error, /超时|结果待核对/);
  assert.equal(sent.message_id, '');
  assert.match(f.fail('outbox-send', { id: sent.id, revision: sent.revision }), /核对/);

  // 搜索不到、草稿还在，仍不足以证明未发出。
  f.set({ draftSend: 'ok' });
  const checked = f.ok('outbox-check', { id: sent.id });
  assert.equal(checked.state, 'unknown');
  assert.match(checked.error, /不允许重发/);
  assert.equal(draftSends(f), 1);

  assert.match(f.fail('outbox-send', { id: checked.id, revision: checked.revision }), /核对/);
  assert.equal(draftSends(f), 1);
});

test('超时但其实已发出：核对在已发送里找回，不重发', t => {
  const f = fixture(t, { draftSend: 'hang-sent', sentFolder: true, delivery: 4 });
  configure(f); seed(f);
  const saved = f.ok('outbox-save', { clientId: 'client-sent', creatorId: 'C1', subject: '合作', body: '正文内容' });
  const sent = f.ok('outbox-send', { id: saved.id, revision: saved.revision });
  assert.equal(sent.state, 'unknown');
  assert.equal(draftSends(f), 1);

  const checked = f.ok('outbox-check', { id: sent.id });
  assert.equal(checked.message_id, 'MID1');
  assert.equal(checked.state, 'delivered');
  assert.equal(draftSends(f), 1, '核对找回后不得重发');
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '等待合成命令启动超时');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

test('跨进程并发：建草稿期间核对和第二次发送均被拒绝', async t => {
  const f = fixture(t, { draftDelayMs: 650 });
  configure(f); seed(f);
  const saved = f.ok('outbox-save', { clientId: 'concurrent', creatorId: 'C1', subject: '并发测试', body: '正文' });
  const sending = f.start('outbox-send', { id: saved.id, revision: saved.revision });
  await waitFor(() => draftCount(f) === 1);
  assert.match(f.fail('outbox-check', { id: saved.id }), /正在发送或核对/);
  assert.match(f.fail('outbox-send', { id: saved.id, revision: saved.revision }), /正在发送或核对/);
  const result = await sending.done;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(draftSends(f), 1);
  assert.equal(draftCount(f), 1);
});

test('进程在草稿编号落盘前被杀：锁自动释放，核对可恢复但没有外发', async t => {
  const f = fixture(t, { draftCreate: 'hang' });
  configure(f); seed(f);
  const saved = f.ok('outbox-save', { clientId: 'crash-before-id', creatorId: 'C1', subject: '中断测试', body: '正文' });
  const sending = f.start('outbox-send', { id: saved.id, revision: saved.revision });
  await waitFor(() => draftCount(f) === 1);
  sending.child.kill('SIGKILL');
  await sending.done;
  assert.equal(draftSends(f), 0);
  const checked = f.ok('outbox-check', { id: saved.id });
  assert.equal(checked.state, 'draft');
  assert.equal(draftSends(f), 0);
});

test('同标记多封已发送或时间缺失：不能随意认领邮件', t => {
  const f = fixture(t, { draftSend: 'no-id', sentFolder: true });
  configure(f); seed(f);
  const saved = f.ok('outbox-save', { clientId: 'ambiguous', creatorId: 'C1', subject: '对账测试', body: '正文' });
  f.ok('outbox-send', { id: saved.id, revision: saved.revision });
  const original = f.lark().outbox[0];
  f.set({ outbox: [original, { ...original, message_id: 'OTHER' }] });
  let checked = f.ok('outbox-check', { id: saved.id });
  assert.equal(checked.state, 'unknown');
  assert.equal(checked.message_id, '');
  assert.match(checked.error, /无法唯一核对/);
  f.set({ outbox: [{ ...original, date: '' }] });
  checked = f.ok('outbox-check', { id: saved.id });
  assert.equal(checked.state, 'unknown');
  assert.equal(checked.message_id, '');
  assert.equal(draftSends(f), 1);
});
