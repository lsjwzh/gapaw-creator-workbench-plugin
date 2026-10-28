(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./app.js') : root.GapawWorkbenchApp, node ? require('./drafts.js') : root.GapawDrafts, node ? require('./facts.js') : root.GapawFacts);
  if (node) module.exports = api;
  else root.addEventListener('DOMContentLoaded', () => { if (root.document.getElementById('wb-detail')) api.mount(root.document, root); });
}(typeof window === 'undefined' ? globalThis : window, function (App, Drafts, Facts) {
  'use strict';
  const RUNTIME_KEY = 'gapaw-creator-workbench:runtime:v1';
  const MAX_BATCH = 10;
  const CHANNEL_LABEL = { comment: '评论区', dm: '普通私信', email: '邮件', affiliate: '达人联盟', followup: '跟进' };
  const ADOPT_LABEL = { adopted: '已采用', conflict: '版本冲突', rejected: '工作台拒绝', unknown: '结果未知', not_applied: '未写入', pending: '写入中' };
  const OP_STATUS = { prepared: '待创建任务', task_created: '待投递消息', accepted: '已交给 MultiCC', delivery_failed: '投递失败' };
  const NEGOTIATION_LABEL = { status: '进展', our_offer: '我方报价', their_ask: '对方要价', next_step: '下一步' };
  const PROMPTS = {
    drafts: '为选中的达人撰写邀约草稿。沿用现有文案的语气与合作条件，结合每位达人的选题与商品，突出与其内容的匹配点；资料不足的地方在说明里列出待核项。',
    reply: '阅读这位达人的往来消息，整理谈判摘要（进展、我方报价、对方要价、下一步），并针对对方最后一条真实来信撰写一条回复草稿。沿用已确认的合作条件，不擅自加价或承诺；资料不足处在说明里列出待核项。',
  };

  const MODULES = [
    { id: 'selection', title: '选人', mode: '持续对话 · 版本名单', needs: '历史选人记录、统计期与来源；历史数值需要结合当前证据复核。', actions: '在选人工作区检查环境、持续对话、查看各版名单，预览并采用身份明确的达人。', target: '本地达人档案与独立选人任务。' },
    { id: 'verification', title: '核验', mode: '人工核验', needs: '确认账号接单权、商品与寄样批次、历史消息及各渠道身份。', actions: '人工勾选核验、登记邮箱来源与目标视频；需要整理资料时在原 MultiCC 任务继续，新增核验任务尚未接入。', target: '达人核验标记和渠道设置；不自动授权发送。' },
    { id: 'cooperation', title: '合作准备', mode: '人工确认条件', needs: '可核对的合作报价、佣金、负责人和对外署名。', actions: '人工保存合作字段与依据；广告、版权、原片、付款节点等未结构化条件写入待确认备注。', target: '达人合作设置，并用于文案占位符；不自动形成对外承诺。' },
    { id: 'drafts', title: '文案', mode: 'AI 拟稿 · 人工采用', needs: '逐人商品依据、已确认条件、最新跨渠道回复；排除已实质回复的首触邀约。', actions: '生成邀约草稿、人工编辑、比较候选版本后采用。', target: '版本化文案；复制和导出均不登记发送事实。' },
    { id: 'outreach', title: '触达', mode: '已有外部流程 · 人工登记', needs: '发送前复查原账号收件箱与跨渠道回复；目标账号、设备和渠道须人工核对。', actions: '按现有外部流程单步执行后登记事实；不明页面或验证码交由人工处理。插件不提供发送按钮。', target: '触达事实及证据；平台受理不等于送达、已读或有效回复。' },
    { id: 'messages', title: '往来', mode: '人工登记原文', needs: '可追溯的消息原文、时间、来源标识和方向。', actions: '登记往来并查看对话；如有外部同步需核对覆盖，当前不宣称全量自动同步。', target: '消息记录；不会自动登记有效回复或改变回复率。' },
    { id: 'reply', title: '谈判回复', mode: 'AI 整理 · 人工确认', needs: '最新真人来信与已确认合作条件；自动回复不视为真人答复。', actions: '总结对话并拟回复，比较后采用摘要和草稿；报价、佣金和合作事实仍由人工确认。', target: '谈判摘要与回复草稿；摘要不是合作阶段事实。' },
    { id: 'followup', title: '跟进', mode: '人工安排', needs: '已联系、未明确拒绝，并已复查最新跨渠道回复。', actions: '设置负责人和跟进日，编辑或采用跟进草稿；到期只作待办提醒。', target: '跟进日期、负责人和草稿；不自动发消息，不重置首次联系时间。' },
    { id: 'fulfilment', title: '履约', mode: '人工登记履约', needs: '已有确认合作事实；样品、物流和实际视频证据可核对。', actions: '登记寄样或已发片，必要时撤销最新错误事实；付款和授权条件继续人工核对。', target: '履约事实及依据；物流、视频、付款尚未自动同步。' },
    { id: 'review', title: '复盘', mode: '按事实查看与导出', needs: '有效且未撤销的本轮事实、实际消息与统计口径。', actions: '查看事实台账与当前总览，导出本地达人与运营记录。', target: '复盘资料与导出文件；导出不等于完整备份或额外触达。' },
  ];

  function parseHash(hash) {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const creator = params.get('creator');
    return { tab: params.get('tab') === 'conversations' ? 'conversations' : 'creators', creator: creator && /^[A-Za-z0-9_.:-]{1,200}$/.test(creator) ? creator : null, module: MODULES.some(m => m.id === params.get('module')) ? params.get('module') : 'selection' };
  }
  function buildHash(view) {
    const params = new URLSearchParams();
    if (view.tab === 'conversations') params.set('tab', 'conversations');
    if (view.creator) params.set('creator', view.creator);
    if (view.module) params.set('module', view.module);
    return '#' + params.toString();
  }
  function filterCreators(items, f) {
    const q = String(f.q || '').trim().toLowerCase();
    return items.filter(c => (!q || [c.id, c.handle, c.topic].some(v => String(v || '').toLowerCase().includes(q)))
      && (!f.priority || c.priority === f.priority) && (!f.stage || c.stage === f.stage) && (!f.hasMessages || c.msg_count > 0));
  }
  // 采用谈判摘要按钮：已采用、用原编号核对、与当前一致、可采用（发起后被改过需要确认）。
  function negotiationAction(p) {
    const a = p.adoption;
    if (a?.status === 'adopted') return { kind: 'done' };
    if (a && ['unknown', 'not_applied', 'pending'].includes(a.status)) return { kind: 'retry', adoptionId: a.adoptionId, expectedUpdated: a.expectedUpdated ?? null };
    if (!p.current) return { kind: 'unavailable' };
    if (p.current.matchesProposal) return { kind: 'same' };
    return { kind: 'adopt', expectedUpdated: p.current.updated ?? null, confirm: p.baseChanged === true };
  }
  function safeHttps(value) {
    try { const u = new URL(String(value)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch (_) { return null; }
  }
  function formatTime(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value || '时间未知') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function newId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  function mount(document, window) {
    const $ = id => document.getElementById(id);
    const client = App.createClient(window.fetch.bind(window));
    const dispatcher = App.createDispatcher(client);
    const state = { status: null, home: null, selected: new Set(), current: null, conversations: null, busy: false, dialog: null, dataStatus: null, dataBusy: false, importPreview: null, importPath: '', importError: '', editors: {}, generation: 0, view: parseHash(window.location.hash) };
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = String(text); if (cls) n.className = cls; return n; };
    const btn = (text, cls, fn) => { const n = el('button', text, cls); n.type = 'button'; n.disabled = state.busy; n.addEventListener('click', fn); return n; };
    const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
    function notice(message, error = false, extra) {
      const n = $('wb-notice'); n.replaceChildren(el('span', message)); n.className = error ? 'notice error' : 'notice';
      if (extra) n.append(' ', extra);
    }
    function taskLink(op) {
      const href = op?.task && App.safeTaskURL(op.task.url, window.location.origin, op.task.taskId);
      return href ? link('打开原任务 ↗', href) : null;
    }
    function setView(patch) {
      state.view = { ...state.view, ...patch };
      const hash = buildHash(state.view);
      if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
      renderTabs();
    }

    let facts = null, factSource = '';
    function bindFacts(url) {
      if (facts && factSource === url) return;
      factSource = url; state.current = null; state.home = null; state.conversations = null; state.selected.clear(); state.editors = {}; state.generation++;
      for (const id of ['wb-creators', 'wb-stats', 'todo-reply', 'todo-due', 'todo-adopt', 'wb-conversations']) $(id).replaceChildren();
      renderEmptyDetail();
      const manager = Facts.create(document, window, client, { source: url, notice(...args) { if (facts === manager) notice(...args); }, redraw(id) { if (facts !== manager) return; if (state.current?.id === id) renderDetail(); if (state.view.module === 'review') renderModuleOverview(); }, async refresh(id) { if (facts === manager && state.current?.id === id) await reloadCurrent(); } });
      facts = manager;
    }

    // —— 全局模块与本地数据 ——
    function currentModule() { return MODULES.find(m => m.id === state.view.module) || MODULES[0]; }
    function showData() { $('wb-data').open = true; $('wb-data').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    function renderEmptyDetail() {
      const m = currentModule();
      const box = $('wb-detail'); box.replaceChildren(el('h2', m.title), el('p', m.actions, 'hint'));
      box.append(el('p', state.home?.items.length ? '从达人列表选择一位，开始处理' + m.title + '。' : '当前还没有可处理的达人记录。可先迁入已有工作台数据，或创建空白工作台后进入选人任务。', 'empty'));
      if (!state.home?.items.length) box.append(btn('打开数据管理', 'secondary', showData));
    }
    function renderModuleOverview() {
      const m = currentModule();
      for (const n of $('wb-module-nav').querySelectorAll('[data-module]')) n.setAttribute('aria-current', n.dataset.module === m.id ? 'step' : 'false');
      const root = $('wb-module-overview'); root.replaceChildren(el('h2', m.title), el('p', m.mode, 'workflow-mode'));
      const grid = el('div', undefined, 'module-guide-grid');
      for (const [label, value] of [['需要的资料', m.needs], ['可以做什么', m.actions], ['保存到哪里', m.target]]) { const box = el('div'); box.append(el('h3', label), el('p', value)); grid.append(box); }
      root.append(grid);
      const actions = el('div', undefined, 'operation-actions');
      if (m.id === 'selection') actions.append(link('打开对话选人工作区 ↗', './selection.html'));
      if (m.id === 'drafts') actions.append(link('查看全部草稿任务 ↗', './drafts.html'));
      if (m.id === 'reply' || m.id === 'messages') actions.append(btn('查看谈判总览', 'secondary', () => { setView({ tab: 'conversations' }); loadConversations(); }));
      if (!state.status?.available) actions.append(btn('迁入数据或建立空白工作台', 'secondary', showData));
      else actions.append(el('p', (state.status.mode === 'local' ? '本地工作台 · ' : '历史兼容来源 · ') + (state.home?.items.length ?? '—') + ' 位达人。选择下方达人即可处理此模块。', 'hint'));
      root.append(actions);
      if (m.id === 'review') {
        root.append(el('p', '7日回复率以首次尝试满7日的达人为分母；自动回复不算真人回复，无成熟样本保持未知。', 'hint'));
        const first = state.home?.items[0]; if (first && facts) root.append(facts.render(first.id, 'export'));
      }
      $('wb-list-title').textContent = m.title + ' · 达人列表'; $('wb-list-hint').textContent = '选择达人，在' + m.title + '模块处理对应记录；可继续使用搜索与筛选。';
    }
    async function selectModule(id, moduleId) {
      const selected = moduleId || id; if (!MODULES.some(m => m.id === selected)) return;
      setView({ module: selected, tab: 'creators' }); renderModuleOverview();
      if (state.current) renderDetail(); else renderEmptyDetail();
      if (selected === 'review' && state.home?.items[0] && facts && !facts.state(state.home.items[0].id).context) await facts.load(state.home.items[0].id);
    }
    function renderDataStatus() {
      const d = state.dataStatus;
      $('wb-data-state').textContent = d ? (d.message || (d.initialized ? '本地工作台已建立。' : '尚未建立本地数据，可迁入已有记录或创建空白工作台。')) : '本地状态尚未读到；业务模块和说明仍可查看。';
      const counts = $('wb-data-counts'); counts.replaceChildren();
      for (const [key, label] of [['creators','达人'],['drafts','文案'],['events','事实'],['messages','消息'],['negotiations','谈判摘要']]) if (d?.counts?.[key] !== undefined) counts.append(el('span', label + ' ' + d.counts[key], 'tag neutral'));
      const migration = $('wb-migration-summary'); migration.replaceChildren();
      if (d?.migration) { migration.append(el('p', '已有数据已迁入本地工作台；源数据库保留不变。', 'hint')); if (d.migration.sourcePath) migration.append(el('p', '来源：' + d.migration.sourcePath, 'path')); if (d.migration.destinationPath) migration.append(el('p', '本地位置：' + d.migration.destinationPath, 'path')); const time = d.migration.importedAt || d.migration.createdAt; if (time) migration.append(el('p', '迁入时间：' + formatTime(time), 'hint')); }
      $('wb-local-init').textContent = d?.initialized && !d.active ? '启用已有本地工作台' : '创建空白工作台'; $('wb-local-init').disabled = state.dataBusy || d?.active === true;
      $('wb-import-path').disabled = state.dataBusy || d?.initialized === true;
      $('wb-import-preview').disabled = state.dataBusy || d?.initialized === true;
      $('wb-data-refresh').disabled = state.dataBusy;
      if (d?.initialized) migration.append(el('p', '当前库已有初始化记录，迁入不会覆盖它。', 'hint'));
      renderImportPreview();
    }
    async function refreshDataStatus() {
      try { state.dataStatus = await client.run('local-workbench-status'); }
      catch (error) { state.dataStatus = null; state.importError = '本地状态读取失败：' + error.message; }
      renderDataStatus();
    }
    function renderImportPreview() {
      const root = $('wb-import-result'); root.replaceChildren();
      if (state.importError) root.append(el('p', state.importError, 'operation-error'));
      const p = state.importPreview; if (!p) return;
      root.append(el('h3', '迁入预览'), el('p', '来源：' + p.sourcePath, 'path'), el('p', '本地目标：' + p.destinationPath, 'path'));
      const labels = { creators: '达人', drafts: '文案', events: '事实', messages: '消息', negotiations: '谈判摘要', audit: '审计记录', meta: '元数据' };
      const list = el('div', undefined, 'data-counts'); for (const table of p.tables || []) list.append(el('span', (labels[table.name] || table.name) + '：' + table.count, 'tag neutral')); root.append(list, el('p', '共 ' + p.totalRows + ' 行；按预览摘要核对后迁入，已有本地数据不会被覆盖。', 'hint'));
      if (p.message) root.append(el('p', p.message, 'hint'));
      if (Array.isArray(p.warnings)) for (const warning of p.warnings) root.append(el('p', warning, 'report-missing'));
      if (p.canImport !== true || !p.sourceDigest) { root.append(el('p', '本次预览不能迁入，请核对来源文件与本地库状态。', 'report-missing')); return; }
      const label = el('label', undefined, 'fact-check'), check = el('input'); check.type = 'checkbox'; check.id = 'wb-import-confirm'; check.disabled = state.dataBusy;
      label.append(check, el('span', '我已核对来源与数量，确认将这些记录迁入新的本地工作台。源库保持不变。'));
      const save = btn('确认迁入这份数据', 'primary', () => importWorkbench()); save.id = 'wb-import-save'; save.disabled = true;
      check.addEventListener('change', () => { save.disabled = state.dataBusy || !check.checked; }); root.append(label, save);
    }
    async function previewImport() {
      if (state.dataBusy || state.dataStatus?.initialized) return;
      const sourcePath = $('wb-import-path').value.trim();
      if (!sourcePath.startsWith('/')) { state.importError = '请填写源数据库文件的绝对路径。'; renderImportPreview(); return; }
      state.dataBusy = true; state.importPreview = null; state.importError = ''; state.importPath = sourcePath; renderDataStatus();
      try { const preview = await client.run('preview-workbench-import', { sourcePath }); if (typeof preview.sourcePath !== 'string' || typeof preview.destinationPath !== 'string' || !Array.isArray(preview.tables) || !/^[0-9a-f]{64}$/.test(preview.sourceDigest || '')) throw new Error('迁入预览缺少可核对的来源、目标或摘要。'); state.importPath = preview.sourcePath; state.importPreview = preview; }
      catch (error) { state.importError = '迁入预览失败：' + error.message; }
      finally { state.dataBusy = false; renderDataStatus(); }
    }
    async function importWorkbench() {
      if (state.dataBusy || !$('wb-import-confirm')?.checked || !state.importPreview?.sourceDigest) return;
      const input = { sourcePath: state.importPath, expectedSourceDigest: state.importPreview.sourceDigest, confirmed: true };
      state.dataBusy = true; state.importError = ''; renderDataStatus();
      try { const receipt = await client.run('import-workbench', input); if (receipt.status !== 'imported' || receipt.sourceDigest !== input.expectedSourceDigest || receipt.sourcePath !== input.sourcePath) throw new Error('迁入回执与已确认预览不一致。'); state.importPreview = null; notice('已有数据已迁入本地工作台，正在读取达人记录。'); await start(); }
      catch (error) { state.importPreview = null; await refreshDataStatus(); const receipt = state.dataStatus?.migration; if (state.dataStatus?.active && receipt?.sourceDigest === input.expectedSourceDigest && receipt?.sourcePath === input.sourcePath) { state.importError = ''; notice('已从本地迁入记录核对原操作成功，正在读取达人。'); await start(); } else state.importError = '迁入尚未完成：' + error.message + '。请重新读取本地状态，核对后再预览。'; }
      finally { state.dataBusy = false; renderDataStatus(); }
    }
    async function initializeLocal() {
      if (state.dataBusy || state.dataStatus?.active) return;
      state.dataBusy = true; state.importError = ''; renderDataStatus();
      try { await client.run('local-workbench-init', { confirmed: true }); state.importPreview = null; await start(); }
      catch (error) { state.importError = '建立工作台失败：' + error.message; }
      finally { state.dataBusy = false; renderDataStatus(); }
    }
    async function start() {
      await refreshDataStatus();
      try {
        state.status = await client.run('outreach-status'); bindFacts(state.status.url || 'unconfigured');
        if (!state.status.available) { $('wb-data').open = true; notice('新工作台尚无可用本地数据。可迁入已有记录或创建空白工作台，所有模块仍可查看。'); renderList(); renderEmptyDetail(); renderModuleOverview(); return; }
        await loadHome(); renderTabs(); renderModuleOverview();
        if (state.view.creator) await openCreator(state.view.creator);
        else renderEmptyDetail();
        if (state.view.tab === 'conversations') loadConversations();
        if (state.view.module === 'review' && state.home.items[0]) await facts.load(state.home.items[0].id);
      } catch (error) { state.status = null; state.home = null; state.current = null; notice('本地工作台数据读取失败：' + error.message + '。仍可切换模块或打开数据管理重试。', true); renderList(); renderModuleOverview(); renderEmptyDetail(); }
    }
    async function loadHome() {
      state.home = await client.run('workbench-home');
      renderStats(); renderTodo(); renderFilters(); renderList(); renderModuleOverview();
      notice(state.status?.mode === 'local' ? '本地工作台已就绪：' + state.home.items.length + ' 位达人。业务数据直接保存在本工作台。' : '历史兼容来源：' + state.home.items.length + ' 位达人。请在数据管理中迁入或启用本地工作台。');
    }
    function renderStats() {
      const s = state.home.summary || {};
      const rate = s.reply7_rate === null || s.reply7_rate === undefined ? '暂无' : s.reply7_rate + '%';
      const cards = [['达人', s.total], ['已触达', s.started], ['已回复', s.responded], ['有意向', s.interested], ['确认合作', s.confirmed], ['7日回复率', rate], ['到期跟进', s.due]];
      $('wb-stats').replaceChildren(...cards.map(([k, v]) => { const c = el('div', undefined, 'wb-stat'); c.append(el('strong', v ?? '—'), el('span', k)); return c; }));
    }
    function todoItem(item, sub, moduleId) {
      const b = btn('', 'wb-todo-item', () => { selectModule(moduleId); openCreator(item.id); }); b.disabled = false;
      b.append(el('strong', item.id), el('span', ' @' + item.handle), el('span', sub, 'hint'));
      return b;
    }
    function renderTodo() {
      const t = state.home.todo;
      const fill = (id, list, sub, empty) => { $(id).replaceChildren(...(list.length ? list.map(x => todoItem(x, sub(x), id === 'todo-reply' ? 'messages' : id === 'todo-due' ? 'followup' : 'reply')) : [el('p', empty, 'hint')])); $(id + '-count').textContent = list.length || ''; };
      fill('todo-reply', t.awaitingReply, x => (CHANNEL_LABEL[x.channel] || x.channel) + ' · ' + formatTime(x.since) + ' 来信', '没有等待我方回复的来信。');
      fill('todo-due', t.due, x => '跟进日 ' + x.next_followup, '没有到期的跟进。');
      fill('todo-adopt', t.pendingAdoption, x => x.count + ' 处候选待比较', '没有待采用的草稿或摘要。');
    }
    function renderFilters() {
      for (const [id, key] of [['wb-priority', 'priority'], ['wb-stage', 'stage']]) {
        const sel = $(id); const keep = sel.value;
        const values = [...new Set(state.home.items.map(c => c[key]).filter(Boolean))].sort();
        sel.replaceChildren(sel.options[0], ...values.map(v => { const o = el('option', v); o.value = v; return o; }));
        sel.value = values.includes(keep) ? keep : '';
      }
    }
    function renderList() {
      const list = $('wb-creators'); list.replaceChildren();
      if (!state.home) { list.append(el('p', '尚无可显示的数据。可打开数据管理迁入已有记录或建立空白工作台。', 'hint')); return; }
      const rows = filterCreators(state.home.items, { q: $('wb-search').value, priority: $('wb-priority').value, stage: $('wb-stage').value, hasMessages: $('wb-has-messages').checked });
      for (const c of rows) {
        const row = el('div', undefined, 'wb-row' + (state.current?.id === c.id ? ' active' : ''));
        const box = el('input'); box.type = 'checkbox'; box.checked = state.selected.has(c.id); box.setAttribute('aria-label', '选择 ' + c.id);
        box.disabled = !box.checked && state.selected.size >= MAX_BATCH;
        box.addEventListener('change', () => { if (box.checked) state.selected.add(c.id); else state.selected.delete(c.id); renderList(); });
        const open = btn('', 'wb-row-open', () => openCreator(c.id)); open.disabled = false;
        const head = el('span', undefined, 'wb-row-head'); head.append(el('strong', c.id), el('span', '@' + c.handle));
        const tags = el('span', undefined, 'wb-row-tags');
        tags.append(el('span', c.stage || '未知阶段', 'tag neutral'));
        if (c.awaitingReply) tags.append(el('span', '待回复', 'tag warn'));
        if (c.due) tags.append(el('span', '到期跟进', 'tag warn'));
        if (c.pendingProposals) tags.append(el('span', c.pendingProposals + ' 处候选', 'tag'));
        open.append(head, el('span', c.topic || '', 'hint'), tags);
        row.append(box, open); list.append(row);
      }
      if (!rows.length) list.append(el('p', '没有符合条件的达人。', 'hint'));
      $('wb-selected').textContent = state.selected.size ? '已选 ' + state.selected.size + ' / ' + MAX_BATCH + ' 位' : '未选择';
      $('wb-batch-drafts').disabled = state.busy || !state.selected.size;
    }

    // —— 达人详情 ——
    async function openCreator(id) {
      const generation = ++state.generation;
      setView({ creator: id, tab: 'creators' });
      $('wb-detail').replaceChildren(el('p', '正在读取 ' + id + '…', 'hint'));
      try {
        const data = await client.run('workbench-creator', { creatorId: id });
        if (generation !== state.generation) return; if (data.sourceUrl !== state.status.url) throw new Error('当前数据来源已在其他页面变化，请刷新本地状态后重新选择达人；原人工输入已按来源保留。'); state.current = { id, data }; renderDetail(); renderList(); await facts.load(id);
      } catch (error) { $('wb-detail').replaceChildren(el('p', '读取失败：' + error.message, 'operation-error')); }
    }
    async function reloadCurrent() { if (state.current) await openCreator(state.current.id); try { state.home = await client.run('workbench-home'); renderStats(); renderTodo(); renderList(); } catch (_) { /* 总览刷新失败不影响详情 */ } }
    function section(title, ...actions) {
      const s = el('section', undefined, 'wb-section'); const h = el('div', undefined, 'section-head');
      h.append(el('h3', title)); if (actions.length) { const a = el('div', undefined, 'operation-actions'); a.append(...actions); h.append(a); }
      s.append(h); return s;
    }
    function renderDetail() {
      const d = state.current.data; const p = d.profile; const box = $('wb-detail'); box.replaceChildren();
      const head = el('header', undefined, 'wb-detail-head');
      const title = el('div'); title.append(el('h2', '@' + p.handle), el('p', [p.id, p.priority, d.stage].filter(Boolean).join(' · '), 'hint'));
      const links = el('div', undefined, 'wb-links');
      for (const [label, key] of [['TikTok', 'tiktok_url'], ['联盟后台', 'affiliate_url'], ['Kalodata', 'kalodata_url']]) { const href = safeHttps(p[key]); if (href) links.append(link(label + ' ↗', href)); }
      title.append(links);
      const actions = el('div', undefined, 'operation-actions');
      actions.append(btn('生成邀约草稿', 'primary', () => openDialog('drafts', [p.id])));
      const replyBtn = btn('总结对话并拟回复', 'secondary', () => openDialog('reply', [p.id]));
      if (!d.messages?.length) { replyBtn.disabled = true; replyBtn.title = '还没有登记往来消息'; }
      actions.append(replyBtn);
      head.append(title, actions); box.append(head);
      if (d.gates?.length) { const g = el('div', undefined, 'wb-gates'); g.append(el('span', '当前记录提示（不代表模块完成或发送许可）', 'hint')); for (const x of d.gates) g.append(el('span', x, 'tag warn')); box.append(g); }
      if (d.operations?.length) box.append(renderOperations(d.operations));
      const active = currentModule().id;
      const panels = el('div', undefined, 'workflow-panels');
      for (const m of MODULES) {
        const panel = el('section', undefined, 'workflow-panel'); panel.dataset.modulePanel = m.id; panel.hidden = m.id !== active;
        panel.append(el('h3', m.title), el('p', m.mode, 'workflow-mode'));
        const info = el('details', undefined, 'workflow-guide'); info.append(el('summary', '查看依赖、允许动作与结果去向'));
        for (const [label, value] of [['依赖', m.needs], ['允许动作', m.actions], ['结果去向', m.target]]) info.append(el('p', label + '：' + value)); panel.append(info);
        if (m.id === 'selection') panel.append(renderProfile(d), link('打开对话选人工作区 ↗', './selection.html'));
        if (['verification', 'cooperation', 'followup'].includes(m.id)) panel.append(facts.render(p.id, m.id));
        if (m.id === 'drafts') panel.append(renderDrafts(d, ['comment', 'dm', 'email', 'affiliate']));
        if (m.id === 'outreach') panel.append(facts.render(p.id, 'outreach'), renderEvents(d, 'outreach'));
        if (m.id === 'messages') panel.append(renderConversation(d), facts.render(p.id, 'message'));
        if (m.id === 'reply') panel.append(btn('总结对话并拟回复', 'secondary', () => openDialog('reply', [p.id])), renderNegotiation(d));
        if (m.id === 'followup') panel.append(renderDrafts(d, ['followup']));
        if (m.id === 'fulfilment') panel.append(facts.render(p.id, 'fulfilment'), renderEvents(d, 'fulfilment'));
        if (m.id === 'review') panel.append(el('p', '此处查看当前达人的事实；全部达人导出位于本页复盘模块概览。', 'hint'), renderEvents(d));
        panels.append(panel);
      }
      box.append(panels);
    }
    function renderOperations(ops) {
      const s = section('相关任务');
      for (const op of ops) {
        const row = el('div', undefined, 'wb-op');
        row.append(el('strong', op.mode === 'reply' ? '总结对话并拟回复' : '生成邀约草稿'), el('span', formatTime(op.createdAt), 'hint'), el('span', OP_STATUS[op.status] || op.status, 'tag' + (op.status === 'accepted' ? '' : ' warn')));
        const l = taskLink(op); if (l) row.append(l);
        if (op.status !== 'accepted') row.append(btn('重试投递', 'subtle', () => retryOperation(op.id)));
        s.append(row);
      }
      return s;
    }
    function renderConversation(d) {
      const s = section('往来对话', ...(d.messages?.length ? [btn('总结这段对话并拟回复', 'subtle', () => openDialog('reply', [d.profile.id]))] : []));
      const msgs = [...(d.messages || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      if (!msgs.length) { s.append(el('p', '还没有登记往来消息。可在下方人工登记已有原文，或使用已验证的外部导入流程。', 'hint')); return s; }
      const list = el('div', undefined, 'wb-thread');
      for (const m of msgs) {
        const b = el('div', undefined, 'wb-msg ' + (m.direction === 'in' ? 'in' : 'out') + (m.kind === '自动回复' ? ' auto' : ''));
        b.append(el('div', (m.direction === 'in' ? '对方' : '我方') + ' · ' + (CHANNEL_LABEL[m.channel] || m.channel) + ' · ' + formatTime(m.at) + (m.kind === '自动回复' ? ' · 自动回复' : ''), 'hint'));
        if (m.zh) b.append(el('p', m.zh));
        const det = el('details'); det.append(el('summary', m.zh ? '原文' : '原文（无中文摘要）'));
        if (m.subject) det.append(el('p', m.subject, 'draft-subject'));
        det.append(el('pre', m.body, 'snapshot')); if (!m.zh) det.open = true;
        b.append(det); list.append(b);
      }
      s.append(list); return s;
    }
    function fieldsTable(fields) {
      const t = el('dl', undefined, 'wb-fields');
      for (const k of Object.keys(NEGOTIATION_LABEL)) { t.append(el('dt', NEGOTIATION_LABEL[k]), el('dd', fields?.[k] || '—')); }
      return t;
    }
    function renderNegotiation(d) {
      const s = section('谈判摘要');
      if (d.negotiation) { s.append(fieldsTable(d.negotiation), el('p', '工作台记录 · 更新于 ' + formatTime(d.negotiation.updated), 'hint')); }
      else s.append(el('p', '工作台还没有谈判摘要。', 'hint'));
      const byId = new Map((d.messages || []).map(m => [m.id, m]));
      for (const p of [...(d.negotiationProposals || [])].sort((a, b) => b.version - a.version)) {
        const c = el('div', undefined, 'draft-version');
        c.append(el('strong', '候选摘要 第 ' + p.version + ' 版'), el('span', ' ' + formatTime(p.createdAt), 'hint'));
        if (p.baseChanged) c.append(el('p', '工作台的谈判摘要在任务发起后已被修改，采用前请对照。', 'report-missing'));
        c.append(fieldsTable(p.fields));
        const basis = el('p', '依据：', 'hint');
        basis.append(...p.basis.map((id, i) => { const m = byId.get(id); return el('span', (i ? '、' : '') + (m ? (m.direction === 'in' ? '对方' : '我方') + ' ' + formatTime(m.at) : '已不在工作台的消息')); }));
        c.append(basis);
        if (p.note) c.append(el('p', '说明：' + p.note, 'hint'));
        c.append(adoptNegotiationControls(p)); s.append(c);
      }
      return s;
    }
    function adoptNegotiationControls(p) {
      const row = el('div', undefined, 'operation-actions'); const action = negotiationAction(p);
      if (p.adoption) row.append(el('span', ADOPT_LABEL[p.adoption.status] || p.adoption.status, 'tag' + (p.adoption.status === 'adopted' ? '' : ' warn')));
      if (action.kind === 'adopt') row.append(btn(action.confirm ? '替换已修改的摘要' : '采用此摘要', 'secondary', () => adoptNegotiation(p, action)));
      if (action.kind === 'retry') row.append(btn('用原编号核对', 'secondary', () => adoptNegotiation(p, action)));
      if (action.kind === 'same') row.append(el('span', '与工作台当前摘要一致', 'hint'));
      if (p.adoption?.message && p.adoption.status !== 'adopted') row.append(el('span', p.adoption.message, 'operation-error'));
      return row;
    }
    async function adoptNegotiation(p, action) {
      if (action.confirm && !window.confirm('@' + p.handle + ' 的谈判摘要在任务发起后已被修改。采用会替换当前摘要，是否继续？')) return;
      state.busy = true;
      try {
        const r = await client.run('adopt-negotiation', { proposalId: p.proposalId, adoptionId: action.adoptionId || newId('an'), expectedUpdated: action.expectedUpdated });
        notice(r.status === 'adopted' ? '谈判摘要已写入工作台并读回一致。' : (ADOPT_LABEL[r.status] || r.status) + '：' + (r.message || ''), r.status !== 'adopted');
      } catch (error) { notice('采用未完成：' + error.message, true); }
      finally { state.busy = false; await reloadCurrent(); }
    }
    function manualWarning(list) { return list?.length ? el('p', '含需人工替换的占位符：' + list.join('、') + '。发送前请替换。', 'report-missing') : null; }
    function renderDrafts(d, channels) {
      const s = section('文案');
      const proposals = d.proposals || [];
      for (const dr of d.drafts.filter(dr => !channels || channels.includes(dr.channel))) {
        const card = el('div', undefined, 'wb-draft');
        const h = el('div', undefined, 'section-head'); h.append(el('h4', dr.label + ' · 版本 ' + dr.revision));
        const editBtn = btn('编辑', 'subtle', () => toggleEditor(card, dr)); h.append(editBtn); card.append(h);
        if (dr.rendered_subject) card.append(el('p', '主题：' + dr.rendered_subject, 'draft-subject'));
        card.append(el('pre', dr.rendered, 'snapshot'));
        const w = manualWarning(dr.manualPlaceholders); if (w) card.append(w);
        const mine = proposals.filter(p => p.channel === dr.channel).sort((a, b) => b.version - a.version || String(b.createdAt).localeCompare(String(a.createdAt)));
        if (mine.length) {
          const det = el('details', undefined, 'wb-proposals'); det.open = mine.some(p => p.adoption?.status !== 'adopted');
          det.append(el('summary', mine.length + ' 个候选版本'));
          for (const p of mine) det.append(renderProposal(p));
          card.append(det);
        }
        const editor = editorFor(d.profile.id, dr); if (editor?.open) card.append(renderEditor(d.profile.id, dr, editor));
        s.append(card);
      }
      s.append(el('p', '工作台按合作设置替换【固定费】【佣金比例】【姓名】。合作设置请在「合作准备」人工核对，已发生的事实请在对应模块登记。', 'hint'));
      return s;
    }
    function renderProposal(p) {
      const c = el('div', undefined, 'draft-version');
      c.append(el('strong', (p.mode === 'reply' ? '回复草稿' : '邀约草稿') + ' 第 ' + p.version + ' 版'), el('span', ' ' + formatTime(p.createdAt), 'hint'));
      if (p.baseChanged) c.append(el('p', '工作台文案在任务发起后已被修改（发起时版本 ' + p.baseRevision + '）。', 'report-missing'));
      else if (p.changedByAdoption) c.append(el('p', '当前文案来自本任务已采用的版本。', 'hint'));
      if (p.subject) c.append(el('p', '主题：' + p.subject, 'draft-subject'));
      c.append(el('pre', p.body, 'snapshot'));
      const w = manualWarning(p.manualPlaceholders); if (w) c.append(w);
      if (p.note) c.append(el('p', '说明：' + p.note, 'hint'));
      const row = el('div', undefined, 'operation-actions'); const action = Drafts.adoptAction(p);
      if (p.adoption) row.append(el('span', ADOPT_LABEL[p.adoption.status] || p.adoption.status, 'tag' + (p.adoption.status === 'adopted' ? '' : ' warn')));
      if (action.kind === 'adopt') row.append(btn(action.confirm ? '替换已修改的文案' : '采用此版本', 'secondary', () => adoptDraft(p, action)));
      if (action.kind === 'retry') row.append(btn('用原编号核对', 'secondary', () => adoptDraft(p, action)));
      if (action.kind === 'same') row.append(el('span', '与工作台当前文案一致', 'hint'));
      if (p.adoption?.message && p.adoption.status !== 'adopted') row.append(el('span', p.adoption.message, 'operation-error'));
      c.append(row); return c;
    }
    async function adoptDraft(p, action) {
      if (action.confirm && !window.confirm('@' + p.handle + ' 的' + p.label + '在任务发起后已被修改（发起时版本 ' + p.baseRevision + '，当前版本 ' + p.current.revision + '）。采用会替换当前文案，是否继续？')) return;
      state.busy = true;
      try {
        const r = await client.run('adopt-draft', { proposalId: p.proposalId, adoptionId: action.adoptionId || newId('ad'), expectedRevision: action.expectedRevision });
        notice(r.status === 'adopted' ? p.label + '已写入工作台并读回一致。' : (ADOPT_LABEL[r.status] || r.status) + '：' + (r.message || ''), r.status !== 'adopted');
      } catch (error) { notice('采用未完成：' + error.message, true); }
      finally { state.busy = false; await reloadCurrent(); }
    }
    function editorKey(id, channel) { return 'gapaw-creator-workbench:editor:v2:' + encodeURIComponent(state.status?.url || 'unconfigured') + ':' + id + ':' + channel; }
    function editorFor(id, dr) {
      const key = editorKey(id, dr.channel); if (!(key in state.editors)) { try { state.editors[key] = JSON.parse(window.localStorage.getItem(key)); } catch (_) { state.editors[key] = null; } } return state.editors[key];
    }
    function saveEditor(id, channel, value) {
      const key = editorKey(id, channel); state.editors[key] = value;
      try { if (value) window.localStorage.setItem(key, JSON.stringify(value)); else window.localStorage.removeItem(key); return true; } catch (_) { notice('人工文案暂存失败，请保留本页和输入。', true); return false; }
    }
    function toggleEditor(card, dr) {
      const id = state.current.id; const existing = card.querySelector('.wb-editor');
      if (existing) { existing.remove(); const draft = editorFor(id, dr); if (draft) { draft.open = false; saveEditor(id, dr.channel, draft); } return; }
      const draft = editorFor(id, dr) || { expectedSource: state.current.data.expectedSource, subject: dr.subject || '', body: dr.body, revision: dr.revision, status: '', open: true };
      draft.open = true; saveEditor(id, dr.channel, draft); card.append(renderEditor(id, dr, draft));
    }
    function renderEditor(id, dr, draft) {
      const form = el('div', undefined, 'wb-editor'); let subject = null;
      if (dr.channel === 'email' || dr.subject) { subject = el('input'); subject.value = draft.subject; subject.maxLength = 300; subject.setAttribute('aria-label', '主题'); subject.addEventListener('input', () => { draft.subject = subject.value; saveEditor(id, dr.channel, draft); }); form.append(subject); }
      const body = el('textarea'); body.value = draft.body; body.rows = 10; body.maxLength = 10000; body.setAttribute('aria-label', '正文'); body.addEventListener('input', () => { draft.body = body.value; saveEditor(id, dr.channel, draft); }); form.append(body);
      form.append(el('p', '人工输入暂存在本浏览器；按原文案版本 ' + draft.revision + ' 保存。金额保留【固定费】等占位符。刷新或冲突不会覆盖你的输入。', 'hint'));
      if (draft.status) form.append(el('p', draft.status, 'report-missing'));
      if (dr.revision !== draft.revision || draft.expectedSource !== state.current.data.expectedSource) {
        const compare = el('details'); compare.append(el('summary', '查看工作台当前版本 ' + dr.revision), el('pre', dr.body, 'snapshot')); form.append(compare);
        form.append(btn('以当前版本为依据，保留我的输入', 'secondary', () => { draft.revision = dr.revision; draft.expectedSource = state.current.data.expectedSource; draft.status = '请核对差异，再决定是否保存人工输入。'; saveEditor(id, dr.channel, draft); renderDetail(); }));
      }
      const row = el('div', undefined, 'operation-actions');
      row.append(btn('保存到工作台', 'primary', async () => {
        if (state.busy) return; if (!draft.expectedSource) { notice('人工文案缺少工作台来源，请重新读取并明确采用当前版本为依据。', true); return; } const submitted = { creatorId: id, expectedSource: draft.expectedSource, channel: dr.channel, subject: draft.subject, body: draft.body, revision: draft.revision };
        if (!saveEditor(id, dr.channel, draft)) return; state.busy = true;
        try {
          const r = await client.run('edit-draft', submitted);
          const message = { saved: '已保存并读回一致。', conflict: '文案已被他人更新，人工输入已保留；请对照当前版本。', not_applied: '工作台未写入，人工输入已保留。', rejected: '工作台拒绝保存：' + (r.message || ''), unknown: '保存结果未知；保留原版本和人工输入，请刷新核对。' }[r.status] || '保存状态尚未确认。';
          if (r.status === 'saved') saveEditor(id, dr.channel, null); else { draft.status = message; saveEditor(id, dr.channel, draft); }
          notice(message, r.status !== 'saved');
        } catch (error) { draft.status = '保存未确认：' + error.message + '。原内容已保留。'; saveEditor(id, dr.channel, draft); notice(draft.status, true); }
        finally { state.busy = false; await reloadCurrent(); }
      }), btn('收起并保留输入', 'subtle', () => { draft.open = false; saveEditor(id, dr.channel, draft); form.remove(); }));
      form.append(row); return form;
    }
    function renderEvents(d, kind) {
      const s = section('事实台账');
      const events = [...(d.events || [])].filter(e => !kind || (kind === 'fulfilment' ? ['寄样', '已发片'].includes(e.type) : !['寄样', '已发片'].includes(e.type))).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      if (!events.length) { s.append(el('p', '还没有登记触达事实。', 'hint')); return s; }
      const list = el('ul', undefined, 'wb-events');
      for (const e of events) {
        const li = el('li', undefined, e.void_reason ? 'void' : '');
        li.append(el('strong', e.type), el('span', ' · ' + (CHANNEL_LABEL[e.channel] || e.channel || '') + ' · ' + formatTime(e.at), 'hint'));
        if (e.note) li.append(el('p', e.note));
        if (e.void_reason) li.append(el('p', '已撤销：' + e.void_reason, 'hint'));
        list.append(li);
      }
      const det = el('details'); det.append(el('summary', events.length + ' 条记录（含已撤销）'), list); s.append(det);
      return s;
    }
    function renderProfile(d) {
      const p = d.profile, st = d.settings || {};
      const s = section('选人历史档案');
      const t = el('dl', undefined, 'wb-fields');
      const rows = [['选题', p.topic], ['角度', p.angle], ['商品', [p.anchor1, p.anchor2].filter(Boolean).join(' / ')], ['粉丝', p.followers], ['联盟成交额（美元）', p.affiliate_gmv_usd], ['宠物成交占比', p.pet_gmv_share_pct == null ? null : p.pet_gmv_share_pct + '%'], ['统计期', p.kalodata_window], ['采集日期', p.data_collected], ['历史', p.history],
        ['固定费（美元）', st.fee], ['佣金比例', st.commission === null || st.commission === undefined ? '未填' : st.commission + '%'], ['署名', st.sender || '未填'], ['负责人', st.owner || '未填'], ['下次跟进', st.next_followup || '未设'], ['邮箱', st.email || '未登记'], ['备注', st.notes]];
      for (const [k, v] of rows) if (v !== undefined && v !== null && v !== '') t.append(el('dt', k), el('dd', v));
      s.append(t, el('p', '资料为历史快照，不等于当前实测。人工核验和合作设置在对应模块修改。', 'hint'));
      if (p.selectionSnapshot?.candidate) {
        const snap = p.selectionSnapshot, c = snap.candidate;
        s.append(el('h4', '已采用的选人资料 · 第 ' + snap.revision + ' 版'), el('p', '名单保存于 ' + formatTime(snap.savedAt) + '；以下资料仍需核验。', 'hint'));
        const facts = el('dl', undefined, 'wb-fields');
        for (const [label, value] of [['平台账号编号', c.identity.accountId || '未知'], ['市场', c.content.country || '未知'], ['语言', c.content.language || '未知'], ['类目', c.content.categories.join('、') || '未知'], ['内容适配', c.content.fit], ['适配依据', c.content.reason], ['缺失项', c.missingFields.join('；') || '未报告']]) facts.append(el('dt', label), el('dd', value));
        s.append(facts, link('查看原名单及版本 ↗', './selection.html?operation=' + encodeURIComponent(snap.operationId)));
        for (const m of c.metrics) s.append(el('p', m.name + '：' + (m.value ?? '未知') + ' ' + m.unit + ' · 来源 ' + m.sourceId + ' · ' + (m.period ? m.period.start + ' 至 ' + m.period.end + '（' + m.period.timeZone + '）' : '时点数据，采集时间见来源')));
        for (const contact of c.contacts) s.append(el('p', '待核验联系方式：' + contact.type + ' · ' + contact.value + ' · 来源 ' + contact.sourceId));
        for (const source of c.sources) { const row = el('p'); row.append(link(source.platform + ' · ' + source.id + ' ↗', source.url), el('span', ' · ' + source.capturedAt + ' · ' + source.note, 'hint')); s.append(row); }
      }

      return s;
    }

    // —— 谈判总览 ——
    async function loadConversations() {
      $('wb-conversations').replaceChildren(el('p', '正在读取…', 'hint'));
      try { state.conversations = (await client.run('workbench-conversations')).items; renderConversations(); }
      catch (error) { $('wb-conversations').replaceChildren(el('p', '读取失败：' + error.message, 'operation-error')); }
    }
    function renderConversations() {
      const box = $('wb-conversations'); box.replaceChildren();
      if (!state.conversations.length) { box.append(el('p', '还没有登记往来对话。', 'empty')); return; }
      for (const c of state.conversations) {
        const card = el('article', undefined, 'operation wb-conv');
        const head = el('div', undefined, 'operation-head');
        const t = el('div'); t.append(el('h3', c.id + ' @' + c.handle), el('p', [c.priority, c.stage, c.lastAt ? '最近 ' + formatTime(c.lastAt) : ''].filter(Boolean).join(' · '), 'hint'));
        const tags = el('div', undefined, 'operation-actions');
        if (c.awaitingReply) tags.append(el('span', '待我方回复', 'tag warn'));
        tags.append(btn('查看', 'subtle', () => openCreator(c.id)), btn('总结对话并拟回复', 'secondary', () => openDialog('reply', [c.id])));
        head.append(t, tags); card.append(head);
        if (c.negotiation) card.append(fieldsTable(c.negotiation));
        const last = [...c.messages].sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
        if (last) card.append(el('p', '最新：' + (last.direction === 'in' ? '对方' : '我方') + ' · ' + (last.zh || String(last.body).slice(0, 160)), 'operation-description'));
        box.append(card);
      }
    }
    function renderTabs() {
      const conv = state.view.tab === 'conversations';
      $('panel-creators').hidden = conv; $('panel-conversations').hidden = !conv;
      $('tab-creators').setAttribute('aria-selected', String(!conv)); $('tab-conversations').setAttribute('aria-selected', String(conv));
    }

    // —— 交给 MultiCC ——
    function readRuntime() { try { return JSON.parse(window.localStorage.getItem(RUNTIME_KEY)) || {}; } catch (_) { return {}; } }
    function openDialog(mode, ids) {
      if (!ids.length) return;
      state.dialog = { mode, ids };
      const names = ids.map(id => { const c = state.home?.items.find(x => x.id === id); return c ? id + '（@' + c.handle + '）' : id; });
      $('task-title').textContent = mode === 'reply' ? '总结对话并拟回复' : '生成邀约草稿';
      $('task-target').textContent = (mode === 'reply' ? '对象：' : '对象（' + ids.length + ' 位）：') + names.join('、');
      $('task-channels').hidden = mode === 'reply'; $('task-slot-wrap').hidden = mode !== 'reply';
      $('task-prompt').value = PROMPTS[mode];
      const rt = readRuntime(); $('task-cli').value = rt.cli || ''; $('task-model').value = rt.model || '';
      dialogControls();
      if (typeof $('task-dialog').showModal === 'function') $('task-dialog').showModal(); else $('task-dialog').setAttribute('open', '');
    }
    function dialogChannels() {
      if (state.dialog?.mode === 'reply') return [$('task-slot').value];
      return [...document.querySelectorAll('input[name=wb-channel]:checked')].map(n => n.value);
    }
    function dialogControls() { $('task-send').disabled = state.busy || !state.dialog || !$('task-cli').value || !$('task-prompt').value.trim() || !dialogChannels().length; }
    function closeDialog() { if (typeof $('task-dialog').close === 'function') $('task-dialog').close(); else $('task-dialog').removeAttribute('open'); }
    async function sendTask() {
      if ($('task-send').disabled) return;
      const { mode, ids } = state.dialog;
      const runtime = { cli: $('task-cli').value }; if ($('task-model').value.trim()) runtime.model = $('task-model').value.trim();
      try { window.localStorage.setItem(RUNTIME_KEY, JSON.stringify({ cli: runtime.cli, model: runtime.model || '' })); } catch (_) { /* 本地暂存不可用不影响发送 */ }
      state.busy = true; dialogControls();
      try {
        const op = (await client.run('prepare-drafts', { requestId: newId('req_' + mode), mode, creatorIds: ids, channels: dialogChannels(), prompt: $('task-prompt').value.trim(), runtime })).operation;
        const done = await dispatcher.dispatch(op, () => {});
        closeDialog(); if (mode === 'drafts') state.selected.clear();
        notice('已交给 MultiCC。结果交回后会出现在对应达人的「文案」' + (mode === 'reply' ? '和「谈判摘要」' : '') + '里，等你比较并采用。', false, taskLink(done));
      } catch (error) { notice('发送未完成：' + error.message + '。可在达人详情的「相关任务」里重试，原任务编号会保留。', true); closeDialog(); }
      finally { state.busy = false; dialogControls(); await reloadCurrent(); }
    }
    async function retryOperation(id) {
      state.busy = true;
      try {
        const op = (await client.run('list-operations')).operations.find(o => o.id === id);
        if (!op) throw new Error('操作记录不存在');
        const done = await dispatcher.dispatch(op, () => {});
        notice('已重新投递。', false, taskLink(done));
      } catch (error) { notice('重试未完成：' + error.message, true); }
      finally { state.busy = false; await reloadCurrent(); }
    }

    for (const n of $('wb-module-nav').querySelectorAll('[data-module]')) n.addEventListener('click', () => selectModule(n.dataset.module));
    $('wb-data-toggle').addEventListener('click', showData);
    $('wb-data-link').addEventListener('click', event => { event.preventDefault(); showData(); });
    $('wb-data-refresh').addEventListener('click', start);
    $('wb-local-init').addEventListener('click', initializeLocal);
    $('wb-import-preview').addEventListener('click', previewImport);
    $('wb-import-path').addEventListener('input', () => { state.importPreview = null; state.importError = ''; renderImportPreview(); });
    $('wb-refresh').addEventListener('click', start);
    for (const id of ['wb-search', 'wb-priority', 'wb-stage', 'wb-has-messages']) $(id).addEventListener(id === 'wb-search' ? 'input' : 'change', renderList);
    $('wb-batch-drafts').addEventListener('click', () => openDialog('drafts', [...state.selected]));
    $('tab-creators').addEventListener('click', () => setView({ tab: 'creators' }));
    $('tab-conversations').addEventListener('click', () => { setView({ tab: 'conversations' }); loadConversations(); });
    window.addEventListener('hashchange', () => { const v = parseHash(window.location.hash); const changed = v.creator && v.creator !== state.current?.id; state.view = v; renderTabs(); renderModuleOverview(); if (state.current && !changed) renderDetail(); else if (!v.creator) renderEmptyDetail(); if (changed) openCreator(v.creator); if (v.tab === 'conversations') loadConversations(); });
    for (const n of document.querySelectorAll('input[name=wb-channel]')) n.addEventListener('change', dialogControls);
    for (const id of ['task-cli', 'task-prompt', 'task-slot']) $(id).addEventListener(id === 'task-prompt' ? 'input' : 'change', dialogControls);
    $('task-send').addEventListener('click', sendTask);
    renderTabs(); renderModuleOverview(); renderEmptyDetail(); if (window.location.hash === '#data') showData(); start();
    return { state, get facts() { return facts; }, openCreator, openDialog, loadHome, selectModule, refreshDataStatus, previewImport, importWorkbench, initializeLocal };
  }
  return { MODULES, mount, parseHash, buildHash, filterCreators, negotiationAction, safeHttps };
}));
