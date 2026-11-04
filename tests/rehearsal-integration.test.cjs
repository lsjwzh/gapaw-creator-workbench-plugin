'use strict';
// 影子演练：真实 Rust 程序 + 合成业务库；只读业务库，不发送任何消息。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const binary = process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench';
const PACK = path.join(__dirname, 'fixtures', 'rehearsal-pack.json');

function business(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
  db.exec(`CREATE TABLE creators(id TEXT PRIMARY KEY,handle TEXT UNIQUE,profile TEXT NOT NULL,settings TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages(id TEXT PRIMARY KEY,creator TEXT,channel TEXT,direction TEXT,at TEXT,sender TEXT,subject TEXT,body TEXT,zh TEXT,kind TEXT,source TEXT UNIQUE,created TEXT);
    CREATE TABLE negotiations(creator TEXT PRIMARY KEY,status TEXT,our_offer TEXT,their_ask TEXT,next_step TEXT,updated TEXT);
    INSERT INTO creators VALUES('GW1','cat.home','{}','{}',0);
    INSERT INTO messages VALUES('m-in-1','GW1','email','in','2026-10-11T14:45:00Z','a@x.test','Rates','Rate card body','模板报价单','自动回复','s1','');
    INSERT INTO messages VALUES('m-out-0','GW1','email','out','2026-10-10T00:00:00Z','','old','早于来信','','正常','s0','');
    INSERT INTO messages VALUES('m-out-1','GW1','email','out','2026-10-16T08:59:00Z','','Re','We can do $100','提议两条合计 $100','正常','s2','');
    INSERT INTO negotiations VALUES('GW1','等对方回复','$100','$450','','2026-10-16');`);
  db.close();
}
const snapshot = file => { const db = new DatabaseSync(file, { readOnly: true }); const r = db.prepare('SELECT count(*) n FROM messages').get().n + ':' + db.prepare('SELECT count(*) n FROM negotiations').get().n; db.close(); return r + ':' + fs.readFileSync(file).length; };

