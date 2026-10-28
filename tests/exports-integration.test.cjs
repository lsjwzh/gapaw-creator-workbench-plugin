'use strict';
// 真实 Rust 导出客户端与原版 Python 工作台；全部文件、资料及 HTTP 服务均为隔离测试夹具。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile, execFileSync, spawn } = require('node:child_process');

const binary = path.resolve(process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench');
const source = process.env.GAPAW_OUTREACH_SOURCE || '/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach';
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip' };
const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function fixture(t) {
  assert.ok(fs.existsSync(binary), '请先构建真实 Rust 程序或设置 GAPAW_TEST_BINARY');
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/gapaw-exports-'));
  const state = path.join(root, '插件状态 (合成)'), exports = path.join(state, 'exports');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', GAPAW_CREATOR_DATA_DIR: state,
    GAPAW_CHROME_PLUGIN_DIR: path.join(root, 'unused-source'), GAPAW_CHROME_DATA_DIR: path.join(root, 'unused-chrome') };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  delete env.GAPAW_WORKBENCH_URL; delete env.GAPAW_WORKBENCH_ADOPTION_TOKEN;
  const cleanup = [];
  t.after(async () => {
    try { for (const stop of cleanup.reverse()) await stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  function python(script, args = []) {
    return execFileSync('python3', ['-B', '-c', script, ...args], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  }
  function raw(input) { return command('workbench-export', input); }
  function command(name, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(binary, [name], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(error);
        try { assert.equal(stderr, ''); resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  async function run(input) {
    const result = await raw(input); assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
  }
  async function configure(url) {
    const result = await command('outreach-configure', { url }); assert.equal(result.ok, true, JSON.stringify(result));
  }
  function entries() { return fs.existsSync(exports) ? fs.readdirSync(exports).sort() : []; }
  function fileOf(result) {
    assert.match(result.downloadUrl, /^\/api\/download\?path=/);
    const parsed = new URL(result.downloadUrl, 'http://127.0.0.1');
    assert.deepEqual([...parsed.searchParams.keys()], ['path']);
    const file = parsed.searchParams.get('path');
    assert.equal(file, path.join(exports, result.exportId, result.fileName));
    return file;
  }
  function validate(result, format, id) {
    assert.equal(result.status, 'ready'); assert.equal(result.format, format); assert.equal(result.exportId, id);
    assert.equal(result.scope, 'all_creators'); assert.equal(result.mimeType, MIME[format]);
    assert.equal(result.fileName, `gapaw-outreach-${id}.${format}`);
    assert.match(result.warning, /不含完整往来消息和谈判数据/);
    assert.equal(Number.isNaN(Date.parse(result.createdAt)), false);
    const file = fileOf(result), bytes = fs.readFileSync(file);
    assert.equal(bytes.length, result.size);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), result.sha256);
    assert.deepEqual(bytes.subarray(0, 4), signature);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(path.dirname(file), 'snapshot.json')).mode & 0o777, 0o600);
    return file;
  }
  return { root, state, exports, env, cleanup, python, raw, run, command, configure, entries, fileOf, validate };
}

async function fakeServer(f, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'Gapaw达人触达系统' }));
    }
    handler(req, res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); };
  f.cleanup.push(stop);
  return { url: 'http://127.0.0.1:' + server.address().port, requests, stop };
}

