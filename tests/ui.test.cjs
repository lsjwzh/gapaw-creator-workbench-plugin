const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, createDispatcher, safeTaskURL, safePluginURL, safeSourceURL, safePlatformURL, formatRate, formatContributionRate, parseResultFile, mount } = require('../ui/app.js');

function operation(overrides = {}) {
  return { id: 'op-1', requestId: 'request-1', status: 'prepared', prompt: '<script>业务文本</script>', runtime: { cli: 'codex-exp' }, workspace: { dirId: 'dir-1', path: '/运营' }, task: null, error: null, createdAt: '2026-10-23T01:00:00Z', dispatch: { create: { dirId: 'dir-1', title: '按回本率选达人', clientMsgId: 'create-1', cli: 'codex-exp' }, message: { clientMsgId: 'message-1', text: '任务原文', intent: 'work', lang: 'zh' } }, ...overrides };
}
const task = { taskId: 'task-1', sessionId: 'session-1', shellId: 'shell-1', url: '/air?task=task-1' };
function dispatchHarness(options = {}) {
  const calls = []; let stored = operation(options.operation);
  const client = {
    async request(path, body) {
      calls.push({ path, body });
      if (path === '/api/directories') return options.directories || [{ id: 'dir-1', path: '/运营' }];
      if (path === '/api/task-shells/shell-1') return { receipts: options.receipts || [] };
      if (path === '/api/air/tasks') { if (options.failCreate) throw new Error('创建暂未确认'); return { ok: true, ...task }; }
      if (options.failMessage) throw new Error('消息投递暂未确认');
      return { ok: true, taskId: task.taskId, receiptId: 'receipt-1' };
    },
    async run(command, input) {
      calls.push({ command, input });
      if (command === 'record-dispatch') {
        if (input.stage === 'created' && options.failSaveCreate) throw new Error('记录保存失败');
        if (input.stage === 'sent' && options.failSaveSent) throw new Error('回执保存失败');
        stored = { ...stored, task, error: null, status: input.stage === 'created' ? 'task_created' : 'accepted' };
      }
      if (command === 'record-error') stored = { ...stored, status: input.stage === 'create' ? 'create_failed' : 'delivery_failed', error: { stage: input.stage, message: input.message } };
      return { operation: stored };
    }
  };
  return { client, calls, get stored() { return stored; } };
}

