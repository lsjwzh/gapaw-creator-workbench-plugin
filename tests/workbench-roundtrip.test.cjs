'use strict';
// 真实插件客户端 → Python HTTP 桥接 → Rust 供应端 → 合成旧业务库。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const binary = path.resolve(process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench');
const bundle = path.resolve(__dirname, '../integrations/workbench-adoption');
const source = process.env.GAPAW_OUTREACH_SOURCE || '/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach';

async function fixture(t, local = false) {
  assert.ok(fs.existsSync(binary), '请先构建真实 Rust 程序或设置 GAPAW_TEST_BINARY');
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/gapaw-roundtrip-'));
  // 专属目录约束拒绝 /tmp；这里只建空测试目录，业务数据始终在 /tmp。
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-roundtrip-')));
  const runtime = path.join(root, 'runtime'); let database = path.join(root, 'outreach.sqlite3');
  const token = crypto.randomBytes(48).toString('hex');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', GAPAW_CREATOR_DATA_DIR: path.join(root, 'plugin-state'),
    GAPAW_CHROME_PLUGIN_DIR: path.join(root, 'unused-source'), GAPAW_CHROME_DATA_DIR: path.join(root, 'unused-chrome'),
    GAPAW_WORKBENCH_ADOPTION_TOKEN: token, GAPAW_WORKBENCH_EXECUTABLE: binary, GAPAW_WORKBENCH_DB: database };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID; delete env.GAPAW_WORKBENCH_URL;
  let server, serverExit, serverErrors = '';
  t.after(async () => {
    try {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM');
        const timer = setTimeout(() => server.kill('SIGKILL'), 2000);
        try { await serverExit; } finally { clearTimeout(timer); }
      }
      assert.equal(serverErrors.includes(token), false, '服务日志不能包含凭证');
      assert.equal(serverErrors, '', '合成服务应无错误日志');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
  function python(script, args = [], input = '') {
    return execFileSync('python3', ['-B', '-c', script, ...args], { env, input, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  }
  function raw(command, input = {}) {
    const output = execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(output.includes(token), false, '插件响应不能包含凭证');
    return JSON.parse(output);
  }
  function run(command, input = {}) {
    const result = raw(command, input);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  }
  execFileSync('python3', ['-B', path.join(bundle, 'build-patched.py'), source, '--output', runtime], { env, encoding: 'utf8', timeout: 10000 });
  python(`import sys,json
sys.path.insert(0,sys.argv[1])
from store import Store
profile={"id":"LEGACY001","handle":"synthetic_same_handle","rank":1,"priority":"合成","followers":None,"affiliate_gmv_usd":None,"pet_gmv_share_pct":None,"topic":"合成旧档案","history":"合成旧记录","prior_invite":False,"kalodata_window":"unknown","anchor1":"","anchor2":"","warnings":[],"products":[]}
Store(sys.argv[2]).init({"source_sha256":"synthetic-only","records":[{"profile":profile,"drafts":[{"channel":c,"subject":"合成草稿","body":"合成正文【固定费】"} for c in ("comment","dm","email","affiliate","followup")]}]})`, [runtime, database]);
  function legacy() {
    return python(`import sys,sqlite3,json
with sqlite3.connect(sys.argv[1]) as c:
 rows=[(n,c.execute("SELECT sql FROM sqlite_master WHERE name=?",(n,)).fetchone()[0],c.execute("SELECT * FROM "+n+" ORDER BY rowid").fetchall()) for n in ("creators","drafts","events","audit","meta","messages","negotiations")]
 print(json.dumps(rows,ensure_ascii=False,separators=(",",":")))`, [database]);
  }
  function counts() {
    return JSON.parse(python(`import sys,sqlite3,json
with sqlite3.connect(sys.argv[1]) as c:
 print(json.dumps({n:c.execute("SELECT count(*) FROM gapaw_selection_"+n).fetchone()[0] for n in ("batches","candidates","observations","receipts","audit")}))`, [database]));
  }
  let initialized;
  if (local) {
    const preview = run('preview-workbench-import', {sourcePath:database});
    run('import-workbench', {sourcePath:database, expectedSourceDigest:preview.sourceDigest, confirmed:true});
    database = path.join(env.GAPAW_CREATOR_DATA_DIR, 'workbench.sqlite');
    initialized = run('workbench-status');
  }
  const old = legacy();
  if (!local) {
  initialized = run('workbench-provider', { action: 'initialize', authorization: 'Bearer ' + token, payload: {} });
  assert.equal(initialized.ready, true);
  assert.equal(legacy(), old);
  const script = "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from server import make_handler;from store import Store;from http.server import ThreadingHTTPServer;s=ThreadingHTTPServer(('127.0.0.1',0),make_handler(Store(sys.argv[2]),Path(sys.argv[1])));print(s.server_port,flush=True);s.serve_forever()";
  server = spawn('python3', ['-B', '-u', '-c', script, runtime, database], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise(resolve => server.once('exit', resolve));
  server.stderr.on('data', chunk => { serverErrors += chunk; });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('合成工作台服务启动超时')), 5000);
    const finish = (error, value) => { clearTimeout(timer); server.stdout.off('data', read); server.off('error', fail); server.off('exit', stopped); error ? reject(error) : resolve(value); };
    const fail = error => finish(error);
    const stopped = () => finish(new Error('合成工作台服务提前退出'));
    const read = chunk => { output += chunk; if (output.includes('\n')) { const p = Number(output.trim()); p > 0 && p < 65536 ? finish(null, p) : finish(new Error('合成服务未返回合法端口')); } };
    server.stdout.on('data', read); server.once('error', fail); server.once('exit', stopped);
  });
  env.GAPAW_WORKBENCH_URL = 'http://127.0.0.1:' + port;
  }
  run('configure', { workspace: { dirId: 'roundtrip-dir', path: workspace } });
  const operation = run('prepare-operation', { requestId: 'roundtrip-operation', prompt: '仅验证合成候选保存，不访问平台或发送消息。', runtime: { cli: 'codex' } }).operation;
  const owner = { operationId: operation.id, taskId: 'roundtrip-task' };
  run('record-dispatch', { operationId: operation.id, stage: 'created', response: { taskId: owner.taskId, sessionId: 'roundtrip-session', shellId: 'roundtrip-shell', url: '/air?task=roundtrip-task' } });
  run('record-dispatch', { operationId: operation.id, stage: 'sent', response: { taskId: owner.taskId, receiptId: 'roundtrip-dispatch-receipt' } });
  return { run, raw, owner, legacy, old, counts, database, token, storeId: initialized.businessStoreId };
}

