(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./app.js') : root.GapawWorkbenchApp);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.GapawDrafts = api; root.addEventListener('DOMContentLoaded', () => { if (root.document.getElementById('draft-composer')) api.mount(root.document, root); }); }
}(typeof window === 'undefined' ? globalThis : window, function (App) {
  'use strict';
  const MAX_CREATORS = 10;
  const FORM_KEY = 'gapaw-creator-workbench:drafts-form:v1';
  const ADOPTED_LABEL = { adopted: '已采用', conflict: '版本冲突', rejected: '工作台拒绝', unknown: '结果未知', not_applied: '未写入', pending: '写入中' };

  function newId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  // 按达人与渠道分组，组内新版本在前。
  function groupProposals(proposals) {
    const groups = new Map();
    for (const p of proposals) {
      const key = p.creatorId + '\u0000' + p.channel;
      if (!groups.has(key)) groups.set(key, { creatorId: p.creatorId, handle: p.handle, channel: p.channel, label: p.label, items: [] });
      groups.get(key).items.push(p);
    }
    for (const g of groups.values()) g.items.sort((a, b) => b.version - a.version);
    return [...groups.values()];
  }
  // 采用按钮的状态：已采用、需要用原编号核对、可采用（是否需要确认覆盖人工修改）。
  function adoptAction(p) {
    const a = p.adoption;
    if (a?.status === 'adopted') return { kind: 'done' };
    if (a && ['unknown', 'not_applied', 'pending'].includes(a.status)) return { kind: 'retry', adoptionId: a.adoptionId, expectedRevision: a.expectedRevision };
    if (!p.current || !Number.isSafeInteger(p.current.revision)) return { kind: 'unavailable' };
    if (p.current.matchesProposal) return { kind: 'same' };
    return { kind: 'adopt', expectedRevision: p.current.revision, confirm: p.baseChanged === true };
  }

  function mount(document, window) {
    const $ = id => document.getElementById(id);
    const client = App.createClient(window.fetch.bind(window));
    const dispatcher = App.createDispatcher(client);
    const state = { status: null, creators: [], selected: new Set(), operations: [], drafts: new Map(), busy: false };
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const btn = (text, cls, fn) => { const n = el('button', text, cls); n.type = 'button'; n.disabled = state.busy; n.addEventListener('click', fn); return n; };
    function notice(message, error = false) { $('draft-notice').textContent = message; $('draft-notice').className = error ? 'notice error' : 'notice'; }
    function channels() { return [...document.querySelectorAll('input[name=channel]:checked')].map(n => n.value); }
    function controls() {
      $('draft-selection').textContent = '已选 ' + state.selected.size + ' / ' + MAX_CREATORS + ' 位。';
      $('draft-send').disabled = state.busy || !state.status?.available || !state.selected.size || !channels().length || !$('draft-cli').value || !$('draft-prompt').value.trim();
    }
    function saveForm() { try { window.localStorage.setItem(FORM_KEY, JSON.stringify({ prompt: $('draft-prompt').value, cli: $('draft-cli').value, model: $('draft-model').value })); } catch (_) { /* 本地暂存不可用不影响发送 */ } }
    function restoreForm() { try { const v = JSON.parse(window.localStorage.getItem(FORM_KEY)); if (v) { if (v.prompt) $('draft-prompt').value = v.prompt; $('draft-cli').value = v.cli || ''; $('draft-model').value = v.model || ''; } } catch (_) { /* 忽略损坏的暂存 */ } }

    function renderCreators() {
      const list = $('creator-list'); list.replaceChildren();
      if (!state.creators.length) { list.append(el('p', state.status?.available ? '工作台没有达人记录。' : '请先在首页的数据管理中迁入记录或建立本地工作台。', 'hint')); controls(); return; }
      const q = $('creator-search').value.trim().toLowerCase();
      for (const c of state.creators) {
        if (q && ![c.id, c.handle, c.topic].some(v => String(v || '').toLowerCase().includes(q))) continue;
        const row = el('label', undefined, 'draft-creator');
        const box = el('input'); box.type = 'checkbox'; box.checked = state.selected.has(c.id);
        box.disabled = !box.checked && state.selected.size >= MAX_CREATORS;
        box.addEventListener('change', () => { if (box.checked) state.selected.add(c.id); else state.selected.delete(c.id); renderCreators(); });
        row.append(box, el('strong', c.id), el('span', '@' + c.handle), el('span', c.topic || '', 'hint'), el('span', c.stage || '', 'tag neutral'));
        list.append(row);
      }
      controls();
    }

    async function loadStatus() {
      try {
        state.status = await client.run('outreach-status');
        $('outreach-state').textContent = state.status.message;
        const local = state.status.mode === 'local' || String(state.status.url || '').startsWith('local-workbench:');
        $('outreach-legacy').hidden = local || !state.status.configured;
        if (!local && /^http:\/\/127\.0\.0\.1:\d+$/.test(state.status.url || '')) $('outreach-url').value = state.status.url; else $('outreach-url').value = '';
        $('outreach-save').disabled = local;
        state.selected.clear();
        if (state.status.available) { state.creators = (await client.run('outreach-creators')).items; notice((local ? '本地工作台' : '旧版兼容来源') + '共 ' + state.creators.length + ' 位达人。'); }
        else { state.creators = []; notice(state.status.message, state.status.configured); }
      } catch (error) { state.status = null; state.creators = []; state.selected.clear(); notice('读取工作台状态失败：' + error.message, true); }
      renderCreators();
    }
    async function saveURL() {
      if (state.status?.mode === 'local' || String(state.status?.url || '').startsWith('local-workbench:')) return;
      state.busy = true; controls();
      try { await client.run('outreach-configure', { url: $('outreach-url').value.trim() }); await loadStatus(); }
      catch (error) { notice('未保存：' + error.message, true); }
      finally { state.busy = false; controls(); }
    }

    async function loadOperations() {
      try {
        const data = await client.run('list-operations');
        state.operations = data.operations.filter(op => op.kind === 'drafts');
      } catch (error) { notice('读取草稿任务失败：' + error.message, true); }
      renderOperations();
      for (const op of state.operations) if (op.task) loadDrafts(op.id);
    }
    async function loadDrafts(id) {
      try { state.drafts.set(id, await client.run('get-drafts', { operationId: id, live: true })); }
      catch (error) { state.drafts.set(id, { error: error.message }); }
      renderOperations();
    }
    function putOperation(op) { const i = state.operations.findIndex(o => o.id === op.id); if (i >= 0) state.operations[i] = op; else state.operations.unshift(op); renderOperations(); }

    async function send() {
      if ($('draft-send').disabled) return;
      state.busy = true; controls();
      const input = { requestId: newId('req_drafts'), creatorIds: [...state.selected], channels: channels(), prompt: $('draft-prompt').value.trim(), runtime: { cli: $('draft-cli').value } };
      if ($('draft-model').value.trim()) input.runtime.model = $('draft-model').value.trim();
      try {
        const op = (await client.run('prepare-drafts', input)).operation;
        putOperation(op);
        const done = await dispatcher.dispatch(op, putOperation);
        putOperation(done); state.selected.clear(); renderCreators();
        notice('已交给 MultiCC。草稿交回后会显示在下方任务里，等待你比较并采用。');
      } catch (error) { notice('发送未完成：' + error.message + '。可在下方任务卡片重试，原任务编号会保留。', true); await loadOperations(); }
      finally { state.busy = false; controls(); }
    }
    async function retry(op) {
      state.busy = true; renderOperations();
      try { putOperation(await dispatcher.dispatch(op, putOperation)); notice('已重新投递。'); }
      catch (error) { notice('重试未完成：' + error.message, true); }
      finally { state.busy = false; renderOperations(); }
    }
    async function adopt(op, p, action) {
      if (action.confirm && !window.confirm('@' + p.handle + ' 的' + p.label + '在任务发起后已被修改（发起时版本 ' + p.baseRevision + '，当前版本 ' + p.current.revision + '）。采用会替换当前文案，是否继续？')) return;
      state.busy = true; renderOperations();
      try {
        const r = await client.run('adopt-draft', { proposalId: p.proposalId, adoptionId: action.adoptionId || newId('ad'), expectedRevision: action.expectedRevision });
        if (r.status === 'adopted') notice('已写入工作台并读回一致：@' + p.handle + ' · ' + p.label + ' 第 ' + p.version + ' 版。');
        else notice((ADOPTED_LABEL[r.status] || r.status) + '：' + (r.message || ''), true);
      } catch (error) { notice('采用结果未确认：' + error.message + '。刷新后可用原编号核对。', true); }
      finally { state.busy = false; await loadDrafts(op.id); }
    }

    function renderProposal(op, p) {
      const box = el('div', undefined, 'draft-version');
      const head = el('div', undefined, 'operation-head');
      head.append(el('strong', '第 ' + p.version + ' 版'));
      if (p.adoption) head.append(el('span', ADOPTED_LABEL[p.adoption.status] || p.adoption.status, 'tag' + (p.adoption.status === 'adopted' ? '' : ' warn')));
      box.append(head);
      if (p.subject) box.append(el('p', '主题：' + p.subject, 'draft-subject'));
      box.append(el('pre', p.body, 'snapshot'));
      if (p.note) box.append(el('p', '说明：' + p.note, 'hint'));
      if (p.adoption?.message && p.adoption.status !== 'adopted') box.append(el('p', p.adoption.message, 'operation-error'));
      const action = adoptAction(p); const actions = el('div', undefined, 'operation-actions');
      if (action.kind === 'adopt') actions.append(btn(action.confirm ? '采用（替换已修改的文案）' : '采用此版本', 'secondary', () => adopt(op, p, action)));
      else if (action.kind === 'retry') actions.append(btn('用原编号核对并重试', 'secondary', () => adopt(op, p, action)));
      else if (action.kind === 'same') actions.append(el('span', '与工作台当前文案一致', 'hint'));
      else if (action.kind === 'unavailable') actions.append(el('span', '暂时读不到工作台当前文案，无法采用', 'hint'));
      box.append(actions);
      return box;
    }
    function renderDrafts(op) {
      const wrap = el('div', undefined, 'result-section');
      const data = state.drafts.get(op.id);
      if (!data) { wrap.append(el('p', '正在读取草稿…', 'hint')); return wrap; }
      if (data.error) { wrap.append(el('p', '读取草稿失败：' + data.error, 'operation-error')); return wrap; }
      if (data.liveError) wrap.append(el('p', '无法读取工作台当前文案：' + data.liveError + '。草稿已保留，恢复连接后可采用。', 'operation-error'));
      if (!data.proposals.length) { wrap.append(el('p', '任务尚未交回草稿。可进入原任务查看进度或补充条件。', 'hint')); return wrap; }
      for (const g of groupProposals(data.proposals)) {
        const section = el('details', undefined, 'draft-group'); section.open = g.items.some(p => adoptAction(p).kind === 'adopt' || adoptAction(p).kind === 'retry');
        const latest = g.items[0];
        const summary = el('summary'); summary.append(el('strong', g.creatorId + ' @' + g.handle + ' · ' + g.label), el('span', ' 共 ' + g.items.length + ' 版', 'hint'));
        if (latest.baseChanged) summary.append(el('span', ' 工作台文案已在发起后修改', 'tag warn'));
        else if (latest.changedByAdoption) summary.append(el('span', ' 当前文案来自本任务已采用的版本', 'tag'));
        section.append(summary);
        if (latest.current) {
          const cur = el('div', undefined, 'draft-version current');
          cur.append(el('strong', '工作台当前文案 · 版本 ' + latest.current.revision));
          if (latest.current.subject) cur.append(el('p', '主题：' + latest.current.subject, 'draft-subject'));
          cur.append(el('pre', latest.current.body, 'snapshot'));
          section.append(cur);
        }
        for (const p of g.items) section.append(renderProposal(op, p));
        wrap.append(section);
      }
      return wrap;
    }
    function renderOperations() {
      const list = $('draft-operations'); list.replaceChildren();
      if (!state.operations.length) { list.append(el('p', '还没有草稿任务。', 'empty')); return; }
      for (const op of state.operations) {
        const card = el('article', undefined, 'operation');
        const head = el('div', undefined, 'operation-head');
        head.append(el('h3', op.dispatch?.create?.title || '生成邀约草稿'));
        head.append(el('span', App.completed(op) ? '已投递' : op.error ? '待重试' : '待投递', 'tag' + (App.completed(op) ? '' : ' warn')));
        const meta = el('div', undefined, 'operation-meta');
        meta.append(el('span', new Date(op.createdAt).toLocaleString('zh-CN')), el('span', (op.draftScope?.channels || []).length + ' 个渠道'), el('span', op.runtime?.cli || ''));
        card.append(head, meta);
        if (op.error) card.append(el('p', op.error.message || '上次投递失败', 'operation-error'));
        const actions = el('div', undefined, 'operation-actions');
        const href = op.task && App.safeTaskURL(op.task.url, window.location.origin, op.task.taskId);
        if (href) { const a = el('a', '打开原任务补充条件 ↗'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; actions.append(a); }
        if (!App.completed(op)) actions.append(btn('重试投递', 'secondary', () => retry(op)));
        if (op.task) actions.append(btn('刷新草稿', 'subtle', () => loadDrafts(op.id)));
        card.append(actions);
        if (op.task) card.append(renderDrafts(op));
        list.append(card);
      }
    }

    restoreForm();
    $('outreach-save').addEventListener('click', saveURL);
    $('outreach-refresh').addEventListener('click', loadStatus);
    $('creator-search').addEventListener('input', renderCreators);
    $('draft-send').addEventListener('click', send);
    $('draft-history-refresh').addEventListener('click', loadOperations);
    for (const n of document.querySelectorAll('input[name=channel]')) n.addEventListener('change', controls);
    for (const id of ['draft-prompt', 'draft-cli', 'draft-model']) { $(id).addEventListener('input', () => { saveForm(); controls(); }); $(id).addEventListener('change', controls); }
    loadStatus(); loadOperations();
    return { state, loadStatus, loadOperations, loadDrafts, send, adopt };
  }
  return { mount, groupProposals, adoptAction };
}));
