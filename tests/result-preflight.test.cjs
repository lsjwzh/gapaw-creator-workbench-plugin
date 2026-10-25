'use strict';
// 真实 Rust 命令与隔离 SQLite；无真实账号、浏览器或平台请求。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';

function fixture(t, setup = true) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-preflight-'));
  const state = path.join(root, 'state');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-preflight-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state, GAPAW_CHROME_PLUGIN_DIR: path.join(root, 'unused-source'), GAPAW_CHROME_DATA_DIR: path.join(root, 'unused-data') };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const raw = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
  const run = (command, input = {}) => { const out = raw(command, input); assert.equal(out.ok, true, JSON.stringify(out)); return out.data; };
  const prepare = (requestId, create = true) => {
    const operation = run('prepare-operation', { requestId, prompt: '核验已有资料，未知成本不补零。', runtime: { cli: 'codex' } }).operation;
    const taskId = 'task-' + requestId;
    if (create) run('record-dispatch', { operationId: operation.id, stage: 'created', response: { taskId, sessionId: 'session-' + requestId, shellId: 'shell-' + requestId, url: '/air?task=' + taskId } });
    return { operationId: operation.id, taskId };
  };
  let owner;
  if (setup) { run('configure', { workspace: { dirId: 'fixture-dir', path: workspace } }); owner = prepare('one'); }
  const payload = (resultId = 'result-one', expectedRevision = 0) => ({ ...owner, resultId, expectedRevision, report: report() });
  const python = code => execFileSync('python3', ['-c', code, path.join(state, 'state.sqlite')], { encoding: 'utf8' });
  return { root, state, run, raw, owner, prepare, payload, python };
}
function report() {
  const video = (id, fields = {}) => ({ videoId: id, url: 'https://www.tiktok.com/@fixture/video/' + id, publishedAt: '2026-10-01T00:00:00Z', contributionRate: '0.300000000001', sales: [{ kind: 'total', gmv: '0.1', commissionRate: '0.3' }], adSpend: '0', fixedFee: '0', sampleCost: '0', ...fields });
  const candidate = (id, videos, sources = ['https://affiliate.tiktok.com/creator/one']) => ({ platform: 'tiktok', creatorId: id, handle: 'fixture_' + id, profileUrl: 'https://www.tiktok.com/@fixture_' + id, reason: '隔离测试资料，不是真实采集', sources: sources.map(url => ({ url, capturedAt: '2026-10-02T00:00:00Z', note: '仅作为来源链接标签，不证明字段已核验' })), missingFields: [], videos });
  return { schemaVersion: 1, methodVersion: 'roi-selection-v1', generatedAt: '2026-10-02T00:00:00Z', period: { start: '2026-10-01', end: '2026-10-01', timeZone: 'UTC' }, currency: 'USD', coverage: '仅给定样本，不保证完整分页', missingFields: [], candidates: [candidate('known', [video('tiny'), video('zero', { contributionRate: '0.3' }), video('negative', { fixedFee: '1' })]), candidate('unknown', [video('unknown', { adSpend: null })], ['https://www.kalodata.com/creator/one', 'https://example.invalid/evidence'])] };
}
function files(directory) {
  if (!fs.existsSync(directory)) return null;
  const out = {};
  // SQLite只读WAL连接仍维护共享锁页及空WAL；验证持久业务库与非空事务日志不变。
  for (const file of fs.readdirSync(directory)) { const full = path.join(directory, file); const stat = fs.statSync(full); if (!stat.isFile() || file.endsWith('-shm') || file.endsWith('-wal') && stat.size === 0) continue; out[file] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); }
  return out;
}

