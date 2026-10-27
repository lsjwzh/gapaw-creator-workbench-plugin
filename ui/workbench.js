(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./app.js') : root.GapawWorkbenchApp, node ? require('./drafts.js') : root.GapawDrafts);
  if (node) module.exports = api;
  else root.addEventListener('DOMContentLoaded', () => { if (root.document.getElementById('wb-detail')) api.mount(root.document, root); });
}(typeof window === 'undefined' ? globalThis : window, function (App, Drafts) {
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

  function parseHash(hash) {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const creator = params.get('creator');
    return { tab: params.get('tab') === 'conversations' ? 'conversations' : 'creators', creator: creator && /^[A-Za-z0-9_.:-]{1,200}$/.test(creator) ? creator : null };
  }
  function buildHash(view) {
    const params = new URLSearchParams();
    if (view.tab === 'conversations') params.set('tab', 'conversations');
    if (view.creator) params.set('creator', view.creator);
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
    const state = { status: null, home: null, selected: new Set(), current: null, conversations: null, busy: false, dialog: null, view: parseHash(window.location.hash) };
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

    // —— 连接与总览 ——
    async function start() {
      try {
        state.status = await client.run('outreach-status');
        $('wb-connect').hidden = state.status.available;
        $('wb-connect-state').textContent = state.status.message;
        if (state.status.url && !$('wb-url').value) $('wb-url').value = state.status.url;
        if (!state.status.available) { notice(state.status.configured ? '现有达人工作台暂不可用：' + state.status.message : '请先连接现有达人工作台。', state.status.configured); return; }
        await loadHome();
        renderTabs();
        if (state.view.creator) openCreator(state.view.creator);
        if (state.view.tab === 'conversations') loadConversations();
      } catch (error) { notice('读取工作台状态失败：' + error.message, true); }
    }
    async function saveURL() {
      state.busy = true;
      try { await client.run('outreach-configure', { url: $('wb-url').value.trim()}); }
      catch (error) { notice('未连接：' + error.message, true); return; }
      finally { state.busy = false; }
      await start();
    }
    async function loadHome() {
      state.home = await client.run('workbench-home');
      renderStats(); renderTodo(); renderFilters(); renderList();
      notice('已连接现有达人工作台：' + state.home.items.length + ' 位达人。数据以工作台为准，刷新即重新读取。');
    }
    function renderStats() {
      const s = state.home.summary || {};
      const rate = s.reply7_rate === null || s.reply7_rate === undefined ? '暂无' : s.reply7_rate + '%';
      const cards = [['达人', s.total], ['已触达', s.started], ['已回复', s.responded], ['有意向', s.interested], ['确认合作', s.confirmed], ['7日回复率', rate], ['到期跟进', s.due]];
      $('wb-stats').replaceChildren(...cards.map(([k, v]) => { const c = el('div', undefined, 'wb-stat'); c.append(el('strong', v ?? '—'), el('span', k)); return c; }));
    }
    function todoItem(item, sub) {
      const b = btn('', 'wb-todo-item', () => openCreator(item.id)); b.disabled = false;
      b.append(el('strong', item.id), el('span', ' @' + item.handle), el('span', sub, 'hint'));
      return b;
    }
    function renderTodo() {
      const t = state.home.todo;
      const fill = (id, list, sub, empty) => { $(id).replaceChildren(...(list.length ? list.map(x => todoItem(x, sub(x))) : [el('p', empty, 'hint')])); $(id + '-count').textContent = list.length || ''; };
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
      if (!state.home) return;
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
      setView({ creator: id, tab: 'creators' });
      $('wb-detail').replaceChildren(el('p', '正在读取 ' + id + '…', 'hint'));
      try {
        const data = await client.run('workbench-creator', { creatorId: id });
        state.current = { id, data }; renderDetail(); renderList();
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
      if (d.gates?.length) { const g = el('div', undefined, 'wb-gates'); for (const x of d.gates) g.append(el('span', x, 'tag warn')); box.append(g); }
      if (d.operations?.length) box.append(renderOperations(d.operations));
      box.append(renderConversation(d), renderNegotiation(d), renderDrafts(d), renderEvents(d), renderProfile(d));
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
      if (!msgs.length) { s.append(el('p', '还没有登记往来消息。原文登记仍在原工作台或导入脚本中完成。', 'hint')); return s; }
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
    function renderDrafts(d) {
      const s = section('文案');
      const proposals = d.proposals || [];
      for (const dr of d.drafts) {
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
        s.append(card);
      }
      s.append(el('p', '工作台按合作设置替换【固定费】【佣金比例】【姓名】。合作设置与事实登记仍在原工作台修改。', 'hint'));
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
    function toggleEditor(card, dr) {
      const existing = card.querySelector('.wb-editor'); if (existing) { existing.remove(); return; }
      const form = el('div', undefined, 'wb-editor');
      let subject = null;
      if (dr.channel === 'email' || dr.subject) { subject = el('input'); subject.value = dr.subject; subject.maxLength = 300; subject.setAttribute('aria-label', '主题'); form.append(subject); }
      const body = el('textarea'); body.value = dr.body; body.rows = 10; body.maxLength = 10000; body.setAttribute('aria-label', '正文'); form.append(body);
      form.append(el('p', '编辑的是模板原文：金额请保留【固定费】等占位符。保存时按版本 ' + dr.revision + ' 写入，若已被他人修改会提示冲突。', 'hint'));
      const row = el('div', undefined, 'operation-actions');
      row.append(btn('保存到工作台', 'primary', async () => {
        state.busy = true;
        try {
          const r = await client.run('edit-draft', { creatorId: state.current.id, channel: dr.channel, subject: subject ? subject.value : dr.subject, body: body.value, revision: dr.revision });
          notice({ saved: '已保存并读回一致。', conflict: '文案已被他人更新，未保存；请刷新后重新编辑。', not_applied: '工作台未写入，请重试。', rejected: '工作台拒绝保存：' + (r.message || ''), unknown: r.message }[r.status] || r.status, r.status !== 'saved');
        } catch (error) { notice('未保存：' + error.message, true); }
        finally { state.busy = false; await reloadCurrent(); }
      }), btn('取消', 'subtle', () => form.remove()));
      form.append(row); card.append(form);
    }
    function renderEvents(d) {
      const s = section('事实台账');
      const events = [...(d.events || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)));
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
      const s = section('档案与合作设置');
      const t = el('dl', undefined, 'wb-fields');
      const rows = [['选题', p.topic], ['角度', p.angle], ['商品', [p.anchor1, p.anchor2].filter(Boolean).join(' / ')], ['粉丝', p.followers], ['联盟成交额（美元）', p.affiliate_gmv_usd], ['宠物成交占比', p.pet_gmv_share_pct === undefined ? null : p.pet_gmv_share_pct + '%'], ['统计期', p.kalodata_window], ['采集日期', p.data_collected], ['历史', p.history],
        ['固定费（美元）', st.fee], ['佣金比例', st.commission === null || st.commission === undefined ? '未填' : st.commission + '%'], ['署名', st.sender || '未填'], ['负责人', st.owner || '未填'], ['下次跟进', st.next_followup || '未设'], ['邮箱', st.email || '未登记'], ['备注', st.notes]];
      for (const [k, v] of rows) if (v !== undefined && v !== null && v !== '') t.append(el('dt', k), el('dd', v));
      s.append(t, el('p', '资料为历史快照；修改合作设置请在原工作台进行。', 'hint'));
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

    $('wb-url-save').addEventListener('click', saveURL);
    $('wb-refresh').addEventListener('click', async () => { try { await loadHome(); if (state.current) await openCreator(state.current.id); if (state.view.tab === 'conversations') await loadConversations(); } catch (error) { notice('刷新失败：' + error.message, true); } });
    for (const id of ['wb-search', 'wb-priority', 'wb-stage', 'wb-has-messages']) $(id).addEventListener(id === 'wb-search' ? 'input' : 'change', renderList);
    $('wb-batch-drafts').addEventListener('click', () => openDialog('drafts', [...state.selected]));
    $('tab-creators').addEventListener('click', () => setView({ tab: 'creators' }));
    $('tab-conversations').addEventListener('click', () => { setView({ tab: 'conversations' }); loadConversations(); });
    window.addEventListener('hashchange', () => { const v = parseHash(window.location.hash); const changed = v.creator && v.creator !== state.current?.id; state.view = v; renderTabs(); if (changed) openCreator(v.creator); if (v.tab === 'conversations') loadConversations(); });
    for (const n of document.querySelectorAll('input[name=wb-channel]')) n.addEventListener('change', dialogControls);
    for (const id of ['task-cli', 'task-prompt', 'task-slot']) $(id).addEventListener(id === 'task-prompt' ? 'input' : 'change', dialogControls);
    $('task-send').addEventListener('click', sendTask);
    renderTabs(); start();
    return { state, openCreator, openDialog, loadHome };
  }
  return { mount, parseHash, buildHash, filterCreators, negotiationAction, safeHttps };
}));