test('真实投递先保存创建结果再发消息，并原样使用冻结载荷', async () => {
  const h = dispatchHarness(); const source = operation();
  const result = await createDispatcher(h.client).dispatch(source);
  assert.deepEqual(h.calls.map(x => x.path || x.command + ':' + x.input.stage), ['/api/directories', '/api/air/tasks', 'record-dispatch:created', '/api/directories', '/api/task-shells/shell-1', '/api/task-shell-tasks/task-1/messages', 'record-dispatch:sent']);
  assert.equal(h.calls[1].body, source.dispatch.create);
  assert.deepEqual(h.calls[5].body, source.dispatch.message);
  assert.equal(result.status, 'accepted');
});
test('创建结果无法持久保存时不得投递消息', async () => {
  const h = dispatchHarness({ failSaveCreate: true });
  await assert.rejects(createDispatcher(h.client).dispatch(operation()), /记录保存失败/);
  assert.equal(h.calls.filter(x => x.path?.endsWith('/messages')).length, 0);
  assert.equal(h.stored.error.stage, 'create');
});
test('消息失败后重试沿用原任务，不再创建任务', async () => {
  const h = dispatchHarness({ failMessage: true }); const dispatcher = createDispatcher(h.client);
  await assert.rejects(dispatcher.dispatch(operation()), /消息投递/);
  assert.equal(h.stored.task.taskId, task.taskId);
  const retry = dispatchHarness({ operation: h.stored });
  await createDispatcher(retry.client).dispatch(h.stored);
  assert.equal(retry.calls.filter(x => x.path === '/api/air/tasks').length, 0);
  assert.equal(retry.calls.find(x => x.path?.endsWith('/messages')).body.clientMsgId, 'message-1');
});
test('创建响应未知时保留同一创建幂等编号', async () => {
  const h = dispatchHarness({ failCreate: true });
  await assert.rejects(createDispatcher(h.client).dispatch(operation()));
  assert.equal(h.stored.dispatch.create.clientMsgId, 'create-1');
  assert.equal(h.stored.task, null);
});
test('回执保存失败时保留已有任务并复用同一消息编号', async () => {
  const h = dispatchHarness({ failSaveSent: true });
  await assert.rejects(createDispatcher(h.client).dispatch(operation()), /回执保存失败/);
  assert.equal(h.stored.task.taskId, 'task-1');
  assert.equal(h.stored.dispatch.message.clientMsgId, 'message-1');
});
test('并发重试同一操作只执行一个投递流程', async () => {
  let resolve; const gate = new Promise(done => { resolve = done; }); const h = dispatchHarness(); const request = h.client.request;
  h.client.request = async (...args) => { await gate; return request(...args); };
  const dispatcher = createDispatcher(h.client); const first = dispatcher.dispatch(operation());
  await assert.rejects(dispatcher.dispatch(operation()), /正在发送/);
  resolve(); await first;
  assert.equal(h.calls.filter(x => x.path === '/api/air/tasks').length, 1);
});
test('已受理的任务不会再次发送', async () => {
  const h = dispatchHarness(); await createDispatcher(h.client).dispatch(operation({ status: 'accepted', task })); assert.equal(h.calls.length, 0);
});
test('任务入口只允许同源且任务编号一致的 /air 路径', () => {
  const origin = 'https://multicc.test';
  assert.equal(safeTaskURL('/air?task=task-1', origin, 'task-1'), '/air?task=task-1');
  for (const path of ['javascript:alert(1)', '//other.test/air?task=task-1', '/manage', '/air?task=another']) assert.equal(safeTaskURL(path, origin, 'task-1'), null);
  assert.equal(safePluginURL('/plugins/chrome-proxy-launcher/ui/index.html', origin, 'chrome-proxy-launcher'), '/plugins/chrome-proxy-launcher/ui/index.html');
  assert.equal(safePluginURL('/plugins/other/ui/index.html', origin, 'chrome-proxy-launcher'), null);
});
test('API 错误和非 JSON 登录页不会被视为成功', async () => {
  await assert.rejects(createClient(async () => ({ ok: true, json: async () => ({ ok: false, error: '未登录' }) })).request('/api/test'), /未登录/);
  await assert.rejects(createClient(async () => ({ ok: true, json: async () => { throw new Error('HTML'); } })).request('/api/test'), /登录/);
});
test('失败 HTTP 回执保留恢复所需标识', async () => {
  const client = createClient(async () => ({ ok: false, status: 503, json: async () => ({ error: '执行失败', receiptId: 'receipt-1', taskId: 'task-1', notDelivered: true }) }));
  await assert.rejects(client.request('/api/test'), error => error.receiptId === 'receipt-1' && error.taskId === 'task-1' && error.notDelivered === true);
});
test('原目录被改绑时创建与消息均停止', async () => {
  for (const source of [operation(), operation({ task, status: 'task_created' })]) {
    const h = dispatchHarness({ operation: source, directories: [{ id: 'dir-1', path: '/另一个目录' }] });
    await assert.rejects(createDispatcher(h.client).dispatch(source), /原工作目录/);
    assert.equal(h.calls.some(x => x.path === '/api/air/tasks' || x.path?.endsWith('/messages')), false);
  }
});
test('已受理但未保存的回执直接补记，不重复投递', async () => {
  const source = operation({ task, status: 'task_created' });
  const h = dispatchHarness({ operation: source, receipts: [{ id: 'receipt-1', taskId: 'task-1', clientMsgId: 'message-1', status: 'accepted' }] });
  await createDispatcher(h.client).dispatch(source);
  assert.equal(h.calls.some(x => x.path?.endsWith('/messages') || x.path?.endsWith('/retry')), false);
  assert.equal(h.stored.status, 'accepted');
});
test('失败与拒绝回执调用原回执重试接口', async () => {
  for (const status of ['failed', 'rejected']) {
    const source = operation({ task, status: 'delivery_failed' });
    const h = dispatchHarness({ operation: source, receipts: [{ id: 'receipt-1', taskId: 'task-1', clientMsgId: 'message-1', status }] });
    await createDispatcher(h.client).dispatch(source);
    assert.equal(h.calls.some(x => x.path === '/api/task-shells/shell-1/receipts/receipt-1/retry'), true);
    assert.equal(h.calls.some(x => x.path?.endsWith('/messages')), false);
  }
});
test('尚在预留与投递中的回执不能标记成功或重复投递', async () => {
  for (const status of ['reserved', 'delivering']) {
    const source = operation({ task, status: 'task_created' });
    const h = dispatchHarness({ operation: source, receipts: [{ id: 'receipt-1', taskId: 'task-1', clientMsgId: 'message-1', status }] });
    await assert.rejects(createDispatcher(h.client).dispatch(source), /等待宿主确认/);
    assert.equal(h.calls.some(x => x.path?.endsWith('/messages') || x.path?.endsWith('/retry')), false);
    assert.equal(h.calls.find(x => x.command === 'record-error').input.receiptId, 'receipt-1');
    assert.notEqual(h.stored.status, 'accepted');
  }
});
test('历史回执不在最近列表时仍可使用持久失败编号恢复', async () => {
  const source = operation({ task, status: 'delivery_failed', error: { stage: 'message', message: '失败', receiptId: 'old-receipt', taskId: 'task-1' } });
  const h = dispatchHarness({ operation: source });
  await createDispatcher(h.client).dispatch(source);
  assert.equal(h.calls.some(x => x.path === '/api/task-shells/shell-1/receipts/old-receipt/retry'), true);
  assert.equal(h.calls.some(x => x.path?.endsWith('/messages')), false);
});
test('回执属于另一任务时停止，不能错误补记成功', async () => {
  const source = operation({ task, status: 'task_created' });
  const h = dispatchHarness({ operation: source, receipts: [{ id: 'receipt-1', taskId: 'other-task', clientMsgId: 'message-1', status: 'accepted' }] });
  await assert.rejects(createDispatcher(h.client).dispatch(source), /身份不一致/);
  assert.notEqual(h.stored.status, 'accepted');
});

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  get firstChild() { return this.children[0]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  set innerHTML(_) { throw new Error('不得通过 innerHTML 写入业务内容'); }
}
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
async function uiHarness(options = {}) {
  const ids = ['notice','send','refresh','save-workspace','directory','prompt','cli','model','restore-template','operations','history-count','workspace-path','workspace-description','host-workspace','workspace-picker','connection-list','refresh-connections','task-form','browser-profile','save-browser','unbind-browser','probe-browser'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const document = { getElementById: id => elements[id], createElement: tag => new Element(tag) };
  const data = new Map(); const calls = []; let prepared = null; let count = 0;
  const browserData = options.browserStatus || browserFixture();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { if (options.failStorage) throw new Error('不可用'); data.set(key, value); }, removeItem: key => data.delete(key) };
  const workspace = options.workspace === undefined ? { dirId: 'dir-1', path: '/运营', valid: true, source: 'plugin' } : options.workspace;
  const window = { location: { origin: 'https://multicc.test' }, crypto: { randomUUID: () => 'uuid-' + (++count) }, localStorage: storage, confirm: () => true,
    fetch: async (path, request) => {
      const body = request.body ? JSON.parse(request.body) : null; calls.push({ path, body }); let value;
      if (path === '/api/directories') value = [{ id: 'dir-1', name: '运营', path: '/运营' }];
      else if (path === '/api/plugins') value = { plugins: [{ id: 'chrome-proxy-launcher', ui: options.chromeUI || '/plugins/chrome-proxy-launcher/ui/index.html' }] };
      else if (path === '/api/task-shells/shell-1') value = { receipts: [] };
      else if (body?.command === 'browser-status') {
        if (options.failBrowserRead) throw new Error('环境来源读取失败');
        if (body.input?.operationId) {
          const selected = (options.operations || [prepared]).find(item => item?.id === body.input.operationId);
          value = options.operationBrowserStatus || { ...browserData, scope: 'operation', binding: selected?.browser || { revision: 0, profile: null, configuredAt: null }, bindingState: selected?.browser ? selected.browser.profile ? 'bound' : 'unbound' : 'legacy_unbound' };
        } else value = structuredClone(browserData);
      }
      else if (body?.command === 'bind-browser') {
        if (options.rejectBinding) return { ok: false, status: 409, json: async () => ({ error: '绑定版本已变化，请刷新后重试' }) };
        if (options.bindingGate) await options.bindingGate;
        const profile = browserData.environments.find(item => item.id === body.input.profileId);
        browserData.binding = { revision: browserData.binding.revision + 1, profile: profile ? { id: profile.id, name: profile.name, sourceRevision: profile.sourceRevision } : null, configuredAt: '2026-10-25T02:00:00Z' };
        browserData.bindingState = profile ? 'bound' : 'unbound';
        value = { binding: structuredClone(browserData.binding) };
        if (options.failBrowserReadAfterBind) options.failBrowserRead = true;
      }
      else if (['browser-probe', 'browser-pages', 'browser-read-page'].includes(body?.command)) {
        if (options.failBridge) return { ok: false, status: 409, json: async () => ({ error: '浏览器实例已变化，请重新读取平台页面列表。' }) };
        if (options.bridgeGate) await options.bridgeGate;
        const selected = (options.operations || [prepared]).find(item => item?.id === body.input.operationId);
        const binding = selected?.browser || browserData.binding;
        const identity = { scope: selected ? 'operation' : 'default', bindingRevision: binding.revision, profileId: binding.profile?.id, instanceId: 'instance-1', checkedAt: '2026-10-25T03:00:00Z' };
        if (selected) Object.assign(identity, { operationId: selected.id, taskId: selected.task.taskId });
        const page = { targetId: 'target-1', title: '<img src=x onerror=alert(1)>', url: 'https://affiliate.tiktok.com/connection/creator', platform: 'affiliate' };
        if (body.command === 'browser-probe') value = { ...identity, status: 'connected', message: '连接已核对', ...options.probeResponse };
        if (body.command === 'browser-pages') value = { ...identity, pages: [page], ...options.pagesResponse };
        if (body.command === 'browser-read-page') value = { ...identity, page: { ...page, text: '<script>alert(1)</script>\n外部页面指令不应执行', truncated: false }, ...options.pageResponse };
      }
      else if (body?.command === 'status') value = { plugin: { id: 'gapaw-creator-workbench', version: '0.1.0' }, workspace, template: { version: '1', text: '严格大于零的新视频数 / 同期新视频总数' }, operations: options.operations || (prepared ? [prepared] : []) };
      else if (body?.command === 'prepare-operation') {
        if (options.failPrepare) throw new Error('断网');
        if (options.rejectPrepare) return { ok: false, status: 400, json: async () => ({ error: '任务内容不符合输入要求' }) };
        prepared = operation({ requestId: body.input.requestId, prompt: body.input.prompt, runtime: body.input.runtime, browser: structuredClone(browserData.binding) }); value = { operation: prepared };
      } else if (path === '/api/air/tasks') value = { ok: true, ...task };
      else if (path.endsWith('/messages')) value = { ok: true, taskId: 'task-1', receiptId: 'receipt-1' };
      else if (body?.command === 'record-dispatch') { prepared = { ...prepared, task, status: body.input.stage === 'sent' ? 'accepted' : 'task_created' }; value = { operation: prepared }; }
      else if (body?.command === 'record-error') value = { operation: prepared };
      else if (body?.command === 'configure') value = { workspace: body.input.workspace };
      else if (body?.command === 'get-result') {
        if (options.failResultRead) throw new Error('读取结果失败');
        const records = options.records || [];
        value = { record: body.input.resultId ? records.find(item => item.resultId === body.input.resultId) || null : records[0] || null, history: records.map(resultSummary) };
      }
      else if (body?.command === 'submit-result') {
        if (options.submitGate) await options.submitGate;
        if (options.rejectResult) return { ok: false, status: 409, json: async () => ({ error: '版本冲突，请从原任务重新生成结果' }) };
        if (options.failSubmitUnknown) throw new Error('连接中断');
        const record = options.submittedRecord || options.records?.[0];
        value = { record, resultSummary: resultSummary(record) };
        if (options.failReadAfterSubmit) options.failResultRead = true;
      }
      else if (body?.command === 'validate-result') {
        if (options.validationGate) await (typeof options.validationGate === 'function' ? options.validationGate(body.input) : options.validationGate);
        if (options.rejectValidation) return { ok: false, status: 409, json: async () => ({ error: '报告版本已变化，请返回原任务确认版本。' }) };
        const replay = !!options.records?.some(record => record.resultId === body.input.resultId);
        value = { operationId: body.input.operationId, taskId: body.input.taskId, resultId: body.input.resultId, expectedRevision: body.input.expectedRevision, currentRevision: replay ? options.records[0].revision : body.input.expectedRevision, canSubmit: true, replay, validation: validationFixture(), computed: resultRecord().computed, canCollectPlatforms: false, adoptionStatus: 'pending', ...options.validationResponse };
      }
      else if (body?.command === 'platform-contract') {
        if (options.contractGate) await options.contractGate;
        value = { operationId: body.input.operationId, taskId: body.input.taskId, contractVersion: 'platform-fields-v1', canCollectPlatforms: false, sources: [{ id: 'affiliate', label: 'TikTok Affiliate', purpose: '逐视频成交和佣金来源', requirements: [{ id: 'sales', label: '逐视频成交额', scope: 'video', requiredForRoi: true, note: '未知数值不能补零' }], limitations: ['读取字段尚未实测'] }], notes: ['公开页面不能证明样本完整。'], ...options.contractResponse };
      }
      else if (body?.command === 'result-contract') value = { taskId: 'task-1', expectedRevision: 0, submissionTemplate: resultInput(resultRecord()) };
      else throw new Error('未预期请求 ' + path);
      return { ok: true, status: 200, json: async () => value };
    }
  };
  const app = mount(document, window); await settle();
  return { app, elements, calls, data, options, browserData };
}
test('页面加载与刷新只读取配置，不自动创建任务或投递消息', async () => {
  const h = await uiHarness({ operations: [operation({ status: 'delivery_failed', task })] });
  await h.app.refresh();
  assert.equal(h.calls.filter(x => x.path === '/api/air/tasks' || x.path.endsWith('/messages')).length, 0);
  assert.equal(h.elements.cli.value, '');
  assert.equal(h.elements.prompt.value.includes('严格大于零'), true);
});
test('未配置目录时发送门禁生效', async () => {
  const h = await uiHarness({ workspace: null });
  h.elements.cli.value = 'codex-exp'; await h.app.send({ preventDefault() {} });
  assert.equal(h.elements.send.disabled, true);
  assert.equal(h.calls.filter(x => x.body?.command === 'prepare-operation').length, 0);
});
test('必须显式选择执行工具，不能误用默认 Claude', async () => {
  const h = await uiHarness(); await h.app.send({ preventDefault() {} });
  assert.match(h.elements.notice.textContent, /选择执行工具/);
  assert.equal(h.calls.filter(x => x.body?.command === 'prepare-operation').length, 0);
});
test('表单双击只生成一个持久操作和一个真实任务', async () => {
  const h = await uiHarness(); h.elements.cli.value = 'codex-exp';
  await Promise.all([h.app.send({ preventDefault() {} }), h.app.send({ preventDefault() {} })]);
  assert.equal(h.calls.filter(x => x.body?.command === 'prepare-operation').length, 1);
  assert.equal(h.calls.filter(x => x.path === '/api/air/tasks').length, 1);
  assert.equal(h.app.state.operations[0].status, 'accepted');
});
test('prepare 响应未知时重试沿用原请求和原内容', async () => {
  const options = { failPrepare: true }; const h = await uiHarness(options); h.elements.cli.value = 'codex-exp';
  await h.app.send({ preventDefault() {} });
  const first = h.calls.find(x => x.body?.command === 'prepare-operation').body.input;
  assert.equal(h.elements.prompt.disabled, true);
  options.failPrepare = false; await h.app.send({ preventDefault() {} });
  const preparations = h.calls.filter(x => x.body?.command === 'prepare-operation');
  assert.deepEqual(preparations[1].body.input, first);
});
test('prepare 明确拒绝输入后解锁编辑，修正后可使用新编号发送', async () => {
  const options = { rejectPrepare: true }; const h = await uiHarness(options); h.elements.cli.value = 'codex-exp';
  await h.app.send({ preventDefault() {} });
  const first = h.calls.find(x => x.body?.command === 'prepare-operation').body.input;
  assert.equal(h.app.state.pending, null);
  assert.equal(h.elements.prompt.disabled, false);
  assert.equal(h.elements.cli.disabled, false);
  assert.equal(h.elements.model.disabled, false);
  assert.equal(h.data.has('gapaw-creator-workbench:pending:v1'), false);
  assert.match(h.elements.notice.textContent, /修改任务内容/);
  options.rejectPrepare = false; h.elements.prompt.value = '修正后的选人任务';
  await h.app.send({ preventDefault() {} });
  const preparations = h.calls.filter(x => x.body?.command === 'prepare-operation');
  assert.notEqual(preparations[1].body.input.requestId, first.requestId);
  assert.equal(preparations[1].body.input.prompt, '修正后的选人任务');
  assert.equal(h.app.state.operations[0].status, 'accepted');
});
test('无法保留请求编号时阻止真实任务创建', async () => {
  const h = await uiHarness({ failStorage: true }); h.elements.cli.value = 'codex-exp';
  await h.app.send({ preventDefault() {} });
  assert.equal(h.calls.filter(x => x.body?.command === 'prepare-operation').length, 0);
  assert.match(h.elements.notice.textContent, /本地存储/);
});
test('宿主目录绑定优先，页面不另发目录配置请求', async () => {
  const h = await uiHarness({ workspace: { dirId: 'dir-1', path: '/宿主目录', source: 'host', valid: true } });
  assert.equal(h.elements['workspace-picker'].hidden, true);
  assert.equal(h.elements['host-workspace'].hidden, false);
  assert.equal(h.calls.some(x => x.path === '/api/directories'), false);
});
test('历史恶意提示词作为文本展示，外部任务地址不成为入口', async () => {
  const h = await uiHarness({ operations: [operation({ task: { ...task, url: 'https://evil.test/air?task=task-1' } })] });
  const visit = node => [node, ...node.children.flatMap(visit)];
  const nodes = visit(h.elements.operations);
  assert.equal(nodes.some(x => x.tagName === 'pre' && x.textContent === '<script>业务文本</script>'), true);
  assert.equal(nodes.some(x => x.tagName === 'a' && x.href?.includes('evil.test')), false);
});
test('连接状态只读取插件清单，不调用可能包含凭据的 Chrome list 命令', async () => {
  const h = await uiHarness();
  assert.equal(h.calls.filter(x => x.path.includes('chrome-proxy-launcher/run')).length, 0);
  const visit = node => [node, ...node.children.flatMap(visit)];
  assert.equal(visit(h.elements['connection-list']).some(x => x.href === '/plugins/chrome-proxy-launcher/ui/index.html'), true);
});