test('字段契约按来源分工且绑定原任务，不把设计责任当已检测能力', t => {
  const f = fixture(t), before = files(f.state);
  const contract = f.run('platform-contract', f.owner);
  assert.equal(contract.contractVersion, 'platform-fields-v1'); assert.equal(contract.canCollectPlatforms, false);
  assert.deepEqual(contract.sources.map(x => x.id), ['affiliate', 'kalodata', 'confirmed_inputs']);
  for (const source of contract.sources) { assert.ok(source.purpose); assert.ok(source.limitations.length); for (const field of source.requirements) { assert.equal(typeof field.requiredForRoi, 'boolean'); assert.ok(field.id && field.label && field.scope && field.note); assert.equal(field.status, undefined); } }
  assert.match(contract.sources[1].limitations.join(''), /估算/); assert.match(contract.notes.join(''), /不要求两个平台同时可用/);
  assert.equal(f.raw('platform-contract', { ...f.owner, taskId: 'wrong' }).ok, false);
  assert.equal(f.raw('platform-contract', { ...f.owner, source: 'affiliate' }).ok, false);
  const capabilities = f.run('status').capabilities;
  assert.equal(capabilities.resultValidation, true); assert.equal(capabilities.platformContract, true); assert.equal(capabilities.platformRead, false);
  assert.equal(f.run('result-contract', { operationId: f.owner.operationId }).platformContractVersion, 'platform-fields-v1');
  assert.deepEqual(files(f.state), before);
});

test('预检不创建状态库，旧数据库缺结果表时不建表或写文件', t => {
  const absent = fixture(t, false);
  const request = { operationId: 'missing', taskId: 'missing', resultId: 'missing', expectedRevision: 0, report: report() };
  assert.equal(absent.raw('validate-result', request).ok, false); assert.equal(fs.existsSync(absent.state), false);
  assert.equal(absent.raw('platform-contract', { operationId: 'missing', taskId: 'missing' }).ok, false); assert.equal(fs.existsSync(absent.state), false);
  const f = fixture(t);
  f.python("import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('DROP TABLE selection_results');c.commit();c.close()");
  const before = files(f.state), preview = f.run('validate-result', f.payload());
  assert.equal(preview.currentRevision, 0); assert.equal(preview.canSubmit, true); assert.deepEqual(files(f.state), before);
  assert.equal(f.python("import sqlite3,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(c.execute(\"SELECT count(*) FROM sqlite_master WHERE name='selection_results'\").fetchone()[0]);c.close()").trim(), '0');
});

test('预检保留精确微正值与未知，来源和真实成本始终待核验', t => {
  const f = fixture(t), request = f.payload(), before = files(f.state);
  request.report.missingFields = ['coverage evidence']; request.report.candidates[1].missingFields = ['creator identity evidence'];
  const preview = f.run('validate-result', request);
  assert.equal(preview.canSubmit, true); assert.equal(preview.replay, false); assert.equal(preview.adoptionStatus, 'pending'); assert.equal(preview.canCollectPlatforms, false);
  assert.equal(preview.validation.candidateCount, 2); assert.equal(preview.validation.totalVideos, 4); assert.equal(preview.validation.completeCandidates, 1); assert.equal(preview.validation.incompleteCandidates, 1); assert.equal(preview.validation.knownPositiveVideos, 1);
  assert.equal(preview.computed.candidates[0].videos[0].surplus, '0.0000000000001'); assert.equal(preview.computed.candidates[1].summary.breakEvenRate, null);
  assert.equal(preview.computed.candidates[1].videos[0].surplus, null); assert.deepEqual(preview.validation.missingFields.find(x => x.videoId === 'unknown').fields, ['adSpend']);
  assert.equal(preview.validation.sourceReview.status, 'unverified'); assert.equal(preview.validation.sourceReview.sourceCount, 3);
  assert.deepEqual(preview.validation.sourceReview.providers.map(x => [x.id, x.sourceCount]), [['affiliate', 1], ['kalodata', 1], ['other', 1]]);
  for (const id of ['calculation', 'identity', 'sample_coverage', 'source_provenance', 'cost_confirmation']) assert.equal(preview.validation.checks.find(x => x.id === id).status, 'unknown');
  assert.deepEqual(files(f.state), before);
  const saved = f.run('submit-result', request);
  assert.deepEqual(saved.record.computed, preview.computed); assert.deepEqual(saved.record.validation, preview.validation);
  assert.deepEqual(f.run('get-result', { operationId: f.owner.operationId }).record, saved.record);
});

