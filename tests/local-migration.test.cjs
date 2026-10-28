'use strict';
// 全部数据库均为隔离合成数据；不连接原工作台服务或读取生产资料。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const binary = path.resolve(process.env.GAPAW_TEST_BINARY || '/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench');
const seed = `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]);c.executescript('''
CREATE TABLE creators(id TEXT PRIMARY KEY,handle TEXT UNIQUE,profile TEXT NOT NULL,settings TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE drafts(creator TEXT REFERENCES creators(id),channel TEXT,subject TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(creator,channel));
CREATE TABLE events(id TEXT PRIMARY KEY,creator TEXT REFERENCES creators(id),channel TEXT,type TEXT,at TEXT,proof TEXT,note TEXT,created TEXT,void_reason TEXT DEFAULT '',request_id TEXT UNIQUE);
CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,kind TEXT,creator TEXT,previous TEXT,current TEXT);
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE messages(id TEXT PRIMARY KEY,creator TEXT REFERENCES creators(id),channel TEXT,direction TEXT,at TEXT,sender TEXT,subject TEXT,body TEXT,zh TEXT,kind TEXT,source TEXT UNIQUE,created TEXT);
CREATE TABLE negotiations(creator TEXT PRIMARY KEY REFERENCES creators(id),status TEXT,our_offer TEXT,their_ask TEXT,next_step TEXT,updated TEXT);
''')
c.execute('INSERT INTO creators VALUES(?,?,?,?,?)',('SYNTH1','synthetic_only',json.dumps({'id':'SYNTH1','handle':'synthetic_only','unknown':None}),json.dumps({'fee':50,'commission':None,'sender':''}),7))
c.execute('INSERT INTO drafts VALUES(?,?,?,?,?)',('SYNTH1','email','SYNTHETIC_SUBJECT_PRIVATE','SYNTHETIC_BODY_PRIVATE',9))
c.executemany('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)',[
 ('event_active','SYNTH1','email','平台受理','2026-10-01','SYNTHETIC_PROOF_PRIVATE','','2026-10-01','','request_active'),
 ('event_void','SYNTH1','email','明确已读','2026-10-02','','SYNTHETIC_NOTE_PRIVATE','2026-10-02','SYNTHETIC_VOID_PRIVATE','request_void')])
c.execute('INSERT INTO audit VALUES(?,?,?,?,?,?)',(8,'2026-10-01','synthetic','SYNTH1','SYNTHETIC_PREVIOUS_PRIVATE','SYNTHETIC_CURRENT_PRIVATE'))
c.execute('INSERT INTO meta VALUES(?,?)',('source_sha256','synthetic-only'))
c.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',('message_1','SYNTH1','email','in','2026-10-02','synthetic@example.invalid','SYNTHETIC_SUBJECT_PRIVATE','SYNTHETIC_MESSAGE_PRIVATE',None,'正常','synthetic:source:1','2026-10-02'))
c.execute('INSERT INTO negotiations VALUES(?,?,?,?,?,?)',('SYNTH1','SYNTHETIC_STATUS_PRIVATE',None,'SYNTHETIC_ASK_PRIVATE','','2026-10-02'))
c.commit();c.close()
`;

