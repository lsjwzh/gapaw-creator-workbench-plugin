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
  function run(command, input = {}) {
    const result = JSON.parse(execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8' }));
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
  return { run, workspace, tasks, receipts, counters, dispatcher: () => createDispatcher(createClient(fetcher)),
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
