'use strict';
// 合成HTTP供应端用于故障与并发注入；真实插件二进制/SQLite，不访问实际服务。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const token = 'SYNTHETIC_TEST_AUTHORIZATION_' + 'x'.repeat(40);
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const clone = structuredClone;
function stored(payload) {
  const candidateIds = payload.report.candidates.map((_, i) => 'candidate_' + payload.adoptionId + '_' + i);
  const receipt = { schemaVersion: 1, adoptionId: payload.adoptionId, businessStoreId: payload.expectedStoreId, payloadHash: hash(payload), batchId: 'batch_' + payload.adoptionId, operationId: payload.operationId, taskId: payload.taskId, resultId: payload.resultId, resultRevision: payload.resultRevision, candidateCount: candidateIds.length, candidateIds, status: 'candidate_pending_verification', createdAt: '2026-10-26T00:00:00Z' };
  const batch = { ...receipt, verification: 'unverified', reportMetadata: Object.fromEntries(['schemaVersion', 'methodVersion', 'generatedAt', 'period', 'currency', 'coverage', 'missingFields'].map(k => [k, payload.report[k]])), observationCount: payload.observations.length, warnings: ['合成供应端，候选仍待核验'], handleConflicts: [] };
  const candidates = payload.report.candidates.map((c, i) => ({ candidateId: candidateIds[i], batchId: receipt.batchId, reportedIdentity: Object.fromEntries(['platform', 'creatorId', 'handle', 'profileUrl'].map(k => [k, c[k]])), reason: c.reason, computed: payload.computed.candidates[i], missingFields: c.missingFields, sources: c.sources, verification: 'unverified', status: 'candidate_pending_verification' }));
  return { found: true, receipt, batch, candidates };
}
function report() {
  return { schemaVersion: 1, methodVersion: 'roi-selection-v1', generatedAt: '2026-10-02T00:00:00Z', period: { start: '2026-10-01', end: '2026-10-01', timeZone: 'UTC' }, currency: 'USD', coverage: '合成报告，仅测试接口核对', missingFields: [], candidates: [{ platform: 'tiktok', creatorId: 'synthetic_creator', handle: 'synthetic_creator', profileUrl: 'https://www.tiktok.com/@synthetic_creator', reason: '合成候选，未核验身份', sources: [{ url: 'https://example.invalid/source', capturedAt: '2026-10-02T00:00:00Z', note: '合成来源' }], missingFields: [], videos: [{ videoId: 'video_one', url: 'https://example.invalid/video/one', publishedAt: '2026-10-01T00:00:00Z', contributionRate: '0.3', sales: [{ kind: 'total', gmv: '100', commissionRate: '0.1' }], adSpend: null, fixedFee: '0', sampleCost: '0' }] }] };
}
async function fixture(t, setup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-workbench-client-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-client-')));
  const state = path.join(root, 'state');
  const control = { storeId: 'store_synthetic', records: new Map(), calls: [], holdReceipts: 0, held: [], waiting: [], dropBefore: false, dropAfter: false, failReceipt: false, forged: false, shortPage: false, wrongPageStore: false, redirect: false, leakToken: false, oversized: false };
  const respond = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', b => { body += b; }); req.on('end', () => {
      assert.equal(req.url, '/api/plugin-selection'); assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer ' + token);
      const { action, payload } = JSON.parse(body); control.calls.push({ action, payload: clone(payload) });
      if (control.redirect) { res.writeHead(302, { location: '/redirected' }); res.end(); return; }
      if (control.leakToken) { respond(res, { secret: token }); return; }
      if (control.oversized) { respond(res, { data: 'x'.repeat(2 * 1024 * 1024) }); return; }
      if (action === 'status') return respond(res, { protocolVersion: 1, ready: true, businessStoreId: control.storeId, status: 'ready' });
      if (action === 'preview') return respond(res, { businessStoreId: control.storeId, payloadHash: hash(payload), candidateCount: payload.report.candidates.length, canAdopt: true, verification: 'unverified', warnings: ['合成预览，尚未写入'], handleConflicts: [] });
      if (action === 'adopt') {
        if (control.dropBefore) { req.socket.destroy(); return; }
        if (!control.records.has(payload.adoptionId)) control.records.set(payload.adoptionId, stored(payload));
        if (control.dropAfter) { req.socket.destroy(); return; }
        const record = clone(control.records.get(payload.adoptionId)); delete record.found;
        return respond(res, { ...record, replayed: false });
      }
      if (action === 'receipt') {
        if (control.holdReceipts > 0) { control.holdReceipts--; control.held.push(() => respond(res, { found: false })); control.waiting.splice(0).forEach(fn => fn()); return; }
        if (control.failReceipt) { res.writeHead(503); res.end('SYNTHETIC_REMOTE_PRIVATE_ERROR'); return; }
        const record = clone(control.records.get(payload.adoptionId) || { found: false });
        if (control.forged && record.found) record.candidates[0].reportedIdentity.creatorId = 'forged_creator';
        return respond(res, record);
      }
      const all = [...control.records.values()];
      if (action === 'list') {
        const items = all.slice(payload.offset, payload.offset + payload.limit).map(x => clone(x.batch));
        if (control.shortPage) items.pop(); if (control.wrongPageStore && items[0]) items[0].businessStoreId = 'wrong_store';
        return respond(res, { items, total: all.length, offset: payload.offset, limit: payload.limit, nextOffset: payload.offset + payload.limit < all.length ? payload.offset + payload.limit : null });
      }
      if (action === 'batch') {
        const record = all.find(x => x.batch.batchId === payload.batchId); const candidates = clone(record.candidates.slice(payload.offset, payload.offset + payload.limit)); const batch = clone(record.batch);
        if (control.shortPage) candidates.pop(); if (control.wrongPageStore) batch.businessStoreId = 'wrong_store';
        return respond(res, { batch, candidates, total: record.candidates.length, offset: payload.offset, limit: payload.limit, nextOffset: payload.offset + payload.limit < record.candidates.length ? payload.offset + payload.limit : null });
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state, GAPAW_CHROME_PLUGIN_DIR: path.join(root, 'unused'), GAPAW_CHROME_DATA_DIR: path.join(root, 'unused-data'), GAPAW_WORKBENCH_URL: 'http://127.0.0.1:' + server.address().port, GAPAW_WORKBENCH_ADOPTION_TOKEN: token };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  // execFile does not accept stdin as an option; write it immediately on the returned child.
  const call = (command, input = {}, override = {}) => new Promise((resolve, reject) => {
    const child = execFile(binary, [command], { env: { ...env, ...override }, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => { if (error) reject(error); else { try { const value = JSON.parse(stdout); assert.ok(!stdout.includes(token)); resolve(value); } catch (e) { reject(e); } } });
    child.stdin.end(JSON.stringify(input));
  });
  const run = async (command, input = {}, override = {}) => { const out = await call(command, input, override); assert.equal(out.ok, true, JSON.stringify(out)); return out.data; };
  let owner;
  if (setup) {
    await run('configure', { workspace: { dirId: 'client_fixture', path: workspace } });
    const op = (await run('prepare-operation', { requestId: 'request_one', prompt: '合成客户端测试', runtime: { cli: 'codex' } })).operation;
    owner = { operationId: op.id, taskId: 'task_one' };
    await run('record-dispatch', { operationId: op.id, stage: 'created', response: { taskId: 'task_one', sessionId: 'session_one', shellId: 'shell_one', url: '/air?task=task_one' } });
    await run('submit-result', { ...owner, resultId: 'result_one', expectedRevision: 0, report: report() });
  }
  const prepare = async (id = 'adoption_one', observationIds = []) => (await run('prepare-adoption', { ...owner, resultId: 'result_one', adoptionId: id, observationIds })).plan;
  const adopt = plan => run('adopt-result', { adoptionId: plan.adoptionId, expectedPayloadHash: plan.payloadHash });
  const waitHeld = () => control.held.length ? Promise.resolve() : new Promise(resolve => control.waiting.push(resolve));
  const release = () => control.held.splice(0).forEach(fn => fn());
  const python = code => execFileSync('python3', ['-c', code, path.join(state, 'state.sqlite')], { encoding: 'utf8' });
  t.after(async () => { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  return { root, state, env, control, owner, run, call, prepare, adopt, waitHeld, release, python };
}

test('准备仅预览，明确提交后独立读回验证且凭证不落库', async t => {
  const f = await fixture(t), plan = await f.prepare();
  assert.equal(plan.status, 'prepared'); assert.equal(f.control.records.size, 0); assert.equal(f.control.calls.filter(x => x.action === 'adopt').length, 0);
  assert.deepEqual(plan.observationIds, []); assert.equal((await f.prepare()).adoptionId, plan.adoptionId);
  const saved = (await f.adopt(plan)).plan; assert.equal(saved.status, 'verified'); assert.equal(saved.receipt.status, 'candidate_pending_verification'); assert.equal(f.control.records.size, 1);
  assert.deepEqual((await f.adopt(plan)).plan.receipt, saved.receipt); assert.equal(f.control.calls.filter(x => x.action === 'adopt').length, 1);
  const calls = f.control.calls.length; assert.equal((await f.run('get-adoption', { ...f.owner, taskId: undefined })).plans[0].status, 'verified'); assert.equal(f.control.calls.length, calls);
  const persisted = f.python("import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute('SELECT * FROM gapaw_workbench_adoptions').fetchall()));c.close()"); assert.ok(!persisted.includes(token));
  assert.equal((await f.run('workbench-list', {})).items.length, 1); assert.equal((await f.run('workbench-batch', { batchId: saved.receipt.batchId })).candidates.length, 1);
});

test('同报告可改观测重新预览，但另一计划已提交后拒绝重复发起', async t => {
  const f = await fixture(t), first = await f.prepare('first');
  const template = (await f.run('observation-contract', f.owner)).templates[0].submissionTemplate;
  await f.run('submit-observation', { rawJson: JSON.stringify(template) });
  const second = await f.prepare('second', [template.observationId]); assert.deepEqual(second.observationIds, [template.observationId]);
  assert.deepEqual((await f.run('get-adoption', { operationId: f.owner.operationId })).plans.map(p => p.adoptionId), ['second', 'first']);
  f.control.dropBefore = true; assert.equal((await f.adopt(first)).plan.status, 'submission_unknown');
  assert.equal((await f.call('adopt-result', { adoptionId: second.adoptionId, expectedPayloadHash: second.payloadHash })).ok, false);
  assert.equal((await f.call('prepare-adoption', { ...f.owner, resultId: 'result_one', adoptionId: 'third', observationIds: [] })).ok, false);
  assert.equal(f.control.calls.filter(x => x.action === 'adopt').length, 1);
});

test('已写但回应断开保留未知，报告更新后仍按原动作核对且不重写', async t => {
  const f = await fixture(t), plan = await f.prepare(); f.control.dropAfter = true;
  assert.equal((await f.adopt(plan)).plan.status, 'submission_unknown'); assert.equal(f.control.records.size, 1);
  await f.run('submit-result', { ...f.owner, resultId: 'result_two', expectedRevision: 1, report: report() });
  f.control.dropAfter = false;
  const recovered = (await f.run('reconcile-adoption', { adoptionId: plan.adoptionId })).plan;
  assert.equal(recovered.status, 'verified'); assert.equal(recovered.resultId, 'result_one'); assert.equal(f.control.calls.filter(x => x.action === 'adopt').length, 1);
});

test('未写断开可用原编号重试，已应答但伪回执不得标成功', async t => {
  const f = await fixture(t), plan = await f.prepare(); f.control.dropBefore = true;
  assert.equal((await f.adopt(plan)).plan.status, 'submission_unknown'); assert.equal(f.control.records.size, 0);
  f.control.dropBefore = false; f.control.forged = true;
  assert.equal((await f.adopt(plan)).plan.status, 'verification_pending'); assert.equal(f.control.records.size, 1);
  f.control.forged = false;
  assert.equal((await f.run('reconcile-adoption', { adoptionId: plan.adoptionId })).plan.status, 'verified');
  assert.deepEqual(f.control.calls.filter(x => x.action === 'adopt').map(x => x.payload.adoptionId), [plan.adoptionId, plan.adoptionId]);
});

test('迟到的prepared核对不能把在途提交回退并放行其他计划', async t => {
  const f = await fixture(t), first = await f.prepare('first'), second = await f.prepare('second');
  f.control.holdReceipts = 1;
  const stale = f.run('reconcile-adoption', { adoptionId: first.adoptionId }); await f.waitHeld();
  f.control.dropBefore = true; assert.equal((await f.adopt(first)).plan.status, 'submission_unknown');
  f.release(); assert.equal((await stale).plan.status, 'submission_unknown');
  assert.equal((await f.call('adopt-result', { adoptionId: second.adoptionId, expectedPayloadHash: second.payloadHash })).ok, false);
});

test('迟到失败不能覆盖另一进程已核验回执', async t => {
  const f = await fixture(t), plan = await f.prepare(); f.control.dropBefore = true; await f.adopt(plan); f.control.dropBefore = false;
  f.control.holdReceipts = 1;
  const stale = f.run('reconcile-adoption', { adoptionId: plan.adoptionId }); await f.waitHeld();
  const done = (await f.adopt(plan)).plan; assert.equal(done.status, 'verified');
  f.release(); assert.deepEqual((await stale).plan.receipt, done.receipt);
  assert.equal((await f.run('get-adoption', { operationId: f.owner.operationId })).plans[0].status, 'verified');
});

test('过期报告、业务库变更、端点变更和错误摘要均拒绝旧计划写入', async t => {
  const f = await fixture(t), plan = await f.prepare();
  assert.equal((await f.call('adopt-result', { adoptionId: plan.adoptionId, expectedPayloadHash: 'wrong' })).ok, false);
  f.control.storeId = 'changed_store'; assert.equal((await f.call('adopt-result', { adoptionId: plan.adoptionId, expectedPayloadHash: plan.payloadHash })).ok, false); f.control.storeId = 'store_synthetic';
  assert.equal((await f.call('adopt-result', { adoptionId: plan.adoptionId, expectedPayloadHash: plan.payloadHash }, { GAPAW_WORKBENCH_URL: 'http://127.0.0.1:1' })).ok, false);
  await f.run('submit-result', { ...f.owner, resultId: 'result_two', expectedRevision: 1, report: report() });
  assert.equal((await f.call('adopt-result', { adoptionId: plan.adoptionId, expectedPayloadHash: plan.payloadHash })).ok, false);
  assert.equal(f.control.calls.filter(x => x.action === 'adopt').length, 0);
});

test('未配置状态与本地读取不创建目录；严格端点、代理、跳转及响应限制', async t => {
  const f = await fixture(t, false);
  const unconfigured = { GAPAW_WORKBENCH_URL: undefined, GAPAW_WORKBENCH_ADOPTION_TOKEN: undefined };
  assert.equal((await f.run('workbench-status', {}, unconfigured)).configured, false);
  assert.deepEqual((await f.run('get-adoption', { operationId: 'none' }, unconfigured)).plans, []); assert.equal(fs.existsSync(f.state), false);
  for (const url of ['http://localhost:1234', 'http://127.1:1234', 'https://127.0.0.1:1234', f.env.GAPAW_WORKBENCH_URL + '/path', f.env.GAPAW_WORKBENCH_URL + '?query=1', 'http://user:password@127.0.0.1:1234']) assert.equal((await f.run('workbench-status', {}, { GAPAW_WORKBENCH_URL: url })).available, false);
  assert.equal((await f.run('workbench-status', {}, { GAPAW_WORKBENCH_ADOPTION_TOKEN: 'short' })).available, false);
  assert.equal((await f.run('workbench-status', {}, { HTTP_PROXY: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' })).available, true);
  for (const flag of ['redirect', 'leakToken', 'oversized']) { f.control[flag] = true; assert.equal((await f.run('workbench-status')).available, false); f.control[flag] = false; }
  assert.equal(fs.existsSync(f.state), false);
});

test('候选分页拒绝其他库或不完整页面，读取不触发写入', async t => {
  const f = await fixture(t), plan = await f.prepare(), saved = (await f.adopt(plan)).plan;
  const before = f.control.calls.filter(x => x.action === 'adopt').length;
  for (const flag of ['shortPage', 'wrongPageStore']) { f.control[flag] = true; assert.equal((await f.call('workbench-list')).ok, false); assert.equal((await f.call('workbench-batch', { batchId: saved.receipt.batchId })).ok, false); f.control[flag] = false; }
  assert.equal(f.control.calls.filter(x => x.action === 'adopt').length, before);
});