async function originalServer(f, local = false) {
  const database = path.join(f.root, 'synthetic-outreach.sqlite3');
  f.python(`import sys
sys.path.insert(0,sys.argv[1])
from store import Store
p={"id":"SYNTH001","handle":"synthetic_creator","rank":1,"priority":"合成","followers":0,"affiliate_gmv_usd":None,"pet_gmv_share_pct":None,"topic":"仅合成资料","history":"没有真实往来","prior_invite":False,"kalodata_window":"2026-10合成区间","anchor1":"合成用品甲","anchor2":"合成用品乙","angle":"=SYNTHETIC_FORMULA","tiktok_url":"https://example.invalid/creator","affiliate_url":"https://example.invalid/affiliate","kalodata_url":"https://example.invalid/source","warnings":[],"products":[{"id":"synthetic-product","title_original":"合成商品","type":"合成类别","estimated_sales":None}],"history_detail":{},"history_snapshot":"2026-10-01"}
s=Store(sys.argv[2]);s.init({"source_sha256":"synthetic-only","records":[{"profile":p,"drafts":[{"channel":c,"subject":"=SUM(1,1)","body":"合成草稿【固定费】美元；佣金【佣金比例】；联系人【姓名】"} for c in ("comment","dm","email","affiliate","followup")]}]})
s.add_message("SYNTH001",{"channel":"email","direction":"in","at":"2026-10-01T00:00:00Z","body":"SYNTHETIC_PRIVATE_THREAD","source":"synthetic:mail","kind":"正常"})
s.set_negotiation("SYNTH001",{"status":"仅合成谈判","our_offer":"待核验","their_ask":"未知","next_step":"不发送"})`, [source, database]);
  const snapshot = () => f.python(`import sys,sqlite3,json
with sqlite3.connect(sys.argv[1]) as c:
 rows=[(n,c.execute("SELECT sql FROM sqlite_master WHERE name=?",(n,)).fetchone()[0],c.execute("SELECT * FROM "+n+" ORDER BY rowid").fetchall()) for n in ("creators","drafts","events","audit","meta","messages","negotiations")]
 print(json.dumps(rows,ensure_ascii=False,separators=(",",":")))`, [database]);
  const before = snapshot();
  if (local) {
    const preview = await f.command('preview-workbench-import', {sourcePath:database});
    assert.equal(preview.ok,true,JSON.stringify(preview));
    const imported = await f.command('import-workbench',{sourcePath:database,expectedSourceDigest:preview.data.sourceDigest,confirmed:true});
    assert.equal(imported.ok,true,JSON.stringify(imported));
    return {snapshot,before,stop:async()=>{}};
  }

  const script = "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from server import make_handler;from store import Store;from http.server import ThreadingHTTPServer;s=ThreadingHTTPServer(('127.0.0.1',0),make_handler(Store(sys.argv[2]),Path(sys.argv[1])));print(s.server_port,flush=True);s.serve_forever()";
  const child = spawn('python3', ['-B', '-u', '-c', script, source, database], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise(resolve => child.once('exit', resolve));
  let errors = '', stopped = false;
  child.stderr.on('data', data => { errors += data; });
  const stop = async () => {
    if (stopped) return; stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exit; } finally { clearTimeout(timer); }
    }
    assert.equal(errors, '', '原版工作台测试服务不应出现异常');
  };
  f.cleanup.push(stop);
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('原版工作台测试服务启动超时')), 5000);
    const finish = (error, value) => { clearTimeout(timer); child.stdout.off('data', read); child.off('error', failed); child.off('exit', ended); error ? reject(error) : resolve(value); };
    const failed = error => finish(error), ended = () => finish(new Error('原版工作台测试服务提前退出'));
    const read = data => { output += data; if (output.includes('\n')) { const p = Number(output.trim()); p > 0 && p < 65536 ? finish(null, p) : finish(new Error('测试端口无效')); } };
    child.stdout.on('data', read); child.once('error', failed); child.once('exit', ended);
  });
  return { url: 'http://127.0.0.1:' + port, snapshot, before, stop };
}