function resultRecord(revision = 1) {
  return {
    operationId: 'op-1', taskId: 'task-1', resultId: 'result-' + revision, revision, savedAt: '2026-10-25T01:00:00Z', adoptionStatus: 'pending',
    report: { schemaVersion: 1, methodVersion: '1', generatedAt: '2026-10-25T00:00:00Z', period: { start: '2026-09-01', end: '2026-09-30', timeZone: 'Asia/Shanghai' }, currency: 'USD', coverage: '公开视频', missingFields: [], candidates: [
      { platform: 'tiktok', creatorId: 'creator-1', handle: '<script>候选文本</script>', profileUrl: 'https://www.tiktok.com/@candidate', reason: '需要复核样本', sources: [{ url: 'javascript:alert(1)', capturedAt: '2026-10-25', note: '<b>来源文本</b>' }], missingFields: ['合作费'], videos: [
        { videoId: 'video-1', url: 'https://www.tiktok.com/video/1', publishedAt: '2026-09-02', contributionRate: null, sales: [{ kind: 'total', gmv: '10', commissionRate: '0.1' }], adSpend: '0', fixedFee: null, sampleCost: '0' }
      ] }
    ] },
    computed: { candidates: [{ creatorKey: 'tiktok:creator-1', summary: { status: 'incomplete', totalVideos: 328, evaluatedVideos: 327, knownPositiveVideos: 1, breakEvenCount: 1, breakEvenRate: '0.003048780487804878', averageSurplus: null }, videos: [{ videoId: 'video-1', surplus: null, missingFields: ['contributionRate', 'fixedFee'] }] }] }
  };
}
function resultSummary(record) { return { resultId: record.resultId, revision: record.revision, savedAt: record.savedAt, candidateCount: record.report.candidates.length, incompleteCount: 1, adoptionStatus: 'pending' }; }
function validationFixture() { return { candidateCount: 1, totalVideos: 328, completeCandidates: 0, incompleteCandidates: 1, knownPositiveVideos: 1, checks: [{ id: 'numbers', label: '数值完整性', status: 'unknown', message: '存在未知成本，不能按零计算。' }], missingFields: [{ creatorKey: 'tiktok:creator-1', videoId: 'video-1', fields: ['contributionRate', 'fixedFee'] }], sourceReview: { status: 'unverified', message: '来源链接与覆盖范围尚未实际核验。' } }; }
function resultInput(record) { return { operationId: record.operationId, taskId: record.taskId, resultId: record.resultId, expectedRevision: record.revision - 1, report: record.report }; }
function resultFile(input) { const text = JSON.stringify(input); return { name: '选人结果.json', size: Buffer.byteLength(text), text: async () => text }; }
function allNodes(node) { return [node, ...node.children.flatMap(allNodes)]; }
function allText(node) { return allNodes(node).map(item => item.textContent).join('\n'); }
function browserFixture() {
  return {
    source: { installed: true, version: '1.5.0', supported: true, available: true, message: '已读取兼容的本地身份信息。' },
    environments: [
      { id: 'profile-a', name: '选人专用身份', sourceRevision: { updatedAt: '2026-10-25T01:00:00Z' }, processState: 'pid_alive' },
      { id: 'profile-b', name: '备用身份', sourceRevision: { updatedAt: '2026-10-25T01:01:00Z' }, processState: 'not_running' }
    ], binding: { revision: 0, profile: null, configuredAt: null }, bindingState: 'unbound', checkedAt: '2026-10-25T01:30:00Z',
    checks: [{ id: 'source', label: '本地身份来源', status: 'passed', message: '本地资料可读取。' }, { id: 'egress', label: '出口', status: 'not_checked', message: '尚未实测出口。' }, { id: 'bridge', label: '自动化桥接', status: 'not_implemented', message: '尚未接入控制桥接。' }, { id: 'platform', label: '平台可读性', status: 'blocked', message: '尚不能读取平台。' }],
    fieldRequirements: [{ id: 'videos', label: '同期新视频与成交记录', source: 'tiktok_affiliate', status: 'not_checked' }, { id: 'ads', label: '广告消耗', source: 'kalodata', status: 'not_checked' }],
    canDispatchTask: true, canCollectPlatforms: false, scope: 'default'
  };
}
function selectBrowser(h, id) { h.elements['browser-profile'].value = id; h.elements['browser-profile'].listeners.change(); }

