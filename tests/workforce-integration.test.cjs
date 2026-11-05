'use strict';
// 真实 Rust + 隔离业务库 + 模拟宿主；不会运行模型、发送邮件或修改真实任务。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { createClient } = require('../ui/client.js');
const { controller } = require('../ui/team.js');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-team-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-team-test-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: root };
  for (const k of Object.keys(env)) if (k.startsWith('MULTICC_PLUGIN_')) delete env[k];
  const raw = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8', timeout: 15000 }));
  const run = (c, i) => { const r = raw(c, i); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const fail = (c, i) => { const r = raw(c, i); assert.equal(r.ok, false, JSON.stringify(r)); return r.error; };
  const sql = (statement, values = []) => JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; d=sqlite3.connect(sys.argv[1]); c=d.execute(sys.argv[2],json.loads(sys.argv[3])); a=c.fetchall(); d.commit(); print(json.dumps(a))', path.join(root, 'workbench.sqlite'), statement, JSON.stringify(values)], { encoding: 'utf8' }));
  const setup = () => run('team-configure', { expectedVersion: 0, workspace: { dirId: 'team-dir', path: workspace }, runtime: { cli: 'codex-exp', provider: 'fixture-line', model: 'fixture-model' } });
  const tasks = new Map(), messages = new Map(); let lost = false, moved = false;
  const fetcher = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    let value;
    if (url.endsWith('/run')) { const r = raw(body.command, body.input); value = r.ok ? r.data : r; }
    else if (url === '/api/directories') value = [{ id: 'team-dir', path: moved ? workspace + '-moved' : workspace }];
    else if (url === '/api/air/tasks') {
      assert.equal(body.dirId, 'team-dir'); assert.equal(body.model, 'fixture-model');
      assert.match(body.rolePrompt, /不直接改 SQLite/);
      if (!tasks.has(body.clientMsgId)) { const n = tasks.size; tasks.set(body.clientMsgId, { ok: true, taskId: 'tsk_role_' + n, sessionId: 'session_' + n, shellId: 'shell_' + n, url: '/air?task=tsk_role_' + n + '&dir=team-dir' }); }
      value = tasks.get(body.clientMsgId);
      if (lost) { lost = false; throw new Error('模拟创建响应丢失'); }
    } else if (/^\/api\/task-shell-tasks\/.+\/messages$/.test(url)) {
      const taskId = url.split('/')[3]; const key = taskId + ':' + body.clientMsgId;
      if (!messages.has(key)) messages.set(key, { ok: true, taskId, receiptId: 'receipt-' + messages.size }); value = messages.get(key);
    } else throw new Error('测试未实现接口：' + url);
    return { ok: true, status: 200, json: async () => value };
  };
  const flow = () => controller(createClient(fetcher));
  const ready = async () => { run('local-workbench-init', { confirmed: true }); sql("INSERT INTO creators(id,handle,profile,settings) VALUES('C1','fixture','{}','{}')"); setup(); return flow().initialize(); };
  const create = (suffix = 'a', extra = {}) => run('work-create', { requestId: 'request-' + suffix, source: 'manual-' + suffix, creatorId: 'C1', kind: 'inbound', instruction: '依据真实档案准备分类建议，不外发。', ...extra }).item;
  const roles = () => run('team-status').staff;
  const task = key => roles().find(s => s.key === key).task.taskId;
  const claim = () => run('work-next', { taskId: task('dispatcher') });
  const context = id => run('work-context', { workId: id, taskId: task('sort') });
  const candidate = ctx => ({ ...ctx.submissionTemplate, result: { summary: '需要老板确认的候选分类', evidence: ['已有档案与当前消息，仅供影子审阅'] } });
  return { root, workspace, env, raw, run, fail, sql, setup, ready, flow, tasks, messages, create, task, claim, context, candidate, lost: () => { lost = true; }, move: () => { moved = true; } };
}

test('未初始化时只读查询不建表、不建数据文件', t => {
  const f = fixture(t); assert.equal(f.run('team-status').configured, false); assert.deepEqual(f.run('work-list').items, []);
  assert.equal(fs.existsSync(path.join(f.root, 'state.sqlite')), false); assert.equal(fs.existsSync(path.join(f.root, 'workbench.sqlite')), false);
  assert.match(f.fail('team-prepare'), /业务数据/);
});

