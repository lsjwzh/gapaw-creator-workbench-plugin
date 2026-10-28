'use strict';
// 工作台首页、总结对话并拟回复、人工编辑：真实 Rust 程序 + 原版工作台 server.py（合成数据）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const workbenchSource = process.env.GAPAW_OUTREACH_SOURCE || '/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach';
const CHANNELS = ['comment', 'dm', 'email', 'affiliate', 'followup'];

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function setup(t) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序或设置 GAPAW_TEST_BINARY');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-console-wb-'));
  const records = ['GW901', 'GW902'].map((id, i) => ({
    profile: { id, rank: i + 1, handle: 'fixture_' + id.toLowerCase(), priority: 'A 优先', followers: 1000, topic: '合成选题 ' + id, angle: '', anchor1: '饮水机', anchor2: '胸背带', history: '', prior_invite: false, kalodata_window: '', affiliate_gmv_usd: 1, pet_gmv_share_pct: 1 },
    drafts: CHANNELS.map(channel => ({ channel, subject: channel === 'email' ? '原主题 ' + id : '', body: '原文案 ' + id + ' ' + channel + ' 【固定费】 【两款商品资料链接】' })),
  }));
  fs.writeFileSync(path.join(data, 'seed.json'), JSON.stringify({ source_sha256: 'fixture', records }));
  const port = await freePort();
  const proc = spawn('python3', ['-B', path.join(workbenchSource, 'server.py'), '--data-dir', data, '--port', String(port)], { stdio: 'ignore' });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-console-state-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-console-')));
  t.after(() => { proc.kill(); for (const d of [data, state, workspace]) fs.rmSync(d, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50 && !(await fetch(url + '/api/health').then(r => r.ok, () => false)); i++) await new Promise(r => setTimeout(r, 100));
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const raw = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8' }));
  const run = (command, input = {}) => { const r = raw(command, input); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const fail = (command, input, pattern) => { const r = raw(command, input); assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, pattern); };
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'X-Outreach-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const detail = id => fetch(url + '/api/creators/' + id).then(r => r.json());
  run('configure', { workspace: { dirId: 'fixture-dir', path: workspace } });
  run('outreach-configure', { url });
  return { run, fail, post, detail, url };
}

test('人工文案绑定读取时的工作台，另页切换同编号同版本来源也拒绝写入', async t => {
  const first = await setup(t), second = await setup(t);
  const shown = first.run('workbench-creator', { creatorId: 'GW901' });
  assert.match(shown.expectedSource, /^[a-f0-9]{64}$/);
  const payload = { creatorId: 'GW901', channel: 'dm', subject: '', body: '绑定来源的文案【固定费】', revision: 0, expectedSource: shown.expectedSource };
  const before = await second.detail('GW901');
  first.run('outreach-configure', { url: second.url });
  first.fail('edit-draft', payload, /地址已变化/);
  first.fail('edit-draft', { ...payload, expectedSource: null }, /地址已变化/);
  assert.deepEqual(await second.detail('GW901'), before);
  first.run('outreach-configure', { url: first.url });
  assert.equal(first.run('edit-draft', payload).status, 'saved');
});

test('首页总览：待回复按最后一条真实来信判断，自动回复不算', async t => {
  const { run, post } = await setup(t);
  await post('/api/creators/GW901/messages', { channel: 'email', direction: 'out', at: '2026-10-01T00:00:00Z', body: 'Hi', source: 'fx:1' });
  await post('/api/creators/GW901/messages', { channel: 'email', direction: 'in', at: '2026-10-02T00:00:00Z', body: 'Interested, what rate?', zh: '有兴趣，问价格', source: 'fx:2' });
  await post('/api/creators/GW902/messages', { channel: 'email', direction: 'in', at: '2026-10-02T00:00:00Z', body: 'OOO', kind: '自动回复', source: 'fx:3' });
  const home = run('workbench-home');
  assert.equal(home.items.length, 2);
  assert.deepEqual(home.todo.awaitingReply.map(x => x.id), ['GW901']);
  assert.equal(home.items.find(x => x.id === 'GW902').awaitingReply, null);
  const conv = run('workbench-conversations');
  assert.equal(conv.items.length, 2);
  const one = run('workbench-creator', { creatorId: 'GW901' });
  assert.equal(one.messages.length, 2);
  assert.deepEqual(one.drafts.find(d => d.channel === 'email').manualPlaceholders, ['【两款商品资料链接】']);
});

test('人工编辑：按版本写入并读回；旧版本冲突；自造占位符与写死金额被拒', async t => {
  const { run, fail, detail } = await setup(t);
  assert.equal(run('edit-draft', { creatorId: 'GW901', channel: 'dm', subject: '', body: '人工改写 【固定费】', revision: 0 }).status, 'saved');
  assert.equal((await detail('GW901')).drafts.find(d => d.channel === 'dm').revision, 1);
  assert.equal(run('edit-draft', { creatorId: 'GW901', channel: 'dm', subject: '', body: '迟到的旧页面', revision: 0 }).status, 'conflict');
  assert.equal((await detail('GW901')).drafts.find(d => d.channel === 'dm').body, '人工改写 【固定费】');
  fail('edit-draft', { creatorId: 'GW901', channel: 'dm', subject: '', body: '寄到【寄样地址】', revision: 1 }, /不是工作台支持的占位符/);
  fail('edit-draft', { creatorId: 'GW901', channel: 'dm', subject: '', body: 'pay 50 美元', revision: 1 }, /固定费/);
});

test('总结对话并拟回复：冻结对话、依据校验、摘要与回复稿分别采用并读回', async t => {
  const { run, fail, post, detail } = await setup(t);
  fail('prepare-drafts', { requestId: 'req_r0', mode: 'reply', creatorIds: ['GW902'], channels: ['followup'], prompt: '总结', runtime: { cli: 'claude' } }, /还没有登记往来消息/);
  await post('/api/creators/GW901/messages', { channel: 'email', direction: 'out', at: '2026-10-01T00:00:00Z', body: 'Offer: $50 for 2 videos', source: 'fx:a' });
  await post('/api/creators/GW901/messages', { channel: 'email', direction: 'in', at: '2026-10-02T00:00:00Z', body: 'I charge $120 for two.', zh: '两条要120', source: 'fx:b' });
  await post('/api/creators/GW901/negotiation', { status: '旧摘要', our_offer: '', their_ask: '', next_step: '' });
  fail('prepare-drafts', { requestId: 'req_r1', mode: 'reply', creatorIds: ['GW901', 'GW902'], channels: ['followup'], prompt: '总结', runtime: { cli: 'claude' } }, /一位达人/);
  const op = run('prepare-drafts', { requestId: 'req_r1', mode: 'reply', creatorIds: ['GW901'], channels: ['followup'], prompt: '总结并拟回复', runtime: { cli: 'claude' } }).operation;
  assert.equal(op.mode, 'reply');
  assert.match(op.dispatch.message.text, /谈判摘要/);
  assert.match(op.dispatch.message.text, /不发送/);
  assert.doesNotMatch(JSON.stringify(op.draftScope), /"email":"/, '联系人邮箱不进入任务上下文');
  // 模拟宿主创建任务与投递成功。
  run('record-dispatch', { operationId: op.id, stage: 'created', response: { ok: true, taskId: 'tsk_reply', sessionId: 's', shellId: 'sh', url: '/air?task=tsk_reply&dir=fixture-dir' } });
  run('record-dispatch', { operationId: op.id, stage: 'sent', response: { ok: true, taskId: 'tsk_reply', receiptId: 'rc' } });
  const ctx = run('draft-context', { operationId: op.id, taskId: 'tsk_reply' });
  const conv = ctx.scope.creators[0].conversation;
  assert.equal(conv.length, 2);
  assert.equal(ctx.submissionTemplate.negotiation.basis.length, 1);
  const ids = conv.map(m => m.messageId);
  const negotiation = { status: '对方要价高于我方', our_offer: '【固定费】两条', their_ask: '两条 120 美元', next_step: '我方决定是否加价', basis: ids, note: '依据两封邮件' };
  fail('submit-drafts', { operationId: op.id, taskId: 'tsk_reply', submissionId: 's0', drafts: [] }, /negotiation/);
  fail('submit-drafts', { operationId: op.id, taskId: 'tsk_reply', submissionId: 's0', negotiation: { ...negotiation, basis: ['not-a-message'] } }, /不在本任务冻结/);
  fail('submit-drafts', { operationId: op.id, taskId: 'tsk_reply', submissionId: 's0', negotiation, drafts: [{ creatorId: 'GW901', channel: 'followup', subject: '', body: '寄到【寄样地址】' }] }, /不是工作台支持的占位符/);
  const reply = { creatorId: 'GW901', channel: 'followup', subject: '', body: 'Thanks! Could we meet at 【固定费】 + 【佣金比例】%? 【两款商品资料链接】 —【姓名】', note: '还价' };
  const s1 = run('submit-drafts', { operationId: op.id, taskId: 'tsk_reply', submissionId: 's1', negotiation, drafts: [reply] });
  assert.equal(s1.negotiations.length, 1);
  assert.deepEqual(s1.proposals[0].manualPlaceholders, ['【两款商品资料链接】']);
  assert.equal(run('submit-drafts', { operationId: op.id, taskId: 'tsk_reply', submissionId: 's1', negotiation, drafts: [reply] }).duplicate, true);

  // 首页待办与档案能看到待采用的候选。
  assert.deepEqual(run('workbench-home').todo.pendingAdoption.map(x => x.id), ['GW901']);
  const view = run('workbench-creator', { creatorId: 'GW901' });
  assert.equal(view.operations[0].mode, 'reply');
  const np = view.negotiationProposals[0];
  assert.equal(np.current.matchesProposal, false);
  const before = (await detail('GW901')).negotiation;

  // 摘要：别人在确认后改了摘要 → 冲突不写；按最新时间采用 → 写入并读回。
  await post('/api/creators/GW901/negotiation', { status: '有人刚改过', our_offer: '', their_ask: '', next_step: '' });
  assert.equal(run('adopt-negotiation', { proposalId: np.proposalId, adoptionId: 'an1', expectedUpdated: before.updated }).status, 'conflict');
  assert.equal((await detail('GW901')).negotiation.status, '有人刚改过');
  const latest = (await detail('GW901')).negotiation.updated;
  assert.equal(run('adopt-negotiation', { proposalId: np.proposalId, adoptionId: 'an2', expectedUpdated: latest }).status, 'adopted');
  assert.equal((await detail('GW901')).negotiation.their_ask, '两条 120 美元');
  assert.equal(run('adopt-negotiation', { proposalId: np.proposalId, adoptionId: 'an2', expectedUpdated: latest }).status, 'adopted', '重复点击幂等');
  fail('adopt-negotiation', { proposalId: np.proposalId, adoptionId: 'an2', expectedUpdated: null }, /不能更换/);

  // 回复稿写入“跟进”文案位置；其他位置与消息、事件不变。
  const dp = view.proposals[0];
  assert.equal(run('adopt-draft', { proposalId: dp.proposalId, adoptionId: 'ad1', expectedRevision: dp.current.revision }).status, 'adopted');
  const after = await detail('GW901');
  assert.equal(after.drafts.find(d => d.channel === 'followup').body, reply.body);
  assert.equal(after.drafts.find(d => d.channel === 'email').revision, 0);
  assert.equal(after.messages.length, 2);
  assert.equal(after.events.length, 0);
  assert.equal(run('workbench-home').todo.pendingAdoption.length, 0);
});