for (const local of [false,true]) test((local ? '本地Rust无旧服务' : '原版兼容')+'导出xlsx与zip可打开，源七表不变，离线重放固定快照', async t => {
  const f = fixture(t), original = await originalServer(f,local);
  if (!local) await f.configure(original.url);
  const xlsx = await f.run({ format: 'xlsx', exportId: 'real_xlsx' });
  const zip = await f.run({ format: 'zip', exportId: 'real_zip' });
  assert.equal(xlsx.replay, false); assert.equal(zip.replay, false);
  const xf = f.validate(xlsx, 'xlsx', 'real_xlsx'), zf = f.validate(zip, 'zip', 'real_zip');
  const checked = JSON.parse(f.python(`import sys,json,io,zipfile
from openpyxl import load_workbook
def inspect(value):
 w=load_workbook(value,read_only=True,data_only=False)
 assert len(w.sheetnames)==6
 assert w['达人主表']['A2'].value=='SYNTH001'
 assert w['达人主表']['P2'].value=="'=SYNTHETIC_FORMULA"
 assert w['个性化文案']['D2'].value=="'=SUM(1,1)"
 names=w.sheetnames;w.close();return names
sheets=inspect(sys.argv[1])
with zipfile.ZipFile(sys.argv[2]) as z:
 assert z.testzip() is None
 names=z.namelist();assert len([n for n in names if n.endswith('.csv')])==6
 assert len([n for n in names if n.startswith('逐人草稿/') and n.endswith('.md')])==1
 assert inspect(io.BytesIO(z.read('达人触达工作簿.xlsx')))==sheets
 assert all(b'SYNTHETIC_PRIVATE_THREAD' not in z.read(n) for n in names)
 print(json.dumps({'sheets':len(sheets),'files':len(names)}))`, [xf, zf]));
  assert.deepEqual(checked, { sheets: 6, files: 9 });
  assert.equal(original.snapshot(), original.before);
  await original.stop();
  assert.deepEqual(await f.run({ format: 'xlsx', exportId: 'real_xlsx' }), { ...xlsx, replay: true });
  assert.deepEqual(await f.run({ format: 'zip', exportId: 'real_zip' }), { ...zip, replay: true });
  assert.deepEqual(f.entries(), ['real_xlsx', 'real_zip']);
});

test('真实原版导出并发同编号只落位一份完整快照，所有调用读回同一内容', async t => {
  const f = fixture(t), original = await originalServer(f); await f.configure(original.url);
  const values = await Promise.all(Array.from({ length: 4 }, () => f.run({ format: 'xlsx', exportId: 'concurrent' })));
  assert.equal(values.filter(v => !v.replay).length, 1);
  for (const value of values) {
    f.validate(value, 'xlsx', 'concurrent');
    assert.equal(value.sha256, values[0].sha256);
    assert.equal(value.createdAt, values[0].createdAt);
    assert.equal(value.downloadUrl, values[0].downloadUrl);
  }
  assert.deepEqual(f.entries(), ['concurrent']);
  assert.deepEqual(fs.readdirSync(path.join(f.exports, 'concurrent')).sort(), ['gapaw-outreach-concurrent.xlsx', 'snapshot.json']);
  assert.equal(original.snapshot(), original.before);
});

test('格式及端点变化拒绝复用编号，路径注入与额外字段在请求前拒绝', async t => {
  const f = fixture(t), good = await fakeServer(f, (req, res) => { res.writeHead(200, { 'Content-Type': MIME.zip }); res.end(Buffer.concat([signature, Buffer.from('合成文件') ])); });
  await f.configure(good.url);
  const saved = await f.run({ format: 'zip', exportId: 'A_1-safe' });
  const before = good.requests.length;
  for (const exportId of ['', '.', '..', '../outside', 'a/b', 'a\\b', '/tmp/injected', 'x%2Fy', '中文', 'x'.repeat(101), ' x', 'x\n']) {
    assert.equal((await f.raw({ format: 'zip', exportId })).ok, false);
  }
  for (const input of [{ format: 'exe', exportId: 'no' }, { format: 'zip', exportId: 'no', path: '/tmp/outside' }, { format: 'zip', exportId: 'no', url: 'http://example.invalid' }, { format: 'xlsx', exportId: saved.exportId }]) {
    assert.equal((await f.raw(input)).ok, false);
  }
  assert.equal(good.requests.length, before);
  const other = await fakeServer(f, (_req, res) => { res.writeHead(500); res.end(); }); await f.configure(other.url);
  assert.equal((await f.raw({ format: 'zip', exportId: saved.exportId })).ok, false);
  assert.deepEqual(other.requests, ['/api/health']);
  assert.deepEqual(f.entries(), ['A_1-safe']);
  assert.equal(fs.existsSync(path.join(f.root, 'outside')), false);
});