test('目录与明确模型线路是初始化前提，配置有版本校验', t => {
  const f = fixture(t); f.run('local-workbench-init', { confirmed: true });
  assert.match(f.fail('team-prepare'), /选择办公室工作目录/);
  const payload = { expectedVersion: 0, workspace: { dirId: 'team-dir', path: f.workspace }, runtime: { cli: 'codex-exp' } };
  assert.match(f.fail('team-configure', payload), /模型与线路/);
  f.setup(); assert.match(f.fail('team-configure', payload), /配置已变化/);
  const a = f.run('team-prepare'), b = f.run('team-prepare'); assert.deepEqual(a.staff, b.staff); assert.equal(a.staff.length, 8);
  assert.match(f.fail('team-configure', { ...payload, expectedVersion: 1 }), /不能改绑/);
});

test('创建响应丢失后重开初始化，仍只创建八个角色任务', async t => {
  const f = fixture(t); f.run('local-workbench-init', { confirmed: true }); f.setup(); f.lost();
  await assert.rejects(f.flow().initialize()); assert.equal(f.tasks.size, 1);
  const data = await f.flow().initialize(); assert.equal(data.initialized, true); assert.equal(f.tasks.size, 8);
  assert.equal(new Set(data.staff.map(s => s.task.taskId)).size, 8);
  assert.deepEqual((await f.flow().initialize()).staff, data.staff); assert.equal(f.tasks.size, 8); assert.equal(f.messages.size, 0);
  assert.equal(data.schedulerEnabled, false);
});

test('目录改绑后初始化停止，不创建任何宿主任务', async t => {
  const f = fixture(t); f.run('local-workbench-init', { confirmed: true }); f.setup(); f.move();
  await assert.rejects(f.flow().initialize(), /删除或改绑/); assert.equal(f.tasks.size, 0);
});

test('同一个宿主任务不能同时绑定多个员工，链接由插件生成', async t => {
  const f = fixture(t); await f.ready(); const rows = f.run('team-status').staff;
  assert.match(f.fail('team-record-task', { staffKey: rows[0].key, response: rows[1].task }), /多个角色/);
  const row = rows[0]; f.run('team-record-task', { staffKey: row.key, response: { ...row.task, url: 'javascript:alert(1)' } });
  assert.match(f.run('team-status').staff[0].task.url, /^\/air\?task=/);
});

test('七类工单固定归属角色，同一类型来源及请求编号去重', async t => {
  const f = fixture(t); await f.ready();
  const a = f.create(); assert.deepEqual(f.create(), a); assert.equal(f.run('work-list').items.length, 1);
  assert.match(f.fail('work-create', { requestId: 'other', source: 'manual-a', creatorId: 'C1', kind: 'inbound', instruction: '改变的内容' }), /已经使用/);
  for (const [kind, role] of Object.entries({ selection: 'sel', copy: 'copy', outreach: 'send', followup: 'follow', negotiation: 'deal', fulfilment: 'ful' })) assert.equal(f.create(kind, { kind }).staffKey, role);
  assert.equal(f.run('work-list').items.length, 7);
});

test('重复领取只恢复原领取与宿主投递编号，不能跨角色领取', async t => {
  const f = fixture(t); await f.ready(); const a = f.create();
  const first = f.claim(), second = f.claim(); assert.deepEqual(first, second); assert.equal(first.item.id, a.id);
  assert.match(f.fail('work-next', { taskId: f.task('sort') }), /任务编号不属于/);
  assert.match(f.fail('work-context', { workId: a.id, taskId: f.task('copy') }), /任务编号不属于/);
});

test('并发进程领取只形成一个领取编号和一条投递消息', async t => {
  const f = fixture(t); await f.ready(); f.create(); const input = JSON.stringify({ taskId: f.task('dispatcher') });
  const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => { const child = execFile(binary, ['work-next'], { env: f.env, encoding: 'utf8' }, (e, stdout) => e ? reject(e) : resolve(JSON.parse(stdout))); child.stdin.end(input); }));
  const rows = await Promise.all(runs); assert.ok(rows.every(r => r.ok)); assert.equal(new Set(rows.map(r => r.data.item.claim.id)).size, 1);
});

