'use strict';
// 使用真实 Rust 程序与页面 dispatcher，宿主 API 由隔离 fixture 替代。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClient, createDispatcher } = require('../ui/app.js');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';

function fixture(t) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序或设置 GAPAW_TEST_BINARY');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-integration-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-integration-')));
  t.after(() => { fs.rmSync(state, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  function raw(command, input = {}) {
    return JSON.parse(execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8' }));
  }
  function run(command, input = {}) {
    const result = raw(command, input);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
  }
  assert.equal(run('status').workspace, null);
  assert.equal(fs.existsSync(path.join(state, 'state.sqlite')), false);
  run('configure', { workspace: { dirId: 'fixture-dir', path: workspace } });
  const tasks = new Map(), receipts = new Map(), counters = { create: 0, message: 0, retry: 0 };
  let dropCreateResponse = false, failMessage = false, moved = false;
  const task = { ok: true, taskId: 'tsk_fixture', sessionId: 'session-fixture', shellId: 'shell-fixture', url: '/air?task=tsk_fixture&dir=fixture-dir' };
  async function fetcher(url, options) {
    const body = options?.body ? JSON.parse(options.body) : {};
    let value, status = 200;
    if (url.endsWith('/run')) value = run(body.command, body.input);
    else if (url === '/api/directories') value = [{ id: 'fixture-dir', path: moved ? workspace + '-moved' : workspace }];
    else if (url === '/api/air/tasks') {
      counters.create++; tasks.set(body.clientMsgId, body); value = task;
      if (dropCreateResponse) { dropCreateResponse = false; throw new Error('模拟宿主创建后响应丢失'); }
    } else if (url === '/api/task-shell-tasks/tsk_fixture/messages') {
      counters.message++;
      assert.equal(tasks.size, 1);
      const receipt = receipts.get(body.clientMsgId) || { id: 'receipt-fixture', taskId: task.taskId, clientMsgId: body.clientMsgId, status: failMessage ? 'failed' : 'accepted' };
      receipts.set(body.clientMsgId, receipt);
      if (receipt.status === 'failed') { value = { ok: false, taskId: task.taskId, receiptId: receipt.id, notDelivered: true, error: '模拟发送失败' }; status = 503; }
      else value = { ok: true, taskId: task.taskId, sessionId: task.sessionId, receiptId: receipt.id, decision: 'continue' };
    } else if (url === '/api/task-shells/shell-fixture') value = { id: task.shellId, receipts: [...receipts.values()] };
    else if (url === '/api/task-shells/shell-fixture/receipts/receipt-fixture/retry') {
      counters.retry++; for (const receipt of receipts.values()) receipt.status = 'accepted';
      value = { ok: true, taskId: task.taskId, sessionId: task.sessionId, receiptId: 'receipt-fixture', decision: 'continue' };
    } else throw new Error('测试未实现接口：' + url);
    return { ok: status === 200, status, json: async () => value };
  }
  return { run, raw, workspace, tasks, receipts, counters, dispatcher: () => createDispatcher(createClient(fetcher)),
    dropCreate: () => { dropCreateResponse = true; }, failMessage: () => { failMessage = true; }, move: () => { moved = true; },
    prepare: requestId => run('prepare-operation', { requestId, prompt: '按回本率选人，仅使用确认数据。', runtime: { cli: 'codex-exp' } }).operation };
}

test('真实 Rust 持久化：创建响应丢失后重开 dispatcher，复用原编号与快照', async t => {
  const f = fixture(t), original = f.prepare('lost-response');
  f.dropCreate();
  await assert.rejects(f.dispatcher().dispatch(original));
  const restored = f.run('list-operations').operations[0];
  assert.equal(restored.status, 'create_failed');
  const sent = await f.dispatcher().dispatch(restored);
  assert.equal(sent.status, 'accepted');
  assert.equal(f.tasks.size, 1); assert.equal(f.receipts.size, 1);
  assert.equal(sent.workspace.path, f.workspace);
  assert.deepEqual(f.prepare('lost-response'), sent);
  await f.dispatcher().dispatch(sent);
  assert.equal(f.counters.message, 1);
});

test('真实 Rust 持久化：失败回执恢复只重试原任务消息', async t => {
  const f = fixture(t), original = f.prepare('failed-receipt');
  f.failMessage();
  await assert.rejects(f.dispatcher().dispatch(original));
  const restored = f.run('list-operations').operations[0];
  assert.equal(restored.task.taskId, 'tsk_fixture');
  assert.equal(restored.status, 'delivery_failed');
  const sent = await f.dispatcher().dispatch(restored);
  assert.equal(sent.status, 'accepted'); assert.equal(f.counters.create, 1);
  assert.equal(f.counters.retry, 1); assert.equal(f.receipts.size, 1);
});

test('目录归属改变后保留原操作并停止发送', async t => {
  const f = fixture(t), original = f.prepare('directory-moved');
  f.move();
  await assert.rejects(f.dispatcher().dispatch(original));
  assert.equal(f.counters.create, 0); assert.equal(f.counters.message, 0);
  const restored = f.run('list-operations').operations[0];
  assert.equal(restored.workspace.path, f.workspace);
});

function sampleReport() {
  const video = (id, extra = {}) => ({ videoId: id, url: 'https://example.invalid/video/' + id,
    publishedAt: '2026-10-01T00:00:00Z', contributionRate: '0.3',
    sales: [{ kind: 'total', gmv: '10', commissionRate: '0.1' }],
    adSpend: '1.99', fixedFee: '0', sampleCost: '0', ...extra });
  const candidate = (id, videos) => ({ platform: 'tiktok', creatorId: id, handle: 'fixture_' + id,
    profileUrl: 'https://example.invalid/creator/' + id, reason: '隔离验证，不是真实达人',
    sources: [{ url: 'https://example.invalid/source', capturedAt: '2026-10-02T00:00:00Z', note: '仅测试费用与成交来源' }],
    missingFields: [], videos });
  return { schemaVersion: 1, methodVersion: 'roi-selection-v1', generatedAt: '2026-10-02T00:00:00Z',
    period: { start: '2026-10-01', end: '2026-10-01', timeZone: 'UTC' }, currency: 'USD',
    coverage: '仅测试固定样本，未访问任何平台', missingFields: [], candidates: [
      candidate('known', [video('positive'), video('exact-zero', { sales: [{ kind: 'total', gmv: '0.3', commissionRate: '0.1' }], adSpend: '0.06' }),
        video('negative', { sales: [{ kind: 'total', gmv: '0', commissionRate: '0.1' }], adSpend: '0', fixedFee: '1' })]),
      candidate('unknown', [video('missing-cost', { adSpend: null })]) ] };
}

test('真实闭环：投递任务→获取契约→提交结果→重启读回与版本恢复', async t => {
  const f = fixture(t), prepared = f.prepare('result-cycle');
  assert.match(prepared.dispatch.message.text, /result-contract/);
  assert.match(prepared.dispatch.message.text, new RegExp(prepared.id));
  const op = await f.dispatcher().dispatch(prepared);
  const contract = f.run('result-contract', { operationId: op.id });
  assert.equal(contract.taskId, op.task.taskId);
  assert.equal(contract.expectedRevision, 0);
  assert.equal(contract.schema.$defs.video.properties.sales.maxItems, 2);
  const input = { ...contract.submissionTemplate, report: sampleReport() };
  const first = f.run('submit-result', input);
  assert.equal(first.record.adoptionStatus, 'pending');
  assert.equal(first.record.revision, 1);
  const [known, unknown] = first.record.computed.candidates;
  assert.equal(known.summary.breakEvenCount, 1);
  assert.equal(known.summary.totalVideos, 3);
  assert.equal(known.summary.averageSurplus, '-0.33');
  assert.deepEqual(known.videos.map(v => v.surplus), ['0.01', '0', '-1']);
  assert.equal(unknown.summary.breakEvenRate, null);
  assert.equal(unknown.videos[0].surplus, null);
  assert.deepEqual(f.run('submit-result', input), first);
  const corrected = { ...input, resultId: 'result-second', expectedRevision: 1, report: sampleReport() };
  corrected.report.candidates[1].videos[0].adSpend = '1';
  const second = f.run('submit-result', corrected);
  assert.equal(second.record.revision, 2);
  assert.equal(second.resultSummary.incompleteCount, 0);
  assert.deepEqual(f.run('submit-result', input), first);
  const latest = f.run('get-result', { operationId: op.id });
  assert.equal(latest.history.length, 2);
  assert.equal(latest.record.resultId, 'result-second');
  assert.deepEqual(f.run('get-result', { operationId: op.id, resultId: input.resultId }).record, first.record);
  const restored = f.run('status').operations[0];
  assert.equal(restored.resultSummary.revision, 2);
  assert.equal(restored.report, undefined);
  assert.deepEqual(restored.dispatch, op.dispatch);
});

test('错误结果不会改写已保存报告：跨任务、版本冲突、口径混用和重复视频', async t => {
  const f = fixture(t), op = await f.dispatcher().dispatch(f.prepare('result-reject'));
  const input = { ...f.run('result-contract', { operationId: op.id }).submissionTemplate, report: sampleReport() };
  f.run('submit-result', input);
  const invalids = [
    { ...input, taskId: 'tsk_other', resultId: 'wrong-task', expectedRevision: 1 },
    { ...input, resultId: 'stale-revision', expectedRevision: 0 },
    { ...input, report: { ...input.report, coverage: '偷偷修改同编号载荷' } }
  ];
  const mixed = structuredClone(input); mixed.resultId = 'mixed'; mixed.expectedRevision = 1;
  mixed.report.candidates[0].videos[0].sales.push({ kind: 'ads', gmv: '1', commissionRate: '0.1' });
  invalids.push(mixed);
  const duplicate = structuredClone(input); duplicate.resultId = 'duplicate-video'; duplicate.expectedRevision = 1;
  duplicate.report.candidates[1].videos[0].videoId = 'positive'; invalids.push(duplicate);
  for (const invalid of invalids) assert.equal(f.raw('submit-result', invalid).ok, false);
  const restored = f.run('get-result', { operationId: op.id });
  assert.equal(restored.history.length, 1); assert.equal(restored.record.resultId, input.resultId);
});
