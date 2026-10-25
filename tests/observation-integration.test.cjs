'use strict';
// 合成响应与隔离目录；不访问真实账号、Chrome或平台。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-observations-'));
  const state = path.join(root, 'state');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-observations-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state, GAPAW_CHROME_PLUGIN_DIR: path.join(root, 'unused-source'), GAPAW_CHROME_DATA_DIR: path.join(root, 'unused-data') };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const raw = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { env, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  const run = (command, input = {}) => { const out = raw(command, input); assert.equal(out.ok, true, JSON.stringify(out)); return out.data; };
  const prepare = (requestId, create = true) => {
    const operation = run('prepare-operation', { requestId, prompt: '离线来源观测隔离测试', runtime: { cli: 'codex' } }).operation;
    const taskId = 'task-' + requestId;
    if (create) run('record-dispatch', { operationId: operation.id, stage: 'created', response: { taskId, sessionId: 'session-' + requestId, shellId: 'shell-' + requestId, url: '/air?task=' + taskId } });
    return { operationId: operation.id, taskId };
  };
  let owner;
  if (setup) { run('configure', { workspace: { dirId: 'fixture-dir', path: workspace } }); owner = prepare('one'); }
  const python = code => execFileSync('python3', ['-c', code, path.join(state, 'state.sqlite')], { encoding: 'utf8' });
  const template = adapter => run('observation-contract', owner).templates.find(t => t.adapter === adapter).submissionTemplate;
  return { root, state, run, raw, owner, prepare, python, template };
}
function files(directory) {
  if (!fs.existsSync(directory)) return null;
  const out = {};
  for (const file of fs.readdirSync(directory)) { const full = path.join(directory, file); const stat = fs.statSync(full); if (!stat.isFile() || file.endsWith('-shm') || file.endsWith('-wal') && stat.size === 0) continue; out[file] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); }
  return out;
}
const AFFILIATE = 'affiliate-marketplace-v1';
const KALODATA = 'kalodata-creator-videos-v1';

test('两种完整合成模板可预览且来源命名空间不合并', t => {
  const f = fixture(t), before = files(f.state), c = f.run('observation-contract', f.owner);
  assert.equal(c.canCollectPlatforms, false); assert.equal(c.mode, 'imported_response'); assert.equal(c.templates.length, 2);
  for (const template of c.templates) {
    assert.match(template.description, /合成/);
    const out = f.run('preview-observation', template.submissionTemplate), s = out.snapshot;
    assert.equal(out.replay, false); assert.equal(out.canCollectPlatforms, false); assert.equal(s.source.verified, false);
    assert.equal(s.schemaVersion, 1); assert.equal(s.items.length, 1); assert.equal(s.coverage.complete, false); assert.equal(s.coverage.zeroResultsVerified, false);
    if (template.adapter === AFFILIATE) { assert.equal(s.items[0].sourceIdentity.namespace, 'affiliate_oec'); assert.equal(s.items[0].creatorIdentity, null); }
    else { assert.equal(s.items[0].sourceIdentity.namespace, 'kalodata_video'); assert.equal(s.items[0].creatorIdentity.namespace, 'kalodata_creator'); }
    for (const field of Object.values(s.items[0].fields)) assert.equal(field.verification, 'unverified');
  }
  assert.deepEqual(files(f.state), before);
});

test('Affiliate 按真实包装路径投影：未知、零、负值、浮点和显示金额均保留语义', t => {
  const f = fixture(t), request = f.template(AFFILIATE), p = request.response.creator_profile_list[0];
  p.video_gmv.value.value = '-0.0001'; p.live_gmv.value.value = 0; p.follower_cnt.value = null;
  p.ec_video_avg_view_cnt.value = 12.5; p.ec_video_engagement.value = '12.5%';
  p.units_sold = { is_authorized: false, value: 999 };
  const fields = f.run('preview-observation', request).snapshot.items[0].fields;
  assert.equal(fields.videoGmv.sourcePath, 'creator_profile_list[0].video_gmv.value.value');
  assert.equal(fields.videoGmv.decimalValue, '-0.0001'); assert.equal(fields.liveGmv.decimalValue, '0');
  assert.equal(fields.followers.decimalValue, null); assert.equal(fields.followers.rawDisplay, null);
  assert.equal(fields.averageViews.rawDisplay, '12.5'); assert.equal(fields.averageViews.decimalValue, null);
  assert.equal(fields.engagement.decimalValue, null); assert.equal(fields.engagement.rawDisplay, '12.5%');
  assert.equal(fields.medGmv.decimalValue, null); assert.equal(fields.medGmv.rawDisplay, '$1.2K');
  assert.equal(fields.videoGmvCurrencySymbol.rawDisplay, '$'); assert.equal(fields.videoGmv.unit, 'source_currency');
  assert.equal(fields.unitsSold.rawDisplay, null);
});