test('上下文、受理回执、候选交回和读回形成闭环，不改正式业务', async t => {
  const f = fixture(t); await f.ready(); const w = f.create(), c = f.claim();
  const response = { ok: true, taskId: f.task('sort'), receiptId: 'receipt-real-fixture' };
  const receipt = { workId: w.id, claimId: c.item.claim.id, taskId: f.task('dispatcher'), response };
  assert.equal(f.run('work-dispatched', receipt).item.state, 'dispatched'); assert.equal(f.run('work-dispatched', receipt).replay, true);
  const ctx = f.context(w.id); assert.equal(ctx.item.state, 'processing'); assert.equal(ctx.creator.id, 'C1');
  const payload = f.candidate(ctx), result = f.run('work-submit', payload); assert.equal(result.item.state, 'awaiting_review');
  assert.equal(f.run('work-submit', payload).replay, true); assert.equal(f.run('work-get', { workId: w.id }).submissions.length, 1);
  for (const table of ['messages', 'drafts', 'events', 'negotiations']) assert.equal(f.sql('SELECT count(*) FROM ' + table)[0][0], 0);
  const homepage = JSON.stringify(f.run('office-status')); assert.ok(!homepage.includes(payload.result.summary)); assert.ok(homepage.includes('awaiting_review'));
});

test('员工先交回，随后登记回执不能倒退状态；丢回执可找回原投递', async t => {
  const f = fixture(t); await f.ready(); const w = f.create(), c = f.claim(), ctx = f.context(w.id);
  f.run('work-submit', f.candidate(ctx)); const recovered = f.claim(); assert.equal(recovered.item.id, w.id); assert.deepEqual(recovered.dispatch, c.dispatch);
  f.run('work-dispatched', { workId: w.id, claimId: c.item.claim.id, taskId: f.task('dispatcher'), response: { ok: true, taskId: f.task('sort'), receiptId: 'late-receipt' } });
  assert.equal(f.run('work-get', { workId: w.id }).item.state, 'awaiting_review'); assert.equal(f.claim().item, null);
});

test('旧工单、伪回执、跨员工和空依据均不能覆盖有效结果', async t => {
  const f = fixture(t); await f.ready(); const w = f.create(), c = f.claim(), ctx = f.context(w.id), p = f.candidate(ctx);
  assert.match(f.fail('work-dispatched', { workId: w.id, claimId: c.item.claim.id, taskId: f.task('dispatcher'), response: { ok: true, taskId: f.task('copy'), receiptId: 'bad' } }), /不符/);
  assert.match(f.fail('work-submit', { ...p, taskId: f.task('copy') }), /任务编号/);
  assert.match(f.fail('work-submit', { ...p, expectedVersion: 99 }), /版本/);
  assert.match(f.fail('work-submit', { ...p, result: { summary: '无依据', evidence: [] } }), /依据/);
  f.run('work-submit', p); assert.match(f.fail('work-submit', { ...p, result: { ...p.result, summary: '同号修改' } }), /编号已使用/);
});

test('处理中新来信、档案编辑或谈判变化都会使旧候选过期', async t => {
  const f = fixture(t); await f.ready();
  for (const [key, sql] of [
    ['mail', "INSERT INTO messages(id,creator,direction,body,at) VALUES('fresh','C1','in','新来信','2026-11-04T12:00:00Z')"],
    ['profile', "UPDATE creators SET settings='{\"declined\":true}' WHERE id='C1'"],
    ['negotiation', "INSERT INTO negotiations(creator,status) VALUES('C1','对方已拒绝')"]
  ]) {
    const w = f.create(key); const c = f.claim();
    f.run('work-dispatched', { workId: w.id, claimId: c.item.claim.id, taskId: f.task('dispatcher'), response: { ok: true, taskId: f.task('sort'), receiptId: 'r-' + key } });
    const p = f.candidate(f.context(w.id)); f.sql(sql);
    assert.match(f.fail('work-submit', p), /数据已变化/); assert.equal(f.run('work-get', { workId: w.id }).item.state, 'stale');
  }
});

test('领取上下文前数据变化也标过期，作废后不能继续交回', async t => {
  const f = fixture(t); await f.ready(); const w = f.create(); f.claim();
  f.sql("UPDATE creators SET handle='changed' WHERE id='C1'"); assert.match(f.fail('work-context', { workId: w.id, taskId: f.task('sort') }), /已标为过期/);
  const stale = f.run('work-get', { workId: w.id }).item; assert.equal(stale.state, 'stale');
  assert.match(f.fail('work-cancel', { workId: w.id, expectedVersion: 99 }), /已变化/);
  f.run('work-cancel', { workId: w.id, expectedVersion: stale.version }); assert.equal(f.claim().item, null);
});