test('结果比例保留四位小数，极小正数不显示为零，未知仍为未知', () => {
  assert.equal(formatRate('0.003048780487804878'), '0.3049%');
  assert.equal(formatRate('0.000000000000000000000001'), '<0.0001%');
  assert.equal(formatRate('0'), '0.0000%');
  assert.equal(formatRate(null), '未知');
  assert.equal(formatRate('错误数字'), '未知');
});
test('已知负贡献率按有符号百分比展示，回本率与佣金率仍拒绝负数', async () => {
  assert.equal(formatContributionRate('-0.5'), '-50.0000%');
  assert.equal(formatContributionRate('-2'), '-200.0000%');
  assert.equal(formatContributionRate('-0.0000000001'), '>-0.0001% 且 <0%');
  assert.equal(formatContributionRate(null), '未知');
  assert.equal(formatRate('-0.5'), '未知');
  const record = resultRecord(); record.report.candidates[0].videos[0].contributionRate = '-0.5';
  const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })], records: [record] });
  await h.app.loadResult('op-1');
  assert.match(allText(h.elements.operations), /佣金前贡献率：-50\.0000%/);
});
test('来源链接拒绝脚本、凭据与本地文件，Chrome 相对 ui 路径可用', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///private/report', 'https://user:secret@example.com/']) assert.equal(safeSourceURL(url), null);
  assert.equal(safeSourceURL('https://www.tiktok.com/@candidate'), 'https://www.tiktok.com/@candidate');
  assert.equal(safePluginURL('ui/index.html', 'https://multicc.test', 'chrome-proxy-launcher'), '/plugins/chrome-proxy-launcher/ui/index.html');
  assert.equal(safePluginURL('../other/ui/index.html', 'https://multicc.test', 'chrome-proxy-launcher'), null);
});
test('结果文件大小、格式、归属与版本必须验证且不能静默改写', async () => {
  const source = operation({ task }); const input = resultInput(resultRecord());
  assert.deepEqual(await parseResultFile(resultFile(input), source), input);
  await assert.rejects(parseResultFile({ ...resultFile(input), size: 1024 * 1024 + 1 }, source), /1 MiB/);
  await assert.rejects(parseResultFile({ ...resultFile(input), name: '结果.txt' }, source), /JSON/);
  await assert.rejects(parseResultFile({ ...resultFile(input), text: async () => '{bad' }, source), /有效/);
  await assert.rejects(parseResultFile(resultFile({ ...input, taskId: 'other-task' }), source), /不属于/);
  await assert.rejects(parseResultFile(resultFile({ ...input, operationId: 'other-op' }), source), /不属于/);
  await assert.rejects(parseResultFile(resultFile({ ...input, expectedRevision: -1 }), source), /版本/);
});
test('受理任务仍显示尚无结果，查看和刷新结果不会重新投递任务', async () => {
  const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })] });
  assert.match(allText(h.elements.operations), /尚无结果报告/);
  await h.app.loadResult('op-1'); await h.app.loadResult('op-1');
  assert.equal(h.calls.filter(item => item.body?.command === 'get-result').length, 2);
  assert.equal(h.calls.some(item => item.body?.command === 'submit-result' || item.path === '/api/air/tasks' || item.path.endsWith('/messages')), false);
});
test('报告展示计算结果、缺失与证据，恶意文本不会成为页面标签', async () => {
  const record = resultRecord(); const h = await uiHarness({ operations: [operation({ task, status: 'accepted', resultSummary: resultSummary(record) })], records: [record] });
  await h.app.loadResult('op-1');
  const text = allText(h.elements.operations); const nodes = allNodes(h.elements.operations);
  assert.match(text, /已保存报告，待采纳/); assert.match(text, /0\.3049%/); assert.match(text, /平均结余：未知 USD/);
  assert.match(text, /候选缺失 1 项 · 视频缺失 2 项/); assert.match(text, /统计区间：2026-09-01/);
  assert.match(text, /<script>候选文本<\/script>/); assert.match(text, /<b>来源文本<\/b>/);
  assert.equal(nodes.some(item => item.tagName === 'a' && item.href?.startsWith('javascript:')), false);
  assert.equal(nodes.some(item => item.tagName === 'script'), false);
});
test('查看历史版本保留最新版本摘要', async () => {
  const latest = resultRecord(2); const older = resultRecord(1);
  const h = await uiHarness({ operations: [operation({ task, status: 'accepted', resultSummary: resultSummary(latest) })], records: [latest, older] });
  await h.app.loadResult('op-1', older.resultId);
  assert.equal(h.app.state.results.get('op-1').record.revision, 1);
  assert.equal(h.app.state.operations[0].resultSummary.revision, 2);
  const buttons = allNodes(h.elements.operations).filter(item => item.tagName === 'button');
  assert.equal(buttons.some(item => item.textContent === '第 2 版'), true);
});
test('导入失败保留已知结果，跨任务文件不会提交', async () => {
  const record = resultRecord(); const options = { operations: [operation({ task, status: 'accepted', resultSummary: resultSummary(record) })], records: [record], rejectResult: true };
  const h = await uiHarness(options); await h.app.loadResult('op-1');
  await h.app.importResult('op-1', resultFile({ ...resultInput(record), taskId: 'another-task' }));
  assert.equal(h.calls.some(item => item.body?.command === 'submit-result'), false);
  await h.app.importResult('op-1', resultFile(resultInput(record)));
  await h.app.saveResult('op-1');
  assert.equal(h.app.state.results.get('op-1').record.resultId, record.resultId);
  assert.match(h.app.state.results.get('op-1').error, /版本冲突/);
  assert.equal(h.app.state.operations[0].resultSummary.revision, 1);
});
test('重复导入旧版按原载荷提交，读回最新结果且不降级摘要', async () => {
  const latest = resultRecord(2); const older = resultRecord(1); const input = resultInput(older);
  const h = await uiHarness({ operations: [operation({ task, status: 'accepted', resultSummary: resultSummary(latest) })], records: [latest, older], submittedRecord: older });
  await h.app.importResult('op-1', resultFile(input));
  await h.app.saveResult('op-1');
  const submit = h.calls.find(item => item.body?.command === 'submit-result'); assert.deepEqual(submit.body.input, input);
  assert.equal(h.app.state.operations[0].resultSummary.revision, 2);
  assert.equal(h.app.state.results.get('op-1').record.revision, 2);
  assert.equal(h.app.state.results.get('op-1').history.length, 2);
  assert.match(h.elements.notice.textContent, /本次回执为第 1 版，当前最新为第 2 版/);
});
test('保存回执之后读回失败显示待确认并保留旧报告', async () => {
  const older = resultRecord(1); const newer = resultRecord(2);
  const options = { operations: [operation({ task, status: 'accepted', resultSummary: resultSummary(older) })], records: [older], submittedRecord: newer, failReadAfterSubmit: true };
  const h = await uiHarness(options); await h.app.loadResult('op-1');
  await h.app.importResult('op-1', resultFile(resultInput(newer)));
  await h.app.saveResult('op-1');
  assert.match(h.app.state.results.get('op-1').error, /已收到保存回执.*待刷新确认/);
  assert.equal(h.app.state.results.get('op-1').record.revision, 1);
  assert.equal(h.app.state.operations[0].resultSummary.revision, 1);
});
test('结果格式示例仅查询，未伪造或提交样例结果', async () => {
  const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })] });
  await h.app.showResultContract('op-1');
  assert.equal(h.app.state.results.get('op-1').template.taskId, 'task-1');
  assert.equal(h.calls.some(item => item.body?.command === 'submit-result'), false);
});