function fixture(t) {
  assert.ok(fs.existsSync(binary), '请先构建真实 Rust 程序');
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/gapaw-local-migration-'));
  const source = path.join(root, '合成旧工作台.sqlite'), state = path.join(root, '插件持久目录'), target = path.join(state, 'workbench.sqlite');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', GAPAW_CREATOR_DATA_DIR: state };
  delete env.MULTICC_PLUGIN_WORKSPACE; delete env.MULTICC_PLUGIN_DIR_ID;
  const cleanup = [];
  t.after(async () => { try { for (const fn of cleanup.reverse()) await fn(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  const python = (script, args = []) => execFileSync('python3', ['-B', '-c', script, ...args], { env, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  python(seed, [source]);
  function command(name, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(binary, [name], { env, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(error);
        try {
          assert.equal(stderr, '');
          assert.doesNotMatch(stdout, /SYNTHETIC_(?:SUBJECT|BODY|PROOF|NOTE|VOID|PREVIOUS|CURRENT|MESSAGE|STATUS|ASK)_PRIVATE|synthetic@example/);
          resolve(JSON.parse(stdout));
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  async function preview() { const r = await command('preview-workbench-import', { sourcePath: source }); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; }
  async function run(p) { const r = await command('import-workbench', { sourcePath: p.sourcePath, expectedSourceDigest: p.sourceDigest, confirmed: true }); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; }
  function summary(file, destination = false) {
    return JSON.parse(python(`import sqlite3,sys,json,hashlib
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.execute('BEGIN')
out=[]
for name,sql in c.execute("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name!='gapaw_local_migration_receipts' ORDER BY name"):
 if sys.argv[2]=='1' and name in ('gapaw_selection_meta','gapaw_selection_batches','gapaw_selection_candidates','gapaw_selection_observations','gapaw_selection_receipts','gapaw_selection_audit'):continue
 q='"'+name.replace('"','""')+'"';suffix=" WHERE key IS NOT 'gapaw_local_business_id'" if name=='meta' and sys.argv[2]=='1' else ''
 rows=c.execute('SELECT * FROM '+q+suffix).fetchall()
 def safe(v):
  if isinstance(v,bytes):return {'blob':v.hex()}
  return v
 encoded=sorted(json.dumps([safe(v) for v in row],ensure_ascii=False,separators=(',',':')) for row in rows)
 out.append([name,sql,len(rows),hashlib.sha256(json.dumps(encoded,ensure_ascii=False).encode()).hexdigest()])
print(json.dumps(out));c.close()`, [file, destination ? '1' : '0']));
  }
  function noPartial() { assert.equal(fs.existsSync(target), false); if (fs.existsSync(state)) assert.deepEqual(fs.readdirSync(state).filter(n => n.startsWith('.workbench-migration-')), []); }
  return { root, source, state, target, env, cleanup, python, command, preview, run, summary, noPartial };
}

test('预览只读，真实SQLite备份逐表保留完整值、主键、版本、来源与撤销记录', async t => {
  const f = fixture(t), before = f.summary(f.source), original = fs.readFileSync(f.source);
  const p = await f.preview();
  assert.equal(p.canImport, true); assert.equal(p.destinationExists, false); assert.equal(p.destinationPath, f.target);
  assert.equal(p.tables.length, 7); assert.equal(p.totalRows, 8); assert.match(p.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(p.tables.find(x => x.name === 'drafts').primaryKey, ['creator', 'channel']);
  assert.equal(fs.existsSync(f.state), false); assert.deepEqual(fs.readFileSync(f.source), original);
  const result = await f.run(p);
  assert.equal(result.status, 'imported'); assert.equal(result.replay, false); assert.match(result.databaseId, /^[a-f0-9-]{36}$/);
  assert.equal(result.sourceDigest, p.sourceDigest); assert.deepEqual(result.tables, p.tables);
  assert.deepEqual(f.summary(f.target, true), before); assert.deepEqual(f.summary(f.source), before);
  assert.deepEqual(fs.readFileSync(f.source), original);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o600); assert.equal(fs.statSync(f.state).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(f.state).filter(n => n.startsWith('.workbench-migration-')), []);
  const candidateCounts = JSON.parse(f.python(`import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]);names=['gapaw_selection_meta','gapaw_selection_batches','gapaw_selection_candidates','gapaw_selection_observations','gapaw_selection_receipts','gapaw_selection_audit'];print(json.dumps({n:c.execute('SELECT count(*) FROM '+n).fetchone()[0] for n in names}));c.close()`, [f.target]));
  for (const [table, count] of Object.entries(candidateCounts)) assert.equal(count, table === 'gapaw_selection_meta' ? 2 : 0, table);
});

test('WAL中尚未checkpoint的最新提交完整迁入且原库不变', async t => {
  const f = fixture(t);
  const child = spawn('python3', ['-B', '-u', '-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL');c.execute('PRAGMA wal_autocheckpoint=0')
c.execute("UPDATE creators SET revision=71");c.execute("INSERT INTO messages VALUES('wal_message','SYNTH1','dm','in','2026-10-03','','','SYNTHETIC_MESSAGE_PRIVATE',NULL,'正常','synthetic:wal','2026-10-03')");c.commit();print('ready',flush=True);sys.stdin.read();c.close()`, f.source], { env: f.env, stdio: ['pipe','pipe','pipe'] });
  const exit = new Promise(resolve => child.once('exit', resolve));
  f.cleanup.push(async () => { child.stdin.end(); await exit; });
  await new Promise((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
  assert.ok(fs.statSync(f.source + '-wal').size > 0);
  const before = f.summary(f.source), wal = fs.readFileSync(f.source + '-wal');
  const p = await f.preview(); assert.equal(p.tables.find(x => x.name === 'messages').count, 2);
  await f.run(p); assert.deepEqual(f.summary(f.target, true), before); assert.deepEqual(f.summary(f.source), before);
  assert.deepEqual(fs.readFileSync(f.source + '-wal'), wal);
});

test('额外表、二进制、NULL、额外字段、索引、视图和触发器完整保留', async t => {
  const f = fixture(t);
  f.python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript('''ALTER TABLE creators ADD COLUMN extra_blob BLOB;
CREATE TABLE "extra quoted table"(id TEXT PRIMARY KEY,payload BLOB,real_value REAL,empty TEXT,unknown TEXT) WITHOUT ROWID;
CREATE TABLE extra_counter(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);
CREATE INDEX extra_index ON extra_counter(value);
CREATE VIEW extra_view AS SELECT id,value FROM extra_counter;
CREATE TRIGGER extra_trigger AFTER INSERT ON extra_counter BEGIN UPDATE extra_counter SET value=NEW.value WHERE id=NEW.id; END;
PRAGMA user_version=17; PRAGMA application_id=8123;''')
c.execute('UPDATE creators SET extra_blob=?',(bytes([0,255,1]),));c.execute('INSERT INTO "extra quoted table" VALUES(?,?,?,?,?)',('extra',bytes([255,0,128]),1.25,'',None));c.execute("INSERT INTO extra_counter(value) VALUES('synthetic')");c.commit();c.close()`, [f.source]);
  const before = f.summary(f.source), p = await f.preview(); assert.equal(p.tables.length, 10);
  await f.run(p); assert.deepEqual(f.summary(f.target, true), before);
  const objects = file => f.python(`import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('view','trigger') OR name='extra_index' ORDER BY name").fetchall()));c.close()`, [file]);
  assert.equal(objects(f.target), objects(f.source));
});

test('重试返回原回执，不覆盖迁入后修改；原库下线后也可恢复', async t => {
  const f = fixture(t), p = await f.preview(), imported = await f.run(p);
  f.python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("UPDATE drafts SET revision=99,body='local-edited'");c.commit();c.close()`, [f.target]);
  const edited = f.summary(f.target, true); fs.renameSync(f.source, f.source + '.retained');
  const replay = await f.run(p); assert.deepEqual(replay, { ...imported, replay: true });
  assert.deepEqual(f.summary(f.target, true), edited);
});

test('并发相同迁入只有一份原子创建，所有调用返回同一身份与回执', async t => {
  const f = fixture(t), p = await f.preview();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.run(p)));
  assert.equal(results.filter(x => !x.replay).length, 1);
  for (const r of results) { assert.equal(r.databaseId, results[0].databaseId); assert.equal(r.receiptId, results[0].receiptId); }
  assert.deepEqual(f.summary(f.target, true), f.summary(f.source));
  assert.deepEqual(fs.readdirSync(f.state).filter(n => n.startsWith('.workbench-migration-')), []);
});

test('预览后来源变化、未明确确认、未知字段及非绝对路径拒绝且无半成品', async t => {
  const f = fixture(t), p = await f.preview();
  for (const input of [
    { sourcePath: f.source, expectedSourceDigest: p.sourceDigest },
    { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: false },
    { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: true, destinationPath: '/tmp/forbidden.sqlite' },
    { sourcePath: './relative.sqlite', expectedSourceDigest: p.sourceDigest, confirmed: true },
  ]) { assert.equal((await f.command('import-workbench', input)).ok, false); f.noPartial(); }
  f.python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE creators SET revision=revision+1');c.commit();c.close()`, [f.source]);
  const changed = await f.command('import-workbench', { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: true });
  assert.equal(changed.ok, false); assert.match(changed.error, /已变化/); f.noPartial();
});

test('迁入过程中WAL来源再次提交时拒绝发布并清理完整临时备份', async t => {
  const f = fixture(t);
  f.python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL');c.execute('CREATE TABLE synthetic_large(id INTEGER PRIMARY KEY,payload BLOB)');c.executemany('INSERT INTO synthetic_large VALUES(?,?)',((i,bytes([i%255])*1024) for i in range(20000)));c.commit();c.close()`, [f.source]);
  const p = await f.preview(); let changed = false;
  const timer = setInterval(() => {
    if (!changed && fs.existsSync(f.state) && fs.readdirSync(f.state).some(n => n.startsWith('.workbench-migration-'))) {
      changed = true;
      f.python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE creators SET revision=999');c.commit();c.close()`, [f.source]);
    }
  }, 2);
  let result;
  try { result = await f.command('import-workbench', { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: true }); }
  finally { clearInterval(timer); }
  assert.equal(changed, true); assert.equal(result.ok, false); assert.match(result.error, /期间来源已变化/); f.noPartial();
});

test('损坏或不兼容源、复制后初始化失败都保留原库且不留半成品', async t => {
  const f = fixture(t), original = fs.readFileSync(f.source);
  fs.writeFileSync(f.source, 'synthetic corrupt database');
  assert.equal((await f.command('preview-workbench-import', { sourcePath: f.source })).ok, false); f.noPartial();
  fs.writeFileSync(f.source, original);
  f.python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('DROP TABLE messages');c.commit();c.close()`, [f.source]);
  assert.equal((await f.command('preview-workbench-import', { sourcePath: f.source })).ok, false); f.noPartial();
  fs.writeFileSync(f.source, original);
  f.python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript("CREATE TRIGGER block_identity BEFORE INSERT ON meta WHEN NEW.key='gapaw_local_business_id' BEGIN SELECT RAISE(ABORT,'synthetic init failure'); END;");c.commit();c.close()`, [f.source]);
  const before = f.summary(f.source), p = await f.preview();
  assert.equal((await f.command('import-workbench', { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: true })).ok, false);
  f.noPartial(); assert.deepEqual(f.summary(f.source), before);
});

test('已有无关目标、来源符号链接、目标符号链接及损坏回执拒绝覆盖', async t => {
  const f = fixture(t), p = await f.preview();
  fs.mkdirSync(f.state); fs.writeFileSync(f.target, 'retained target');
  assert.equal((await f.command('import-workbench', { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: true })).ok, false);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'retained target'); fs.unlinkSync(f.target);
  const link = path.join(f.root, 'linked-source.sqlite'); fs.symlinkSync(f.source, link);
  assert.equal((await f.command('preview-workbench-import', { sourcePath: link })).ok, false);
  fs.symlinkSync(f.source, f.target);
  assert.equal((await f.command('import-workbench', { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: true })).ok, false);
  assert.equal(fs.lstatSync(f.target).isSymbolicLink(), true); fs.unlinkSync(f.target);
  await f.run(p);
  f.python(`import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]);v=json.loads(c.execute('SELECT receipt FROM gapaw_local_migration_receipts').fetchone()[0]);v['totalRows']=999;c.execute('UPDATE gapaw_local_migration_receipts SET receipt=?',(json.dumps(v),));c.commit();c.close()`, [f.target]);
  const before = fs.readFileSync(f.target);
  const r = await f.command('import-workbench', { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: true });
  assert.equal(r.ok, false); assert.match(r.error, /回执校验失败/); assert.deepEqual(fs.readFileSync(f.target), before);
});

test('迁入后持久目录被替换为符号链接，预览和重试都拒绝且不碰原目标', async t => {
  const f = fixture(t), p = await f.preview(); await f.run(p);
  const retained = f.state + '-retained'; fs.renameSync(f.state, retained); fs.symlinkSync(retained, f.state);
  const target = path.join(retained, 'workbench.sqlite'), before = fs.readFileSync(target);
  const preview = await f.command('preview-workbench-import', { sourcePath: f.source });
  const replay = await f.command('import-workbench', { sourcePath: f.source, expectedSourceDigest: p.sourceDigest, confirmed: true });
  assert.equal(preview.ok, false); assert.equal(replay.ok, false); assert.match(replay.error, /符号链接/);
  assert.deepEqual(fs.readFileSync(target), before);
});