test('数值齐全只使数学检查通过，不使来源、费用或覆盖通过', t => {
  const f = fixture(t), request = f.payload(); request.report.candidates.pop();
  const v = f.run('validate-result', request).validation;
  assert.equal(v.checks.find(x => x.id === 'calculation').status, 'passed');
  for (const id of ['identity', 'sample_coverage', 'source_provenance', 'cost_confirmation']) assert.equal(v.checks.find(x => x.id === id).status, 'unknown');
  request.report.candidates = [];
  const empty = f.run('validate-result', request).validation;
  assert.equal(empty.totalVideos, 0); assert.equal(empty.checks.find(x => x.id === 'sample_coverage').status, 'warning');
});

test('预检不锁版本；其后发生另一提交时原预检仍被原子提交拒绝', t => {
  const f = fixture(t), first = f.payload('first'), second = f.payload('second');
  assert.equal(f.run('validate-result', first).canSubmit, true);
  f.run('submit-result', second);
  const before = files(f.state);
  assert.equal(f.raw('submit-result', first).ok, false); assert.equal(f.raw('validate-result', first).ok, false);
  assert.deepEqual(files(f.state), before); assert.equal(f.run('get-result', { operationId: f.owner.operationId }).history.length, 1);
});

test('历史重投保留原结果版本，新载荷不能借用原resultId', t => {
  const f = fixture(t), first = f.payload('first'), saved = f.run('submit-result', first);
  f.run('submit-result', f.payload('second', 1));
  const before = files(f.state), preview = f.run('validate-result', first);
  assert.equal(preview.replay, true); assert.equal(preview.expectedRevision, 0); assert.equal(preview.currentRevision, 2); assert.deepEqual(preview.computed, saved.record.computed);
  assert.deepEqual(files(f.state), before); assert.deepEqual(f.run('submit-result', first), saved);
  const changed = structuredClone(first); changed.report.coverage = '改写旧结果'; assert.equal(f.raw('validate-result', changed).ok, false);
});

test('跨任务、未创建任务与非法报告拒绝，预检不绕过提交结构约束', t => {
  const f = fixture(t), request = f.payload(), before = files(f.state);
  for (const input of [{ ...request, taskId: 'wrong' }, { ...request, report: { ...request.report, unknownField: true } }, { ...request, extra: true }]) { assert.equal(f.raw('validate-result', input).ok, false); }
  const mixed = structuredClone(request); mixed.report.candidates[0].videos[0].sales.push({ kind: 'ads', gmv: '1', commissionRate: '0.1' }); assert.equal(f.raw('validate-result', mixed).ok, false);
  assert.deepEqual(files(f.state), before);
  const pending = f.prepare('pending', false); assert.equal(f.raw('validate-result', { ...request, ...pending }).ok, false); assert.equal(f.raw('platform-contract', pending).ok, false);
});

test('旧快照仅内存派生validation，读取和预检均不改写持久报告', t => {
  const f = fixture(t), request = f.payload(); f.run('submit-result', request);
  f.python("import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);raw=c.execute('SELECT record FROM selection_results').fetchone()[0];r=json.loads(raw);del r['validation'];c.execute('UPDATE selection_results SET record=?',(json.dumps(r),));c.commit();c.close()");
  const before = files(f.state), record = f.run('get-result', { operationId: f.owner.operationId }).record;
  assert.equal(record.validation.sourceReview.status, 'unverified'); assert.equal(f.run('validate-result', request).replay, true); assert.deepEqual(files(f.state), before);
  assert.equal(f.python("import sqlite3,sys,json\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);r=json.loads(c.execute('SELECT record FROM selection_results').fetchone()[0]);print('validation' in r);c.close()").trim(), 'False');
});

 test('旧报告未知方法或保存计算不一致时拒绝派生摘要', t => {
  for (const mode of ['method', 'computed']) {
    const f = fixture(t), request = f.payload(); f.run('submit-result', request);
    const change = mode === 'method' ? "r['report']['methodVersion']='unknown-method'" : "r['computed']['candidates'][0]['videos'][0]['surplus']='999'";
    f.python("import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);r=json.loads(c.execute('SELECT record FROM selection_results').fetchone()[0]);del r['validation'];" + change + ";c.execute('UPDATE selection_results SET record=?',(json.dumps(r),));c.commit();c.close()");
    const before = files(f.state);
    assert.equal(f.raw('get-result', { operationId: f.owner.operationId }).ok, false);
    assert.equal(f.raw('validate-result', request).ok, false);
    assert.deepEqual(files(f.state), before);
  }
});