test('环境初次加载与刷新仅只读检测，不调用来源命令或自动保存绑定', async () => {
  const h = await uiHarness(); await h.app.refreshConnections();
  assert.equal(h.calls.filter(item => item.body?.command === 'browser-status').length, 2);
  assert.equal(h.calls.some(item => item.body?.command === 'bind-browser'), false);
  assert.equal(h.calls.some(item => item.path.includes('chrome-proxy-launcher/run')), false);
  assert.equal(h.calls.some(item => ['list', 'probe', 'launch', 'egress'].includes(item.body?.command)), false);
  const text = allText(h.elements['connection-list']);
  assert.match(text, /出口未实测/); assert.match(text, /平台字段完整性仍需单独验证/); assert.match(text, /同期新视频与成交记录/);
  assert.equal(allNodes(h.elements['connection-list']).filter(item => item.className?.startsWith('tag')).every(item => item.className.includes('neutral')), true);
});
test('保存绑定提交期望版本与脱敏来源版本，成功后读回确认', async () => {
  const h = await uiHarness(); selectBrowser(h, 'profile-a'); await h.app.saveBrowserBinding();
  const input = h.calls.find(item => item.body?.command === 'bind-browser').body.input;
  assert.deepEqual(input, { profileId: 'profile-a', expectedRevision: 0, expectedSourceRevision: { updatedAt: '2026-10-25T01:00:00Z' } });
  assert.equal(h.app.state.browser.status.binding.profile.id, 'profile-a');
  assert.match(h.elements.notice.textContent, /已保存并读回/);
  assert.equal(h.calls.filter(item => item.body?.command === 'browser-status').length, 2);
  assert.equal(/proxy|password|subscription|userData|pid|port/i.test(JSON.stringify(input)), false);
});
test('解除默认绑定只提交空身份和版本，历史快照不变', async () => {
  const source = browserFixture(); source.binding = { revision: 2, profile: { ...source.environments[0] }, configuredAt: '2026-10-25T01:10:00Z' }; source.bindingState = 'bound';
  const old = operation({ task, status: 'accepted', browser: structuredClone(source.binding) });
  const h = await uiHarness({ browserStatus: source, operations: [old] }); await h.app.saveBrowserBinding(true);
  assert.deepEqual(h.calls.find(item => item.body?.command === 'bind-browser').body.input, { profileId: null, expectedRevision: 2 });
  assert.equal(h.app.state.browser.status.binding.profile, null);
  assert.equal(old.browser.profile.id, 'profile-a');
  assert.match(allText(h.elements.operations), /选人专用身份/);
});
test('来源无法读取时不冒充无身份，禁止保存并保留原插件入口', async () => {
  const source = browserFixture(); source.source.available = false; source.source.message = '来源配置不可读取，请检查原插件。'; source.environments = []; source.bindingState = 'unavailable';
  const h = await uiHarness({ browserStatus: source });
  assert.equal(h.elements['browser-profile'].disabled, true);
  assert.equal(h.elements['save-browser'].disabled, true);
  assert.match(h.elements['browser-profile'].firstChild.textContent, /来源不可读取/);
  assert.doesNotMatch(h.elements['browser-profile'].firstChild.textContent, /尚无身份/);
  assert.match(allText(h.elements['connection-list']), /来源配置不可读取/);
  assert.equal(allNodes(h.elements['connection-list']).some(item => item.href === '/plugins/chrome-proxy-launcher/ui/index.html'), true);
});
test('身份删除、配置变化和旧任务未记录分别展示，任务检查不更改绑定', async () => {
  for (const bindingState of ['missing', 'changed', 'legacy_unbound']) {
    const source = browserFixture(); const frozen = { revision: 1, profile: { ...source.environments[0] }, configuredAt: '2026-10-25T01:10:00Z' };
    const old = operation({ task, status: 'accepted', ...(bindingState === 'legacy_unbound' ? {} : { browser: frozen }) });
    const inspected = { ...source, scope: 'operation', binding: bindingState === 'legacy_unbound' ? source.binding : frozen, bindingState };
    const h = await uiHarness({ operations: [old], operationBrowserStatus: inspected }); await h.app.inspectOperationBrowser(old.id);
    const text = allText(h.elements.operations);
    assert.match(text, bindingState === 'missing' ? /原身份已不存在/ : bindingState === 'changed' ? /保存时间已变化/ : /未记录浏览器绑定/);
    assert.deepEqual(h.calls.filter(item => item.body?.command === 'browser-status').at(-1).body.input, { operationId: old.id });
    assert.equal(h.calls.some(item => item.body?.command === 'bind-browser'), false);
  }
});
test('切换默认身份只改变后续任务，已有任务不套用新身份', async () => {
  const h = await uiHarness(); selectBrowser(h, 'profile-a'); await h.app.saveBrowserBinding();
  h.elements.cli.value = 'codex-exp'; await h.app.send({ preventDefault() {} });
  const frozen = structuredClone(h.app.state.operations[0].browser);
  selectBrowser(h, 'profile-b'); await h.app.saveBrowserBinding();
  assert.equal(h.app.state.browser.status.binding.profile.id, 'profile-b');
  assert.deepEqual(h.app.state.operations[0].browser, frozen);
  assert.equal(frozen.profile.id, 'profile-a');
});
test('绑定保存失败保留原绑定并标记待重新检测', async () => {
  const source = browserFixture(); source.binding = { revision: 1, profile: { ...source.environments[0] }, configuredAt: '2026-10-25T01:10:00Z' }; source.bindingState = 'bound';
  const h = await uiHarness({ browserStatus: source, rejectBinding: true }); selectBrowser(h, 'profile-b'); await h.app.saveBrowserBinding();
  assert.equal(h.app.state.browser.status.binding.profile.id, 'profile-a');
  assert.equal(h.app.state.browser.stale, true);
  assert.match(allText(h.elements['connection-list']), /原状态保留/);
  assert.equal(h.elements['save-browser'].disabled, true);
});
test('绑定已回执但读回失败单独提示待确认，不清空旧状态', async () => {
  const h = await uiHarness({ failBrowserReadAfterBind: true }); selectBrowser(h, 'profile-a'); await h.app.saveBrowserBinding();
  assert.equal(h.app.state.browser.status.binding.profile, null);
  assert.equal(h.browserData.binding.profile.id, 'profile-a');
  assert.equal(h.app.state.browser.stale, true);
  assert.match(h.elements.notice.textContent, /已收到绑定回执，待刷新确认/);
  assert.match(allText(h.elements['connection-list']), /上次观测，当前已失效/);
});
test('绑定保存期间阻止发任务和重复保存，纯读检测不启动浏览器', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const h = await uiHarness({ bindingGate: gate }); selectBrowser(h, 'profile-a'); h.elements.cli.value = 'codex-exp';
  const saving = h.app.saveBrowserBinding(); await settle();
  assert.equal(h.elements.send.disabled, true);
  await h.app.send({ preventDefault() {} }); await h.app.saveBrowserBinding();
  assert.equal(h.calls.some(item => item.body?.command === 'prepare-operation'), false);
  assert.equal(h.calls.filter(item => item.body?.command === 'bind-browser').length, 1);
  release(); await saving;
  assert.equal(h.elements.send.disabled, false);
});
test('未绑定仍能发提示词任务，冻结明确的空绑定', async () => {
  const h = await uiHarness(); h.elements.cli.value = 'codex-exp'; await h.app.send({ preventDefault() {} });
  assert.equal(h.app.state.operations[0].status, 'accepted');
  assert.deepEqual(h.app.state.operations[0].browser, { revision: 0, profile: null, configuredAt: null });
  assert.match(allText(h.elements.operations), /本次未绑定专用身份/);
});
test('刷新检测失败时保留上次观测并明确标成非最新', async () => {
  const options = {}; const h = await uiHarness(options); options.failBrowserRead = true; await h.app.refreshConnections();
  assert.equal(h.app.state.browser.status.environments.length, 2);
  assert.equal(h.app.state.browser.stale, true);
  assert.match(allText(h.elements['connection-list']), /检测失败，旧状态不能视为最新/);
  assert.match(allText(h.elements['connection-list']), /非最新/);
});
test('旧任务检查不能被默认身份冒充，身份名称按文本渲染', async () => {
  const source = browserFixture(); source.environments[0].name = '<img src=x onerror=alert(1)>';
  const inspected = { ...source, scope: 'operation', bindingState: 'bound' };
  const h = await uiHarness({ browserStatus: source, operations: [operation({ task, status: 'accepted' })], operationBrowserStatus: inspected });
  assert.equal(h.elements['browser-profile'].children.some(item => item.textContent.includes('<img')), true);
  assert.equal(allNodes(h.elements['browser-profile']).some(item => item.tagName === 'img'), false);
  await h.app.inspectOperationBrowser('op-1');
  assert.match(allText(h.elements.operations), /不能套用当前默认身份/);
});

