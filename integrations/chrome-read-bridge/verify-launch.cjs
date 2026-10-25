'use strict';
// 完整原命令入口与真正达人客户端联合验收；只操作本测试创建的目录和进程。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const socketName = id => 'read-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 16) + '.sock';
const capture = (binary, args, options = {}, input) => new Promise((resolve, reject) => {
  const child = execFile(binary, args, { timeout: 30000, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error && (error.killed || error.signal)) return reject(new Error('测试子进程未在期限内结束：' + error.signal));
    resolve({ code: error ? error.code : 0, stdout, stderr });
  });
  child.on('error', reject);
  child.stdin.end(input === undefined ? '' : JSON.stringify(input));
});

test('完整启动、原任务读取、读中停止、会话保留与进程清理', {
  skip: !process.env.CHROME_TEST_BIN || !process.env.PLUGIN_TEST_MANIFEST || !process.env.GAPAW_TEST_BINARY,
  timeout: 150000,
}, async t => {
  const root = fs.mkdtempSync('/tmp/cbr-launch-');
  fs.chmodSync(root, 0o700);
  // 达人工作目录拒绝 /tmp；新建空的专用目录，通过真实 configure 校验后在结束时删除。
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.gapaw-full-bridge-test-')));
  const target = path.join(root, 'target');
  const sourceData = path.join(root, 'source-data');
  const creatorData = path.join(root, 'creator-data');
  const sourcePlugin = path.join(root, 'source-plugin');
  const manifest = path.resolve(process.env.PLUGIN_TEST_MANIFEST);
  const binary = path.join(target, 'debug/chrome-proxy-launcher');
  const creatorBinary = path.resolve(process.env.GAPAW_TEST_BINARY);
  const sockets = new Set(), servers = [], identities = [], processes = [];
  const sourceEnv = { ...process.env, CHROME_READ_TEST_ROOT: root };
  const creatorEnv = { ...process.env, GAPAW_CREATOR_DATA_DIR: creatorData, GAPAW_CHROME_PLUGIN_DIR: sourcePlugin, GAPAW_CHROME_DATA_DIR: sourceData };
  delete creatorEnv.MULTICC_PLUGIN_WORKSPACE;
  delete creatorEnv.MULTICC_PLUGIN_DIR_ID;
  let compiled = false;
  const raw = async (executable, env, command, input = {}) => {
    const result = await capture(executable, [command], { env }, input);
    try { return JSON.parse(result.stdout); }
    catch (_) { throw new Error('测试命令未返回有效 JSON：' + command + '\n' + result.stderr); }
  };
  const source = async (command, input = {}) => {
    const result = await raw(binary, sourceEnv, command, input);
    assert.equal(result.ok, true, '来源命令 ' + command + '：' + JSON.stringify(result));
    return result.data;
  };
  const creator = async (command, input = {}) => {
    const result = await raw(creatorBinary, creatorEnv, command, input);
    assert.equal(result.ok, true, '达人命令 ' + command + '：' + JSON.stringify(result));
    return result.data;
  };
  const waitGone = async record => {
    for (let n = 0; n < 100 && (alive(record.pid) || alive(record.supervisorPid)); n++) await pause(50);
    assert.equal(alive(record.pid), false, '临时 Chrome 必须退出');
    assert.equal(alive(record.supervisorPid), false, '临时监督进程必须退出');
    record.cleaned = true;
  };
  t.after(async () => {
    const errors = [];
    if (compiled) for (const id of identities) {
      try { await raw(binary, sourceEnv, 'stop', { id }); } catch (error) { errors.push(error); }
    }
    for (const record of processes) {
      if (record.cleaned) continue;
      for (const pid of [record.pid, record.supervisorPid]) {
        if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
      }
      try { await waitGone(record); } catch (error) { errors.push(error); }
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, '测试进程清理失败');
  });
  assert.ok(fs.existsSync(creatorBinary), '请先构建真正达人客户端二进制');
  // 每次在自己的 target 下显式编译测试 feature，绝不把生产二进制当测试程序运行。
  const built = await capture('cargo', ['build', '--locked', '--features', 'gapaw-read-bridge-test', '--manifest-path', manifest, '--target-dir', target], { timeout: 60000 });
  assert.equal(built.code, 0, built.stderr);
  compiled = true;
  const noRootEnv = { ...process.env }; delete noRootEnv.CHROME_READ_TEST_ROOT;
  const missingRoot = await capture(binary, ['list'], { env: noRootEnv });
  assert.notEqual(missingRoot.code, 0, '测试构建缺少根目录必须拒绝，不能回退生产数据');
  assert.match(missingRoot.stderr, /CHROME_READ_TEST_ROOT/);

  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'fixture.key'), '-out', path.join(root, 'fixture.crt'), '-days', '1', '-subj', '/CN=kalodata.com'], { stdio: 'ignore' });
  assert.equal(certificate.status, 0);
  const firstScript = `const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.fillStyle='rgb(80,120,160)';x.fillRect(0,0,64,64);const b=x.getImageData(0,0,64,64).data;let h=2166136261;for(const v of b)h=Math.imul(h^v,16777619);window.fixtureFirstHash=h>>>0;`;
  const requests = [], accepted = [], denied = [];
  const fixture = https.createServer({ key: fs.readFileSync(path.join(root, 'fixture.key')), cert: fs.readFileSync(path.join(root, 'fixture.crt')) }, (request, response) => {
    requests.push({ url: request.url, cookie: request.headers.cookie || '' });
    const label = request.url.startsWith('/beta') ? 'beta' : 'alpha';
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Set-Cookie', 'session_fixture=' + label + '; Path=/; Secure; SameSite=Lax');
    response.end(`<!doctype html><meta charset="utf-8"><script>${firstScript}</script><title>合成身份 ${label}</title>
      <p>公开正文 ${label}</p><p id="fingerprint"></p><script>document.getElementById('fingerprint').textContent='首段指纹 '+window.fixtureFirstHash;</script>
      <form><p>表单秘密</p><input value="密码秘密"><textarea>输入秘密</textarea></form>
      <p hidden>隐藏秘密</p><div style="opacity:0">透明秘密</div><div style="height:0;overflow:hidden">裁切秘密</div>
      <div style="clip-path:inset(100%)">路径裁切秘密</div><div contenteditable>编辑秘密</div><iframe src="https://evil.invalid/frame"></iframe>`);
  });
  fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await listen(fixture); servers.push(fixture);
  const proxy = http.createServer((request, response) => { denied.push(request.url); response.writeHead(502); response.end(); });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  proxy.on('connect', (request, client, head) => {
    if (!['kalodata.com:443', 'affiliate.tiktok.com:443'].includes(request.url)) { denied.push(request.url); client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    accepted.push(request.url);
    const upstream = net.connect(fixture.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
  });
  await listen(proxy); servers.push(proxy);
  const wrapper = path.join(root, 'chrome'), chromeErrors = path.join(root, 'chrome.stderr');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(process.env.CHROME_TEST_BIN) + ' --headless=new --use-mock-keychain --ignore-certificate-errors --disable-background-networking --disable-component-update --disable-sync "$@" 2>>' + quote(chromeErrors) + '\n', { mode: 0o700 });
  for (const name of ['alpha', 'beta']) {
    const saved = await source('save', { name, chromePath: wrapper, proxy: { scheme: 'http', host: '127.0.0.1', port: proxy.address().port } });
    identities.push(saved.profile.id);
  }
  const [alpha, beta] = identities;
  const launch = async (id, url) => {
    const launched = await source('launch', { id, url, automaticFingerprint: true, checkProxy: true });
    assert.equal(launched.fingerprint.installationVerified, true);
    assert.equal(launched.fingerprint.status, 'loaded');
    assert.ok(Number.isInteger(launched.pid) && Number.isInteger(launched.supervisorPid));
    processes.push(launched);
    assert.ok(alive(launched.pid) && alive(launched.supervisorPid));
    const socket = path.join(sourceData, 'run', socketName(id));
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    const info = JSON.parse(fs.readFileSync(path.join(sourceData, 'run', id + '.browser.json'), 'utf8'));
    assert.equal(info.pid, launched.pid); assert.equal(info.supervisorPid, launched.supervisorPid);
    assert.equal(fs.existsSync(path.join(launched.userDataDir, 'DevToolsActivePort')), false);
    return launched;
  };
  let first;
  try { first = await launch(alpha, 'https://kalodata.com/alpha?private=redacted#fragment'); }
  catch (error) { throw new Error(error.message + '\n临时 Chrome 输出：\n' + (fs.existsSync(chromeErrors) ? fs.readFileSync(chromeErrors, 'utf8').slice(-6000) : '无')); }
  const second = await launch(beta, 'https://affiliate.tiktok.com/beta?private=redacted');
  fs.mkdirSync(path.join(sourcePlugin, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(manifest), 'plugin.json'), path.join(sourcePlugin, 'plugin.json'));
  fs.copyFileSync(binary, path.join(sourcePlugin, 'bin/chrome-proxy-launcher'));
  fs.chmodSync(path.join(sourcePlugin, 'bin/chrome-proxy-launcher'), 0o700);

  const inventory = await creator('browser-status');
  assert.equal(inventory.source.readOnlyBridge, true);
  const bind = (id, revision) => creator('bind-browser', { profileId: id, expectedRevision: revision, expectedSourceRevision: inventory.environments.find(item => item.id === id).sourceRevision });
  await creator('configure', { workspace: { dirId: 'full-bridge-fixture-dir', path: workspace } });
  await bind(alpha, 0);
  const prepare = async label => {
    const operation = (await creator('prepare-operation', { requestId: 'request-' + label, prompt: '只核验本地合成页面', runtime: { cli: 'codex' } })).operation;
    const taskId = 'fixture-task-' + label;
    await creator('record-dispatch', { operationId: operation.id, stage: 'created', response: { taskId, sessionId: 'fixture-session-' + label, shellId: 'fixture-shell-' + label, url: '/air?task=' + taskId } });
    await creator('record-dispatch', { operationId: operation.id, stage: 'sent', response: { taskId, receiptId: 'fixture-receipt-' + label } });
    return { operationId: operation.id, taskId };
  };
  const alphaOwner = await prepare('alpha');
  const probe = await creator('browser-probe', { operationId: alphaOwner.operationId });
  assert.equal(probe.profileId, alpha); assert.equal(probe.status, 'connected'); assert.equal(probe.canCollectPlatforms, false);
  const read = async (owner, id, label) => {
    let pages, result;
    for (let n = 0; n < 40; n++) {
      pages = await creator('browser-pages', owner);
      assert.equal(pages.profileId, id); assert.equal(pages.operationId, owner.operationId); assert.equal(pages.taskId, owner.taskId);
      const page = pages.pages.find(item => item.url.endsWith('/' + label));
      if (page) {
        result = await creator('browser-read-page', { ...owner, targetId: page.targetId, expectedInstanceId: pages.instanceId });
        if (result.page.text.includes('首段指纹')) break;
      }
      await pause(100);
    }
    assert.ok(result, '合成平台页面必须完成读取');
    assert.equal(result.canCollectPlatforms, false); assert.equal(result.untrustedContent, true);
    assert.match(result.page.text, new RegExp('^公开正文 ' + label + '\\n首段指纹 \\d+$'));
    assert.equal(result.page.truncated, false);
    assert.ok(!result.page.url.includes('?') && !result.page.url.includes('#'));
    return { pages, result };
  };
  const a = await read(alphaOwner, alpha, 'alpha');
  let rawHash = 2166136261;
  for (let n = 0; n < 4096; n++) for (const value of [80, 120, 160, 255]) rawHash = Math.imul(rawHash ^ value, 16777619);
  assert.notEqual(Number(a.result.page.text.match(/首段指纹 (\d+)/)[1]), rawHash >>> 0, '网页首段脚本必须已受指纹扩展保护');
  await bind(beta, 1);
  const betaOwner = await prepare('beta');
  assert.equal((await creator('browser-probe')).profileId, beta);
  const databaseHash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(creatorData, 'state.sqlite'))).digest('hex');
  const beforeRead = databaseHash();
  const frozen = await read(alphaOwner, alpha, 'alpha');
  assert.equal(frozen.pages.bindingRevision, 1, '切换默认身份不得改变旧任务');
  const b = await read(betaOwner, beta, 'beta');
  assert.equal(b.pages.bindingRevision, 2); assert.equal(b.result.page.platform, 'affiliate');
  assert.notEqual(b.pages.instanceId, a.pages.instanceId);
  assert.equal((await raw(creatorBinary, creatorEnv, 'browser-pages', { ...alphaOwner, taskId: betaOwner.taskId })).ok, false);
  assert.equal(databaseHash(), beforeRead, '页面读取不得写入业务状态库');

  // 仅测试 feature 在真实 DOMSnapshot 请求写入后暂停读取响应，确保 stop 命中进行中的请求。
  const delayGate = path.join(sourceData, 'run/test-snapshot-delay');
  const delayStarted = path.join(sourceData, 'run/test-snapshot-delay.started');
  fs.writeFileSync(delayGate, 'one-shot');
  const readStartedAt = Date.now();
  const interruptedRead = raw(creatorBinary, creatorEnv, 'browser-read-page', {
    ...alphaOwner, targetId: frozen.result.page.targetId, expectedInstanceId: frozen.pages.instanceId,
  }).then(value => ({ value }), error => ({ error }));
  for (let n = 0; n < 100 && !fs.existsSync(delayStarted); n++) await pause(20);
  assert.equal(fs.existsSync(delayStarted), true, '必须确认 DOMSnapshot 已写入后才发起停止');
  assert.equal(fs.readFileSync(delayStarted, 'utf8'), 'request-written');
  // 未完成的排队请求不得在关闭后再次被 poll 接收，否则监督进程会额外等待完整请求。
  const queued = net.connect(path.join(sourceData, 'run', socketName(alpha)));
  sockets.add(queued); queued.on('close', () => sockets.delete(queued)); queued.on('error', () => {});
  await new Promise((resolve, reject) => { queued.once('connect', resolve); queued.once('error', reject); });
  queued.write('{');
  const stopStartedAt = Date.now();
  const stopped = await source('stop', { id: alpha }); assert.equal(stopped.stopped, true);
  const interrupted = await interruptedRead;
  assert.ifError(interrupted.error);
  assert.equal(interrupted.value.ok, false, '被停止中断的读取不得返回页面结果');
  assert.ok(Date.now() - readStartedAt < 3000, '读取必须在停止信号后有界结束，不能等满 8 秒');
  await waitGone(first);
  const stopElapsedMs = Date.now() - stopStartedAt;
  assert.ok(stopElapsedMs < 3000, '慢读取和排队请求不能阻塞正常停止');
  assert.equal(fs.existsSync(path.join(sourceData, 'run/test-system-stop-fallback')), false, '必须使用私有管道正常关闭，不能悄悄走系统回退');
  t.diagnostic('真实读中停止及进程回收耗时：' + stopElapsedMs + ' 毫秒');
  queued.destroy();
  const alphaSocket = path.join(sourceData, 'run', socketName(alpha));
  assert.equal(fs.existsSync(alphaSocket), false);
  assert.equal(fs.existsSync(path.join(sourceData, 'run', alpha + '.browser.json')), false);
  assert.equal(fs.existsSync(path.join(sourceData, 'run', alpha + '.pid')), false);
  assert.equal((await raw(creatorBinary, creatorEnv, 'browser-probe', { operationId: alphaOwner.operationId })).ok, false);
  const restarted = await launch(alpha, 'https://kalodata.com/alpha?private=again#new-fragment');
  const afterRestart = await read(alphaOwner, alpha, 'alpha');
  assert.notEqual(afterRestart.pages.instanceId, a.pages.instanceId);
  const stale = await raw(creatorBinary, creatorEnv, 'browser-read-page', { ...alphaOwner, targetId: afterRestart.result.page.targetId, expectedInstanceId: a.pages.instanceId });
  assert.equal(stale.ok, false, '旧实例标识必须在读取前拒绝');
  assert.equal(afterRestart.result.page.text, a.result.page.text, '同一身份重启后保留同一首段指纹结果');
  assert.ok(requests.some(item => item.url.includes('private=again') && item.cookie.includes('session_fixture=alpha')), '读中停止重开必须保留合成会话 Cookie');
  assert.equal(databaseHash(), beforeRead);
  for (const [id, record] of [[alpha, restarted], [beta, second]]) {
    assert.equal((await source('stop', { id })).stopped, true);
    await waitGone(record);
    assert.equal(fs.existsSync(path.join(sourceData, 'run', socketName(id))), false);
    assert.equal(fs.existsSync(path.join(sourceData, 'run', id + '.browser.json')), false);
    assert.equal(fs.existsSync(path.join(sourceData, 'run', id + '.pid')), false);
  }
  const empty = await launch(beta);
  assert.equal((await creator('browser-pages', betaOwner)).pages.length, 0, '未指定网址的新标签不属于允许读取的平台');
  assert.equal((await source('stop', { id: beta })).stopped, true);
  await waitGone(empty);
  assert.equal(fs.existsSync(path.join(sourceData, 'run', socketName(beta))), false);
  assert.ok(requests.some(item => item.url.startsWith('/alpha')) && requests.some(item => item.url.startsWith('/beta')));
  assert.ok(accepted.includes('kalodata.com:443') && accepted.includes('affiliate.tiktok.com:443'));
  assert.ok(denied.includes('evil.invalid:443'), '未允许目标必须在本地代理拒绝');
  assert.ok(!fs.readFileSync(chromeErrors, 'utf8').includes('Failed to create a ProcessSingleton'), '打开页面不再启动第二个 Chrome 进程');
});