test('Kalodata 视频日期、广告标记和估算收入不会变成确认发布时间或广告费', t => {
  const f = fixture(t), request = f.template(KALODATA), video = request.response.data[0];
  video.create_time = 1790812800; video.sale = '0'; video.revenue = '12.3400'; video.ad = 1; video.ad_revenue_ratio = '0.25';
  const s = f.run('preview-observation', request).snapshot, fields = s.items[0].fields;
  assert.equal(s.context.period.timeZone, 'unknown'); assert.equal(fields.publishedAt.rawDisplay, '1790812800'); assert.equal(fields.publishedAt.decimalValue, null); assert.equal(fields.publishedAt.unit, 'date_unknown');
  assert.equal(fields.sales.decimalValue, '0'); assert.equal(fields.revenue.decimalValue, '12.3400'); assert.equal(fields.revenue.estimated, 'third_party_estimate');
  assert.equal(fields.advertisingFlag.rawDisplay, '1'); assert.equal(fields.advertisingFlag.decimalValue, null); assert.match(fields.advertisingFlag.scope, /not_cost/);
  assert.equal(fields.advertisingRevenueRatio.decimalValue, '0.25'); assert.equal(fields.advertisingRevenueRatio.unit, 'ratio_unknown');
  assert.equal(fields.adSpend, undefined); assert.equal(s.roi, undefined); assert.equal(s.coverage.complete, false);
});

test('缺分页、has_more=false和空数组均不证明全量或实际零结果', t => {
  const f = fixture(t), request = f.template(AFFILIATE);
  for (const pagination of [undefined, { has_more: false }, { has_more: true }, {}]) {
    request.response.next_pagination = pagination;
    const c = f.run('preview-observation', request).snapshot.coverage;
    assert.equal(c.complete, false); assert.equal(c.status, 'partial'); assert.equal(c.reportedHasMore, pagination?.has_more ?? null);
  }
  request.response.creator_profile_list = [];
  const c = f.run('preview-observation', request).snapshot.coverage;
  assert.equal(c.itemCount, 0); assert.equal(c.status, 'unknown'); assert.equal(c.zeroResultsVerified, false);
});

test('额外敏感字段不进入投影或数据库，只保存摘要与安全快照', t => {
  const f = fixture(t), request = f.template(AFFILIATE), sentinel = 'SYNTHETIC_SECRET_DO_NOT_PROJECT';
  request.response.cookie = sentinel; request.response.token = sentinel;
  request.response.creator_profile_list[0].email = sentinel;
  request.response.creator_profile_list[0].creator_oecuid.token = sentinel;
  request.response.creator_profile_list[0].video_gmv.value.authorization = sentinel;
  const saved = f.run('submit-observation', request);
  assert.ok(!JSON.stringify(saved).includes(sentinel)); assert.match(saved.snapshot.inputHash, /^[0-9a-f]{64}$/);
  const storage = f.python("import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute('SELECT * FROM source_observations').fetchall()));c.close()");
  assert.ok(!storage.includes(sentinel)); assert.ok(!storage.includes('creator_profile_list\\\":'));
  const read = f.run('get-observations', f.owner); assert.deepEqual(read.snapshots, [saved.snapshot]);
});

test('同ID同输入幂等且异载荷、跨任务重用、跨任务读取拒绝', t => {
  const f = fixture(t), request = f.template(AFFILIATE);
  const first = f.run('submit-observation', request); assert.equal(first.replay, false);
  const replay = f.run('submit-observation', request); assert.equal(replay.replay, true); assert.deepEqual(replay.snapshot, first.snapshot);
  assert.equal(f.run('preview-observation', request).replay, true);
  const changed = structuredClone(request); changed.response.creator_profile_list[0].follower_cnt.value = 101;
  assert.equal(f.raw('submit-observation', changed).ok, false); assert.equal(f.raw('preview-observation', changed).ok, false);
  const other = f.prepare('two'); assert.equal(f.raw('submit-observation', { ...request, ...other }).ok, false);
  assert.equal(f.raw('get-observations', { ...other, observationId: request.observationId }).ok, false);
  assert.equal(f.raw('get-observations', { ...f.owner, taskId: 'wrong' }).ok, false);
  assert.equal(f.run('get-observations', f.owner).snapshots.length, 1);
  const pending = f.prepare('pending', false); assert.equal(f.raw('preview-observation', { ...request, ...pending }).ok, false);
});

test('只读预览不建缺失数据库或缺失观测表，非法提交也不创建目录', t => {
  const f = fixture(t), request = f.template(AFFILIATE), absent = fixture(t, false);
  for (const cmd of ['observation-contract', 'preview-observation', 'submit-observation', 'get-observations']) {
    assert.equal(absent.raw(cmd, cmd.includes('contract') || cmd.startsWith('get-') ? f.owner : request).ok, false);
    assert.equal(fs.existsSync(absent.state), false);
  }
  f.python("import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('DROP TABLE IF EXISTS source_observations');c.commit();c.close()");
  const before = files(f.state);
  f.run('preview-observation', request); assert.deepEqual(f.run('get-observations', f.owner).snapshots, []);
  assert.deepEqual(files(f.state), before);
  assert.equal(f.python("import sqlite3,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(c.execute(\"SELECT count(*) FROM sqlite_master WHERE name='source_observations'\").fetchone()[0]);c.close()").trim(), '0');
});

