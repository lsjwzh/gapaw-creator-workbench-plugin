(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.addEventListener('DOMContentLoaded', () => api.mount(root.document, root));
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const PLUGIN_ID = 'gapaw-creator-workbench';
  const DRAFT_KEY = PLUGIN_ID + ':draft:v1';
  const PENDING_KEY = PLUGIN_ID + ':pending:v1';

  function safeTaskURL(value, origin, taskId) {
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || url.pathname !== '/air' || url.username || url.password) return null;
      if (taskId && url.searchParams.get('task') !== taskId) return null;
      return url.pathname + url.search;
    } catch (_) { return null; }
  }
  function safePluginURL(value, origin, pluginId) {
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || !url.pathname.startsWith('/plugins/' + encodeURIComponent(pluginId) + '/') || url.username || url.password) return null;
      return url.pathname + url.search;
    } catch (_) { return null; }
  }
  function createClient(fetcher) {
    async function request(path, body) {
      const options = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
      if (body !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
      let response;
      try { response = await fetcher(path, options); }
      catch (_) { throw new Error('网络连接失败。恢复连接后可重试，原任务编号会保留。'); }
      let value;
      try { value = await response.json(); }
      catch (_) { throw new Error('宿主返回了无法读取的内容，请确认已登录 MultiCC。'); }
      if (!response.ok || value?.ok === false) {
        const detail = typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message;
        const error = new Error(detail || '请求未成功（' + response.status + '）');
        error.status = response.status;
        for (const key of ['receiptId', 'taskId', 'notDelivered']) if (value?.[key] !== undefined) error[key] = value[key];
        throw error;
      }
      return value;
    }
    return { request, run: (command, input = {}) => request('/api/plugins/' + PLUGIN_ID + '/run', { command, input }) };
  }
  function completed(operation) { return operation.status === 'accepted'; }
  function createDispatcher(client) {
    const active = new Set();
    async function verifyWorkspace(operation) {
      const directories = await client.request('/api/directories');
      if (!Array.isArray(directories)) throw new Error('无法核对任务的原工作目录，请稍后重试。');
      const directory = directories.find(item => item.id === operation.workspace.dirId);
      if (!directory || directory.path !== operation.workspace.path) throw new Error('原工作目录已删除或改绑，已停止投递。请在宿主恢复原目录绑定后重试，或另发新任务。');
    }
    async function deliverMessage(operation) {
      const shellPath = '/api/task-shells/' + encodeURIComponent(operation.task.shellId);
      const shell = await client.request(shellPath);
      if (!Array.isArray(shell?.receipts)) throw new Error('无法读取原任务回执，已停止投递，请稍后重试。');
      const receipt = shell.receipts.find(item => item.clientMsgId === operation.dispatch.message.clientMsgId);
      if (receipt) {
        if (receipt.taskId !== operation.task.taskId) throw new Error('回执与原任务身份不一致，已停止投递。');
        if (receipt.status === 'accepted') return { taskId: receipt.taskId, receiptId: receipt.id };
        if (['failed', 'rejected'].includes(receipt.status)) return client.request(shellPath + '/receipts/' + encodeURIComponent(receipt.id) + '/retry', {});
        const error = new Error('原消息仍在等待宿主确认，尚不能标记已投递。稍后点击重试会重新检查回执。');
        error.receiptId = receipt.id; error.taskId = receipt.taskId; error.notDelivered = false; throw error;
      }
      if (operation.error?.receiptId) {
        if (operation.error.taskId && operation.error.taskId !== operation.task.taskId) throw new Error('保存的失败回执与原任务不一致，已停止投递。');
        return client.request(shellPath + '/receipts/' + encodeURIComponent(operation.error.receiptId) + '/retry', {});
      }
      return client.request('/api/task-shell-tasks/' + encodeURIComponent(operation.task.taskId) + '/messages', operation.dispatch.message);
    }
    async function dispatch(operation, onUpdate = () => {}) {
      if (active.has(operation.id)) throw new Error('这条任务正在发送，请等待当前请求完成。');
      if (completed(operation)) return operation;
      active.add(operation.id);
      let stage = operation.task?.taskId ? 'message' : 'create';
      try {
        if (!operation.task?.taskId) {
          await verifyWorkspace(operation);
          const response = await client.request('/api/air/tasks', operation.dispatch.create);
          const saved = await client.run('record-dispatch', { operationId: operation.id, stage: 'created', response });
          if (!saved.operation?.task?.taskId) throw new Error('任务创建结果未能持久保存；请重试恢复记录。');
          operation = saved.operation;
          onUpdate(operation);
        }
        stage = 'message';
        await verifyWorkspace(operation);
        const response = await deliverMessage(operation);
        const saved = await client.run('record-dispatch', { operationId: operation.id, stage: 'sent', response });
        if (!saved.operation || !completed(saved.operation)) throw new Error('投递回执未能持久保存；请重试恢复记录。');
        operation = saved.operation;
        onUpdate(operation);
        return operation;
      } catch (error) {
        try {
          const input = { operationId: operation.id, stage, message: error.message };
          if (stage === 'message' && error.receiptId && error.taskId && typeof error.notDelivered === 'boolean') {
            for (const key of ['receiptId', 'taskId', 'notDelivered']) input[key] = error[key];
          }
          const saved = await client.run('record-error', input);
          if (saved.operation) onUpdate(saved.operation);
        } catch (_) { /* 保存失败不授权进入下一阶段；界面保留原操作供幂等重试。 */ }
        throw error;
      } finally { active.delete(operation.id); }
    }
    return { dispatch, active };
  }
  function mount(document, window) {
    const $ = id => document.getElementById(id);
    const client = createClient(window.fetch.bind(window));
    const dispatcher = createDispatcher(client);
    const state = { status: null, operations: [], directories: [], busy: false, loading: false, initialized: false, pending: null };
    function readStorage(key) { try { return JSON.parse(window.localStorage.getItem(key)); } catch (_) { return null; } }
    function writeStorage(key, value) { try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } }
    function announce(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'notice error' : 'notice'; }
    function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
    function link(text, href) { const node = element('a', text); node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node; }
    function workspaceReady() { return !!(state.status?.workspace && state.status.workspace.valid !== false); }
    function controls() {
      $('send').disabled = state.busy || state.loading || !workspaceReady();
      $('send').textContent = state.busy ? '正在保存与投递…' : state.pending ? '重试发送到 MultiCC' : '发送到 MultiCC';
      $('refresh').disabled = state.busy || state.loading;
      $('save-workspace').disabled = state.busy || state.loading || !!state.pending || !$('directory').value;
      for (const id of ['prompt', 'cli', 'model', 'restore-template', 'directory']) $(id).disabled = state.busy || state.loading || !!state.pending;
    }
    function putOperation(operation) {
      const at = state.operations.findIndex(item => item.id === operation.id);
      if (at < 0) state.operations.unshift(operation); else state.operations[at] = operation;
      renderOperations();
    }
    function renderOperations() {
      const list = $('operations'); list.replaceChildren();
      $('history-count').textContent = state.operations.length ? state.operations.length + ' 条记录' : '';
      if (!state.operations.length) { list.append(element('p', '还没有发起任务。发送后，这里会保留任务入口和每次使用的提示词。', 'empty')); return; }
      for (const operation of state.operations) {
        const card = element('article', undefined, 'operation');
        const head = element('div', undefined, 'operation-head');
        head.append(element('h3', operation.dispatch?.create?.title || '按回本率选择达人'));
        head.append(element('span', completed(operation) ? '已投递' : operation.error ? '待重试' : operation.task ? '待投递消息' : '待创建任务', 'tag' + (completed(operation) ? '' : ' warn')));
        const meta = element('div', undefined, 'operation-meta');
        const date = new Date(operation.createdAt);
        meta.append(element('span', Number.isNaN(date.getTime()) ? '时间暂不可用' : date.toLocaleString('zh-CN')));
        meta.append(element('span', operation.runtime?.cli || '执行工具未知'));
        meta.append(element('span', operation.workspace?.path || '目录信息不可用', 'path'));
        card.append(head, meta);
        card.append(element('p', completed(operation) ? '消息已交给 MultiCC。具体执行进度与需要补充的信息，请进入原任务查看。' : '自动投递尚未完成；刷新页面不会自动发送，请点击重试继续原操作。', 'operation-description'));
        if (operation.error) card.append(element('p', typeof operation.error === 'string' ? operation.error : operation.error.message || '上次投递失败', 'operation-error'));
        const actions = element('div', undefined, 'operation-actions');
        if (operation.task?.taskId) {
          const taskURL = safeTaskURL(operation.task.url || '/air?task=' + encodeURIComponent(operation.task.taskId), window.location.origin, operation.task.taskId);
          if (taskURL) actions.append(link('进入原任务继续 ↗', taskURL));
        }
        if (!completed(operation)) {
          const retry = element('button', dispatcher.active.has(operation.id) ? '正在重试…' : '重试投递', 'secondary'); retry.type = 'button'; retry.disabled = state.busy || dispatcher.active.has(operation.id);
          retry.addEventListener('click', () => retryOperation(operation.id)); actions.append(retry);
        }
        card.append(actions);
        const details = element('details'); details.append(element('summary', '查看本次提示词快照'), element('pre', operation.prompt || '', 'snapshot')); card.append(details);
        list.append(card);
      }
    }
    async function retryOperation(id) {
      if (state.busy) return;
      const operation = state.operations.find(item => item.id === id); if (!operation) return;
      state.busy = true; controls(); renderOperations(); announce('正在继续原操作，沿用已有任务与消息编号…');
      try { await dispatcher.dispatch(operation, putOperation); announce('任务已投递。请进入原任务查看执行进度。'); }
      catch (error) { announce(error.message, true); }
      finally { state.busy = false; controls(); renderOperations(); }
    }
    function saveDraft() { writeStorage(DRAFT_KEY, { prompt: $('prompt').value, cli: $('cli').value, model: $('model').value }); }
    async function send(event) {
      event.preventDefault();
      if (state.busy || state.loading || !workspaceReady()) return;
      const prompt = $('prompt').value.trim(); const cli = $('cli').value;
      if (!prompt) { announce('请先填写任务内容。', true); return; }
      if (!cli) { announce('请明确选择执行工具。', true); return; }
      state.busy = true; controls(); renderOperations(); announce('正在持久保存任务内容…');
      try {
        if (!state.pending) {
          const runtime = { cli }; if ($('model').value.trim()) runtime.model = $('model').value.trim();
          state.pending = { requestId: window.crypto.randomUUID(), prompt, runtime };
          if (!writeStorage(PENDING_KEY, state.pending)) { state.pending = null; throw new Error('浏览器无法保存重试编号。请允许本站本地存储后再发送。'); }
        }
        const saved = await client.run('prepare-operation', state.pending);
        if (!saved.operation?.id) throw new Error('插件没有返回持久操作编号，请重试。');
        putOperation(saved.operation);
        state.pending = null; writeStorage(PENDING_KEY, null);
        announce('内容已保存，正在创建任务并投递首条消息…');
        await dispatcher.dispatch(saved.operation, putOperation);
        announce('任务已投递。请进入原任务查看执行进度。');
      } catch (error) {
        if (state.pending && error.status === 400) {
          state.pending = null;
          writeStorage(PENDING_KEY, null);
          announce(error.message + ' 请修改任务内容后重新发送。', true);
        } else announce(error.message, true);
      }
      finally { state.busy = false; controls(); renderOperations(); }
    }
    async function loadDirectories() {
      const select = $('directory'); select.replaceChildren(element('option', '请选择已登记的目录')); select.firstChild.value = '';
      const directories = await client.request('/api/directories');
      if (!Array.isArray(directories)) throw new Error('宿主目录列表格式不兼容，请到 MultiCC 管理页检查目录。');
      state.directories = directories.filter(item => item && typeof item.id === 'string' && typeof item.path === 'string');
      for (const directory of state.directories) { const option = element('option', (directory.name || directory.path) + ' · ' + directory.path); option.value = directory.id; select.append(option); }
      if (state.status?.workspace?.dirId) select.value = state.status.workspace.dirId;
    }
    function hostManaged(workspace) { return workspace && ['host', 'host-env', 'environment', 'env', 'host_environment'].includes(workspace.source); }
    async function refresh() {
      if (state.busy || state.loading) return;
      state.loading = true; controls(); announce('正在读取插件配置和任务记录…');
      try {
        const status = await client.run('status');
        if (!status?.plugin || !Array.isArray(status.operations)) throw new Error('插件返回的状态格式不兼容。');
        state.status = status; state.operations = status.operations;
        const workspace = status.workspace;
        $('workspace-path').textContent = workspace?.path || '尚未配置专属目录';
        $('workspace-description').textContent = hostManaged(workspace) ? '此目录由 MultiCC 宿主管理。' : workspaceReady() ? '新任务将归属此目录；历史任务继续使用原目录。' : '先选择已登记的持久目录，再发起任务。';
        $('host-workspace').hidden = !hostManaged(workspace);
        $('workspace-picker').hidden = !!hostManaged(workspace);
        if (!state.initialized) {
          const draft = readStorage(DRAFT_KEY); const pending = readStorage(PENDING_KEY);
          state.pending = pending && typeof pending.requestId === 'string' && typeof pending.prompt === 'string' && pending.runtime?.cli ? pending : null;
          $('prompt').value = state.pending?.prompt ?? draft?.prompt ?? status.template?.text ?? '';
          $('cli').value = state.pending?.runtime.cli ?? draft?.cli ?? '';
          $('model').value = state.pending?.runtime.model ?? draft?.model ?? '';
          state.initialized = true;
        }
        renderOperations();
        if (!hostManaged(workspace)) await loadDirectories();
        announce(workspace?.valid === false ? workspace.error || '专属目录目前不可用，请重新配置。' : state.pending ? '上次发送尚未确认。点击重试会沿用原编号和原内容。' : workspaceReady() ? '配置已读取，可以编辑提示词并发起任务。' : '请先选择专属工作目录。', workspace?.valid === false);
      } catch (error) { announce(error.message, true); }
      finally { state.loading = false; controls(); }
    }
    async function configure() {
      if (state.busy || state.loading) return;
      const directory = state.directories.find(item => item.id === $('directory').value); if (!directory) return;
      state.busy = true; controls();
      try { await client.run('configure', { workspace: { dirId: directory.id, path: directory.path } }); state.busy = false; await refresh(); }
      catch (error) { announce(error.message, true); }
      finally { state.busy = false; controls(); }
    }
    async function refreshConnections() {
      const container = $('connection-list'); $('refresh-connections').disabled = true;
      container.replaceChildren(element('p', '正在读取已安装插件…', 'hint'));
      try {
        const response = await client.request('/api/plugins');
        const plugins = Array.isArray(response) ? response : response?.plugins;
        if (!Array.isArray(plugins)) throw new Error('插件清单格式不兼容');
        const chrome = plugins.find(item => item.id === 'chrome-proxy-launcher');
        container.replaceChildren();
        const row = element('div', undefined, 'connection'); const top = element('div', undefined, 'connection-top');
        top.append(element('strong', 'Chrome 出口隔离'), element('span', chrome ? '已安装' : '未发现', 'tag' + (chrome ? '' : ' warn'))); row.append(top);
        row.append(element('p', chrome ? '复用现有插件配置独立身份与出口；运行及连接状态尚未检测。' : '请到 MultiCC 插件管理中安装 Chrome 出口隔离插件。'));
        const url = chrome && safePluginURL(chrome.uiUrl || chrome.ui?.url || (typeof chrome.ui === 'string' ? chrome.ui : ''), window.location.origin, chrome.id);
        row.append(link(chrome && url ? '打开 Chrome 配置 ↗' : '前往插件管理 ↗', url || '/manage')); container.append(row);
        for (const [name, detail] of [['TikTok Affiliate', '账号登录与平台数据读取尚未接入。'], ['Kalodata', '订阅权限与平台数据读取尚未接入。'], ['浏览器自动化桥接', '出口正常不代表可读取平台；桥接能力尚未接入。']]) {
          const item = element('div', undefined, 'connection'); const heading = element('div', undefined, 'connection-top'); heading.append(element('strong', name), element('span', '待接入', 'tag warn')); item.append(heading, element('p', detail)); container.append(item);
        }
      } catch (error) { container.replaceChildren(element('p', '连接清单读取失败：' + error.message, 'operation-error')); }
      finally { $('refresh-connections').disabled = false; }
    }
    $('task-form').addEventListener('submit', send);
    $('refresh').addEventListener('click', refresh);
    $('save-workspace').addEventListener('click', configure);
    $('directory').addEventListener('change', controls);
    $('refresh-connections').addEventListener('click', refreshConnections);
    for (const id of ['prompt', 'cli', 'model']) $(id).addEventListener('input', saveDraft);
    $('restore-template').addEventListener('click', () => { if (state.pending || !state.status?.template?.text) return; if ($('prompt').value && !window.confirm('恢复示例会替换当前尚未发送的内容，是否继续？')) return; $('prompt').value = state.status.template.text; saveDraft(); });
    refresh(); refreshConnections();
    return { state, refresh, send, configure, retryOperation, refreshConnections };
  }
  return { createClient, createDispatcher, safeTaskURL, safePluginURL, completed, mount };
}));
