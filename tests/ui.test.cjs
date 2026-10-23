const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, createDispatcher, safeTaskURL, safePluginURL, mount } = require('../ui/app.js');

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
  const ids = ['notice','send','refresh','save-workspace','directory','prompt','cli','model','restore-template','operations','history-count','workspace-path','workspace-description','host-workspace','workspace-picker','connection-list','refresh-connections','task-form'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const document = { getElementById: id => elements[id], createElement: tag => new Element(tag) };
  const data = new Map(); const calls = []; let prepared = null; let count = 0;
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { if (options.failStorage) throw new Error('不可用'); data.set(key, value); }, removeItem: key => data.delete(key) };
  const workspace = options.workspace === undefined ? { dirId: 'dir-1', path: '/运营', valid: true, source: 'plugin' } : options.workspace;
  const window = { location: { origin: 'https://multicc.test' }, crypto: { randomUUID: () => 'uuid-' + (++count) }, localStorage: storage, confirm: () => true,
    fetch: async (path, request) => {
      const body = request.body ? JSON.parse(request.body) : null; calls.push({ path, body }); let value;
      if (path === '/api/directories') value = [{ id: 'dir-1', name: '运营', path: '/运营' }];
      else if (path === '/api/plugins') value = { plugins: [{ id: 'chrome-proxy-launcher', ui: '/plugins/chrome-proxy-launcher/ui/index.html' }] };
      else if (path === '/api/task-shells/shell-1') value = { receipts: [] };
      else if (body?.command === 'status') value = { plugin: { id: 'gapaw-creator-workbench', version: '0.1.0' }, workspace, template: { version: '1', text: '严格大于零的新视频数 / 同期新视频总数' }, operations: options.operations || (prepared ? [prepared] : []) };
      else if (body?.command === 'prepare-operation') {
        if (options.failPrepare) throw new Error('断网');
        if (options.rejectPrepare) return { ok: false, status: 400, json: async () => ({ error: '任务内容不符合输入要求' }) };
        prepared = operation({ requestId: body.input.requestId, prompt: body.input.prompt, runtime: body.input.runtime }); value = { operation: prepared };
      } else if (path === '/api/air/tasks') value = { ok: true, ...task };
      else if (path.endsWith('/messages')) value = { ok: true, taskId: 'task-1', receiptId: 'receipt-1' };
      else if (body?.command === 'record-dispatch') { prepared = { ...prepared, task, status: body.input.stage === 'sent' ? 'accepted' : 'task_created' }; value = { operation: prepared }; }
      else if (body?.command === 'record-error') value = { operation: prepared };
      else if (body?.command === 'configure') value = { workspace: body.input.workspace };
      else throw new Error('未预期请求 ' + path);
      return { ok: true, status: 200, json: async () => value };
    }
  };
  const app = mount(document, window); await settle();
  return { app, elements, calls, data, options };
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
  assert.equal(nodes.some(x => x.tagName === 'a'), false);
});
test('连接状态只读取插件清单，不调用可能包含凭据的 Chrome list 命令', async () => {
  const h = await uiHarness();
  assert.equal(h.calls.filter(x => x.path.includes('chrome-proxy-launcher/run')).length, 0);
  const visit = node => [node, ...node.children.flatMap(visit)];
  assert.equal(visit(h.elements['connection-list']).some(x => x.href === '/plugins/chrome-proxy-launcher/ui/index.html'), true);
});