test('连续点击唤醒只受理原消息，初始化不要求测试邮箱', async t => {
  const f = fixture(t); await f.ready(); f.create();
  await f.flow().wake(); await f.flow().wake(); assert.equal(f.messages.size, 1);
  assert.equal(f.run('setup-status', { brief: true }).values.testRecipient, '');
  f.move(); await assert.rejects(f.flow().wake(), /改绑/);
});

test('超过首页两百条显示上限后，仍能唤醒较早的待派发工单', async t => {
  const f = fixture(t); await f.ready(); const original = f.create('old');
  for (let i = 0; i < 201; i++) {
    f.sql("INSERT INTO work_items(id,request_id,request,kind,source,creator,staff_key,state,version,basis,instruction,created,updated) VALUES(?,?,'{}','inbound',?,'C1','sort','cancelled',0,'basis','已作废','2099-01-01','2099-01-01')", ['cancel-' + i, 'cancel-request-' + i, 'cancel-source-' + i]);
  }
  const status = f.run('team-status'); assert.equal(status.items.length, 200); assert.equal(status.wakeWorkId, original.id);
  await f.flow().wake(); assert.equal(f.messages.size, 1); assert.equal(f.claim().item.id, original.id);
});

async function deliveryFixture(t, products = true) {
  const f = fixture(t); await f.ready();
  f.sql('UPDATE creators SET profile=?,settings=? WHERE id=?', [JSON.stringify(products ? { products: '已核验狗用精华', topic: '养犬' } : {}), JSON.stringify({ product_checked: products, fee: 50 }), 'C1']);
  const w = f.create('selection-delivery', { kind: 'selection' }); f.claim();
  const ctx = f.run('work-context', { workId: w.id, taskId: f.task('sel') });
  f.run('work-submit', f.candidate(ctx));
  const prepare = () => f.run('delivery-prepare', { workId: w.id, taskId: f.task('sel') });
  const validate = value => f.run('delivery-validate', { contract: value.input.contract, payload: value.input.payload, fromTaskId: f.task('sel'), toTaskId: f.task('copy') });
  return { ...f, w, prepare, validate };
}

test('选人交付正文从业务库生成，明确保留缺失条件且不写正式数据', async t => {
  const f = await deliveryFixture(t), data = f.prepare();
  assert.equal(data.input.contract.type, 'selection-brief'); assert.equal(data.input.toTaskId, f.task('copy'));
  assert.equal(data.input.payload.conditions.fee, 50); assert.ok(data.input.payload.missingConditions.includes('commission'));
  assert.equal(f.validate(data).valid, true); assert.deepEqual(f.prepare(), data);
  assert.equal(f.sql('SELECT count(*) FROM drafts')[0][0], 0); assert.equal(f.sql('SELECT count(*) FROM messages')[0][0], 0);
});

test('缺少已核验产品时禁止形成可交付选人资料', async t => {
  const f = await deliveryFixture(t, false);
  assert.match(f.fail('delivery-prepare', { workId: f.w.id, taskId: f.task('sel') }), /已核验的适配产品/);
});

test('交付契约拒绝虚构正文、错误接收角色和未知版本', async t => {
  const f = await deliveryFixture(t), good = f.prepare();
  const bad = structuredClone(good); bad.input.payload.conditions.fee = 500;
  assert.equal(f.validate(bad).valid, false);
  bad.input = structuredClone(good.input); bad.input.contract.version = 2; assert.equal(f.validate(bad).valid, false);
  assert.equal(f.run('delivery-validate', { ...good.input, fromTaskId: f.task('sel') }).valid, false);
  assert.equal(f.run('delivery-validate', { contract: good.input.contract, payload: good.input.payload, fromTaskId: f.task('sel'), toTaskId: f.task('deal') }).valid, false);
  assert.match(f.fail('delivery-prepare', { workId: f.w.id, taskId: f.task('copy') }), /任务编号/);
});

test('交付后新来信使原版本校验失败，不能继续验收为最新资料', async t => {
  const f = await deliveryFixture(t), good = f.prepare(); assert.equal(f.validate(good).valid, true);
  f.sql("INSERT INTO messages(id,creator,direction,body) VALUES('new-mail','C1','in','条件改变')");
  const checked = f.validate(good); assert.equal(checked.valid, false); assert.match(checked.issues.join(' '), /业务数据已变化/);
});