function report() {
  const candidate = (id, adSpend) => ({ platform: 'tiktok', creatorId: id, handle: 'synthetic_same_handle',
    profileUrl: 'https://www.tiktok.com/@synthetic_same_handle', reason: '文'.repeat(2001) + '\n\t合成依据',
    sources: [{ url: 'https://example.invalid/source', capturedAt: '2026-10-02T00:00:00Z', note: '源'.repeat(1990) + '\n\t仅合成资料' }],
    missingFields: ['合成字段\n待核验'], videos: [{ videoId: id + '-video', url: 'https://example.invalid/video/' + id,
      publishedAt: '2026-10-01T00:00:00Z', contributionRate: '0.3', sales: [{ kind: 'total', gmv: '10', commissionRate: '0.1' }], adSpend, fixedFee: '0', sampleCost: '0' }] });
  return { schemaVersion: 1, methodVersion: 'roi-selection-v1', generatedAt: '2026-10-02T00:00:00Z',
    period: { start: '2026-10-01', end: '2026-10-01', timeZone: 'UTC' }, currency: 'USD',
    coverage: '中'.repeat(2001) + '\n\t未核验覆盖', missingFields: ['覆盖\n未知'], candidates: [candidate('known', '1'), candidate('unknown', null)] };
}

for (const local of [false,true]) test((local ? '本地无旧服务' : '旧版双端兼容')+'：长中文多行报告预览零写入，采纳读回、分页与事实保护', async t => {
  const f = await fixture(t,local), inputReport = report();
  const stored = f.run('submit-result', { ...f.owner, resultId: 'roundtrip-result', expectedRevision: 0, report: inputReport });
  assert.equal(stored.record.computed.candidates[1].summary.breakEvenRate, null);
  const observation = f.run('observation-contract', f.owner).templates[0].submissionTemplate;
  const savedObservation = f.run('submit-observation', observation);
  const observationId = savedObservation.snapshot.observationId;
  assert.equal(f.run('workbench-status').businessStoreId, f.storeId);
  const empty = { batches: 0, candidates: 0, observations: 0, receipts: 0, audit: 0 };
  assert.deepEqual(f.counts(), empty);
  const prepared = f.run('prepare-adoption', { ...f.owner, resultId: 'roundtrip-result', adoptionId: 'roundtrip-adoption', observationIds: [observationId] });
  assert.equal(prepared.plan.status, 'prepared');
  assert.equal(prepared.preview.handleConflicts.length, 2);
  assert.deepEqual(f.counts(), empty);
  assert.equal(f.legacy(), f.old);
  const submission = { adoptionId: prepared.plan.adoptionId, expectedPayloadHash: prepared.plan.payloadHash };
  const adopted = f.run('adopt-result', submission).plan;
  assert.equal(adopted.status, 'verified', JSON.stringify(adopted));
  assert.equal(adopted.receipt.payloadHash, prepared.plan.payloadHash);
  assert.equal(adopted.receipt.businessStoreId, f.storeId);
  assert.equal(adopted.receipt.status, 'candidate_pending_verification');
  const savedCounts = { batches: 1, candidates: 2, observations: 1, receipts: 1, audit: 1 };
  assert.deepEqual(f.counts(), savedCounts);
  assert.deepEqual(f.run('adopt-result', submission).plan, adopted);
  assert.deepEqual(f.run('reconcile-adoption', { adoptionId: adopted.adoptionId }).plan, adopted);
  assert.deepEqual(f.run('get-adoption', { operationId: f.owner.operationId }).plans, [adopted]);
  assert.deepEqual(f.counts(), savedCounts);
  const listing = f.run('workbench-list', { offset: 0, limit: 1 });
  assert.equal(listing.total, 1);
  assert.equal(listing.items[0].batchId, adopted.receipt.batchId);
  assert.equal(listing.items[0].reportMetadata.coverage, inputReport.coverage);
  assert.equal(listing.items[0].observationCount, 1);
  const first = f.run('workbench-batch', { batchId: adopted.receipt.batchId, offset: 0, limit: 1 });
  const second = f.run('workbench-batch', { batchId: adopted.receipt.batchId, offset: 1, limit: 1 });
  assert.equal(first.nextOffset, 1); assert.equal(second.nextOffset, null);
  assert.equal(first.total, 2); assert.equal(second.total, 2);
  for (const [index, candidate] of [first.candidates[0], second.candidates[0]].entries()) {
    assert.equal(candidate.candidateId, adopted.receipt.candidateIds[index]);
    assert.equal(candidate.status, 'candidate_pending_verification');
    assert.equal(candidate.verification, 'unverified');
    assert.equal(candidate.reason, inputReport.candidates[index].reason);
    assert.deepEqual(candidate.sources, inputReport.candidates[index].sources);
    assert.deepEqual(candidate.missingFields, inputReport.candidates[index].missingFields);
    assert.deepEqual(candidate.computed, stored.record.computed.candidates[index]);
  }
  assert.equal(second.candidates[0].computed.summary.breakEvenRate, null);
  assert.equal(second.candidates[0].computed.videos[0].surplus, null);
  assert.equal(f.legacy(), f.old);
  assert.equal(fs.readFileSync(f.database).includes(Buffer.from(f.token)), false, '凭证不能写入业务库');
});