function bridgeOptions(overrides = {}) {
  const browserStatus = browserFixture();
  browserStatus.binding = { revision: 1, profile: structuredClone(browserStatus.environments[0]), configuredAt: '2026-10-25T02:00:00Z' };
  browserStatus.bindingState = 'bound'; browserStatus.checks.find(check => check.id === 'bridge').status = 'available';
  return { browserStatus, operations: [operation({ task, status: 'accepted', browser: structuredClone(browserStatus.binding) })], ...overrides };
}
test('平台页面地址严格限定 HTTPS 白名单且不能泄漏查询、片段、凭据或端口', () => {
  for (const url of ['http://affiliate.tiktok.com/', 'https://affiliate.tiktok.com.evil.test/', 'https://evil.test/', 'https://user:secret@www.kalodata.com/', 'https://kalodata.com:8443/', 'https://www.kalodata.com/?token=secret', 'https://www.kalodata.com/#secret', 'https://www.kalodata.com/?', 'javascript:alert(1)']) assert.equal(safePlatformURL(url), null);
  assert.equal(safePlatformURL('https://affiliate.tiktok.com/creator', 'affiliate'), 'https://affiliate.tiktok.com/creator');
  assert.equal(safePlatformURL('https://www.kalodata.com/creator', 'affiliate'), null);
  assert.equal(safePlatformURL('https://kalodata.com/creator', 'kalodata'), 'https://kalodata.com/creator');
});
test('加载、刷新和连接探测均不会自动列页面或读取文字', async () => {
  const h = await uiHarness(bridgeOptions()); await h.app.refresh(); await h.app.refreshConnections();
  assert.equal(h.calls.some(item => ['browser-probe', 'browser-pages', 'browser-read-page'].includes(item.body?.command)), false);
  await h.app.probeBrowser();
  assert.deepEqual(h.calls.find(item => item.body?.command === 'browser-probe').body.input, {});
  assert.equal(h.app.state.browser.probe.data.profileId, 'profile-a');
  assert.equal(h.calls.some(item => ['browser-pages', 'browser-read-page'].includes(item.body?.command)), false);
  assert.match(allText(h.elements['connection-list']), /本次未读取页面，出口与平台字段尚未验证/);
});
test('连接探测拒绝错误身份与版本，失败后标记旧连接失效', async () => {
  const options = bridgeOptions(); const h = await uiHarness(options); await h.app.probeBrowser();
  for (const response of [{ profileId: 'other' }, { bindingRevision: 99 }, { scope: 'operation' }, { instanceId: '' }, { status: 'unknown' }]) {
    options.probeResponse = response; await h.app.probeBrowser();
    assert.equal(h.app.state.browser.probe.stale, true); assert.equal(h.app.state.browser.probe.data.profileId, 'profile-a');
    assert.match(allText(h.elements['connection-list']), /上次连接状态已过期/);
  }
});
test('切换默认绑定后页面读取仍携带旧任务身份与列表实例', async () => {
  const h = await uiHarness(bridgeOptions()); await h.app.probeBrowser(); selectBrowser(h, 'profile-b'); await h.app.saveBrowserBinding();
  assert.equal(h.app.state.browser.probe.stale, true);
  await h.app.loadBrowserPages('op-1'); await h.app.readBrowserPage('op-1');
  assert.deepEqual(h.calls.find(item => item.body?.command === 'browser-pages').body.input, { operationId: 'op-1', taskId: 'task-1' });
  assert.deepEqual(h.calls.find(item => item.body?.command === 'browser-read-page').body.input, { operationId: 'op-1', taskId: 'task-1', targetId: 'target-1', expectedInstanceId: 'instance-1' });
  assert.equal(h.app.state.pageReads.get('op-1').snapshot.profileId, 'profile-a');
  assert.equal(h.app.state.browser.status.binding.profile.id, 'profile-b');
  assert.equal(h.calls.some(item => item.body?.command === 'submit-result'), false);
});
test('页面列表与文字逐项核对任务归属、绑定、版本和平台地址', async () => {
  for (const response of [{ operationId: 'other' }, { taskId: 'other' }, { profileId: 'other' }, { bindingRevision: 99 }, { scope: 'default' }, { pages: [{ targetId: 'target-1', title: '错误页面', url: 'https://kalodata.com/?token=hidden', platform: 'kalodata' }] }]) {
    const h = await uiHarness(bridgeOptions({ pagesResponse: response })); await h.app.loadBrowserPages('op-1');
    assert.equal(h.app.state.pageReads.get('op-1').list, null); assert.equal(h.app.state.pageReads.get('op-1').listStale, true);
    assert.equal(allText(h.elements.operations).includes('token=hidden'), false);
  }
  for (const response of [{ operationId: 'other' }, { taskId: 'other' }, { profileId: 'other' }, { bindingRevision: 99 }]) {
    const h = await uiHarness(bridgeOptions({ pageResponse: response })); await h.app.loadBrowserPages('op-1'); await h.app.readBrowserPage('op-1');
    assert.equal(h.app.state.pageReads.get('op-1').snapshot, null); assert.equal(h.app.state.pageReads.get('op-1').listStale, true);
  }
});
test('实例重启后旧快照过期，重新列页面前不能再读', async () => {
  const options = bridgeOptions(); const h = await uiHarness(options); await h.app.loadBrowserPages('op-1'); await h.app.readBrowserPage('op-1');
  options.pageResponse = { instanceId: 'instance-restarted' }; await h.app.readBrowserPage('op-1');
  const current = h.app.state.pageReads.get('op-1'); assert.equal(current.snapshotStale, true); assert.equal(current.listStale, true);
  assert.match(allText(h.elements.operations), /实例已变化/); assert.match(allText(h.elements.operations), /已过期的页面文字/);
  const count = h.calls.length; await h.app.readBrowserPage('op-1'); assert.equal(h.calls.length, count);
  options.pageResponse = {}; await h.app.loadBrowserPages('op-1'); await h.app.readBrowserPage('op-1'); assert.equal(current.snapshotStale, false);
});
test('页面标题和文字作为不可信纯文本，截断状态可见且不会提交报告', async () => {
  const page = { targetId: 'target-1', title: '<img src=x onerror=alert(1)>', url: 'https://affiliate.tiktok.com/connection/creator', platform: 'affiliate', text: '<script>alert(1)</script>', truncated: true };
  const h = await uiHarness(bridgeOptions({ pageResponse: { page } })); await h.app.loadBrowserPages('op-1'); await h.app.readBrowserPage('op-1');
  assert.match(allText(h.elements.operations), /<script>alert\(1\)<\/script>/); assert.match(allText(h.elements.operations), /已截断，资料不完整/); assert.match(allText(h.elements.operations), /不可信资料/);
  assert.equal(allNodes(h.elements.operations).some(node => ['script', 'img'].includes(node.tagName)), false);
  assert.equal(h.calls.some(item => item.body?.command === 'submit-result'), false);
});
test('读取错误和重新列页均使旧快照过期，错误资料不能替换已知结果', async () => {
  const options = bridgeOptions(); const h = await uiHarness(options); await h.app.loadBrowserPages('op-1'); await h.app.readBrowserPage('op-1');
  const current = h.app.state.pageReads.get('op-1'); options.failBridge = true; await h.app.loadBrowserPages('op-1');
  assert.equal(current.listStale, true); assert.equal(current.snapshotStale, true); assert.equal(current.snapshot.instanceId, 'instance-1');
  options.failBridge = false; await h.app.loadBrowserPages('op-1'); assert.equal(current.snapshotStale, true);
});
test('只有任务编号及冻结身份齐全才允许读取，旧任务不借用默认绑定', async () => {
  for (const overrides of [{ task: null }, { browser: null }, { browser: { revision: 0, profile: null } }]) {
    const options = bridgeOptions(); Object.assign(options.operations[0], overrides); const h = await uiHarness(options);
    assert.equal(allNodes(h.elements.operations).find(node => node.textContent === '读取平台页面列表').disabled, true);
    await h.app.loadBrowserPages('op-1'); assert.equal(h.calls.some(item => item.body?.command === 'browser-pages'), false);
  }
});
test('无桥接能力的旧状态清楚提示需要升级', async () => {
  const h = await uiHarness(); assert.match(allText(h.elements['connection-list']), /只读桥接需要升级/);
  h.browserData.checks.find(check => check.id === 'bridge').status = 'probe_available'; await h.app.refreshConnections();
  assert.match(allText(h.elements['connection-list']), /可检测连接/);
  h.browserData.checks = h.browserData.checks.filter(check => check.id !== 'bridge'); await h.app.refreshConnections();
  assert.match(allText(h.elements['connection-list']), /只读桥接需要升级/);
});
test('快照拒绝超长文字、错误页面编号及页面切换', async () => {
  const valid = { targetId: 'target-1', title: '测试', url: 'https://affiliate.tiktok.com/connection/creator', platform: 'affiliate', text: '文字', truncated: false };
  for (const changed of [{ text: '字'.repeat(120001) }, { targetId: 'another' }, { url: 'https://affiliate.tiktok.com/other' }, { url: 'https://evil.test/' }]) {
    const h = await uiHarness(bridgeOptions({ pageResponse: { page: { ...valid, ...changed } } })); await h.app.loadBrowserPages('op-1'); await h.app.readBrowserPage('op-1');
    assert.equal(h.app.state.pageReads.get('op-1').snapshot, null);
  }
});
test('读取进行中阻止重复调用，探测期间不允许改绑', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const options = bridgeOptions({ bridgeGate: gate }); const h = await uiHarness(options);
  const probing = h.app.probeBrowser(); await settle(); selectBrowser(h, 'profile-b'); await h.app.saveBrowserBinding(); await h.app.probeBrowser();
  assert.equal(h.calls.filter(item => item.body?.command === 'browser-probe').length, 1); assert.equal(h.calls.some(item => item.body?.command === 'bind-browser'), false);
  release(); await probing;
});

