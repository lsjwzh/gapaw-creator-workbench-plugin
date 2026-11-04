(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./app.js') : root.GapawWorkbenchApp);
  if (node) module.exports = api;
  else root.addEventListener('DOMContentLoaded', () => { if (root.document.getElementById('reh-items')) api.mount(root.document, root); });
}(typeof window === 'undefined' ? globalThis : window, function (App) {
  'use strict';
  const QUESTION_STATE = { open: ['待回答', 'tag warn'], unsure: ['暂不确定', 'tag warn'], confirmed: ['已同意', 'tag'], edited: ['已修改', 'tag'], rejected: ['不适用', 'tag muted'] };
  const CASE_STATE = { open: ['待判断', 'tag warn'], agreed: ['同意 AI', 'tag'], history: ['按当时做法', 'tag'], custom: ['我的做法', 'tag'], skipped: ['已跳过', 'tag muted'] };
  const CONFIDENCE = { high: '历史做法一致', medium: '历史做法有变化', low: '历史依据不足' };
  const format = v => typeof v === 'number' ? String(v) : String(v ?? '');
  const shortTime = s => s ? String(s).replace('T', ' ').slice(0, 16) : '';

  function mount(document, window) {
    const client = App.createClient(window.fetch.bind(window));
    const $ = id => document.getElementById(id);
    const state = { data: null, step: null, open: null, detail: null, busy: false, seq: 0 };
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = text; if (cls) n.className = cls; return n; };
    const tag = ([label, cls]) => el('span', label, cls);
    function notice(message, error = false) { const n = $('reh-notice'); n.textContent = message; n.className = error ? 'notice error' : 'notice'; }
    const requestId = () => 'reh_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);

    async function load(keepNotice) {
      try {
        state.data = await client.run('rehearsal-status');
        if (!state.data.pack) { notice('还没有导入演练包。演练包由 AI 从你的历史记录提炼生成，导入后即可开始。', true); render(); return; }
        if (!keepNotice) notice(state.data.message);
        if (!state.step || !state.data.steps.some(s => s.id === state.step)) state.step = (state.data.steps.find(s => s.done < s.total) || state.data.steps[0]).id;
        render();
      } catch (e) { notice(e.message, true); }
    }

    function render() {
      const d = state.data;
      $('reh-steps').replaceChildren(); $('reh-items').replaceChildren(); $('reh-summary').replaceChildren(); $('reh-profile').replaceChildren(); $('reh-diff').replaceChildren();
      if (!d?.pack) return;
      const s = d.summary;
      const summary = [['待处理', s.open], ['客观数值待确认', s.hardOpen], ['已记住的倾向', s.remembered], ['案例同意 AI', s.casesDecided ? s.casesAgreed + ' / ' + s.casesDecided : '—']];
      $('reh-summary').append(...summary.map(([k, v]) => { const c = el('div', undefined, 'reh-stat'); c.append(el('strong', String(v)), el('span', k)); return c; }));
      for (const step of d.steps) {
        const b = el('button', undefined, 'reh-step'); b.type = 'button'; b.dataset.step = step.id;
        if (step.id === state.step) b.setAttribute('aria-current', 'step');
        b.append(el('span', step.title), el('span', step.done + '/' + step.total, step.done === step.total ? 'tag' : 'tag warn'));
        b.onclick = () => { state.step = step.id; state.open = null; state.detail = null; render(); };
        $('reh-steps').append(b);
      }
      const items = d.items.filter(i => i.step === state.step);
      for (const it of items) $('reh-items').append(itemCard(it));
      for (const p of d.profile) {
        const li = el('li'); li.append(el('strong', p.question), el('span', ' ' + format(p.value)), el('span', ' · ' + p.source, 'hint'));
        if (p.kind === 'hard') li.prepend(el('span', '客观数值', 'tag'), document.createTextNode(' '));
        $('reh-profile').append(li);
      }
      if (!d.profile.length) $('reh-profile').append(el('li', '还没有。', 'hint'));
      for (const x of s.differences) $('reh-diff').append(el('li', x.title + '：' + (CASE_STATE[x.decision]?.[0] || x.decision) + (x.note ? '（' + x.note + '）' : '')));
      if (!s.differences.length) $('reh-diff').append(el('li', '暂无。'));
    }

    function itemCard(it) {
      const card = el('article', undefined, 'card reh-item'); card.id = 'reh-' + it.id.replace(/[^A-Za-z0-9_-]/g, '-'); card.dataset.state = it.state;
      const head = el('button', undefined, 'reh-head'); head.type = 'button'; head.setAttribute('aria-expanded', String(state.open === it.id));
      const title = el('span', undefined, 'reh-title');
      title.append(el('span', it.type === 'case' ? '真实来信' : (it.kind === 'hard' ? '客观数值' : '做法偏好'), 'tag subtle-tag'), document.createTextNode(' ' + it.title));
      head.append(title, tag((it.type === 'case' ? CASE_STATE : QUESTION_STATE)[it.state] || ['?', 'tag']));
      head.onclick = () => toggle(it.id);
      card.append(head);
      if (it.type === 'question' && it.value !== null && it.value !== undefined && state.open !== it.id) card.append(el('p', '当前：' + format(it.value), 'hint reh-current'));
      if (state.open === it.id && state.detail?.item?.id === it.id) card.append(it.type === 'case' ? caseBody(state.detail) : questionBody(state.detail));
      else if (state.open === it.id) card.append(el('p', '正在读取…', 'hint'));
      return card;
    }

    async function toggle(id) {
      if (state.open === id) { state.open = null; state.detail = null; render(); return; }
      state.open = id; state.detail = null; render();
      const seq = ++state.seq;
      try { const detail = await client.run('rehearsal-item', { itemId: id }); if (seq === state.seq && state.open === id) { state.detail = detail; render(); } }
      catch (e) { notice(e.message, true); }
    }

    async function save(itemId, decision, extra = {}) {
      if (state.busy) return;
      state.busy = true;
      for (const b of document.querySelectorAll('#reh-items button.primary, #reh-items button.secondary')) b.disabled = true;
      try {
        await client.run('rehearsal-answer', { itemId, decision, requestId: requestId(), expectedRevision: state.data.revision, ...extra });
        notice('已记下。演练中不会发送任何消息。');
        const items = state.data.items.filter(i => i.step === state.step), idx = items.findIndex(i => i.id === itemId);
        await load(true);
        const fresh = state.data.items.filter(i => i.step === state.step);
        const next = fresh.slice(idx + 1).find(i => i.state === 'open') || fresh.find(i => i.state === 'open');
        state.open = null; state.detail = null;
        if (next) await toggle(next.id); else render();
      } catch (e) { notice(e.message, true); render(); }
      finally { state.busy = false; }
    }

    function evidenceList(item) {
      const box = el('details', undefined, 'reh-evidence'); box.open = true;
      box.append(el('summary', '依据（' + item.evidence.length + ' 条）'));
      const ul = el('ul');
      for (const e of item.evidence) { const li = el('li'); li.append(el('strong', (e.label || e.source) + '：'), document.createTextNode(e.text)); ul.append(li); }
      box.append(ul); return box;
    }

    function input(item, current) {
      const a = item.answer, wrap = el('div', undefined, 'reh-input');
      const initial = current ?? item.prefill.value;
      let control;
      if (a.type === 'choice') {
        control = el('div', undefined, 'reh-options'); control.setAttribute('role', 'radiogroup');
        for (const o of a.options) {
          const l = el('label', undefined, 'reh-option'), r = el('input'); r.type = 'radio'; r.name = 'reh-choice'; r.value = o; r.checked = o === initial;
          l.append(r, document.createTextNode(' ' + o + (o === item.prefill.value ? '（历史做法）' : ''))); control.append(l);
        }
        control.read = () => control.querySelector('input:checked')?.value;
      } else if (a.type === 'text') {
        control = el('textarea', undefined, 'reh-text'); control.value = format(initial); control.rows = 3; control.maxLength = 500;
        control.read = () => control.value.trim();
      } else {
        control = el('input'); control.type = 'number'; control.step = 'any'; control.value = format(initial); control.className = 'reh-number';
        if (a.min !== undefined) control.min = a.min; if (a.max !== undefined) control.max = a.max;
        control.read = () => control.value === '' ? null : Number(control.value);
      }
      const label = el('label', '你的做法' + (a.unit ? '（' + a.unit + (a.per ? '，' + a.per : '') + '）' : ''));
      wrap.append(label, control); wrap.read = control.read; return wrap;
    }

    function questionBody(detail) {
      const q = detail.item, r = detail.resolved, body = el('div', undefined, 'reh-body');
      body.append(el('p', '为什么要问：' + q.why, 'hint'), el('p', '会用在：' + q.feeds.join('、'), 'hint'));
      const pre = el('div', undefined, 'reh-prefill');
      pre.append(el('strong', 'AI 预填（从历史提炼）：' + format(q.prefill.value)), el('span', CONFIDENCE[q.prefill.confidence], q.prefill.confidence === 'high' ? 'tag' : 'tag warn'), el('p', q.prefill.text));
      body.append(pre);
      if (q.conflict) body.append(el('p', '需要你拍板：' + q.conflict, 'reh-conflict'));
      if (q.kind === 'hard') body.append(el('p', '这是客观数值：自动运营只会使用你在这里明确确认的值，不会从历史自行推断。', 'hint'));
      body.append(evidenceList(q));
      const field = input(q, r.state === 'edited' ? r.value : null);
      const note = el('textarea', undefined, 'reh-note'); note.rows = 2; note.maxLength = 1000; note.placeholder = '备注（可选）：例外情况、原因'; note.setAttribute('aria-label', '备注');
      body.append(field, note);
      const actions = el('div', undefined, 'operation-actions');
      const btn = (text, cls, fn) => { const b = el('button', text, cls); b.type = 'button'; b.onclick = fn; actions.append(b); return b; };
      const noteValue = () => note.value.trim() || undefined;
      btn('同意预填', 'primary', () => save(q.id, 'accept', { note: noteValue() }));
      btn('按我改的保存', 'secondary', () => {
        const v = field.read();
        if (v === null || v === undefined || v === '') { notice('请先填写或选择你的做法。', true); return; }
        if (v === q.prefill.value) { notice('和预填一样，请直接点“同意预填”。', true); return; }
        save(q.id, 'edit', { value: v, note: noteValue() });
      });
      btn('暂不确定', 'secondary', () => save(q.id, 'unsure', { note: noteValue() }));
      btn('不适用', 'secondary', () => save(q.id, 'reject', { note: noteValue() }));
      body.append(actions, historyList(detail.history));
      return body;
    }

    function messageBlock(title, m, cls) {
      const box = el('div', undefined, cls); box.append(el('h3', title));
      if (!m) { box.append(el('p', '当时没有回复。', 'hint')); return box; }
      box.append(el('p', [shortTime(m.at), m.channel, m.kind && m.kind !== '正常' ? m.kind : ''].filter(Boolean).join(' · '), 'hint'));
      box.append(el('p', m.zh || m.body || '（无正文）', 'reh-message'));
      if (m.zh && m.body) { const d = el('details'); d.append(el('summary', '原文'), el('p', m.body, 'reh-message')); box.append(d); }
      return box;
    }

    function caseBody(detail) {
      const c = detail.item, s = c.suggestion, ctx = detail.context, body = el('div', undefined, 'reh-body');
      if (!ctx.available) body.append(el('p', ctx.reason, 'notice error'));
      else {
        const who = ctx.message.handle ? '@' + ctx.message.handle : ctx.message.creator;
        body.append(el('p', '达人：' + who + '（' + ctx.message.creator + '）', 'hint'), messageBlock('来信', ctx.message, 'reh-incoming'));
      }
      const sug = el('div', undefined, 'reh-suggestion'); sug.append(el('h3', 'AI 建议（按已记住的倾向）'));
      const line = el('p'); line.append(el('strong', s.classification), document.createTextNode(' → ' + s.action + ' '));
      if (s.conditionChange) line.append(el('span', '涉及条件变化，永远由你确认', 'tag warn'));
      const ul = el('ul'); for (const p of s.points) ul.append(el('li', p));
      sug.append(line, ul);
      const rules = el('p', undefined, 'hint'); rules.append('依据的倾向：');
      for (const r of detail.rules) rules.append(el('span', r.question + (r.resolved.value !== null ? '（' + format(r.resolved.value) + '）' : '（还没回答）'), r.resolved.value !== null ? 'tag' : 'tag warn'), document.createTextNode(' '));
      sug.append(rules);
      body.append(sug);
      if (ctx.available) {
        body.append(messageBlock('你当时的做法', ctx.history.reply, 'reh-history'));
        const n = ctx.history.negotiation;
        if (n) body.append(el('p', '谈判记录：' + [n.status, n.ourOffer && '我方：' + n.ourOffer, n.theirAsk && '对方：' + n.theirAsk].filter(Boolean).join('；'), 'hint'));
      }
      const note = el('textarea', undefined, 'reh-note'); note.rows = 3; note.maxLength = 1000; note.placeholder = '如果你会用别的做法，写在这里（选“我会这样做”时必填）'; note.setAttribute('aria-label', '你的做法');
      body.append(note);
      const actions = el('div', undefined, 'operation-actions');
      const btn = (text, cls, fn) => { const b = el('button', text, cls); b.type = 'button'; b.onclick = fn; actions.append(b); };
      const noteValue = () => note.value.trim() || undefined;
      btn('同意 AI 建议', 'primary', () => save(c.id, 'agree', { note: noteValue() }));
      btn('当时的做法更好', 'secondary', () => save(c.id, 'history', { note: noteValue() }));
      btn('我会这样做', 'secondary', () => { if (!note.value.trim()) { notice('请先写下你的做法。', true); note.focus(); return; } save(c.id, 'custom', { note: noteValue() }); });
      btn('跳过', 'secondary', () => save(c.id, 'skip', { note: noteValue() }));
      body.append(actions, historyList(detail.history));
      return body;
    }

    function historyList(history) {
      if (!history?.length) return el('span');
      const d = el('details', undefined, 'reh-history-list'); d.append(el('summary', '回答记录（' + history.length + '）'));
      const ul = el('ul', undefined, 'hint');
      const names = { accept: '同意预填', edit: '修改为', reject: '不适用', unsure: '暂不确定', agree: '同意 AI 建议', history: '按当时做法', custom: '我会这样做', skip: '跳过' };
      for (const h of history) ul.append(el('li', shortTime(h.at) + ' ' + (names[h.decision] || h.decision) + (h.value !== null && h.value !== undefined ? ' ' + format(h.value) : '') + (h.note ? '（' + h.note + '）' : '')));
      d.append(ul); return d;
    }

    load();
    return { state, load };
  }
  return { mount };
}));
