'use strict';
// 新建合成库 + 原版 server.py；HTTP代理只注入故障，不接触真实账号、联系人或生产库。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile, execFileSync } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const source = process.env.GAPAW_OUTREACH_SOURCE || '/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach';
const channels = ['comment', 'dm', 'email', 'affiliate', 'followup'];
const at = (seconds = 120) => new Date(Date.now() - seconds * 1000).toISOString();
const newId = (() => { let n = 0; return () => 'request_' + (++n); })();
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function fixture(t, configure = true) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-facts-')), data = path.join(root, 'business'), state = path.join(root, 'state'); fs.mkdirSync(data);
  const records = ['GW901', 'GW902'].map((id, i) => ({ profile: { id, rank: i + 1, handle: 'synthetic_' + id, priority: 'A', followers: 10, topic: '合成用品', angle: '合成角度', anchor1: '合成锚点', anchor2: '合成锚点2', history: '', prior_invite: false, kalodata_window: '', affiliate_gmv_usd: 1, pet_gmv_share_pct: 1, products: [], tiktok_url: 'https://example.invalid/' + id, affiliate_url: 'https://example.invalid/affiliate/' + id, history_detail: {}, history_snapshot: '' }, drafts: channels.map(channel => ({ channel, subject: '', body: '合成草稿 【固定费】 【佣金比例】' })) }));
  fs.writeFileSync(path.join(data, 'seed.json'), JSON.stringify({ source_sha256: 'synthetic', records }));
  const port = await freePort();
  const proc = spawn('python3', ['-B', path.join(source, 'server.py'), '--data-dir', data, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let serviceError = ''; proc.stderr.on('data', b => { serviceError += b; });
  const url = 'http://127.0.0.1:' + port;
  let started = false;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url + '/api/health')).ok) { started = true; break; } } catch (_) { } await new Promise(r => setTimeout(r, 50)); }
  if (!started) { proc.kill(); throw new Error('合成工作台未启动'); }
  const control = { calls: [], dropBefore: false, dropAfter: false, failReadAfterPost: false, blockReads: false, holdNextRead: false, held: [], waiting: [] };
  const proxy = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    control.calls.push({ method: req.method, path: req.url });
    if (req.method === 'POST' && control.dropBefore) { req.socket.destroy(); return; }
    if (req.method === 'GET' && req.url.startsWith('/api/creators/') && control.blockReads) { res.writeHead(503); res.end('{}'); return; }
    try {
      const upstream = await fetch(url + req.url, { method: req.method, headers: req.method === 'POST' ? { 'X-Outreach-Request': req.headers['x-outreach-request'] || '', 'Content-Type': 'application/json' } : {}, body: req.method === 'POST' ? body : undefined });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const send = () => { res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') }); res.end(bytes); };
      if (req.method === 'POST') {
        if (control.failReadAfterPost) control.blockReads = true;
        if (control.dropAfter) { req.socket.destroy(); return; }
      }
      if (req.method === 'GET' && req.url.startsWith('/api/creators/') && control.holdNextRead) { control.holdNextRead = false; control.held.push(send); control.waiting.splice(0).forEach(fn => fn()); return; }
      send();
    } catch (_) { req.socket.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
  const expectedSource = crypto.createHash('sha256').update(JSON.stringify(proxyUrl)).digest('hex');
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state }; delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const raw = (command, input = {}) => new Promise((resolve, reject) => {
    if (command === 'workbench-fact-status') input = { expectedSource, ...input };
    const child = execFile(binary, [command], { env, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 }, (err, stdout) => { if (err) reject(err); else { try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } } }); child.stdin.end(JSON.stringify(input));
  });
  const run = async (command, input = {}) => { const r = await raw(command, input); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const fail = async (command, input) => { const r = await raw(command, input); assert.ok(r.ok === false || r.data?.receipt?.status === 'rejected', JSON.stringify(r)); return r; };
  const get = async (id = 'GW901') => (await fetch(url + '/api/creators/' + id)).json();
  const legacy = async (route, input) => { const r = await fetch(url + route, { method: 'POST', headers: { 'X-Outreach-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); assert.equal(r.status, 200); return r.json(); };
  const sql = code => execFileSync('python3', ['-c', code, path.join(data, 'outreach.sqlite3'), path.join(state, 'state.sqlite')], { encoding: 'utf8' });
  const settings = (patch, revision = 0, requestId = newId()) => ({ creatorId: 'GW901', expectedSource, requestId, confirmed: true, expectedRevision: revision, settings: patch, basis: '人工确认的合成依据' });
  const event = (type = '发送尝试', extra = {}, requestId = newId()) => ({ creatorId: 'GW901', expectedSource, requestId, confirmed: true, event: { channel: 'email', type, at: at(), proof: '合成截图或人工确认依据', note: '', ...extra } });
  const message = (extra = {}, requestId = newId()) => ({ creatorId: 'GW901', expectedSource, requestId, confirmed: true, message: { channel: 'email', direction: 'in', at: at(), sender: '合成发送方', subject: '合成主题', body: '合成往来原文', zh: '合成中文摘要', kind: '正常', source: 'synthetic-source-' + requestId, ...extra } });
  const waitHeld = () => control.held.length ? Promise.resolve() : new Promise(resolve => control.waiting.push(resolve));
  const release = () => control.held.splice(0).forEach(fn => fn());
  t.after(async () => { release(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proc.kill(); if (proc.exitCode === null) await new Promise(resolve => proc.once('exit', resolve)); fs.rmSync(root, { recursive: true, force: true }); assert.equal(serviceError, '', '原服务不应出现内部异常'); });
  if (configure) await run('outreach-configure', { url: proxyUrl });
  return { root, state, run, raw, fail, get, legacy, sql, settings, event, message, control, waitHeld, release, url, proxyUrl, expectedSource };
}

test('事实契约只读并明确原报价限制、未知与人工登记边界', async t => {
  const absent = await fixture(t, false);
  await absent.fail('workbench-fact-status', { creatorId: 'GW901' }); assert.equal(fs.existsSync(absent.state), false);
  await absent.fail('workbench-fact-contract', { creatorId: 'GW901' }); assert.equal(fs.existsSync(absent.state), false);
  const f = await fixture(t), before = await f.get();
  const c = await f.run('workbench-fact-contract', { creatorId: 'GW901' });
  assert.equal(c.expectedSource, f.expectedSource); assert.equal(c.sourceUrl, f.proxyUrl); assert.match(c.contract.sourceScope, /不是数据库身份/); assert.match(c.contract.settingsBasisScope, /不长期保存/);
  assert.equal(c.settingsRevision, 0); assert.equal(c.settings.commission, null); assert.equal(c.settings.account_checked, false);
  assert.deepEqual(c.contract.feeChoices, [50, 100]); assert.match(c.contract.feeScope, /工作台当前接口限制/); assert.match(c.contract.note, /不发送/); assert.deepEqual(c.events, []);
  assert.deepEqual(await f.get(), before); assert.equal(f.control.calls.filter(x => x.method === 'POST').length, 0);
  await f.fail('workbench-fact-contract', { creatorId: 'GW901', extra: true });
});

test('设置经原API按版本保存、独立读回、固定请求幂等并保留未知值', async t => {
  const f = await fixture(t), request = f.settings({ fee: 100, commission: 12.5, owner: '人工负责人', notes: '多行\n人工依据' });
  const saved = (await f.run('edit-settings', request)).receipt; assert.equal(saved.status, 'saved'); assert.equal(saved.revision, 1);
  const detail = await f.get(); assert.equal(detail.settings.fee, 100); assert.equal(detail.settings.commission, 12.5); assert.equal(detail.settings.account_checked, false); assert.equal(detail.revision, 1);
  assert.deepEqual((await f.run('edit-settings', request)).receipt, saved); assert.equal((await f.get()).revision, 1);
  await f.fail('edit-settings', { ...request, settings: { fee: 50 } }); await f.fail('edit-settings', { ...request, creatorId: 'GW902' });
  const stale = (await f.run('edit-settings', f.settings({ notes: '旧版本不得覆盖' }, 0))).receipt; assert.equal(stale.status, 'conflict');
  const clear = (await f.run('edit-settings', f.settings({ commission: null, owner: '', notes: '' }, 1))).receipt; assert.equal(clear.status, 'saved'); assert.equal((await f.get()).settings.commission, null);
  const local = f.sql("import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[2]);print(json.dumps(c.execute('SELECT * FROM gapaw_fact_requests').fetchall()));c.close()");
  assert.ok(!local.includes('人工负责人')); assert.ok(!local.includes('人工确认的合成依据'));
});

test('设置白名单、数值、确认依据、渠道与日期严格拒绝，不写业务', async t => {
  const f = await fixture(t), invalid = [
    { fee: 75 }, { fee: true }, { commission: true }, { commission: -1 }, { commission: 101 }, { commission: '10' },
    { channel_ready: { email: true } }, { channel_ready: { comment: false, dm: false, email: true, affiliate: false } },
    { account_checked: 1 }, { next_followup: '2026-02-30' }, { email: 'invalid' }, { email_source: 'http://user:password@example.invalid/' }, { unknown: true },
  ];
  for (const patch of invalid) await f.fail('edit-settings', f.settings(patch));
  await f.fail('edit-settings', { ...f.settings({ notes: 'x' }), confirmed: false });
  await f.fail('edit-settings', { ...f.settings({ notes: 'x' }), basis: '' });
  await f.fail('edit-settings', { ...f.settings({ notes: 'x' }), expectedRevision: '0' });
  await f.fail('edit-settings', { ...f.settings({ notes: 'x' }), extra: true });
  assert.equal((await f.get()).revision, 0); assert.equal(f.control.calls.filter(x => x.method === 'POST').length, 0);
});

test('事件登记保留原工作台依赖，只记人工事实而不发送，异载荷不借弱幂等', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('record-event', f.event('平台受理'))).receipt.status, 'rejected');
  await f.fail('record-event', f.event('发送尝试', { proof: '' }));
  await f.fail('record-event', f.event('发送尝试', { channel: 'followup' }));
  await f.fail('record-event', f.event('发送尝试', { at: new Date(Date.now() + 3600000).toISOString() }));
  const request = f.event('发送尝试', { at: at(300) });
  const saved = (await f.run('record-event', request)).receipt; assert.equal(saved.status, 'saved'); assert.ok(saved.remoteId);
  assert.equal((await f.run('record-event', request)).receipt.status, 'saved');
  await f.fail('record-event', { ...request, event: { ...request.event, note: '不同载荷' } }); await f.fail('record-event', { ...request, creatorId: 'GW902' });
  assert.equal((await f.run('record-event', f.event('平台受理', { at: at(250) }))).receipt.status, 'saved');
  assert.equal((await f.run('record-event', f.event('明确已读', { at: at(200) }))).receipt.status, 'saved');
  assert.equal((await f.run('record-event', f.event('有效回复', { at: at(180) }))).receipt.status, 'saved');
  assert.equal((await f.run('record-event', f.event('确认合作', { at: at(160) }))).receipt.status, 'rejected');
  assert.equal((await f.get()).messages.length, 0);
  const reused = f.event('发送尝试', {}, 'external_reused');
  await f.legacy('/api/creators/GW901/events', { ...reused.event, proof: '原来的依据', request_id: reused.requestId });
  const count = (await f.get()).events.length;
  assert.equal((await f.run('record-event', reused)).receipt.status, 'conflict'); assert.equal((await f.get()).events.length, count);
});

test('消息按来源核对完整原文，out登记不自动建事件，禁止静默改既有摘要', async t => {
  const f = await fixture(t), request = f.message({ direction: 'out', body: 'ONLY_SYNTHETIC_MESSAGE_BODY' });
  const saved = (await f.run('record-message', request)).receipt; assert.equal(saved.status, 'saved');
  assert.equal((await f.get()).messages.length, 1); assert.equal((await f.get()).events.length, 0);
  assert.deepEqual((await f.run('record-message', request)).receipt, saved);
  await f.fail('record-message', { ...request, message: { ...request.message, body: '不同原文' } });
  const changed = { ...request, requestId: newId(), message: { ...request.message, zh: '不能借同来源更新摘要', kind: '自动回复' } };
  assert.equal((await f.run('record-message', changed)).receipt.status, 'conflict'); assert.equal((await f.get()).messages[0].zh, request.message.zh);
  assert.equal((await f.run('record-message', { ...request, requestId: newId(), creatorId: 'GW902' })).receipt.status, 'rejected');
  for (const fields of [{ source: '' }, { body: '  ' }, { direction: 'both' }, { kind: 'other' }, { channel: 'followup' }, { at: new Date(Date.now() + 3600000).toISOString() }, { body: '中'.repeat(18000) }]) await f.fail('record-message', f.message(fields));
  const local = f.sql("import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[2]);print(json.dumps(c.execute('SELECT * FROM gapaw_fact_requests').fetchall()));c.close()"); assert.ok(!local.includes('ONLY_SYNTHETIC_MESSAGE_BODY'));
});

test('撤销绑定事件hash与达人，只能按原服务依赖从最后有效事件撤销', async t => {
  const f = await fixture(t); await f.run('record-event', f.event('发送尝试', { at: at(300) })); await f.run('record-event', f.event('平台受理', { at: at(200) }));
  const context = await f.run('workbench-fact-contract', { creatorId: 'GW901' }), first = context.events[0], latest = context.events[1];
  const request = e => ({ creatorId: 'GW901', expectedSource: context.expectedSource, requestId: newId(), confirmed: true, eventId: e.id, expectedEventHash: e.eventHash, reason: '人工核对后撤销合成记录' });
  assert.equal((await f.run('void-event', request(first))).receipt.status, 'rejected');
  assert.equal((await f.run('void-event', { ...request(latest), expectedEventHash: '0'.repeat(64) })).receipt.status, 'conflict');
  const valid = request(latest), saved = (await f.run('void-event', valid)).receipt; assert.equal(saved.status, 'saved'); assert.equal((await f.get()).events.find(e => e.id === latest.id).void_reason, valid.reason);
  assert.deepEqual((await f.run('void-event', valid)).receipt, saved); await f.fail('void-event', { ...valid, reason: '异载荷' });
  assert.equal((await f.run('void-event', request(latest))).receipt.status, 'conflict');
  assert.equal((await f.run('void-event', request(first))).receipt.status, 'saved');
  await f.fail('void-event', { ...request(first), creatorId: 'GW902' });
});

test('写入回应丢失后保留unknown，禁止新编号，仅读核对恢复原回执', async t => {
  const f = await fixture(t), request = f.event(); f.control.dropAfter = true; f.control.failReadAfterPost = true;
  const unknown = (await f.run('record-event', request)).receipt; assert.equal(unknown.status, 'unknown'); assert.equal(unknown.canRetry, true); assert.equal((await f.get()).events.length, 1);
  await f.fail('record-message', f.message());
  const calls = f.control.calls.length; assert.equal((await f.run('workbench-fact-status', { creatorId: 'GW901', requestId: request.requestId })).receipts[0].status, 'unknown'); assert.equal(f.control.calls.length, calls);
  f.control.dropAfter = false; f.control.failReadAfterPost = false; f.control.blockReads = false;
  const postCount = f.control.calls.filter(c => c.method === 'POST').length;
  const recovered = (await f.run('workbench-fact-status', { creatorId: 'GW901', requestId: request.requestId, reconcile: true })).receipts[0]; assert.equal(recovered.status, 'saved');
  assert.equal(f.control.calls.filter(c => c.method === 'POST').length, postCount); assert.equal((await f.run('record-event', request)).receipt.status, 'saved');
  await f.fail('workbench-fact-status', { creatorId: 'GW902', requestId: request.requestId });
});

test('暂未读到仍为unknown，原编号重试可恢复，迟到读取不覆盖saved', async t => {
  const f = await fixture(t), request = f.message(); f.control.dropBefore = true;
  assert.equal((await f.run('record-message', request)).receipt.status, 'unknown'); assert.equal((await f.get()).messages.length, 0);
  assert.equal((await f.run('workbench-fact-status', { creatorId: 'GW901', requestId: request.requestId, reconcile: true })).receipts[0].status, 'unknown');
  f.control.dropBefore = false; f.control.holdNextRead = true;
  const stale = f.run('workbench-fact-status', { creatorId: 'GW901', requestId: request.requestId, reconcile: true }); await f.waitHeld();
  const saved = (await f.run('record-message', request)).receipt; assert.equal(saved.status, 'saved');
  f.release(); assert.equal((await stale).receipts[0].status, 'saved'); assert.equal((await f.get()).messages.length, 1);
});

test('并发相同请求不会重复设置审计、跨达人共享编号拒绝', async t => {
  const f = await fixture(t), request = f.settings({ commission: 20 });
  const results = await Promise.all([f.run('edit-settings', request), f.run('edit-settings', request)]);
  assert.ok(results.some(r => r.receipt.status === 'saved'));
  const current = (await f.run('workbench-fact-status', { creatorId: 'GW901', requestId: request.requestId, reconcile: true })).receipts[0]; assert.equal(current.status, 'saved'); assert.equal((await f.get()).revision, 1);
  assert.equal(f.sql("import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);print(c.execute(\"SELECT count(*) FROM audit WHERE kind='设置'\").fetchone()[0]);c.close()").trim(), '1');
  await f.fail('edit-settings', { ...request, creatorId: 'GW902' });
  assert.equal((await f.get('GW902')).revision, 0);
});


test('提交前校验以持久拒绝回执返回，修正后新确认不锁成未知', async t => {
  const f = await fixture(t), request = f.message({ subject: 'x'.repeat(301) });
  const invalid = (await f.run('record-message', request)).receipt;
  assert.equal(invalid.status, 'rejected'); assert.equal(invalid.canRetry, false); assert.match(invalid.message, /提交前校验未通过/);
  assert.equal(f.control.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal((await f.run('workbench-fact-status', { creatorId: 'GW901', requestId: request.requestId })).receipts[0].status, 'rejected');
  assert.deepEqual((await f.run('record-message', request)).receipt, invalid);
  await f.fail('record-message', { ...request, message: { ...request.message, subject: '修正主题' } });
  const corrected = { ...request, requestId: newId(), message: { ...request.message, subject: '修正主题' } };
  assert.equal((await f.run('record-message', corrected)).receipt.status, 'saved');
  assert.equal((await f.get()).messages.length, 1);
});

test('人工登记首次写入绑定来源，切换同名达人来源不复用回执或未知锁', async t => {
  const a = await fixture(t), b = await fixture(t);
  const oldSaved = a.event(), oldUnknown = a.message();
  assert.equal((await a.run('record-event', oldSaved)).receipt.status, 'saved');
  a.control.dropBefore = true;
  assert.equal((await a.run('record-message', oldUnknown)).receipt.status, 'unknown');
  const staleForm = a.settings({ owner: 'A表单不可写到B' });
  await a.run('outreach-configure', { url: b.proxyUrl });
  const current = await a.run('workbench-fact-contract', { creatorId: 'GW901' });
  assert.equal(current.expectedSource, b.expectedSource); assert.deepEqual(current.recentReceipts, []);
  const before = b.control.calls.filter(c => c.method === 'POST').length;
  assert.equal((await a.raw('edit-settings', staleForm)).ok, false);
  assert.equal((await a.raw('record-event', { ...a.event(), expectedSource: undefined })).ok, false);
  for (const request of [oldSaved, oldUnknown]) {
    assert.equal((await a.raw('workbench-fact-status', { creatorId: 'GW901', requestId: request.requestId, expectedSource: a.expectedSource, reconcile: true })).ok, false);
    assert.equal((await a.raw('workbench-fact-status', { creatorId: 'GW901', requestId: request.requestId, expectedSource: b.expectedSource })).ok, false);
  }
  assert.equal(b.control.calls.filter(c => c.method === 'POST').length, before);
  assert.equal((await b.get()).revision, 0);
  assert.equal((await a.run('record-event', { ...a.event(), expectedSource: b.expectedSource })).receipt.status, 'saved');
  assert.equal((await b.get()).events.length, 1); assert.equal((await a.get()).messages.length, 0);
  assert.equal((await a.run('workbench-fact-status', { creatorId: 'GW901', expectedSource: b.expectedSource })).receipts.length, 1);
});