test('选择结果文件只读预检，展示未知和未核验提示后才能显式保存', async () => {
  const record = resultRecord(); const input = resultInput(record); const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })], records: [record] });
  await h.app.importResult('op-1', resultFile(input));
  assert.deepEqual(h.calls.find(item => item.body?.command === 'validate-result').body.input, input);
  assert.equal(h.calls.some(item => item.body?.command === 'submit-result'), false);
  const text = allText(h.elements.operations); assert.match(text, /视频样本 328 条/); assert.match(text, /数值完整 0 位 · 资料未齐 1 位/); assert.match(text, /固定合作费/); assert.match(text, /来源与覆盖范围未核验/); assert.match(text, /不代表选人已通过/);
  const save = allNodes(h.elements.operations).find(node => node.textContent === '保存报告'); assert.equal(save.disabled, false);
  await h.app.saveResult('op-1'); assert.deepEqual(h.calls.find(item => item.body?.command === 'submit-result').body.input, input);
});
test('读取要求按原任务按需查询，来源职责和字段要求只作为文本展示', async () => {
  const options = { operations: [operation({ task, status: 'accepted' })] }; const h = await uiHarness(options);
  assert.equal(h.calls.some(item => item.body?.command === 'platform-contract'), false);
  await h.app.showPlatformContract('op-1');
  assert.deepEqual(h.calls.find(item => item.body?.command === 'platform-contract').body.input, { operationId: 'op-1', taskId: 'task-1' });
  assert.match(allText(h.elements.operations), /逐视频成交和佣金来源/); assert.match(allText(h.elements.operations), /回本计算必需/); assert.match(allText(h.elements.operations), /字段可读性尚未实测/);
  options.contractResponse = { sources: [{ id: 'confirmed_inputs', label: '确认资料', purpose: '补齐本次资料', requirements: ['connection', 'batch', 'cost'].map(scope => ({ id: scope, label: '核验要求', scope, requiredForRoi: true, note: '按本次任务核验' })), limitations: [] }] };
  await h.app.showPlatformContract('op-1'); assert.match(allText(h.elements.operations), /连接：按本次任务核验/); assert.match(allText(h.elements.operations), /本批次：按本次任务核验/); assert.match(allText(h.elements.operations), /成本资料：按本次任务核验/);
  options.contractResponse = { taskId: 'other-task' }; await h.app.showPlatformContract('op-1');
  assert.equal(h.app.state.results.get('op-1').requirements, null); assert.match(allText(h.elements.operations), /不属于当前任务/);
  assert.equal(h.calls.some(item => ['browser-read-page', 'browser-pages', 'submit-result'].includes(item.body?.command)), false);
});
test('预检拒绝跨操作任务结果和版本的回执，不允许保存', async () => {
  const record = resultRecord();
  for (const response of [{ operationId: 'other' }, { taskId: 'other' }, { resultId: 'other' }, { expectedRevision: 9 }, { currentRevision: 9, replay: false }, { canSubmit: false }, { canCollectPlatforms: true }, { adoptionStatus: 'adopted' }, { validation: { ...validationFixture(), sourceReview: { status: 'verified', message: '冒充来源已核验' } } }]) {
    const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })], records: [record], validationResponse: response });
    await h.app.importResult('op-1', resultFile(resultInput(record))); await h.app.saveResult('op-1');
    assert.equal(h.app.state.results.get('op-1').preview.validation, null); assert.equal(h.calls.some(item => item.body?.command === 'submit-result'), false);
  }
});
test('换文件立即清空旧预检，过期异步响应不能替换新文件', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const options = { operations: [operation({ task, status: 'accepted' })], validationGate: input => input.resultId === 'result-1' ? gate : Promise.resolve(), submittedRecord: resultRecord(2), records: [resultRecord(2)] };
  const h = await uiHarness(options); const first = h.app.importResult('op-1', resultFile(resultInput(resultRecord(1)))); await settle();
  const secondInput = resultInput(resultRecord(2)); await h.app.importResult('op-1', resultFile(secondInput));
  const preview = h.app.state.results.get('op-1').preview; assert.equal(preview.validation.resultId, 'result-2');
  release(); await first; assert.equal(preview.validation.resultId, 'result-2');
  await h.app.saveResult('op-1'); assert.deepEqual(h.calls.find(item => item.body?.command === 'submit-result').body.input, secondInput);
});
test('换成无效文件撤销前一份文件的保存资格', async () => {
  const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })], records: [resultRecord()] });
  await h.app.importResult('op-1', resultFile(resultInput(resultRecord())));
  await h.app.importResult('op-1', { name: 'wrong.json', size: 4, text: async () => '{bad' }); await h.app.saveResult('op-1');
  const preview = h.app.state.results.get('op-1').preview; assert.equal(preview.validation, null); assert.equal(preview.payload, null);
  assert.equal(h.calls.some(item => item.body?.command === 'submit-result'), false);
});
test('保存双击只提交一次且保存期间不能换文件', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const record = resultRecord();
  const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })], records: [record], submitGate: gate });
  await h.app.importResult('op-1', resultFile(resultInput(record))); const saving = h.app.saveResult('op-1'); await settle();
  await h.app.saveResult('op-1'); await h.app.importResult('op-1', resultFile(resultInput(resultRecord(2))));
  assert.equal(h.calls.filter(item => item.body?.command === 'submit-result').length, 1); assert.equal(h.calls.filter(item => item.body?.command === 'validate-result').length, 1);
  release(); await saving; await h.app.saveResult('op-1'); assert.equal(h.calls.filter(item => item.body?.command === 'submit-result').length, 1);
});
test('预检后版本冲突保留旧报告，必须重新预检且不改原编号或版本', async () => {
  const record = resultRecord(); const input = resultInput(record); const options = { operations: [operation({ task, status: 'accepted' })], records: [record], rejectResult: true };
  const h = await uiHarness(options); await h.app.loadResult('op-1'); await h.app.importResult('op-1', resultFile(input)); await h.app.saveResult('op-1');
  assert.equal(h.app.state.results.get('op-1').record.resultId, record.resultId); assert.equal(h.app.state.results.get('op-1').preview.stale, true);
  await h.app.saveResult('op-1'); assert.equal(h.calls.filter(item => item.body?.command === 'submit-result').length, 1);
  options.rejectValidation = true; await h.app.retryResultValidation('op-1');
  assert.deepEqual(h.calls.filter(item => item.body?.command === 'validate-result').at(-1).body.input, input);
  assert.equal(h.app.state.results.get('op-1').preview.validation, null); assert.match(allText(h.elements.operations), /版本已变化/);
});
test('提交回应未知后沿用原文件重新预检并以幂等重放恢复', async () => {
  const record = resultRecord(); const input = resultInput(record); const options = { operations: [operation({ task, status: 'accepted' })], records: [], submittedRecord: record, failSubmitUnknown: true };
  const h = await uiHarness(options); await h.app.importResult('op-1', resultFile(input)); await h.app.saveResult('op-1');
  options.failSubmitUnknown = false; options.records = [record]; await h.app.retryResultValidation('op-1');
  assert.equal(h.app.state.results.get('op-1').preview.validation.replay, true); assert.match(allText(h.elements.operations), /不新建或覆盖版本/);
  await h.app.saveResult('op-1'); assert.equal(h.app.state.results.get('op-1').preview.saved, true);
  assert.equal(h.calls.filter(item => item.body?.command === 'submit-result').every(item => JSON.stringify(item.body.input) === JSON.stringify(input)), true);
});
test('预检后刷新和查看历史不会自动保存，文件改变不影响缓存载荷', async () => {
  const older = resultRecord(); const latest = resultRecord(2); const input = resultInput(older); let reads = 0;
  const file = { name: 'result.json', size: 4000, text: async () => { reads++; return JSON.stringify(reads === 1 ? input : resultInput(latest)); } };
  const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })], records: [latest, older], submittedRecord: older });
  await h.app.importResult('op-1', file); await h.app.refresh(); await h.app.loadResult('op-1', older.resultId);
  assert.equal(h.calls.some(item => item.body?.command === 'submit-result'), false);
  await h.app.saveResult('op-1'); assert.equal(reads, 1); assert.deepEqual(h.calls.find(item => item.body?.command === 'submit-result').body.input, input);
});
test('保存回执必须匹配已预检结果和版本，异常不替换旧报告', async () => {
  for (const returned of [resultRecord(2), { ...resultRecord(), resultId: 'other-result' }, { ...resultRecord(), taskId: 'other-task' }]) {
    const record = resultRecord(); const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })], records: [record], submittedRecord: returned });
    await h.app.loadResult('op-1'); await h.app.importResult('op-1', resultFile(resultInput(record))); await h.app.saveResult('op-1');
    assert.equal(h.app.state.results.get('op-1').record.resultId, record.resultId); assert.equal(h.app.state.results.get('op-1').preview.saved, false); assert.equal(h.app.state.results.get('op-1').preview.stale, true);
  }
});
test('预检和保存摘要的来源文字保持纯文本，兼容没有摘要的旧报告', async () => {
  const validation = validationFixture(); validation.sourceReview.message = '<img src=x onerror=alert(1)>'; validation.checks[0].message = '<script>alert(1)</script>';
  validation.missingFields[0].fields.push('sales[0].gmv', 'sales[1].commissionRate', '其他未确认资料');
  const record = { ...resultRecord(), validation }; const h = await uiHarness({ operations: [operation({ task, status: 'accepted' })], records: [record], validationResponse: { validation } });
  await h.app.importResult('op-1', resultFile(resultInput(record))); await h.app.saveResult('op-1');
  assert.match(allText(h.elements.operations), /<img src=x/); assert.match(allText(h.elements.operations), /<script>alert/);
  assert.match(allText(h.elements.operations), /成交记录第 1 项 · 成交额/); assert.match(allText(h.elements.operations), /成交记录第 2 项 · 佣金率/); assert.match(allText(h.elements.operations), /其他未确认资料/);
  assert.equal(allNodes(h.elements.operations).some(node => ['script', 'img'].includes(node.tagName)), false);
});
