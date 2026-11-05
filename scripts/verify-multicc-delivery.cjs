#!/usr/bin/env node
'use strict';
// Cross-project contract check. Explicit source and binary paths; isolated data only.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
async function main() {
  assert.ok(process.env.MULTICC_DELIVERY_HOST_WORKTREE, '需要指定宿主开发工作区');
  assert.ok(process.env.GAPAW_TEST_BINARY, '需要指定当前插件测试二进制');
  assert.ok(process.env.MULTICC_RUST_ADDON, '需要指定当前宿主原生模块');
  const { createTaskDeliveries } = require(path.join(process.env.MULTICC_DELIVERY_HOST_WORKTREE, 'src/task-shell/deliveries'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-delivery-contract-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-delivery-contract-')));
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: root }; for (const k of Object.keys(env)) if (k.startsWith('MULTICC_PLUGIN_')) delete env[k];
  const run = (command, input = {}) => {
    const result = JSON.parse(execFileSync(process.env.GAPAW_TEST_BINARY, [command], { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 15000 }));
    assert.equal(result.ok, true, result.error); return result.data;
  };
  const sql = (statement, params = []) => JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; d=sqlite3.connect(sys.argv[1]); r=d.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall(); d.commit(); print(json.dumps(r))', path.join(root, 'workbench.sqlite'), statement, JSON.stringify(params)], { encoding: 'utf8' }));
  try {
    run('local-workbench-init', { confirmed: true });
    sql('INSERT INTO creators(id,handle,profile,settings) VALUES(?,?,?,?)', ['C1', '隔离验收达人', JSON.stringify({ products: '已核验狗用精华', topic: '养犬', angle: '日常护理' }), JSON.stringify({ product_checked: true, fee: 50 })]);
    run('team-configure', { expectedVersion: 0, workspace: { dirId: 'fixture-dir', path: workspace }, runtime: { cli: 'codex-exp', model: 'fixture', provider: 'fixture' } });
    for (const row of run('team-prepare').staff) run('team-record-task', { staffKey: row.key, response: { ok: true, taskId: 'tsk_' + row.key, sessionId: 'session_' + row.key, shellId: 'shell_' + row.key } });
    const selection = suffix => {
      const w = run('work-create', { requestId: 'selection_' + suffix, source: 'manual_' + suffix, kind: 'selection', creatorId: 'C1', instruction: '选人资料交给文案准备，仅影子候选。' }).item;
      const claimed = run('work-next', { taskId: 'tsk_dispatcher' });
      run('work-dispatched', { workId: w.id, taskId: 'tsk_dispatcher', claimId: claimed.item.claim.id, response: { ok: true, taskId: 'tsk_sel', receiptId: 'receipt_' + suffix } });
      const ctx = run('work-context', { workId: w.id, taskId: 'tsk_sel' });
      run('work-submit', { ...ctx.submissionTemplate, result: { summary: '护理内容与产品用途匹配', evidence: ['当前达人档案的产品与内容方向'] } });
      const prepared = run('delivery-prepare', { workId: w.id, taskId: 'tsk_sel' });
      return { action: prepared.action, input: prepared.input };
    };
    const receipts = new Map(); let lose = true;
    const host = createTaskDeliveries({ file: path.join(root, 'host-deliveries.sqlite'),
      taskSummary: id => ({ id, dirId: 'fixture-dir', readOnly: false }),
      sendTaskMessage: async (taskId, text, opts) => {
        if (!receipts.has(opts.clientMsgId)) receipts.set(opts.clientMsgId, { ok: true, taskId, receiptId: 'host_receipt_' + receipts.size });
        if (lose) { lose = false; throw Error('受理后响应丢失'); }
        return receipts.get(opts.clientMsgId);
      },
      runPluginCommand: async (id, command, input) => { assert.equal(id, 'gapaw-creator-workbench'); return { status: 200, payload: run(command, input) }; },
    });
    const call = (role, action, input) => host.execute({ taskId: 'tsk_' + role, sessionId: 'session_' + role }, { action, input });
    const first = selection('first'); const submitted = await call('sel', first.action, first.input);
    assert.equal(submitted.notificationPending, true);
    assert.equal((await call('sel', 'submit', first.input)).notificationPending, false); assert.equal(receipts.size, 1);
    const id = submitted.item.id;
    assert.equal((await call('copy', 'check', { deliveryId: id, expectedVersion: 1 })).item.validation.valid, true);
    await call('copy', 'return', { deliveryId: id, expectedVersion: 1, requestId: 'return_1', reason: '需要明确写作角度', issues: ['补充达人内容对应的文案角度'] });
    sql('UPDATE creators SET profile=? WHERE id=?', [JSON.stringify({ products: '已核验狗用精华', topic: '养犬', angle: '结合每日梳毛场景介绍护理用途' }), 'C1']);
    const second = selection('second'); second.input.deliveryId = id; second.input.expectedVersion = 1;
    assert.equal((await call('sel', 'submit', second.input)).item.version, 2);
    await assert.rejects(call('copy', 'accept', { deliveryId: id, expectedVersion: 1, requestId: 'old', reason: '旧页面', issues: [] }), /stale_version/);
    const accepted = await call('copy', 'accept', { deliveryId: id, expectedVersion: 2, requestId: 'accept_2', reason: '来源与用途足够写候选；佣金保留待确认', issues: [] });
    assert.equal(accepted.item.state, 'accepted');
    assert.equal((await call('copy', 'read', { deliveryId: id, version: 1 })).item.state, 'returned');
    const third = selection('third'); const waiting = await call('sel', 'submit', third.input);
    sql("INSERT INTO messages(id,creator,direction,body) VALUES('new-inbound','C1','in','合作条件变化')");
    const stale = await call('copy', 'accept', { deliveryId: waiting.item.id, expectedVersion: 1, requestId: 'stale', reason: '检查最新资料', issues: [] });
    assert.equal(stale.code, 'delivery_check_failed');
    assert.equal(sql('SELECT count(*) FROM drafts')[0][0], 0); assert.equal(sql("SELECT count(*) FROM messages WHERE direction='out'")[0][0], 0);
    console.log(JSON.stringify({ 结果: '跨项目隔离交接链通过', 已验证: ['选人候选生成契约正文', '真实宿主Rust持久化', '投递响应丢失恢复且去重', '文案读取与业务检查', '退回并列明缺项', '修订第2版且保留第1版', '拒绝旧版本验收', '第2版验收通过', '新来信阻止过期资料验收'], 正式草稿写入: 0, 对外发送: 0, 模型执行: 0 }, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
