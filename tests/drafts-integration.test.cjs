'use strict';
// 真实 Rust 程序 + 原版工作台 server.py（只读引用源码，合成数据），覆盖第一里程碑的草稿闭环。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createClient, createDispatcher } = require('../ui/app.js');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const workbenchSource = process.env.GAPAW_OUTREACH_SOURCE || '/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach';
const CHANNELS = ['comment', 'dm', 'email', 'affiliate', 'followup'];

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function startWorkbench(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-outreach-'));
  const records = ['GW901', 'GW902', 'GW903'].map((id, i) => ({
    profile: { id, rank: i + 1, handle: 'fixture_' + id.toLowerCase(), priority: 'A 优先', followers: 1000 + i, topic: '合成选题 ' + id, angle: '合成角度', anchor1: '饮水机', anchor2: '胸背带', history: '', prior_invite: false, kalodata_window: '', affiliate_gmv_usd: 1, pet_gmv_share_pct: 1 },
    drafts: CHANNELS.map(channel => ({ channel, subject: channel === 'email' ? '原主题 ' + id : '', body: '原文案 ' + id + ' ' + channel + ' 【固定费】' })),
  }));
  fs.writeFileSync(path.join(data, 'seed.json'), JSON.stringify({ source_sha256: 'fixture', records }));
  const port = await freePort();
  const proc = spawn('python3', [path.join(workbenchSource, 'server.py'), '--data-dir', data, '--port', String(port)], { stdio: 'ignore' });
  t.after(() => { proc.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return url; } catch (_) { /* 等待启动 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('工作台副本未启动');
}

test('草稿闭环：选三人生成 → 补条件重交 → 人工修改触发版本提示 → 采用并读回', async t => {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序或设置 GAPAW_TEST_BINARY');
  const workbench = await startWorkbench(t);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-drafts-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-drafts-')));
  t.after(() => { fs.rmSync(state, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const raw = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8' }));
  const run = (command, input = {}) => { const r = raw(command, input); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const fail = (command, input, pattern) => { const r = raw(command, input); assert.equal(r.ok, false); assert.match(r.error, pattern); };
  const wbGet = async p => (await fetch(workbench + p)).json();
  const wbDraft = async (id, ch) => (await wbGet('/api/creators/' + id)).drafts.find(d => d.channel === ch);

  run('configure', { workspace: { dirId: 'fixture-dir', path: workspace } });
  assert.equal(run('outreach-status').configured, false);
  fail('outreach-configure', { url: 'http://example.com:80' }, /127\.0\.0\.1/);
  assert.equal(run('outreach-configure', { url: workbench }).available, true);
  assert.equal(run('outreach-creators').items.length, 3);

  // 1. 选择三位达人，经页面同款 dispatcher 投递到宿主 fixture。
  const task = { ok: true, taskId: 'tsk_drafts', sessionId: 'session-drafts', shellId: 'shell-drafts', url: '/air?task=tsk_drafts&dir=fixture-dir' };
  let sentText = '';
  const fetcher = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    let value;
    if (url.endsWith('/run')) { const r = raw(body.command, body.input); value = r.ok ? r.data : r; }
    else if (url === '/api/directories') value = [{ id: 'fixture-dir', path: workspace }];
    else if (url === '/api/air/tasks') value = task;
    else if (url === '/api/task-shells/shell-drafts') value = { receipts: [] };
    else if (url === '/api/task-shell-tasks/tsk_drafts/messages') { sentText = body.text; value = { ok: true, taskId: 'tsk_drafts', receiptId: 'rcpt_drafts' }; }
    else throw new Error('未预期地址 ' + url);
    return { ok: value.ok !== false, status: 200, json: async () => value };
  };
  const client = createClient(fetcher);
  const prepared = (await client.run('prepare-drafts', { requestId: 'req_drafts_1', creatorIds: ['GW901', 'GW902', 'GW903'], channels: ['email', 'dm'], prompt: '为这三位写首轮邀约', runtime: { cli: 'claude' } })).operation;
  assert.equal(prepared.kind, 'drafts');
  assert.equal(prepared.draftScope.creators.length, 3);
  const again = run('prepare-drafts', { requestId: 'req_drafts_1', creatorIds: ['GW901', 'GW902', 'GW903'], channels: ['email', 'dm'], prompt: '为这三位写首轮邀约', runtime: { cli: 'claude' } });
  assert.equal(again.operation.id, prepared.id, '同一请求编号幂等');
  fail('prepare-drafts', { requestId: 'req_drafts_1', creatorIds: ['GW901'], channels: ['email'], prompt: 'x', runtime: { cli: 'claude' } }, /不能更改/);
  const op = await createDispatcher(client).dispatch(prepared);
  assert.equal(op.status, 'accepted');
  assert.match(sentText, /draft-context/);
  assert.match(sentText, /不发送邮件/);
  // 选人命令不能作用在草稿任务上。
  fail('platform-contract', { operationId: op.id, taskId: 'tsk_drafts' }, /草稿/);

  // 2. 任务读取冻结上下文并交回第一版。
  fail('draft-context', { operationId: op.id, taskId: 'tsk_other' }, /taskId/);
  const ctx = run('draft-context', { operationId: op.id, taskId: 'tsk_drafts' });
  assert.equal(ctx.submissionTemplate.drafts.length, 6);
  assert.equal(ctx.scope.creators[0].drafts.find(d => d.channel === 'email').revision, 0);
  assert.equal(ctx.scope.creators[0].settings.email, undefined, '联系人邮箱不进入上下文');
  const v1 = ['GW901', 'GW902', 'GW903'].flatMap(id => [
    { creatorId: id, channel: 'email', subject: 'Gapaw x ' + id, body: 'Hi ' + id + ', 【固定费】 for 2 videos + 【佣金比例】% commission. —【姓名】', note: '首版' },
    { creatorId: id, channel: 'dm', subject: '', body: 'Hey ' + id + '! Quick collab idea. 【固定费】', note: '首版' },
  ]);
  const s1 = run('submit-drafts', { operationId: op.id, taskId: 'tsk_drafts', submissionId: 'sub1', drafts: v1 });
  assert.equal(s1.proposals.length, 6);
  assert.equal(run('submit-drafts', { operationId: op.id, taskId: 'tsk_drafts', submissionId: 'sub1', drafts: v1 }).duplicate, true);
  fail('submit-drafts', { operationId: op.id, taskId: 'tsk_drafts', submissionId: 'sub1', drafts: v1.slice(1) }, /不同内容/);
  fail('submit-drafts', { operationId: op.id, taskId: 'tsk_drafts', submissionId: 'bad1', drafts: [{ creatorId: 'GW999', channel: 'email', subject: 's', body: 'b' }] }, /范围/);
  fail('submit-drafts', { operationId: op.id, taskId: 'tsk_drafts', submissionId: 'bad2', drafts: [{ creatorId: 'GW901', channel: 'comment', subject: '', body: 'b' }] }, /范围/);
  fail('submit-drafts', { operationId: op.id, taskId: 'tsk_drafts', submissionId: 'bad3', drafts: [{ creatorId: 'GW901', channel: 'email', subject: 's', body: 'pay 50 美元' }] }, /固定费/);

  // 3. 用户在任务中补充条件 → 任务重交第二版（GW901 邮件），版本号递增、旧版本保留。
  const s2 = run('submit-drafts', { operationId: op.id, taskId: 'tsk_drafts', submissionId: 'sub2', drafts: [{ creatorId: 'GW901', channel: 'email', subject: 'Gapaw x GW901 (free sample)', body: 'Hi GW901, free sample first, then 【固定费】. —【姓名】', note: '按用户补充：先寄样' }] });
  assert.equal(s2.proposals[0].version, 2);

  // 4. 人工在工作台改 GW902 邮件 → 读回出现版本提示；按旧版本采用被拒，原人工文案不被覆盖。
  const human = await fetch(workbench + '/api/creators/GW902/drafts/email', { method: 'POST', headers: { 'X-Outreach-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: '人工主题', body: '人工改写 【固定费】', revision: 0 }) });
  assert.equal(human.status, 200);
  const live = run('get-drafts', { operationId: op.id, live: true });
  assert.equal(live.liveError, null);
  const p902 = live.proposals.find(p => p.creatorId === 'GW902' && p.channel === 'email');
  assert.equal(p902.baseChanged, true);
  assert.equal(p902.current.revision, 1);
  const stale = run('adopt-draft', { proposalId: p902.proposalId, adoptionId: 'ad_902_stale', expectedRevision: 0 });
  assert.equal(stale.status, 'conflict');
  assert.equal((await wbDraft('GW902', 'email')).body, '人工改写 【固定费】');

  // 5. 采用 GW901 第二版：写入工作台、revision +1、读回一致；重复点击幂等。
  const p901 = live.proposals.find(p => p.creatorId === 'GW901' && p.channel === 'email' && p.version === 2);
  const adopted = run('adopt-draft', { proposalId: p901.proposalId, adoptionId: 'ad_901', expectedRevision: p901.current.revision });
  assert.equal(adopted.status, 'adopted');
  const after = await wbDraft('GW901', 'email');
  assert.equal(after.revision, 1);
  assert.equal(after.subject, 'Gapaw x GW901 (free sample)');
  assert.equal(run('adopt-draft', { proposalId: p901.proposalId, adoptionId: 'ad_901', expectedRevision: 0 }).status, 'adopted');
  fail('adopt-draft', { proposalId: p901.proposalId, adoptionId: 'ad_901', expectedRevision: 1 }, /不能更换/);
  // 已经写入后，再用旧第一版按旧 revision 采用会冲突，不会覆盖。
  const p901v1 = live.proposals.find(p => p.creatorId === 'GW901' && p.channel === 'email' && p.version === 1);
  assert.equal(run('adopt-draft', { proposalId: p901v1.proposalId, adoptionId: 'ad_901_v1', expectedRevision: 0 }).status, 'conflict');
  // 用户确认人工修改后，按最新版本采用 GW902 也能成功。
  assert.equal(run('adopt-draft', { proposalId: p902.proposalId, adoptionId: 'ad_902', expectedRevision: 1 }).status, 'adopted');
  assert.equal((await wbDraft('GW902', 'email')).revision, 2);

  // 6. 刷新恢复：list-operations 与 get-drafts 均可找回原任务、版本与采用状态；未触碰其他渠道与达人。
  const listed = run('list-operations').operations.find(o => o.id === op.id);
  assert.equal(listed.task.taskId, 'tsk_drafts');
  const final = run('get-drafts', { operationId: op.id, live: true });
  assert.equal(final.proposals.length, 7);
  assert.equal(final.proposals.find(p => p.proposalId === p901.proposalId).adoption.status, 'adopted');
  assert.equal(final.proposals.find(p => p.proposalId === p901.proposalId).current.matchesProposal, true);
  const v1After = final.proposals.find(p => p.proposalId === p901v1.proposalId);
  assert.equal(v1After.baseChanged, false, '采用本身引起的版本变化不算人工修改');
  assert.equal(v1After.changedByAdoption, true);
  assert.equal((await wbDraft('GW903', 'email')).revision, 0);
  assert.equal((await wbDraft('GW901', 'dm')).revision, 0);
  const events = (await wbGet('/api/creators/GW901')).events;
  assert.equal(events.length, 0, '不登记触达事件');
});
