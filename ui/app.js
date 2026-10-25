(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./data-workflow.js') : root.GapawDataWorkflow);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.addEventListener('DOMContentLoaded', () => api.mount(root.document, root));
}(typeof window === 'undefined' ? globalThis : window, function (Workflow) {
  'use strict';
  const PLUGIN_ID = 'gapaw-creator-workbench';
  const DRAFT_KEY = PLUGIN_ID + ':draft:v1';
  const PENDING_KEY = PLUGIN_ID + ':pending:v1';
  const RESULT_LIMIT = 1024 * 1024;
  const PAGE_TEXT_LIMIT = 120000;

  function safePlatformURL(value, platform) {
    try {
      if (typeof value !== 'string' || /[?#]/.test(value)) return null;
      const url = new URL(value);
      const expected = url.hostname === 'affiliate.tiktok.com' ? 'affiliate' : ['www.kalodata.com', 'kalodata.com'].includes(url.hostname) ? 'kalodata' : null;
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && expected && (!platform || expected === platform) ? url.href : null;
    } catch (_) { return null; }
  }

  function safeSourceURL(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch (_) { return null; }
  }
  function formatRate(value) {
    if (value === null || value === undefined || value === '') return '未知';
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) return '未知';
    if (/[1-9]/.test(String(value).split(/[eE]/)[0]) && number * 100 < 0.0001) return '<0.0001%';
    return (number * 100).toFixed(4) + '%';
  }
  function formatContributionRate(value) {
    if (value === null || value === undefined || value === '') return '未知';
    const number = Number(value);
    if (!Number.isFinite(number) || number > 1) return '未知';
    if (String(value).startsWith('-') && /[1-9]/.test(String(value).split(/[eE]/)[0])) {
      return Math.abs(number) * 100 < 0.0001 ? '>-0.0001% 且 <0%' : (number * 100).toFixed(4) + '%';
    }
    return formatRate(value);
  }
  async function parseResultFile(file, operation) {
    if (!file || !/\.json$/i.test(file.name || '')) throw new Error('请选择 JSON 格式的结果文件。');
    if (!Number.isFinite(file.size) || file.size > RESULT_LIMIT) throw new Error('结果文件不能超过 1 MiB。');
    const text = await file.text();
    if (new TextEncoder().encode(text).length > RESULT_LIMIT) throw new Error('结果文件不能超过 1 MiB。');
    let input;
    try { input = JSON.parse(text); } catch (_) { throw new Error('文件不是有效的 JSON，请返回原任务修正结果文件。'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('结果文件需要包含完整提交对象。');
    if (input.operationId !== operation.id || input.taskId !== operation.task?.taskId) throw new Error('结果文件不属于当前任务，已停止导入。请从对应的原任务获取结果。');
    if (typeof input.resultId !== 'string' || !input.resultId || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !input.report || typeof input.report !== 'object') throw new Error('结果文件缺少结果编号、版本或报告，请返回原任务修正。');
    return input;
  }

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
      if (typeof value !== 'string' || !value) return null;
      const url = new URL(value, origin + '/plugins/' + encodeURIComponent(pluginId) + '/');
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
    const state = { status: null, operations: [], directories: [], busy: false, loading: false, initialized: false, pending: null, results: new Map(), browser: { status: null, loading: false, saving: false, error: '', stale: false, selectedId: '', chromeURL: '/manage', probe: { loading: false, data: null, error: '', stale: false } }, operationBrowsers: new Map(), pageReads: new Map() };
    const workflow = Workflow.create(document, window, client, id => state.operations.find(item => item.id === id), renderOperations);
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
      browserControls();
    }
    function browserControls() {
      const browser = state.browser; const status = browser.status;
      const available = status?.source?.installed && status.source.supported && status.source.available && status.bindingState !== 'unavailable' && !browser.stale;
      const locked = state.busy || browser.loading || browser.saving || browser.probe.loading || !!state.pending;
      $('browser-profile').disabled = locked || !available;
      $('save-browser').disabled = locked || !available || !browser.selectedId;
      $('unbind-browser').disabled = locked || !status?.binding?.profile || browser.stale;
      $('refresh-connections').disabled = browser.loading || browser.saving || browser.probe.loading;
      $('probe-browser').disabled = locked || browser.stale || !status?.binding?.profile;
      $('probe-browser').textContent = browser.probe.loading ? '正在检测连接…' : '检测只读连接';
    }
    function putOperation(operation) {
      const at = state.operations.findIndex(item => item.id === operation.id);
      if (at < 0) state.operations.unshift(operation); else state.operations[at] = operation;
      renderOperations();
    }
    function resultState(id) {
      if (!state.results.has(id)) state.results.set(id, { open: false, loading: false, record: null, history: [], error: '', template: null, requirements: null, requirementsLoading: false, requirementsError: '', preview: { generation: 0, loading: false, payload: null, validation: null, error: '', stale: false, saved: false, fileName: '' } });
      return state.results.get(id);
    }
    function resultOperation(id) {
      const operation = state.operations.find(item => item.id === id);
      if (!operation?.task?.taskId) throw new Error('请先创建对应的 MultiCC 任务。');
      return operation;
    }
    function verifyRecord(record, operation) {
      if (record && (record.operationId !== operation.id || record.taskId !== operation.task.taskId)) throw new Error('宿主返回的报告不属于当前任务，已停止显示。');
    }
    async function loadResult(id, resultId) {
      const current = resultState(id); if (current.loading) return;
      current.loading = true; current.open = true; current.error = ''; renderOperations();
      try {
        const operation = resultOperation(id);
        const input = { operationId: id }; if (resultId) input.resultId = resultId;
        const response = await client.run('get-result', input);
        if (!response || !Object.hasOwn(response, 'record') || !Array.isArray(response.history)) throw new Error('报告返回格式不兼容。');
        verifyRecord(response.record, operation);
        current.record = response.record; current.history = response.history;
        if (!resultId) operation.resultSummary = response.record ? response.history.find(item => item.resultId === response.record.resultId) || operation.resultSummary : null;
      } catch (error) { current.error = error.message; }
      finally { current.loading = false; renderOperations(); }
    }
    async function importResult(id, file) {
      const current = resultState(id); if (current.loading || !file) return;
      const preview = current.preview; const generation = ++preview.generation;
      Object.assign(preview, { loading: true, payload: null, validation: null, error: '', stale: false, saved: false, fileName: file.name || '结果文件' });
      current.open = true; current.error = ''; renderOperations();
      try {
        const operation = resultOperation(id);
        const input = await parseResultFile(file, operation);
        if (generation !== preview.generation) return;
        preview.payload = JSON.stringify(input);
        await preflightResult(id, generation);
      } catch (error) { if (generation === preview.generation) preview.error = error.message + ' 已有报告会保留；请回到原任务修正后重新选择文件。'; }
      finally { if (generation === preview.generation) { preview.loading = false; renderOperations(); } }
    }
    function verifyValidation(data, input) {
      if (!data || ['operationId', 'taskId', 'resultId', 'expectedRevision'].some(key => data[key] !== input[key])) throw new Error('预检回执不属于本次文件、任务或版本，已停止保存。');
      if (data.canSubmit !== true || typeof data.replay !== 'boolean' || !Number.isSafeInteger(data.currentRevision) || data.currentRevision < 0 || (!data.replay && data.currentRevision !== input.expectedRevision) || data.canCollectPlatforms !== false || data.adoptionStatus !== 'pending') throw new Error('预检状态或版本不兼容，请重新预检。');
      const validation = data.validation;
      if (!validation || !['candidateCount', 'totalVideos', 'completeCandidates', 'incompleteCandidates', 'knownPositiveVideos'].every(key => Number.isSafeInteger(validation[key]) && validation[key] >= 0) || !Array.isArray(validation.checks) || !Array.isArray(validation.missingFields) || validation.sourceReview?.status !== 'unverified' || typeof validation.sourceReview.message !== 'string' || !Array.isArray(data.computed?.candidates)) throw new Error('预检摘要格式不兼容，请更新插件后重试。');
      if (!validation.checks.every(check => typeof check.label === 'string' && typeof check.message === 'string' && ['passed', 'unknown', 'warning'].includes(check.status)) || !validation.missingFields.every(item => typeof item.creatorKey === 'string' && Array.isArray(item.fields) && item.fields.every(field => typeof field === 'string'))) throw new Error('预检缺项说明格式不兼容，请更新插件后重试。');
    }
    async function preflightResult(id, generation) {
      const current = resultState(id); const preview = current.preview;
      const input = JSON.parse(preview.payload); const operation = resultOperation(id);
      if (input.operationId !== operation.id || input.taskId !== operation.task.taskId) throw new Error('待预检文件已不属于当前任务，请重新选择原任务文件。');
      const data = await client.run('validate-result', input);
      if (generation !== preview.generation) return;
      verifyValidation(data, input); preview.validation = data; preview.stale = false;
    }
    async function retryResultValidation(id) {
      const current = resultState(id); const preview = current.preview;
      if (current.loading || preview.loading || !preview.payload || preview.saved) return;
      const generation = ++preview.generation; preview.loading = true; preview.validation = null; preview.error = ''; current.error = ''; renderOperations();
      try { await preflightResult(id, generation); }
      catch (error) { if (generation === preview.generation) { preview.error = error.message; preview.stale = true; } }
      finally { if (generation === preview.generation) { preview.loading = false; renderOperations(); } }
    }
    async function saveResult(id) {
      const current = resultState(id); const preview = current.preview;
      if (current.loading || preview.loading || preview.stale || preview.saved || !preview.payload || !preview.validation) return;
      current.loading = true; current.open = true; current.error = ''; renderOperations();
      try {
        const operation = resultOperation(id); const input = JSON.parse(preview.payload);
        if (input.operationId !== operation.id || input.taskId !== operation.task.taskId) throw new Error('预检文件不属于当前任务，请重新选择文件。');
        verifyValidation(preview.validation, input);
        const response = await client.run('submit-result', input);
        if (!response?.record || !response.resultSummary) throw new Error('报告保存回执不完整。请使用原文件重试确认结果。');
        verifyRecord(response.record, operation);
        if (response.record.resultId !== input.resultId || response.record.revision !== input.expectedRevision + 1 || response.resultSummary.resultId !== input.resultId || response.resultSummary.revision !== response.record.revision) throw new Error('报告保存回执与本次文件或版本不一致，请刷新确认。');
        preview.saved = true;
        try {
          const latest = await client.run('get-result', { operationId: id });
          if (!latest?.record || !Array.isArray(latest.history)) throw new Error('暂未读到已保存的报告。');
          verifyRecord(latest.record, operation);
          const latestSummary = latest.history.find(item => item.resultId === latest.record.resultId);
          if (!latestSummary) throw new Error('最新报告的版本信息暂不可用。');
          current.record = latest.record; current.history = latest.history;
          operation.resultSummary = latestSummary;
          announce('已保存报告，待采纳。本次回执为第 ' + response.record.revision + ' 版，当前最新为第 ' + latest.record.revision + ' 版；正式达人业务库尚未回写。');
        } catch (error) {
          current.error = '已收到保存回执（第 ' + response.record.revision + ' 版），待刷新确认：' + error.message;
          announce(current.error, true);
        }
      } catch (error) { preview.stale = true; current.error = error.message + ' 已有报告会保留，请重新预检后再保存；不会自动改写文件中的结果编号或版本。'; }
      finally { current.loading = false; renderOperations(); }
    }
    async function showPlatformContract(id) {
      const current = resultState(id); if (current.requirementsLoading) return;
      current.requirementsLoading = true; current.requirementsError = ''; renderOperations();
      try {
        const operation = resultOperation(id);
        const data = await client.run('platform-contract', { operationId: id, taskId: operation.task.taskId });
        if (data?.operationId !== id || data.taskId !== operation.task.taskId || data.contractVersion !== 'platform-fields-v1' || data.canCollectPlatforms !== false || !Array.isArray(data.sources) || !Array.isArray(data.notes)) throw new Error('读取要求不属于当前任务或格式不兼容，已停止展示。');
        if (!data.sources.every(source => ['affiliate', 'kalodata', 'confirmed_inputs'].includes(source.id) && typeof source.label === 'string' && typeof source.purpose === 'string' && Array.isArray(source.requirements) && Array.isArray(source.limitations) && source.requirements.every(item => typeof item.label === 'string' && typeof item.scope === 'string' && typeof item.requiredForRoi === 'boolean' && typeof item.note === 'string'))) throw new Error('平台读取要求格式不兼容，请更新插件。');
        current.requirements = data;
      } catch (error) { current.requirements = null; current.requirementsError = error.message; }
      finally { current.requirementsLoading = false; renderOperations(); }
    }
    async function showResultContract(id) {
      const current = resultState(id); if (current.loading) return;
      current.loading = true; current.open = true; current.error = ''; renderOperations();
      try {
        const operation = resultOperation(id);
        const contract = await client.run('result-contract', { operationId: id });
        if (contract.taskId !== operation.task.taskId || !contract.submissionTemplate) throw new Error('结果文件说明与当前任务不匹配。');
        current.template = contract.submissionTemplate;
      } catch (error) { current.error = error.message; }
      finally { current.loading = false; renderOperations(); }
    }
    function reportNumber(value) { return value === null || value === undefined ? '未知' : String(value); }
    function sourceLink(text, value) { const href = safeSourceURL(value); return href ? link(text, href) : element('span', text + '（链接不可用）', 'hint'); }
    function renderValidation(validation) {
      const panel = element('div', undefined, 'validation-summary');
      panel.append(element('p', '候选 ' + reportNumber(validation.candidateCount) + ' 位 · 视频样本 ' + reportNumber(validation.totalVideos) + ' 条 · 已知正结余 ' + reportNumber(validation.knownPositiveVideos) + ' 条', 'validation-metrics'));
      panel.append(element('p', '数值完整 ' + reportNumber(validation.completeCandidates) + ' 位 · 资料未齐 ' + reportNumber(validation.incompleteCandidates) + ' 位。未知费用保持未知，数值可计算不代表选人已通过。', 'hint'));
      for (const check of validation.checks || []) {
        const row = element('div', undefined, 'validation-check'); const heading = element('div', undefined, 'connection-top');
        heading.append(element('strong', check.label), element('span', { passed: '格式或数值已核对', unknown: '未知', warning: '待核验' }[check.status] || '待核验', 'tag neutral'));
        row.append(heading, element('p', check.message, 'hint')); panel.append(row);
      }
      const source = validation.sourceReview;
      panel.append(element('p', '来源与覆盖范围未核验：' + (typeof source?.message === 'string' ? source.message : '需要在原任务复核平台来源、区间及完整样本。'), 'browser-warning'));
      if (validation.missingFields?.length) {
        const missing = element('details', undefined, 'validation-missing'); missing.open = true;
        missing.append(element('summary', '费用及资料缺项（' + validation.missingFields.length + ' 处）'));
        const labels = { contributionRate: '佣金前贡献率', commissionRate: '佣金率', adSpend: '广告消耗', fixedFee: '固定合作费', sampleCost: '寄样分摊', sales: '成交记录', gmv: '成交额', kind: '成交类型' };
        const fieldLabel = field => { const sale = /^sales\[(\d+)\]\.(gmv|commissionRate|kind)$/.exec(field); return sale ? '成交记录第 ' + (Number(sale[1]) + 1) + ' 项 · ' + labels[sale[2]] : labels[field] || field; };
        for (const item of validation.missingFields) missing.append(element('p', item.creatorKey + (item.videoId ? ' · 视频 ' + item.videoId : '') + '：' + (item.fields || []).map(fieldLabel).join('、'), 'report-missing'));
        panel.append(missing);
      }
      return panel;
    }
    function renderPreflight(operation, current) {
      const preview = current.preview; const panel = element('div', undefined, 'result-preflight');
      panel.append(element('h3', preview.saved ? '本次文件已收到保存回执' : '保存前预检'), element('p', preview.fileName, 'path'));
      if (preview.loading) panel.append(element('p', '正在只读预检文件，尚未保存报告…', 'hint'));
      if (preview.error) panel.append(element('p', preview.error, 'operation-error'));
      if (preview.stale) panel.append(element('p', '上次预检已失效，请重新预检。预检不会锁定版本，保存时仍会再次核对。', 'browser-warning'));
      if (preview.validation) {
        panel.append(renderValidation(preview.validation.validation));
        const details = element('details'); details.append(element('summary', '查看预检计算结果'));
        for (const candidate of preview.validation.computed.candidates) {
          const summary = candidate.summary || {};
          details.append(element('p', candidate.creatorKey + ' · 回本命中 / 样本：' + reportNumber(summary.breakEvenCount) + ' / ' + reportNumber(summary.totalVideos) + ' · 扣广回本率：' + formatRate(summary.breakEvenRate) + ' · 平均结余：' + reportNumber(summary.averageSurplus), 'hint'));
        }
        panel.append(details);
        if (preview.validation.replay) panel.append(element('p', '此文件对应已有结果。保存将确认原版本，不新建或覆盖版本。', 'hint'));
      }
      panel.append(element('p', '预检仅检查文件、数值和版本；来源与样本覆盖仍未核验。资料未齐也可保存为待核验报告，正式达人库仍待采纳。', 'hint'));
      const actions = element('div', undefined, 'operation-actions');
      const save = element('button', preview.saved ? '已收到保存回执' : current.loading ? '正在保存…' : '保存报告', 'primary'); save.type = 'button'; save.disabled = current.loading || preview.loading || preview.stale || preview.saved || !preview.validation; save.addEventListener('click', () => saveResult(operation.id)); actions.append(save);
      if (preview.payload && !preview.saved) { const retry = element('button', '重新预检', 'subtle'); retry.type = 'button'; retry.disabled = current.loading || preview.loading; retry.addEventListener('click', () => retryResultValidation(operation.id)); actions.append(retry); }
      panel.append(actions); return panel;
    }
    function renderPlatformRequirements(current) {
      const section = element('details', undefined, 'platform-requirements'); section.open = true;
      section.append(element('summary', '平台读取要求（字段可读性尚未实测）'));
      for (const source of current.requirements.sources) {
        const group = element('section', undefined, 'platform-source'); group.append(element('h3', source.label), element('p', source.purpose, 'hint'));
        const list = element('ul');
        for (const item of source.requirements) {
          const scope = { video: '逐视频', creator: '逐达人', report: '整份报告', period: '统计区间', task: '本次任务', product: '商品', order: '订单', account: '账号', connection: '连接', batch: '本批次', cost: '成本资料' }[item.scope] || item.scope;
          const row = element('li'); row.append(element('strong', item.label + (item.requiredForRoi ? ' · 回本计算必需' : ' · 辅助核验')), element('p', scope + '：' + item.note, 'hint')); list.append(row);
        }
        group.append(list); for (const limitation of source.limitations) group.append(element('p', limitation, 'browser-warning')); section.append(group);
      }
      for (const note of current.requirements.notes) section.append(element('p', note, 'hint'));
      section.append(element('p', '以上是读取契约，不代表当前账号已能读取这些字段，也不代表已完成平台采集。', 'browser-warning')); return section;
    }
    function renderReport(record) {
      const report = record.report || {}; const root = element('div', undefined, 'report');
      root.append(element('h3', '第 ' + record.revision + ' 版 · 已保存报告，待采纳'));
      root.append(element('p', '统计区间：' + (report.period?.start || '未知') + ' 至 ' + (report.period?.end || '未知') + ' · ' + (report.period?.timeZone || '时区未知') + ' · 币种：' + (report.currency || '未知'), 'report-context'));
      root.append(element('p', '生成：' + (report.generatedAt || '未知') + ' · 保存：' + (record.savedAt || '未知'), 'hint'));
      if (record.validation) root.append(renderValidation(record.validation));
      if (report.coverage) root.append(element('p', '覆盖范围：' + (typeof report.coverage === 'string' ? report.coverage : JSON.stringify(report.coverage)), 'report-context'));
      if (report.missingFields?.length) root.append(element('p', '报告缺失项：' + report.missingFields.join('、'), 'report-missing'));
      if (!report.candidates?.length) root.append(element('p', '本报告没有候选达人。空结果仍保留来源与统计口径。', 'empty'));
      for (const candidate of report.candidates || []) {
        const computed = record.computed?.candidates?.find(item => item.creatorKey === candidate.platform + ':' + candidate.creatorId);
        const summary = computed?.summary || {}; const card = element('section', undefined, 'report-candidate');
        const heading = element('div', undefined, 'operation-head');
        heading.append(element('h3', candidate.handle || candidate.creatorId), element('span', summary.status === 'complete' ? '计算完整' : summary.status === 'no_sample' ? '无样本' : '资料未齐', 'tag' + (summary.status === 'complete' ? '' : ' warn'))); card.append(heading);
        card.append(sourceLink('达人主页 ↗', candidate.profileUrl));
        if (candidate.reason) card.append(element('p', candidate.reason, 'report-context'));
        const metrics = element('div', undefined, 'report-metrics');
        metrics.append(element('p', '回本命中 / 样本：' + reportNumber(summary.breakEvenCount) + ' / ' + reportNumber(summary.totalVideos)), element('p', '扣广回本率：' + formatRate(summary.breakEvenRate)), element('p', '平均结余：' + reportNumber(summary.averageSurplus) + ' ' + (report.currency || '')), element('p', '已评估：' + reportNumber(summary.evaluatedVideos) + ' · 已知正结余：' + reportNumber(summary.knownPositiveVideos)));
        card.append(metrics);
        const missingVideos = (computed?.videos || []).reduce((sum, item) => sum + (item.missingFields?.length || 0), 0);
        card.append(element('p', '候选缺失 ' + (candidate.missingFields?.length || 0) + ' 项 · 视频缺失 ' + missingVideos + ' 项', 'hint'));
        if (candidate.missingFields?.length) card.append(element('p', candidate.missingFields.join('、'), 'report-missing'));
        const sources = element('details'); sources.append(element('summary', '来源与证据（' + (candidate.sources?.length || 0) + '）'));
        for (const source of candidate.sources || []) { const item = element('p', undefined, 'report-source'); item.append(sourceLink(source.note || '查看来源 ↗', source.url), element('span', ' · 采集：' + (source.capturedAt || '未知'), 'hint')); sources.append(item); }
        card.append(sources);
        const videos = element('details'); videos.append(element('summary', '逐视频明细（' + (candidate.videos?.length || 0) + '）'));
        for (const video of candidate.videos || []) {
          const calculation = computed?.videos?.find(item => item.videoId === video.videoId);
          const item = element('div', undefined, 'report-video'); item.append(sourceLink(video.videoId + ' ↗', video.url), element('p', '结余：' + reportNumber(calculation?.surplus) + ' ' + (report.currency || '') + ' · 发布：' + (video.publishedAt || '未知')));
          item.append(element('p', '佣金前贡献率：' + formatContributionRate(video.contributionRate) + ' · 广告消耗：' + reportNumber(video.adSpend) + ' · 固定合作费：' + reportNumber(video.fixedFee) + ' · 寄样分摊：' + reportNumber(video.sampleCost), 'hint'));
          for (const sales of video.sales || []) item.append(element('p', ({ organic: '自然成交', ads: '广告成交', total: '总成交' }[sales.kind] || sales.kind) + '：' + reportNumber(sales.gmv) + ' · 佣金率：' + formatRate(sales.commissionRate), 'hint'));
          if (calculation?.missingFields?.length) item.append(element('p', '缺失：' + calculation.missingFields.join('、'), 'report-missing'));
          videos.append(item);
        }
        card.append(videos); root.append(card);
      }
      return root;
    }
    function renderResultSection(operation) {
      const current = resultState(operation.id); const section = element('section', undefined, 'result-section');
      const summary = operation.resultSummary;
      section.append(element('p', summary ? '已保存报告，待采纳 · 第 ' + summary.revision + ' 版 · ' + summary.candidateCount + ' 位候选 · ' + summary.incompleteCount + ' 位资料未齐' : '尚无结果报告。任务已投递不代表结果已完成。', 'result-status'));
      const actions = element('div', undefined, 'operation-actions');
      const view = element('button', current.loading ? '正在读取…' : current.open ? '刷新最新结果' : '查看结果', 'secondary'); view.type = 'button'; view.disabled = current.loading; view.addEventListener('click', () => loadResult(operation.id)); actions.append(view);
      const file = element('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
      file.addEventListener('change', event => importResult(operation.id, event.target.files?.[0]));
      const upload = element('button', '选择结果文件并预检', 'secondary'); upload.type = 'button'; upload.disabled = current.loading || state.busy; upload.addEventListener('click', () => file.click()); actions.append(upload, file);
      const contract = element('button', '查看导入示例', 'subtle'); contract.type = 'button'; contract.disabled = current.loading; contract.addEventListener('click', () => showResultContract(operation.id)); actions.append(contract);
      const requirements = element('button', current.requirementsLoading ? '正在读取要求…' : '查看读取要求', 'subtle'); requirements.type = 'button'; requirements.disabled = current.requirementsLoading; requirements.addEventListener('click', () => showPlatformContract(operation.id)); actions.append(requirements);
      section.append(actions, element('p', '选择原任务生成的 JSON 文件（最多 1 MiB）后先只读预检；点击“保存报告”才写入。文件携带原版本与任务归属，不会自动覆盖已有报告。', 'hint'));
      if (current.error) section.append(element('p', current.error, 'operation-error'));
      if (current.requirementsError) section.append(element('p', current.requirementsError, 'operation-error'));
      if (current.requirements) section.append(renderPlatformRequirements(current));
      if (current.preview.fileName) section.append(renderPreflight(operation, current));
      if (current.open) {
        if (current.history.length) {
          const history = element('div', undefined, 'result-history'); history.append(element('span', '历史版本：', 'hint'));
          for (const entry of current.history) { const button = element('button', '第 ' + entry.revision + ' 版' + (current.record?.resultId === entry.resultId ? ' · 当前查看' : ''), 'subtle'); button.type = 'button'; button.disabled = current.loading; button.addEventListener('click', () => loadResult(operation.id, entry.resultId)); history.append(button); }
          section.append(history);
        }
        if (current.record) section.append(renderReport(current.record));
        else if (!current.loading && !current.error) section.append(element('p', '尚未保存报告。请在原任务完成选人核验，再导入结果文件。', 'hint'));
        if (current.template) { const details = element('details'); details.open = true; details.append(element('summary', '提供给原任务的结果文件示例'), element('p', '这只是当前版本的格式示例，请让原任务补齐实际资料。不要把占位值当成业务数据。', 'hint'), element('pre', JSON.stringify(current.template, null, 2), 'snapshot')); section.append(details); }
      }
      return section;
    }
    function browserStatusLabel(status) {
      return { passed: '已核对', info: '状态说明', not_implemented: '待接入', requires_upgrade: '需要升级', probe_available: '可检测连接', connected: '连接已核对', available: '可读取', unavailable: '不可读取', installed: '已安装', missing: '缺失', bound: '已绑定', unbound: '未绑定', changed: '配置已变化', legacy_unbound: '本次未记录', pid_alive: '进程存活线索', not_running: '未发现运行进程', unknown: '未知', unsupported: '不支持', supported: '兼容', not_checked: '未检测', unchecked: '未检测', untested: '未实测', not_integrated: '待接入', not_connected: '未连接', pending: '待验证', blocked: '尚不具备', configured: '已配置', not_configured: '未配置', stale: '已过期' }[status] || '待确认';
    }
    function browserBindingMessage(data) {
      const profile = data.binding?.profile;
      const identity = profile ? profile.name + '（' + profile.id + '）' : '';
      return { unbound: '尚未绑定专用身份，可先发任务补充资料。', bound: '当前绑定：' + identity, missing: '原身份已不存在：' + identity + '。请在 Chrome 插件恢复原身份，或绑定其他身份后发起新任务。', changed: '原身份配置的保存时间已变化：' + identity + '。请核对原插件配置；历史任务需恢复原身份配置，或使用新绑定发起新任务。', unavailable: '当前无法读取 Chrome 身份来源，请在原插件检查版本和配置后刷新。', legacy_unbound: '本次任务未记录浏览器绑定，不会套用当前默认身份。' }[data.bindingState] || '浏览器身份状态尚未确认。';
    }
    function validateBrowserStatus(data, scope) {
      if (!data?.source || !Array.isArray(data.environments) || !data.binding || !Array.isArray(data.checks) || !Array.isArray(data.fieldRequirements) || data.scope !== scope || !Number.isSafeInteger(data.binding.revision)) throw new Error('环境检测返回格式不兼容，请更新插件后重试。');
      return data;
    }
    function renderBrowserChecks(data, stale = false) {
      const panel = element('div', undefined, 'browser-checks');
      panel.append(element('p', browserBindingMessage(data), data.bindingState === 'bound' && !stale ? 'hint' : 'browser-warning'));
      if (data.binding?.configuredAt) panel.append(element('p', '绑定保存时间：' + data.binding.configuredAt, 'hint'));
      panel.append(element('p', (stale ? '上次观测，当前已失效：' : '本次只读观测：') + (data.checkedAt || '时间未知'), 'hint'));
      for (const check of data.checks) {
        const row = element('div', undefined, 'connection'); const top = element('div', undefined, 'connection-top');
        top.append(element('strong', check.label || '依赖检查'), element('span', stale ? '非最新' : browserStatusLabel(check.status), 'tag neutral')); row.append(top);
        if (check.message) row.append(element('p', check.message)); panel.append(row);
      }
      const bridge = data.checks.find(check => check.id === 'bridge');
      if (!bridge || ['not_implemented', 'not_integrated', 'requires_upgrade'].includes(bridge.status)) panel.append(element('p', '只读桥接需要升级：请在 Chrome 插件确认兼容的桥接版本，再检测连接。', 'browser-warning'));
      panel.append(element('p', '进程存活仅是线索。连接检测不启动浏览器，也不读取页面；页面文字需在原任务手动读取。出口未实测，平台字段完整性仍需单独验证。', 'hint'));
      if (data.fieldRequirements.length) {
        const details = element('details', undefined, 'browser-fields'); details.append(element('summary', '选人需要的平台资料'));
        for (const field of data.fieldRequirements) {
          const source = { tiktok_affiliate: 'TikTok Affiliate', affiliate: 'TikTok Affiliate', kalodata: 'Kalodata', user: '用户确认', workspace: '专属目录' }[field.source] || field.source || '来源待确认';
          details.append(element('p', field.label + ' · ' + source + ' · ' + (stale ? '待重新检测' : browserStatusLabel(field.status)), 'hint'));
        }
        panel.append(details);
      }
      return panel;
    }
    async function inspectOperationBrowser(id) {
      let current = state.operationBrowsers.get(id);
      if (!current) { current = { loading: false, data: null, error: '', stale: false }; state.operationBrowsers.set(id, current); }
      if (current.loading) return;
      current.loading = true; current.error = ''; renderOperations();
      try {
        const operation = state.operations.find(item => item.id === id); if (!operation) throw new Error('未找到原任务记录。');
        const data = validateBrowserStatus(await client.run('browser-status', { operationId: id }), 'operation');
        if (operation.browser) {
          if (data.binding.revision !== operation.browser.revision || data.binding.profile?.id !== operation.browser.profile?.id) throw new Error('检测身份与本次任务快照不一致，已停止展示。');
        } else if (data.bindingState !== 'legacy_unbound') throw new Error('旧任务没有绑定快照，不能套用当前默认身份。');
        current.data = data; current.stale = false;
        if (data.bindingState !== 'bound') { const pages = pageReadState(id); pages.listStale = true; pages.snapshotStale = true; }
      } catch (error) { current.error = error.message; current.stale = true; const pages = pageReadState(id); pages.listStale = true; pages.snapshotStale = true; }
      finally { current.loading = false; renderOperations(); }
    }
    function pageReadState(id) {
      if (!state.pageReads.has(id)) state.pageReads.set(id, { loading: false, list: null, snapshot: null, selectedId: '', error: '', listStale: false, snapshotStale: false });
      return state.pageReads.get(id);
    }
    function browserOperation(id) {
      const operation = resultOperation(id);
      if (!operation.browser?.profile?.id) throw new Error('本次任务未绑定专用身份，请在原任务补充资料；不会套用当前默认身份。');
      return operation;
    }
    function verifyBrowserResponse(data, binding, scope, operation) {
      if (!data || data.scope !== scope || data.profileId !== binding.profile?.id || data.bindingRevision !== binding.revision) throw new Error('返回的浏览器身份与本次绑定不一致，已停止展示。');
      if (operation && (data.operationId !== operation.id || data.taskId !== operation.task.taskId)) throw new Error('返回的页面资料不属于当前任务，已停止展示。');
      if (typeof data.instanceId !== 'string' || !data.instanceId || typeof data.checkedAt !== 'string' || !Number.isFinite(Date.parse(data.checkedAt))) throw new Error('只读连接返回格式不兼容，请升级插件后重试。');
    }
    function verifyPlatformPage(page) {
      if (!page || typeof page.targetId !== 'string' || !page.targetId || typeof page.title !== 'string' || !['affiliate', 'kalodata'].includes(page.platform) || !safePlatformURL(page.url, page.platform)) throw new Error('页面地址或来源不符合允许的平台范围，已停止展示。');
      return page;
    }
    async function probeBrowser() {
      const browser = state.browser; const probe = browser.probe; const binding = browser.status?.binding;
      if (probe.loading || browser.loading || browser.saving || browser.stale || !binding?.profile) return;
      probe.loading = true; probe.error = ''; probe.stale = true; renderConnections();
      try {
        const data = await client.run('browser-probe');
        verifyBrowserResponse(data, binding, 'default');
        if (data.status !== 'connected') throw new Error('只读连接尚未确认，请检查原 Chrome 插件。');
        if (browser.status?.binding.revision !== binding.revision || browser.status?.binding.profile?.id !== binding.profile.id) throw new Error('默认绑定已变化，请重新检测连接。');
        probe.data = data; probe.stale = false;
      } catch (error) { probe.error = error.message; }
      finally { probe.loading = false; renderConnections(); }
    }
    async function loadBrowserPages(id) {
      const current = pageReadState(id); if (current.loading) return;
      current.loading = true; current.error = ''; current.listStale = true; current.snapshotStale = true; renderOperations();
      try {
        const operation = browserOperation(id);
        const data = await client.run('browser-pages', { operationId: id, taskId: operation.task.taskId });
        verifyBrowserResponse(data, operation.browser, 'operation', operation);
        if (!Array.isArray(data.pages)) throw new Error('平台页面列表格式不兼容，请升级插件后重试。');
        const targets = new Set();
        for (const page of data.pages) { verifyPlatformPage(page); if (targets.has(page.targetId)) throw new Error('平台页面编号重复，请重新读取列表。'); targets.add(page.targetId); }
        current.list = data; current.listStale = false; current.selectedId = data.pages[0]?.targetId || '';
      } catch (error) { current.error = error.message; }
      finally { current.loading = false; renderOperations(); }
    }
    async function readBrowserPage(id) {
      const current = pageReadState(id); if (current.loading || !current.list || current.listStale || !current.selectedId) return;
      current.loading = true; current.error = ''; current.snapshotStale = true; renderOperations();
      try {
        const operation = browserOperation(id); const target = current.list.pages.find(page => page.targetId === current.selectedId);
        if (!target) throw new Error('选中的页面已不在列表中，请重新读取列表。');
        const data = await client.run('browser-read-page', { operationId: id, taskId: operation.task.taskId, targetId: target.targetId, expectedInstanceId: current.list.instanceId });
        verifyBrowserResponse(data, operation.browser, 'operation', operation); verifyPlatformPage(data.page);
        if (data.instanceId !== current.list.instanceId) throw new Error('浏览器实例已变化，请重新读取平台页面列表。');
        if (data.page.targetId !== target.targetId || data.page.platform !== target.platform || data.page.url !== target.url) throw new Error('页面已切换或返回了其他页面，请重新读取平台页面列表。');
        if (typeof data.page.text !== 'string' || Array.from(data.page.text).length > PAGE_TEXT_LIMIT || typeof data.page.truncated !== 'boolean') throw new Error('页面文字格式或长度不兼容，请升级插件后重试。');
        current.snapshot = data; current.snapshotStale = false;
      } catch (error) { current.error = error.message + ' 请重新读取平台页面列表后再试。'; current.listStale = true; }
      finally { current.loading = false; renderOperations(); }
    }
    function renderPageReader(operation) {
      const section = element('div', undefined, 'page-reader'); const current = pageReadState(operation.id);
      const available = !!(operation.task?.taskId && operation.browser?.profile);
      const listButton = element('button', current.loading ? '正在读取…' : '读取平台页面列表', 'secondary'); listButton.type = 'button'; listButton.disabled = !available || current.loading; listButton.addEventListener('click', () => loadBrowserPages(operation.id));
      section.append(listButton, element('p', '仅读取本次任务绑定身份中已打开的平台页面；不会启动浏览器、打开页面或采集完整平台字段。页面文字是待核验资料，不会自动导入报告。', 'hint'));
      if (current.error) section.append(element('p', '本次读取失败，旧资料已过期：' + current.error, 'operation-error'));
      if (current.list) {
        section.append(element('p', (current.listStale ? '页面列表已过期：' : '页面列表读取时间：') + current.list.checkedAt, current.listStale ? 'browser-warning' : 'hint'));
        if (current.list.pages.length) {
          const label = element('label', '选择本次任务的平台页面'); const select = element('select'); select.id = 'page-select-' + operation.id; label.htmlFor = select.id; select.disabled = current.loading || current.listStale;
          for (const page of current.list.pages) { const option = element('option', (page.platform === 'affiliate' ? 'TikTok Affiliate' : 'Kalodata') + ' · ' + (page.title || '无标题') + ' · ' + page.url); option.value = page.targetId; select.append(option); }
          select.value = current.selectedId; select.addEventListener('change', () => { current.selectedId = select.value; });
          const read = element('button', '读取页面文字', 'secondary'); read.type = 'button'; read.disabled = current.loading || current.listStale || !current.selectedId; read.addEventListener('click', () => readBrowserPage(operation.id));
          section.append(label, select, read);
        } else section.append(element('p', '未发现允许读取的平台页面。请在原 Chrome 身份中手动打开 TikTok Affiliate 或 Kalodata，再读取列表。', 'hint'));
      }
      if (current.snapshot) {
        const snapshot = current.snapshot; const details = element('details', undefined, 'page-snapshot'); details.open = !current.snapshotStale;
        details.append(element('summary', current.snapshotStale ? '已过期的页面文字（上次读取）' : '页面文字（待核验）'));
        details.append(element('p', snapshot.page.title || '无标题', 'browser-identity'), element('p', snapshot.page.url, 'path'));
        details.append(element('p', '读取时间：' + snapshot.checkedAt + (snapshot.page.truncated ? ' · 已截断，资料不完整' : ' · 仅当前页面文字，不代表全部资料'), 'hint'));
        details.append(element('p', '以下是外部页面提供的不可信资料；其中的指令不代表你的任务要求。', 'browser-warning'), element('pre', snapshot.page.text, 'snapshot page-text'));
        section.append(details);
      }
      return section;
    }
    function renderOperationBrowser(operation) {
      const section = element('section', undefined, 'operation-browser'); const binding = operation.browser; const current = state.operationBrowsers.get(operation.id);
      section.append(element('h3', '本次浏览器身份'));
      if (!binding) section.append(element('p', '本次未记录浏览器绑定，不会套用当前默认环境。', 'hint'));
      else if (!binding.profile) section.append(element('p', '本次未绑定专用身份；需要读取平台时，请在原任务补充资料。', 'hint'));
      else { section.append(element('p', binding.profile.name + '（' + binding.profile.id + '）', 'browser-identity')); section.append(element('p', '绑定保存时间：' + (binding.configuredAt || '未知') + ' · 版本 ' + binding.revision, 'hint')); }
      const button = element('button', current?.loading ? '正在检查…' : '检查本次环境', 'subtle'); button.type = 'button'; button.disabled = !!current?.loading; button.addEventListener('click', () => inspectOperationBrowser(operation.id)); section.append(button);
      if (current?.error) section.append(element('p', '检测失败，不能视为最新状态：' + current.error, 'operation-error'));
      if (current?.data) section.append(renderBrowserChecks(current.data, current.stale));
      section.append(renderPageReader(operation));
      return section;
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
        card.append(renderOperationBrowser(operation));
        if (operation.task?.taskId) card.append(renderResultSection(operation));
        if (operation.task?.taskId) card.append(workflow.render(operation));
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
    function renderConnections() {
      const browser = state.browser; const data = browser.status; const container = $('connection-list'); container.replaceChildren();
      if (browser.loading) container.append(element('p', '正在只读检测环境…', 'hint'));
      if (browser.error) container.append(element('p', browser.error, 'operation-error'));
      if (data) {
        const row = element('div', undefined, 'connection'); const heading = element('div', undefined, 'connection-top');
        heading.append(element('strong', 'Chrome 出口隔离'), element('span', browser.stale ? '需重新检测' : data.source.installed ? data.source.supported ? data.source.available ? '已发现兼容来源' : '来源不可读取' : '版本待适配' : '未安装', 'tag neutral')); row.append(heading);
        if (data.source.message) row.append(element('p', data.source.message));
        row.append(element('p', '创建、修改或启动专用身份，请在原 Chrome 插件操作。这里仅保存绑定和读取状态。'));
        container.append(row, renderBrowserChecks(data, browser.stale));
      } else if (!browser.loading) container.append(element('p', '当前无法读取环境来源，尚不能确定身份列表。请检查原插件后重试。', 'hint'));
      const probe = browser.probe;
      if (probe.error) container.append(element('p', '连接检测失败，上次连接状态已过期：' + probe.error, 'operation-error'));
      if (probe.data) container.append(element('p', (probe.stale ? '上次连接观测已过期：' : '只读连接已核对：') + probe.data.checkedAt + ' · 身份 ' + probe.data.profileId + '。本次未读取页面，出口与平台字段尚未验证。', probe.stale ? 'browser-warning' : 'hint'));
      container.append(link(browser.chromeURL === '/manage' ? '前往插件管理 ↗' : '打开 Chrome 配置 ↗', browser.chromeURL));
      browserControls();
    }
    function acceptBrowserStatus(data) {
      const browser = state.browser; browser.status = data; browser.stale = false; browser.error = '';
      if (browser.probe.data && (browser.probe.data.bindingRevision !== data.binding.revision || browser.probe.data.profileId !== data.binding.profile?.id || data.bindingState !== 'bound')) browser.probe.stale = true;
      const select = $('browser-profile'); select.replaceChildren();
      const placeholder = element('option', data.bindingState === 'unavailable' || !data.source.available || !data.source.supported ? '来源不可读取，请先检查原插件' : data.environments.length ? '请选择专用身份' : '尚无身份，请在原插件创建'); placeholder.value = ''; select.append(placeholder);
      for (const environment of data.environments) {
        const option = element('option', environment.name + ' · ' + browserStatusLabel(environment.processState)); option.value = environment.id; select.append(option);
      }
      browser.selectedId = data.environments.some(item => item.id === data.binding.profile?.id) ? data.binding.profile.id : '';
      select.value = browser.selectedId;
    }
    async function refreshConnections() {
      const browser = state.browser; if (browser.loading || browser.saving || browser.probe.loading) return;
      browser.loading = true; browser.error = ''; renderConnections();
      try {
        const results = await Promise.allSettled([client.run('browser-status'), client.request('/api/plugins')]);
        const [statusResult, pluginsResult] = results;
        if (pluginsResult.status === 'fulfilled') {
          const plugins = Array.isArray(pluginsResult.value) ? pluginsResult.value : pluginsResult.value?.plugins;
          const chrome = Array.isArray(plugins) && plugins.find(item => item.id === 'chrome-proxy-launcher');
          if (chrome) browser.chromeURL = safePluginURL(chrome.uiUrl || chrome.ui?.url || (typeof chrome.ui === 'string' ? chrome.ui : ''), window.location.origin, chrome.id) || '/manage';
        }
        if (statusResult.status === 'rejected') throw statusResult.reason;
        acceptBrowserStatus(validateBrowserStatus(statusResult.value, 'default'));
      } catch (error) { browser.error = '检测失败，旧状态不能视为最新：' + error.message; browser.stale = true; browser.probe.stale = true; }
      finally { browser.loading = false; renderConnections(); }
    }
    async function saveBrowserBinding(clear = false) {
      const browser = state.browser; const current = browser.status;
      if (state.busy || browser.loading || browser.saving || browser.probe.loading || state.pending || !current || browser.stale) return;
      const profile = current.environments.find(item => item.id === browser.selectedId);
      if (!clear && (!profile || !current.source.installed || !current.source.supported || !current.source.available || current.bindingState === 'unavailable')) return;
      const input = { profileId: clear ? null : profile.id, expectedRevision: current.binding.revision };
      if (!clear) input.expectedSourceRevision = profile.sourceRevision;
      browser.saving = true; browser.error = ''; browser.probe.stale = true; state.busy = true; controls(); renderConnections(); renderOperations();
      try {
        const saved = await client.run('bind-browser', input);
        if (!saved?.binding || !Number.isSafeInteger(saved.binding.revision)) throw new Error('绑定保存回执不完整，请刷新检测确认。');
        try {
          const data = validateBrowserStatus(await client.run('browser-status'), 'default');
          if (data.binding.revision !== saved.binding.revision || (data.binding.profile?.id || null) !== input.profileId) throw new Error('绑定状态尚未读回或已被其他页面修改。');
          acceptBrowserStatus(data);
          announce(clear ? '默认浏览器绑定已解除，历史任务仍保留原绑定。' : '专用浏览器绑定已保存并读回。新任务使用此身份，历史任务不变。');
        } catch (error) { browser.error = '已收到绑定回执，待刷新确认：' + error.message; browser.stale = true; announce(browser.error, true); }
      } catch (error) { browser.error = '绑定尚未确认，原状态保留：' + error.message; browser.stale = true; announce(browser.error, true); }
      finally { browser.saving = false; state.busy = false; controls(); renderConnections(); renderOperations(); }
    }
    $('task-form').addEventListener('submit', send);
    $('refresh').addEventListener('click', refresh);
    $('save-workspace').addEventListener('click', configure);
    $('directory').addEventListener('change', controls);
    $('refresh-connections').addEventListener('click', refreshConnections);
    $('browser-profile').addEventListener('change', () => { state.browser.selectedId = $('browser-profile').value; browserControls(); });
    $('save-browser').addEventListener('click', () => saveBrowserBinding(false));
    $('unbind-browser').addEventListener('click', () => saveBrowserBinding(true));
    $('probe-browser').addEventListener('click', probeBrowser);
    for (const id of ['prompt', 'cli', 'model']) $(id).addEventListener('input', saveDraft);
    $('restore-template').addEventListener('click', () => { if (state.pending || !state.status?.template?.text) return; if ($('prompt').value && !window.confirm('恢复示例会替换当前尚未发送的内容，是否继续？')) return; $('prompt').value = state.status.template.text; saveDraft(); });
    refresh(); refreshConnections();
    return { state, workflow, refresh, send, configure, retryOperation, refreshConnections, loadResult, importResult, saveResult, retryResultValidation, showResultContract, showPlatformContract, saveBrowserBinding, inspectOperationBrowser, probeBrowser, loadBrowserPages, readBrowserPage };
  }
  return { createClient, createDispatcher, safeTaskURL, safePluginURL, safeSourceURL, safePlatformURL, formatRate, formatContributionRate, parseResultFile, completed, mount };
}));