test('导出绑定规范化来源指纹，错误空值与旧来源在下载落盘前拒绝', async t => {
  const f = fixture(t);
  const serve = (_req, res) => { res.writeHead(200, { 'Content-Type': MIME.zip }); res.end(Buffer.concat([signature, Buffer.from('source-bound')])); };
  const first = await fakeServer(f, serve);
  await f.configure(first.url + '/');
  const fingerprint = url => crypto.createHash('sha256').update(JSON.stringify(url)).digest('hex');
  const expectedSource = fingerprint(first.url), before = first.requests.length;
  for (const [index, value] of [null, '', '0'.repeat(64), first.url, fingerprint(first.url + '/'), 1].entries()) {
    assert.equal((await f.raw({ format: 'zip', exportId: 'bad_source_' + index, expectedSource: value })).ok, false);
    assert.equal(first.requests.length, before);
    assert.deepEqual(f.entries(), []);
  }
  const saved = await f.run({ format: 'zip', exportId: 'bound_source', expectedSource });
  f.validate(saved, 'zip', 'bound_source');
  assert.equal(first.requests.filter(p => p === '/api/export.zip').length, 1);
  assert.deepEqual(await f.run({ format: 'zip', exportId: saved.exportId, expectedSource }), { ...saved, replay: true });
  const second = await fakeServer(f, serve); await f.configure(second.url);
  assert.equal((await f.raw({ format: 'zip', exportId: 'stale_source', expectedSource })).ok, false);
  assert.equal((await f.raw({ format: 'zip', exportId: saved.exportId, expectedSource })).ok, false);
  assert.equal((await f.raw({ format: 'zip', exportId: saved.exportId, expectedSource: fingerprint(second.url) })).ok, false);
  assert.deepEqual(second.requests, ['/api/health']);
  assert.deepEqual(f.entries(), ['bound_source']);
  const current = await f.run({ format: 'zip', exportId: 'current_source', expectedSource: fingerprint(second.url) });
  f.validate(current, 'zip', 'current_source');
  assert.equal(second.requests.filter(p => p === '/api/export.zip').length, 1);
});