test('错误、结构变化、重复身份、无效上下文及过量响应明确拒绝且不回显正文', t => {
  const f = fixture(t), base = f.template(AFFILIATE);
  const variants = [
    r => { r.response = { code: 401, message: 'SYNTHETIC_PRIVATE_ERROR', creators: [] }; },
    r => { delete r.response.creator_profile_list; },
    r => { r.response.creator_profile_list = null; },
    r => { r.response.creator_profile_list[0].follower_cnt = { value: { unexpected: true } }; },
    r => { r.response.creator_profile_list[0].creator_oecuid = { is_authorized: false, value: 'hidden' }; },
    r => { r.response.creator_profile_list.push(structuredClone(r.response.creator_profile_list[0])); },
    r => { r.response.next_pagination.has_more = 'false'; },
    r => { r.context.extra = 'secret'; },
    r => { r.context.currency = '$'; },
    r => { r.context.period.timeZone = 'Mars/Base'; },
    r => { r.context.period.start = '2026-02-30'; },
    r => { r.context.pageNo = -1; },
    r => { r.extra = true; },
    r => { r.capturedAt = 'yesterday'; },
    r => { r.response.creator_profile_list = Array.from({ length: 101 }, (_, i) => ({ creator_oecuid: { value: 'id_' + i } })); },
    r => { r.response.extra = 'x'.repeat(512 * 1024); },
  ];
  const before = files(f.state);
  for (const change of variants) { const r = structuredClone(base); change(r); const result = f.raw('preview-observation', r); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_ERROR')); }
  const kalo = f.template(KALODATA); kalo.context.creatorSourceId = null; assert.equal(f.raw('preview-observation', kalo).ok, false);
  assert.deepEqual(files(f.state), before);
});

test('持久快照的未知字段或伪造核验状态被读取拒绝', t => {
  for (const mutation of ["r['source']['verified']=True", "r['items'][0]['fields']['followers']['verification']='verified'", "r['coverage']['complete']=True", "r['secret']='SYNTHETIC_PRIVATE_VALUE'", "r['items'][0]['fields']['followers']['rawDisplay']={'token':'SYNTHETIC_PRIVATE_VALUE'}"]) {
    const f = fixture(t), request = f.template(AFFILIATE); f.run('submit-observation', request);
    f.python("import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);r=json.loads(c.execute('SELECT snapshot FROM source_observations').fetchone()[0]);" + mutation + ";c.execute('UPDATE source_observations SET snapshot=?',(json.dumps(r),));c.commit();c.close()");
    const result = f.raw('get-observations', f.owner); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_VALUE'));
  }
});

test('原文封装保留超过JS安全整数与原始浮点显示，不提升浮点精度', t => {
  const f = fixture(t), request = f.template(AFFILIATE), p = request.response.creator_profile_list[0];
  p.creator_oecuid.value = 'RAW_ID'; p.follower_cnt.value = 'RAW_INTEGER'; p.video_gmv.value.value = 'RAW_FLOAT'; p.ec_video_avg_view_cnt.value = 'RAW_TRAILING';
  const rawJson = JSON.stringify(request).replace('"RAW_ID"', '9007199254740993').replace('"RAW_INTEGER"', '9007199254740993').replace('"RAW_FLOAT"', '0.10000000000000001').replace('"RAW_TRAILING"', '1.230000');
  const preview = f.run('preview-observation', { rawJson }), item = preview.snapshot.items[0];
  assert.equal(item.sourceIdentity.sourceId, '9007199254740993');
  assert.equal(item.fields.followers.rawDisplay, '9007199254740993'); assert.equal(item.fields.followers.decimalValue, '9007199254740993'); assert.equal(item.fields.followers.valueType, 'integer');
  assert.equal(item.fields.videoGmv.rawDisplay, '0.10000000000000001'); assert.equal(item.fields.videoGmv.decimalValue, null); assert.equal(item.fields.videoGmv.valueType, 'number');
  assert.equal(item.fields.averageViews.rawDisplay, '1.230000'); assert.equal(item.fields.averageViews.decimalValue, null);
  const saved = f.run('submit-observation', { rawJson }); assert.deepEqual(saved.snapshot, preview.snapshot);
  assert.equal(f.run('submit-observation', { rawJson }).replay, true);
});

test('原文封装严格限定唯一键和大小且仅用于观测预览与保存', t => {
  const f = fixture(t), request = f.template(AFFILIATE), rawJson = JSON.stringify(request), before = files(f.state);
  for (const input of [{ rawJson, extra: true }, { rawJson: {} }, { rawJson: '{broken' }, { rawJson: ' '.repeat(512 * 1024 + 1) }, { rawJson: JSON.stringify({ rawJson }) }]) {
    assert.equal(f.raw('preview-observation', input).ok, false);
  }
  assert.equal(f.raw('get-observations', { rawJson }).ok, false);
  assert.equal(f.raw('observation-contract', { rawJson }).ok, false);
  assert.deepEqual(files(f.state), before);
});