function fixture(t, withBusiness = true) {
  assert.ok(fs.existsSync(binary), '请先构建 Rust 程序');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapaw-reh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  if (withBusiness) business(state);
  const env = { ...process.env, GAPAW_CREATOR_DATA_DIR: state };
  for (const k of Object.keys(env)) if (k.startsWith('MULTICC_PLUGIN_') || k === 'GAPAW_LARK_CLI') delete env[k];
  env.GAPAW_LARK_CLI = path.join(root, 'no-lark-should-be-called');
  const run = (command, input = {}) => JSON.parse(execFileSync(binary, [command], { input: JSON.stringify(input), env, timeout: 60000 }).toString());
  const ok = (c, i) => { const r = run(c, i); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const fail = (c, i) => { const r = run(c, i); assert.equal(r.ok, false, JSON.stringify(r)); return r.error; };
  return { root, state, run, ok, fail, biz: path.join(state, 'workbench.sqlite') };
}
let n = 0;
const rid = () => 'req_test_' + (++n);

test('未导入时如实提示，导入同一文件幂等，内容变化后需新编号', t => {
  const f = fixture(t);
  assert.equal(f.ok('rehearsal-status').pack, null);
  const a = f.ok('rehearsal-import', { path: PACK });
  assert.equal(a.created, true); assert.deepEqual(a.counts, { questions: 3, cases: 2 });
  assert.equal(f.ok('rehearsal-import', { path: PACK }).created, false);
  const changed = path.join(f.root, 'p.json');
  const p = JSON.parse(fs.readFileSync(PACK, 'utf8')); p.title = '改过'; fs.writeFileSync(changed, JSON.stringify(p));
  assert.match(f.fail('rehearsal-import', { path: changed }), /编号|已导入|不同/);
  assert.match(f.fail('rehearsal-import', { path: path.join(f.root, 'none.json') }), /.+/);
  const s = f.ok('rehearsal-status');
  assert.equal(s.summary.open, 5); assert.equal(s.summary.hardOpen, 1); assert.equal(s.summary.remembered, 0);
  assert.deepEqual(s.steps.map(x => [x.id, x.total]), [['offer', 1], ['classify', 2], ['negotiate', 2]]);
});

test('回答问题：同意、修改、不确定与范围校验；客观数值只认明确确认', t => {
  const f = fixture(t); f.ok('rehearsal-import', { path: PACK });
  let rev = f.ok('rehearsal-status').revision;
  assert.match(f.fail('rehearsal-answer', { itemId: 'offer.fee', decision: 'edit', value: 5000, requestId: rid(), expectedRevision: rev }), /.+/);
  assert.match(f.fail('rehearsal-answer', { itemId: 'offer.fee', decision: 'edit', value: 25, requestId: rid(), expectedRevision: rev }), /.+/);
  f.ok('rehearsal-answer', { itemId: 'offer.fee', decision: 'unsure', requestId: rid(), expectedRevision: rev });
  let s = f.ok('rehearsal-status');
  assert.equal(s.summary.hardOpen, 1, '暂不确定仍算未完成'); assert.equal(s.profile.length, 0);
  const req = rid();
  f.ok('rehearsal-answer', { itemId: 'offer.fee', decision: 'edit', value: 100, note: '每条', requestId: req, expectedRevision: s.revision });
  const again = f.run('rehearsal-answer', { itemId: 'offer.fee', decision: 'edit', value: 100, note: '每条', requestId: req, expectedRevision: s.revision });
  assert.equal(again.ok, true, '同一请求重放不报错也不重复记录');
  assert.match(f.fail('rehearsal-answer', { itemId: 'offer.fee', decision: 'accept', requestId: req, expectedRevision: s.revision }), /.+/);
  assert.match(f.fail('rehearsal-answer', { itemId: 'classify.auto', decision: 'accept', requestId: rid(), expectedRevision: s.revision }), /.+/, '版本过期要拒绝');
  s = f.ok('rehearsal-status');
  f.ok('rehearsal-answer', { itemId: 'classify.auto', decision: 'accept', requestId: rid(), expectedRevision: s.revision });
  assert.match(f.fail('rehearsal-answer', { itemId: 'classify.auto', decision: 'edit', value: '随便', requestId: rid(), expectedRevision: f.ok('rehearsal-status').revision }), /.+/);
  s = f.ok('rehearsal-status');
  assert.equal(s.summary.hardOpen, 0); assert.equal(s.summary.remembered, 2);
  const fee = s.profile.find(p => p.id === 'offer.fee');
  assert.equal(fee.value, 100); assert.equal(fee.kind, 'hard');
  const d = f.ok('rehearsal-item', { itemId: 'offer.fee' });
  assert.equal(d.history.length, 2, '记录追加不覆盖：不确定 + 修改');
  assert.equal(d.item.prefill.value, 25);
});

test('来信案例：读取真实来信与当时回复，判断差异被记住，业务库不被修改', t => {
  const f = fixture(t); f.ok('rehearsal-import', { path: PACK });
  const before = snapshot(f.biz);
  const d = f.ok('rehearsal-item', { itemId: 'case.auto' });
  assert.equal(d.context.available, true);
  assert.equal(d.context.message.handle, 'cat.home');
  assert.equal(d.context.history.reply.zh, '提议两条合计 $100', '取来信之后的第一封外发');
  assert.equal(d.context.history.negotiation.theirAsk, '$450');
  assert.equal(d.rules[0].resolved.value, null);
  const miss = f.ok('rehearsal-item', { itemId: 'case.missing' });
  assert.equal(miss.context.available, false); assert.match(miss.context.reason, /找不到/);
  let rev = f.ok('rehearsal-status').revision;
  assert.match(f.fail('rehearsal-answer', { itemId: 'case.auto', decision: 'custom', requestId: rid(), expectedRevision: rev }), /.+/, '我会这样做必须写做法');
  f.ok('rehearsal-answer', { itemId: 'case.auto', decision: 'custom', note: '先查是否真人再定', requestId: rid(), expectedRevision: rev });
  rev = f.ok('rehearsal-status').revision;
  f.ok('rehearsal-answer', { itemId: 'case.missing', decision: 'agree', requestId: rid(), expectedRevision: rev });
  const s = f.ok('rehearsal-status');
  assert.equal(s.summary.casesDecided, 2); assert.equal(s.summary.casesAgreed, 1);
  assert.equal(s.summary.differences.length, 1); assert.equal(s.summary.differences[0].note, '先查是否真人再定');
  assert.equal(snapshot(f.biz), before);
  assert.ok(!fs.existsSync(path.join(f.root, 'calls.jsonl')));
});

test('没有业务库时案例如实说明，不会创建业务库', t => {
  const f = fixture(t, false); f.ok('rehearsal-import', { path: PACK });
  const d = f.ok('rehearsal-item', { itemId: 'case.auto' });
  assert.equal(d.context.available, false); assert.match(d.context.reason, /尚未建立/);
  assert.ok(!fs.existsSync(f.biz));
  assert.match(f.fail('rehearsal-item', { itemId: 'nope' }), /.+/);
});
