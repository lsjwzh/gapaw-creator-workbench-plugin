'use strict';
// 所有输入与库均为 /tmp 合成数据；低层比较驱动直接编译同一 Rust 模块，产品流程使用真实 CLI。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const source = process.env.GAPAW_OUTREACH_SOURCE || '/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach';
const channels = ['comment', 'dm', 'email', 'affiliate', 'followup'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-local-parity-'));
const driver = path.join(root, 'store-driver');
const driverSource = path.join(root, 'driver.rs');
const modulePath = path.resolve(__dirname, '..', 'src', 'local_store.rs');
const seed = {
  source_sha256: 'synthetic-only-local-parity',
  records: ['GW901', 'GW902'].map((id, i) => ({
    profile: { id, rank: i + 1, handle: 'synthetic_' + id, priority: 'A 优先', followers: 9000 + i, affiliate_gmv_usd: 1200, pet_gmv_share_pct: 75, topic: '合成用品', history: '合成历史快照', prior_invite: i === 1, kalodata_window: '合成统计期', anchor1: '合成锚点一', anchor2: '合成锚点二', angle: '合成方向', tiktok_url: 'https://example.invalid/' + id, affiliate_url: 'https://example.invalid/affiliate/' + id, products: [], history_detail: {}, history_snapshot: '2026-09-28' },
    drafts: channels.map(channel => ({ channel, subject: '合成合作【姓名】', body: '两条合计【固定费】美元＋【佣金比例】%佣金；联系人【姓名】' })),
  })),
};
const python = String.raw`
import sys,json,sqlite3
sys.path.insert(0,sys.argv[1])
from store import Store
s=Store(sys.argv[2]);q=json.load(sys.stdin)
try:
 op=q['op'];r=None
 if op=='init':s.init(q['seed'])
 elif op=='get':
  route=q['route'];r=s.detail(route.split('/')[-1]) if route.startswith('/api/creators/') else {'items':s.list(),'summary':s.summary()} if route=='/api/creators' else {'items':s.conversations()} if route=='/api/conversations' else s.summary(q.get('asof')) if route=='/api/summary' else None
 elif op=='post':
  p=q['route'].strip('/').split('/');cid=p[2];data=q['payload'];action=p[3]
  if action=='settings':r=s.update(cid,data['settings'],data['revision'])
  elif action=='drafts':r=s.edit_draft(cid,p[4],data.get('subject',''),data['body'],data['revision'])
  elif action=='events' and len(p)==4:r=s.add_event(cid,data)
  elif action=='events':r=s.void_event(cid,p[4],data.get('reason',''))
  elif action=='messages':r=s.add_message(cid,data)
  elif action=='negotiation':r=s.set_negotiation(cid,data)
 elif op=='audit':
  with s.db() as c:r=[dict(x) for x in c.execute('SELECT * FROM audit ORDER BY id')]
 print(json.dumps({'ok':True,'data':r},ensure_ascii=False))
except (ValueError,KeyError,TypeError) as e:print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False))
`;
fs.writeFileSync(driverSource, `#![allow(dead_code)]
type Result<T> = std::result::Result<T,String>;
#[path = ${JSON.stringify(modulePath)}] mod local_store;
use std::{io::Read,path::Path}; use serde_json::{Value,json};
fn main(){let mut s=String::new();std::io::stdin().read_to_string(&mut s).unwrap();let q:Value=serde_json::from_str(&s).unwrap();let p=std::env::args().nth(1).unwrap();let p=Path::new(&p);let result=match q["op"].as_str().unwrap(){
"init"=>local_store::init(p).and_then(|_|local_store::seed(p,&q["seed"])).map(|_|json!(null)),
"initialize"=>local_store::init(p).map(|_|json!(null)),
"seed"=>local_store::seed(p,&q["seed"]).map(|_|json!(null)),
"identity"=>local_store::identity(p).map(|s|json!(s)),
"get"=>local_store::get(p,q["route"].as_str().unwrap()),
"export"=>local_store::export_details(p).map(|v|json!(v)),
"post"=>match local_store::post(p,q["route"].as_str().unwrap(),&q["payload"]){Ok(Ok(v))=>Ok(v),Ok(Err(e))=>Err(e),Err(e)=>Err(e)},
_=>Err("驱动操作无效".into())};println!("{}",match result{Ok(v)=>json!({"ok":true,"data":v}),Err(e)=>json!({"ok":false,"error":e})});}
`);
const deps = process.env.GAPAW_TEST_DEPS || path.join(path.dirname(binary), 'deps');
const rustArgs = ['--edition=2021', driverSource, '-L', 'dependency=' + deps, '-o', driver];
// release rlib 使用薄LTO；交由同版本Rust编译器处理，避免系统ld读取较新LLVM位码。
if (path.basename(path.dirname(deps)) === 'release') rustArgs.push('-C', 'lto=thin');
for (const name of ['chrono', 'rusqlite', 'serde_json', 'uuid', 'url']) {
  const latest = fs.readdirSync(deps).filter(f => f.startsWith('lib' + name + '-') && f.endsWith('.rlib')).map(f => ({ f, m: fs.statSync(path.join(deps, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
  assert.ok(latest, '缺少 Rust 构建依赖：' + name); rustArgs.push('--extern', name + '=' + path.join(deps, latest.f));
}
try { execFileSync('rustc', rustArgs, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw new Error('Rust比较驱动编译失败：\n' + String(error.stderr || error.message).slice(-5000)); }
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const call = (db, q) => JSON.parse(execFileSync(driver, [db], { input: JSON.stringify(q), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const old = (db, q) => JSON.parse(execFileSync('python3', ['-B', '-c', python, source, db], { input: JSON.stringify(q), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
function normalize(v, key = '') {
  if (Array.isArray(v)) return v.map(x => normalize(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, value] of Object.entries(v)) {
      if (k === 'created' || k === 'updated' || (k === 'at' && Object.hasOwn(v, 'previous'))) out[k] = '<生成时间>';
      else if (k === 'id' && v.request_id) out[k] = 'event:' + v.request_id;
      else if (k === 'id' && v.source) out[k] = 'message:' + v.source;
      else out[k] = normalize(value, k);
    }
    return out;
  }
  if (typeof v === 'string' && ['previous', 'current'].includes(key)) { try { return normalize(JSON.parse(v)); } catch (_) { } }
  return v;
}
let serial = 0;
function fixture(fixtureSeed = seed) {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const legacy = path.join(dir, 'legacy.sqlite'), local = path.join(dir, 'local.sqlite');
  assert.equal(old(legacy, { op: 'init', seed: fixtureSeed }).ok, true); assert.equal(call(local, { op: 'init', seed: fixtureSeed }).ok, true);
  const read = (route = '/api/creators/GW901') => {
    const a = call(local, { op: 'get', route }), b = old(legacy, { op: 'get', route });
    assert.deepEqual(normalize(a), normalize(b)); return a.data;
  };
  const write = (action, payload, creator = 'GW901', expected = true) => {
    const route = '/api/creators/' + creator + '/' + action;
    const a = call(local, { op: 'post', route, payload }), b = old(legacy, { op: 'post', route, payload });
    assert.equal(a.ok, expected, JSON.stringify(a)); assert.deepEqual(normalize(a), normalize(b)); return [a.data, b.data];
  };
  const start = Date.now() - 15 * 86400000;
  const at = (day = 0) => new Date(start + day * 86400000).toISOString();
  let n = 0;
  const event = (type, day = 0, extra = {}, cid = 'GW901', expected = true) => write('events', { channel: 'dm', type, at: at(day), proof: '合成人工依据', note: '', request_id: 'synthetic-' + (++n), ...extra }, cid, expected);
  const message = (extra = {}, cid = 'GW901', expected = true) => write('messages', { channel: 'email', direction: 'in', at: at(1), body: '合成消息正文', zh: '合成摘要', sender: '合成发送人', subject: '合成主题', kind: '正常', source: 'source-' + (++n), ...extra }, cid, expected);
  const summary = (day) => {
    const asof = at(day), a = call(local, { op: 'get', route: '/api/summary?asof=' + encodeURIComponent(asof) }), b = old(legacy, { op: 'get', route: '/api/summary', asof }); assert.deepEqual(a, b); return a.data;
  };
  const audit = () => {
    const query = "import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(x) for x in c.execute('SELECT * FROM audit ORDER BY id')],ensure_ascii=False));c.close()";
    const a = JSON.parse(execFileSync('python3', ['-B', '-c', query, local], { encoding: 'utf8' }));
    assert.deepEqual(normalize(a), normalize(old(legacy, { op: 'audit' }).data)); return a;
  };
  return { dir, legacy, local, read, write, event, message, summary, audit, at };
}

test('独立业务库七表结构、身份稳定、幂等导入和只读行为', () => {
  const f = fixture(), initial = f.read('/api/creators'), identity = call(f.local, { op: 'identity' }).data;
  assert.equal(initial.items.length, 2); assert.equal(initial.summary.started, 0); assert.equal(initial.items[0].settings.commission, null);
  assert.equal(call(f.local, { op: 'init', seed }).ok, true); assert.equal(old(f.legacy, { op: 'init', seed }).ok, true);
  assert.equal(call(f.local, { op: 'identity' }).data, identity); assert.equal(f.read('/api/creators').items.length, 2);
  const absent = path.join(f.dir, 'absent.sqlite'); assert.equal(call(absent, { op: 'get', route: '/api/health' }).ok, false); assert.equal(fs.existsSync(absent), false);
  const tables = JSON.parse(execFileSync('python3', ['-B', '-c', "import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1]);print(json.dumps([r[0] for r in c.execute(\"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name\")]));c.close()", f.local], { encoding: 'utf8' }));
  assert.deepEqual(tables, ['audit', 'creators', 'drafts', 'events', 'messages', 'meta', 'negotiations']);
  assert.deepEqual(normalize(call(f.local, { op: 'export' }).data), normalize([f.read(), f.read('/api/creators/GW902')]));
});

test('设置报价联动、空值和字段约束与原工作台一致，审计完整', () => {
  const f = fixture();
  const [d] = f.write('settings', { settings: { fee: 100, commission: 15, sender: '合成人员', owner: '负责人', notes: '=合成备注', next_followup: '2020-01-01' }, revision: 0 });
  assert.ok(d.drafts.every(x => x.rendered.includes('100美元＋15%'))); assert.equal(d.gates.includes('佣金待填'), false);
  f.write('settings', { settings: { owner: '过期修改' }, revision: 0 }, 'GW901', false);
  for (const patch of [{ fee: 75 }, { fee: true }, { commission: -1 }, { commission: '15' }, { commission: false }, { unknown: true }, { account_checked: 1 }, { next_followup: '2026-02-30' }, { email: 'not-mail' }, { email_source: 'file:///tmp/x' }, { channel_ready: { email: true } }, { channel_ready: { comment: false, dm: false, email: true, affiliate: false } }]) f.write('settings', { settings: patch, revision: 1 }, 'GW901', false);
  f.write('settings', { settings: { commission: null, sender: '', notes: '', owner: '' }, revision: 1 });
  assert.equal(f.read().settings.commission, null); assert.equal(f.audit().length, 2);
});

test('草稿版本与占位金额校验一致，重复导入不覆盖人工编辑', () => {
  const f = fixture();
  f.write('drafts/email', { subject: '人工标题【姓名】', body: '调整后【固定费】美元＋【佣金比例】%佣金', revision: 0 });
  f.write('drafts/email', { subject: '过期', body: '旧草稿', revision: 0 }, 'GW901', false);
  for (const body of ['', '50美元固定费', '合计100 美元', 'x'.repeat(10001)]) f.write('drafts/email', { subject: '', body, revision: 1 }, 'GW901', false);
  f.write('drafts/email', { subject: '', body: '商品编号150美元不匹配固定报价正则', revision: 1 });
  call(f.local, { op: 'init', seed }); old(f.legacy, { op: 'init', seed });
  assert.equal(f.read().drafts.find(x => x.channel === 'email').revision, 2); assert.equal(f.audit().length, 2);
});

test('事件同渠道前置、时间顺序、原请求幂等与合作依赖一致', () => {
  const f = fixture();
  f.event('明确已读', 1, {}, 'GW901', false); f.event('平台受理', 1, {}, 'GW901', false);
  const attempt = f.event('发送尝试', 0, { proof: '', request_id: 'stable-attempt' });
  f.event('发送尝试', 0, { proof: '换依据仍返回原事件', request_id: 'stable-attempt' });
  f.event('发送尝试', 0, { request_id: 'stable-attempt' }, 'GW902', false);
  f.event('明确已读', 2, {}, 'GW901', false); f.event('平台受理', 1, { channel: 'email' }, 'GW901', false);
  f.event('平台受理', 1); f.event('明确已读', 2, { proof: '' }, 'GW901', false); f.event('明确已读', 2);
  f.event('有效回复', -1, {}, 'GW901', false); f.event('有效回复', 3, { channel: 'email' });
  f.event('确认合作', 4, {}, 'GW901', false); f.event('有意向', 4); f.event('确认合作', 5, {}, 'GW901', false);
  f.write('settings', { settings: { commission: 10 }, revision: 0 }); f.event('确认合作', 5); f.event('寄样', 6); f.event('已发片', 7);
  assert.equal(f.read().stage, '已发片'); assert.equal(f.summary(8).confirmed, 1);
  f.event('发送尝试', 100, {}, 'GW901', false); f.event('发送尝试', 0, { channel: 'followup' }, 'GW901', false);
  f.event('明确拒绝', 8); f.event('发送尝试', 9, {}, 'GW901', false); assert.equal(f.read().stage, '明确拒绝');
  assert.ok(attempt[0].id); f.audit();
});

test('事件撤销保留依赖和审计，跨达人/重复撤销拒绝', () => {
  const f = fixture(), first = f.event('发送尝试'), last = f.event('发送失败', 1);
  const action = (pair, reason, expected = true, creator = 'GW901') => {
    const a = call(f.local, { op: 'post', route: '/api/creators/' + creator + '/events/' + pair[0].id + '/void', payload: { reason } });
    const b = old(f.legacy, { op: 'post', route: '/api/creators/' + creator + '/events/' + pair[1].id + '/void', payload: { reason } });
    assert.equal(a.ok, expected); assert.deepEqual(normalize(a), normalize(b));
  };
  action(first, '合成撤销', false); action(last, '', false); action(last, '合成撤销', false, 'GW902');
  action(last, '合成撤销'); action(last, '重复撤销', false); action(first, ' 合成完整原因 ');
  assert.equal(f.read().events.length, 2); assert.equal(f.read().stage, '待核验'); assert.equal(f.summary(8).started, 0); assert.equal(f.audit().length, 2);
});

test('七天统计边界、失败分母、拒绝回复、跟进不重置与待跟进一致', () => {
  const f = fixture();
  f.event('发送尝试'); f.event('发送失败', 1); f.event('发送尝试', 6); f.event('有效回复', 8);
  f.event('发送尝试', 0, {}, 'GW902'); f.event('明确拒绝', 7, {}, 'GW902');
  f.write('settings', { settings: { next_followup: '2000-01-01' }, revision: 0 });
  f.write('settings', { settings: { next_followup: '2000-01-01' }, revision: 0 }, 'GW902');
  assert.equal(f.summary(6.999).mature7, 0);
  const boundary = f.summary(7); assert.equal(boundary.mature7, 2); assert.equal(boundary.reply7, 1); assert.equal(boundary.reply7_rate, 50); assert.equal(boundary.due, 1);
  const after = f.summary(9); assert.equal(after.responded, 2); assert.equal(after.reply7, 1); f.read('/api/creators');
});

test('七天回复率在百分比中点按原Python舍入，1/32保留3.12%', () => {
  const many = { source_sha256: 'synthetic-rounding', records: Array.from({ length: 32 }, (_, i) => ({ ...seed.records[0], profile: { ...seed.records[0].profile, id: 'GW' + (901 + i), handle: 'synthetic_round_' + i, rank: i + 1 } })) };
  const f = fixture(many);
  for (let i = 0; i < 32; i++) f.event('发送尝试', 0, {}, 'GW' + (901 + i));
  f.event('有效回复', 1);
  assert.equal(f.summary(8).reply7_rate, 3.12);
});

test('消息按source复用仅更新摘要和类型，谈判覆盖与会话读模型一致', () => {
  const f = fixture();
  f.message({ source: 'later', at: f.at(2) }); f.message({ source: 'first', direction: 'out', at: f.at(1) });
  f.message({ source: 'later', at: f.at(2), body: '异文不替换原文', zh: '新摘要', kind: '自动回复' });
  f.message({ source: 'later' }, 'GW902', false);
  for (const extra of [{ source: '' }, { body: '' }, { kind: '其他' }, { direction: 'sideways' }, { channel: 'followup' }, { at: f.at(100) }, { at: '2026-01-01T00:00:00' }]) f.message(extra, 'GW901', false);
  assert.deepEqual(f.read().messages.map(m => m.source), ['first', 'later']); assert.equal(f.read('/api/creators').items[0].last_in, '');
  f.write('negotiation', { price: '1' }, 'GW901', false); f.write('negotiation', { status: '还价中', our_offer: '$100', their_ask: '$200', next_step: '待核对' });
  f.write('negotiation', { status: '已拒绝' }); f.write('negotiation', { status: '仅有摘要' }, 'GW902');
  const conv = f.read('/api/conversations'); assert.equal(conv.items.length, 2); assert.equal(conv.items[0].negotiation.our_offer, ''); assert.equal(f.read('/api/creators').summary.started, 0); f.audit();
});

test('初始化拒绝未知非空库与符号链接，原文件逐字节保持不变', () => {
  const dir = path.join(root, 'invalid'); fs.mkdirSync(dir);
  const unknown = path.join(dir, 'other.sqlite');
  execFileSync('python3', ['-B', '-c', "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE unrelated(id INTEGER)');c.execute('INSERT INTO unrelated VALUES(7)');c.commit();c.close()", unknown]);
  const before = fs.readFileSync(unknown); assert.equal(call(unknown, { op: 'initialize' }).ok, false); assert.deepEqual(fs.readFileSync(unknown), before);
  const linked = path.join(dir, 'linked.sqlite'); fs.symlinkSync(unknown, linked); assert.equal(call(linked, { op: 'initialize' }).ok, false); assert.deepEqual(fs.readFileSync(unknown), before);
  const state = path.join(dir, 'state.sqlite'); assert.equal(call(state, { op: 'initialize' }).ok, false); assert.equal(fs.existsSync(state), false);
  const broken = path.join(dir, 'broken.sqlite'); assert.equal(call(broken, { op: 'init', seed }).ok, true);
  execFileSync('python3', ['-B', '-c', "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE meta SET value='broken' WHERE key='gapaw_local_business_id'\");c.commit();c.execute('PRAGMA journal_mode=DELETE');c.close()", broken]);
  const brokenBefore = fs.readFileSync(broken); assert.equal(call(broken, { op: 'initialize' }).ok, false); assert.deepEqual(fs.readFileSync(broken), brokenBefore);
  const constraints = path.join(dir, 'constraints.sqlite'); assert.equal(call(constraints, { op: 'init', seed }).ok, true);
  execFileSync('python3', ['-B', '-c', "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('DROP TABLE messages');c.execute('CREATE TABLE messages(id TEXT PRIMARY KEY,creator TEXT,channel TEXT,direction TEXT,at TEXT,sender TEXT,subject TEXT,body TEXT,zh TEXT,kind TEXT,source TEXT,created TEXT)');c.commit();c.execute('PRAGMA journal_mode=DELETE');c.close()", constraints]);
  const constraintsBefore = fs.readFileSync(constraints); assert.equal(call(constraints, { op: 'initialize' }).ok, false); assert.deepEqual(fs.readFileSync(constraints), constraintsBefore);

});

const cli = (state, command, input = {}) => {
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state }; delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  return JSON.parse(execFileSync(binary, [command], { input: JSON.stringify(input), env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
};
const cliOk = (state, command, input) => { const r = cli(state, command, input); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };

test('真实CLI本地模式无需旧服务即可展示、编辑、记事实和消息，身份防止换库误写', () => {
  const dir = path.join(root, 'cli'), state = path.join(dir, 'state'); fs.mkdirSync(dir);
  const initialized = cliOk(state, 'local-workbench-init', { confirmed: true }); assert.equal(initialized.active, true);
  const db = path.join(state, 'workbench.sqlite'); assert.equal(call(db, { op: 'seed', seed }).ok, true);
  const home = cliOk(state, 'workbench-home'); assert.equal(home.items.length, 2); assert.equal(home.summary.total, 2);
  const c = cliOk(state, 'workbench-fact-contract', { creatorId: 'GW901' }); assert.match(c.sourceUrl, /^local-workbench:/);
  const common = { creatorId: 'GW901', expectedSource: c.expectedSource, confirmed: true };
  const settings = cliOk(state, 'edit-settings', { ...common, requestId: 'local-settings', expectedRevision: 0, settings: { commission: 12, owner: '本地负责人' }, basis: '合成确认' }); assert.equal(settings.receipt.status, 'saved');
  assert.equal(cliOk(state, 'edit-draft', { creatorId: 'GW901', expectedSource: c.expectedSource, channel: 'email', subject: '本地标题', body: '本地文案【固定费】美元', revision: 0 }).status, 'saved');
  const at = new Date(Date.now() - 60000).toISOString();
  const event = cliOk(state, 'record-event', { ...common, requestId: 'local-event', event: { channel: 'email', type: '发送尝试', at, proof: '合成事实依据', note: '' } }); assert.equal(event.receipt.status, 'saved');
  const message = cliOk(state, 'record-message', { ...common, requestId: 'local-message', message: { channel: 'email', direction: 'in', at, sender: '', subject: '本地往来', body: '仅合成消息，不执行外发', zh: '本地摘要', kind: '正常', source: 'local-message-source' } }); assert.equal(message.receipt.status, 'saved');
  const after = cliOk(state, 'workbench-creator', { creatorId: 'GW901' }); assert.equal(after.settings.owner, '本地负责人'); assert.equal(after.messages.length, 1); assert.equal(after.events.length, 1); assert.equal(after.drafts.find(d => d.channel === 'email').revision, 1);
  assert.equal(cliOk(state, 'workbench-conversations').items.length, 1);
  const contract = cliOk(state, 'workbench-fact-contract', { creatorId: 'GW901' }), e = contract.events[0];
  assert.equal(cliOk(state, 'void-event', { ...common, requestId: 'local-void', eventId: e.id, expectedEventHash: e.eventHash, reason: '合成撤销依据' }).receipt.status, 'saved');
  assert.equal(cliOk(state, 'local-workbench-init', { confirmed: true }).sourceUrl, initialized.sourceUrl);
  const replacement = path.join(dir, 'replacement.sqlite'); assert.equal(call(replacement, { op: 'init', seed }).ok, true);
  fs.renameSync(db, path.join(dir, 'preserved.sqlite')); fs.renameSync(replacement, db);
  assert.equal(cli(state, 'edit-settings', { ...common, requestId: 'stale-source', expectedRevision: 0, settings: { owner: '禁止误写' }, basis: '合成确认' }).ok, false);
  const changed = cliOk(state, 'workbench-fact-contract', { creatorId: 'GW901' }); assert.notEqual(changed.expectedSource, common.expectedSource); assert.deepEqual(changed.recentReceipts, []); assert.equal(changed.settings.owner, '');
});

test('真实CLI同版本并发保存只有一个成功且业务审计只增一次', async () => {
  const state = path.join(root, 'concurrent-state'); cliOk(state, 'local-workbench-init', { confirmed: true });
  const db = path.join(state, 'workbench.sqlite'); call(db, { op: 'seed', seed });
  const c = cliOk(state, 'workbench-fact-contract', { creatorId: 'GW901' });
  const save = n => new Promise((resolve, reject) => {
    const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state }; delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
    const child = execFile(binary, ['edit-draft'], { env, encoding: 'utf8' }, (err, stdout) => err ? reject(err) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ creatorId: 'GW901', expectedSource: c.expectedSource, channel: 'email', subject: '并发' + n, body: '合成草稿' + n, revision: 0 }));
  });
  const results = await Promise.all([save(1), save(2)]); assert.equal(results.filter(r => r.ok && r.data.status === 'saved').length, 1); assert.equal(results.filter(r => r.ok && r.data.status === 'conflict').length, 1);
  const counts = JSON.parse(execFileSync('python3', ['-B', '-c', "import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);print(json.dumps([c.execute(\"SELECT revision FROM drafts WHERE creator='GW901' AND channel='email'\").fetchone()[0],c.execute(\"SELECT count(*) FROM audit WHERE kind='文案:email'\").fetchone()[0]]));c.close()", db], { encoding: 'utf8' })); assert.deepEqual(counts, [1, 1]);
});


test('草稿候选保存本地来源，同路径换库和旧无来源任务均不能采用', t => {
  const state = path.join(root, 'draft-source-state');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-local-source-')));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const initial = cliOk(state, 'local-workbench-init', { confirmed: true });
  const db = path.join(state, 'workbench.sqlite'); assert.equal(call(db, { op: 'seed', seed }).ok, true);
  cliOk(state, 'configure', { workspace: { dirId: 'fixture-local-source', path: workspace } });
  let serial = 0;
  const candidate = (creatorId = 'GW901') => {
    const id = ++serial, taskId = 'tsk_local_source_' + id;
    const op = cliOk(state, 'prepare-drafts', { requestId: 'local-draft-request-' + id, creatorIds: [creatorId], channels: ['email'], prompt: '合成来源隔离草稿', runtime: { cli: 'claude' } }).operation;
    cliOk(state, 'record-dispatch', { operationId: op.id, stage: 'created', response: { ok: true, taskId, sessionId: 'local-source-session-' + id, shellId: 'local-source-shell-' + id, url: '/air?task=' + taskId + '&dir=fixture-local-source' } });
    const p = cliOk(state, 'submit-drafts', { operationId: op.id, taskId, submissionId: 'local-draft-submission-' + id, drafts: [{ creatorId, channel: 'email', subject: '合成候选' + id, body: '本地候选' + id + ' 【固定费】', note: '仅测试' }] }).proposals[0];
    return { op, p };
  };
  const first = candidate(); assert.equal(first.op.draftScope.sourceUrl, initial.sourceUrl);
  assert.equal(cliOk(state, 'get-drafts', { operationId: first.op.id, live: true }).liveError, null);
  assert.equal(cliOk(state, 'adopt-draft', { proposalId: first.p.proposalId, adoptionId: 'local-source-adopt-a', expectedRevision: 0 }).status, 'adopted');
  const stale = candidate('GW902');
  const replacement = path.join(root, 'draft-replacement.sqlite'); assert.equal(call(replacement, { op: 'init', seed }).ok, true);
  fs.renameSync(db, path.join(root, 'draft-preserved.sqlite')); fs.renameSync(replacement, db);
  const before = call(db, { op: 'get', route: '/api/creators' });
  const oldReceipt = cli(state, 'adopt-draft', { proposalId: first.p.proposalId, adoptionId: 'local-source-adopt-a', expectedRevision: 0 }); assert.equal(oldReceipt.ok, false); assert.match(oldReceipt.error, /业务库不一致|业务库身份/);
  const live = cliOk(state, 'get-drafts', { operationId: stale.op.id, live: true }); assert.match(live.liveError, /业务库不一致|业务库身份/);
  const rejected = cli(state, 'adopt-draft', { proposalId: stale.p.proposalId, adoptionId: 'local-source-adopt-stale', expectedRevision: 0 }); assert.equal(rejected.ok, false); assert.match(rejected.error, /业务库不一致|业务库身份/);
  assert.deepEqual(call(db, { op: 'get', route: '/api/creators' }), before);
  const fresh = candidate('GW902'); assert.notEqual(fresh.op.draftScope.sourceUrl, initial.sourceUrl);
  assert.equal(cliOk(state, 'adopt-draft', { proposalId: fresh.p.proposalId, adoptionId: 'local-source-adopt-b', expectedRevision: 0 }).status, 'adopted');
  const legacy = candidate();
  execFileSync('python3', ['-B', '-c', "import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1]);v=json.loads(c.execute('SELECT value FROM operations WHERE id=?',(sys.argv[2],)).fetchone()[0]);del v['draftScope']['sourceUrl'];c.execute('UPDATE operations SET value=? WHERE id=?',(json.dumps(v,ensure_ascii=False),sys.argv[2]));c.commit();c.close()", path.join(state, 'state.sqlite'), legacy.op.id]);
  const unchanged = call(db, { op: 'get', route: '/api/creators/GW901' });
  const old = cli(state, 'adopt-draft', { proposalId: legacy.p.proposalId, adoptionId: 'local-source-adopt-legacy', expectedRevision: 0 }); assert.equal(old.ok, false); assert.match(old.error, /旧任务没有业务库身份/);
  assert.match(cliOk(state, 'get-drafts', { operationId: legacy.op.id, live: true }).liveError, /旧任务没有业务库身份/);
  assert.equal(cliOk(state, 'get-drafts', { operationId: legacy.op.id }).proposals.length, 1);
  assert.deepEqual(call(db, { op: 'get', route: '/api/creators/GW901' }), unchanged);
});