test('快照字节与说明篡改拒绝读回，符号链接不能逃逸导出目录', async t => {
  const f = fixture(t), good = await fakeServer(f, (_req, res) => { res.writeHead(200, { 'Content-Type': MIME.zip }); res.end(Buffer.concat([signature, Buffer.from('synthetic') ])); });
  await f.configure(good.url);
  const saved = await f.run({ format: 'zip', exportId: 'tampered' });
  const file = f.fileOf(saved), metadataFile = path.join(path.dirname(file), 'snapshot.json');
  const originalBytes = fs.readFileSync(file), originalMetadata = fs.readFileSync(metadataFile);
  const modified = Buffer.from(originalBytes); modified[modified.length - 1] ^= 1; fs.writeFileSync(file, modified);
  assert.equal((await f.raw({ format: 'zip', exportId: 'tampered' })).ok, false); fs.writeFileSync(file, originalBytes);
  for (const [key, value] of [['size', originalBytes.length + 1], ['sha256', '0'.repeat(64)], ['exportId', 'different'], ['schemaVersion', 999]]) {
    fs.writeFileSync(metadataFile, JSON.stringify({ ...JSON.parse(originalMetadata), [key]: value }));
    assert.equal((await f.raw({ format: 'zip', exportId: 'tampered' })).ok, false);
  }
  fs.writeFileSync(metadataFile, originalMetadata);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const otherFile = path.join(outside, 'payload.zip'); fs.writeFileSync(otherFile, originalBytes);
  const beforeRequests = good.requests.length;
  fs.unlinkSync(file); fs.symlinkSync(otherFile, file);
  assert.equal((await f.raw({ format: 'zip', exportId: 'tampered' })).ok, false); fs.unlinkSync(file); fs.writeFileSync(file, originalBytes);
  const otherMetadata = path.join(outside, 'snapshot.json'); fs.writeFileSync(otherMetadata, originalMetadata);
  fs.unlinkSync(metadataFile); fs.symlinkSync(otherMetadata, metadataFile);
  assert.equal((await f.raw({ format: 'zip', exportId: 'tampered' })).ok, false);
  fs.symlinkSync(path.dirname(file), path.join(f.exports, 'linked'));
  assert.equal((await f.raw({ format: 'zip', exportId: 'linked' })).ok, false);
  const savedRoot = f.exports + '-original'; fs.renameSync(f.exports, savedRoot); fs.symlinkSync(outside, f.exports);
  assert.equal((await f.raw({ format: 'zip', exportId: 'root-linked' })).ok, false);
  assert.equal(good.requests.length, beforeRequests);
  assert.deepEqual(fs.readdirSync(outside).sort(), ['payload.zip', 'snapshot.json']);
  assert.deepEqual(fs.readFileSync(otherFile), originalBytes);
});

test('网络断开、截断、错误类型、重定向及超限响应不产生部分文件', async t => {
  const f = fixture(t); let mode = 'drop';
  const mock = await fakeServer(f, (_req, res) => {
    if (mode === 'drop') return res.destroy();
    if (mode === 'truncated') { res.writeHead(200, { 'Content-Type': MIME.zip, 'Content-Length': 999 }); res.write(signature); return res.end(); }
    if (mode === 'mime') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(signature); }
    if (mode === 'signature') { res.writeHead(200, { 'Content-Type': MIME.zip }); return res.end('not a zip'); }
    if (mode === 'oversize') { res.writeHead(200, { 'Content-Type': MIME.zip }); return res.end(Buffer.concat([signature, Buffer.alloc(8 * 1024 * 1024)])); }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/redirect-should-not-be-requested' }); return res.end(); }
    res.writeHead(500, { 'Content-Type': MIME.zip }); res.end(signature);
  });
  await f.configure(mock.url);
  for (mode of ['drop', 'truncated', 'mime', 'signature', 'oversize', 'redirect', 'status']) {
    const result = await f.raw({ format: 'zip', exportId: 'invalid_' + mode });
    assert.equal(result.ok, false, mode + ':' + JSON.stringify(result));
    assert.deepEqual(f.entries(), [], mode + '不应遗留快照或临时文件');
  }
  assert.equal(mock.requests.some(p => p !== '/api/health' && p !== '/api/export.zip'), false);
});

test('无响应按期限失败、超时后同编号可恢复且仅成功后落位', async t => {
  const f = fixture(t); let hang = true;
  const mock = await fakeServer(f, (_req, res) => { if (!hang) { res.writeHead(200, { 'Content-Type': MIME.zip }); res.end(Buffer.concat([signature, Buffer.from('recovered')])); } });
  await f.configure(mock.url);
  const start = Date.now(), input = { format: 'zip', exportId: 'recover_timeout' };
  assert.equal((await f.raw(input)).ok, false);
  assert.ok(Date.now() - start < 9000, '网络请求应在有限期限内结束');
  assert.deepEqual(f.entries(), []);
  hang = false;
  const saved = await f.run(input); f.validate(saved, 'zip', input.exportId);
  assert.equal(saved.replay, false);
  assert.deepEqual(await f.run(input), { ...saved, replay: true });
  assert.deepEqual(f.entries(), [input.exportId]);
});
