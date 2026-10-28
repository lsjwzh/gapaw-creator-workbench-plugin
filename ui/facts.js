(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GapawFacts = api;
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const CHANNELS = { comment: '评论区', dm: '普通私信', email: '邮件', affiliate: '达人联盟' };
  const LABELS = { saved: '已保存并读回核对', conflict: '版本冲突，未覆盖', rejected: '未通过校验', unknown: '结果未知，待核对原登记', not_applied: '确认未写入，可原编号重试' };
  const SETTINGS = {
    verification: [
      ['account_checked', '已核对账号身份、接单权与目标账号', 'check'],
      ['product_checked', '已核对商品适配、实品与寄样批次用法', 'check'],
      ['history_checked', '已核对本轮前历史消息及跨渠道回复', 'check'],
      ['channel_ready.comment', '评论区已人工核验', 'check'], ['channel_ready.dm', '私信已人工核验', 'check'],
      ['channel_ready.email', '邮件渠道已人工核验', 'check'], ['channel_ready.affiliate', '联盟渠道已人工核验', 'check'],
      ['email', '邮箱', 'text', 300], ['email_source', '邮箱来源链接（HTTP或HTTPS）', 'text', 2000], ['comment_target', '评论目标视频网址', 'text', 2048],
    ],
    cooperation: [['fee', '固定费（两条合计，美元）', 'fee'], ['commission', '佣金比例（%，空白为未知）', 'number'], ['sender', '对外署名', 'text', 200], ['owner', '负责人', 'text', 200], ['notes', '合作备注与待确认条件', 'area', 6000]],
    followup: [['next_followup', '下次跟进日（可清空）', 'date'], ['owner', '跟进负责人', 'text', 200]],
  };
  const OUTREACH = ['发送尝试', '发送失败', '平台受理', '明确已读', '有效回复', '有意向', '确认合作', '明确拒绝'];
  const FULFILMENT = ['寄样', '已发片'];
  const clone = x => JSON.parse(JSON.stringify(x));
  function localTime() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  function safeDownload(value, origin) { try { const u = new URL(value, origin); return u.origin === origin && u.pathname === '/api/download' && String(value).startsWith('/api/download?') && !u.hash ? u.pathname + u.search : null; } catch (_) { return null; } }

  function create(document, window, client, callbacks) {
    const states = new Map();
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; };
    const button = (text, action, disabled = false) => { const n = el('button', text, 'secondary'); n.type = 'button'; n.disabled = disabled; n.addEventListener('click', action); return n; };
    const source = callbacks.source || 'unbound';
    const randomId = () => { if (window.crypto.randomUUID) return window.crypto.randomUUID(); const bytes = window.crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128; const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-'); };
    const storageKey = id => 'gapaw-creator-workbench:manual:v2:' + encodeURIComponent(source) + ':' + id;
    function state(id) {
      if (!states.has(id)) {
        let saved = {}; try { saved = JSON.parse(window.localStorage.getItem(storageKey(id))) || {}; } catch (_) { /* 无本地草稿时从业务读模型开始 */ }
        states.set(id, { context: null, loading: false, busy: false, error: '', forms: saved.forms || {}, pending: saved.pending || null, receipts: [], selectedEvent: saved.selectedEvent || null, exportState: saved.exportState || null, storageError: false });
      }
      return states.get(id);
    }
    function persist(id) {
      const s = state(id);
      try { window.localStorage.setItem(storageKey(id), JSON.stringify({ forms: s.forms, pending: s.pending, selectedEvent: s.selectedEvent, exportState: s.exportState })); s.storageError = false; return true; }
      catch (_) { s.storageError = true; return false; }
    }
    const redraw = id => callbacks.redraw?.(id);
    function receipt(value, id, request) {
      if (!value || value.creatorId !== id || value.expectedSource !== state(id).context?.expectedSource || typeof value.requestId !== 'string' || !Object.hasOwn(LABELS, value.status)) throw new Error('登记回执归属或状态不兼容，尚未确认。');
      if (request && (value.requestId !== request.input.requestId || value.action !== request.command || value.expectedSource !== request.input.expectedSource)) throw new Error('返回回执不属于本次人工登记。');
      return value;
    }
    function applyReceipt(id, value) {
      const s = state(id); const r = receipt(value, id); const at = s.receipts.findIndex(x => x.requestId === r.requestId);
      if (at < 0) s.receipts.unshift(r); else s.receipts[at] = r;
      if (s.pending?.input.requestId === r.requestId) {
        s.pending.receipt = r;
        const f = s.forms[s.pending.form]; if (f) { f.status = r.status; f.message = r.message || ''; }
        if (['saved', 'conflict', 'rejected'].includes(r.status)) { if (f) f.confirmed = false; s.pending = null; }
      }
      persist(id); return r;
    }
    function blocked(id) { const s = state(id); return Boolean(s.pending || s.receipts.some(r => ['unknown', 'not_applied'].includes(r.status))); }
    async function load(id, repaint = true) {
      const s = state(id); if (s.loading) return; s.loading = true; s.error = ''; if (repaint) redraw(id);
      try {
        const c = await client.run('workbench-fact-contract', { creatorId: id });
        if (c.sourceUrl !== source) throw new Error('工作台数据来源已在其他页面变化；原输入已保留，请刷新数据管理并重新选择达人。');
        if (c.creatorId !== id || typeof c.expectedSource !== 'string' || !c.expectedSource || !Number.isSafeInteger(c.settingsRevision) || c.settingsRevision < 0 || !c.settings || !Array.isArray(c.events) || !Array.isArray(c.recentReceipts)) throw new Error('人工登记要求的归属或版本不兼容。');
        s.context = c; s.receipts = c.recentReceipts.map(r => receipt(r, id));
        if (s.pending && !s.receipts.some(r => r.requestId === s.pending.input.requestId)) s.receipts.unshift(s.pending.receipt || { creatorId: id, expectedSource: s.pending.input.expectedSource, requestId: s.pending.input.requestId, action: s.pending.command, status: 'unknown', message: '本浏览器保留了原请求；工作台尚未返回可确认回执。', canRetry: true });
        for (const kind of Object.keys(SETTINGS)) { const f = s.forms[kind]; if (f && !f.dirty && !f.status) { f.baseRevision = c.settingsRevision; for (const [key, , type] of SETTINGS[kind]) f.values[key] = type === 'check' ? settingsValue(c.settings, key) === true : String(settingsValue(c.settings, key)); } }
        if (s.pending) { const r = s.receipts.find(x => x.requestId === s.pending.input.requestId); if (r) applyReceipt(id, r); }
      } catch (error) { s.error = '登记要求读取失败：' + error.message; }
      finally { s.loading = false; if (repaint) redraw(id); }
    }
    function settingsValue(settings, key) { if (key.startsWith('channel_ready.')) return settings.channel_ready?.[key.split('.')[1]] === true; return settings[key] ?? ''; }
    function form(id, kind) {
      const s = state(id); if (!s.forms[kind]) {
        const values = {};
        if (SETTINGS[kind]) for (const [key, , type] of SETTINGS[kind]) values[key] = type === 'check' ? settingsValue(s.context.settings, key) === true : String(settingsValue(s.context.settings, key));
        else if (kind === 'message') Object.assign(values, { channel: 'email', direction: 'in', at: localTime(), sender: '', subject: '', body: '', zh: '', kind: '正常', source: '' });
        else if (kind === 'void') Object.assign(values, { reason: '' });
        else Object.assign(values, { channel: 'dm', type: kind === 'fulfilment' ? '寄样' : '发送尝试', at: localTime(), proof: '', note: '' });
        s.forms[kind] = { values, basis: '', confirmed: false, baseRevision: s.context.settingsRevision, status: '', message: '', dirty: false };
      }
      return s.forms[kind];
    }
    function control(id, kind, key, label, type = 'text', max = 6000, choices) {
      const s = state(id), f = form(id, kind); const wrap = el('label', undefined, type === 'check' ? 'fact-check' : 'fact-field');
      const input = el(type === 'area' ? 'textarea' : choices ? 'select' : 'input');
      input.dataset.factField = key; input.setAttribute('aria-label', label); input.disabled = s.busy || blocked(id);
      if (choices) { for (const [value, title] of choices) { const o = el('option', title); o.value = value; input.append(o); } }
      else if (type === 'area') { input.rows = 3; input.maxLength = max; }
      else { input.type = type === 'check' ? 'checkbox' : type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'time' ? 'datetime-local' : 'text'; input.maxLength = max; if (type === 'number') { input.min = '0'; input.max = '100'; input.step = 'any'; } }
      if (type === 'check') input.checked = f.values[key] === true; else input.value = f.values[key] ?? '';
      input.addEventListener(type === 'check' || choices || type === 'date' ? 'change' : 'input', () => { f.values[key] = type === 'check' ? input.checked : input.value; f.dirty = true; f.confirmed = false; for (const c of document.querySelectorAll?.('[data-fact-confirm="' + kind + '"]') || []) c.checked = false; if (f.status === 'saved') { f.status = ''; f.message = ''; } persist(id); });
      if (type === 'check') wrap.append(input, el('span', label)); else wrap.append(el('span', label), input);
      return wrap;
    }
    function confirmation(id, kind) {
      const s = state(id), f = form(id, kind); const label = el('label', undefined, 'fact-check'); const check = el('input'); check.type = 'checkbox'; check.checked = f.confirmed; check.disabled = s.busy || blocked(id); check.dataset.factConfirm = kind;
      check.addEventListener('change', () => { f.confirmed = check.checked; persist(id); }); label.append(check, el('span', '我已人工核对本次内容与依据，确认登记到该达人。')); return label;
    }
    function textInput(value, max, required = false) { if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value) || required && !value.trim()) throw new Error('内容为空、超过 ' + max + ' 字符或含不支持的控制字符，请修正后登记。'); return value; }
    function httpInput(value) { if (!value) return; let u; try { u = new URL(value); } catch (_) { throw new Error('来源或目标链接须为有效的 HTTP(S) 地址。'); } if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || /\s/.test(value)) throw new Error('来源或目标链接须为不含账号密码的 HTTP(S) 地址。'); }
    function iso(value) { const date = new Date(value); if (!value || Number.isNaN(date.getTime())) throw new Error('请填写实际发生时间。'); if (date.getTime() > Date.now() + 120000) throw new Error('不能把未来计划登记为已发生事实。'); return date.toISOString(); }
    function payload(id, kind) {
      const s = state(id), f = form(id, kind), values = f.values;
      if (!f.confirmed) throw new Error('请先人工核对内容与依据，并勾选确认。');
      const common = { creatorId: id, expectedSource: s.context.expectedSource, requestId: 'manual_' + randomId(), confirmed: true };
      if (SETTINGS[kind]) {
        textInput(f.basis, 2000, true); const patch = {};
        for (const [key, , type] of SETTINGS[kind]) {
          if (key.startsWith('channel_ready.')) { if (!patch.channel_ready) patch.channel_ready = clone(s.context.settings.channel_ready || {}); patch.channel_ready[key.split('.')[1]] = values[key]; }
          else if (key === 'commission') { patch[key] = values[key] === '' ? null : Number(values[key]); if (patch[key] !== null && (!Number.isFinite(patch[key]) || patch[key] < 0 || patch[key] > 100)) throw new Error('佣金比例须在 0 到 100 之间；未知请留空。'); }
          else if (key === 'fee') { if (values[key] === '') { patch[key] = null; continue; } if (!['50', '100'].includes(String(values[key]))) throw new Error('当前工作台固定费字段只接受 50 或 100；其他条件请写入待确认备注。'); patch[key] = Number(values[key]); }
          else patch[key] = type === 'check' ? values[key] === true : textInput(values[key], 6000);
        }
        for (const key of ['email_source', 'comment_target']) if (patch[key] !== undefined) httpInput(patch[key]);
        if (patch.email && !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(patch.email)) throw new Error('请填写有效邮箱。');
        if (patch.channel_ready?.email && (!patch.email || !patch.email_source)) throw new Error('勾选邮件渠道核验前请填写邮箱和来源链接。');
        if (patch.channel_ready?.comment && !patch.comment_target) throw new Error('勾选评论渠道核验前请填写目标视频网址。');
        return { command: 'edit-settings', form: kind, input: { ...common, expectedRevision: f.baseRevision, settings: patch, basis: f.basis.trim() } };
      }
      if (kind === 'message') { for (const key of ['sender', 'subject', 'source']) textInput(values[key], 300, key === 'source'); textInput(values.body, 20000, true); textInput(values.zh, 4000); return { command: 'record-message', form: kind, input: { ...common, message: { ...values, at: iso(values.at) } } }; }
      if (kind === 'void') {
        const event = s.context.events.find(e => e.id === s.selectedEvent); if (!event?.eventHash) throw new Error('原事实版本已不可用，请重新读取登记要求。'); textInput(values.reason, 1000, true);
        return { command: 'void-event', form: kind, input: { ...common, eventId: event.id, expectedEventHash: event.eventHash, reason: values.reason.trim() } };
      }
      textInput(values.proof, 6000, true); textInput(values.note, 6000);
      return { command: 'record-event', form: kind, input: { ...common, event: { ...values, at: iso(values.at) } } };
    }
    async function submit(id, kind) {
      const s = state(id); if (s.busy || s.loading || blocked(id)) return;
      let request; try { request = payload(id, kind); if (new TextEncoder().encode(JSON.stringify(request.input)).length > 50000) throw new Error('本次登记超过 50000 字节，请精简内容并保留来源依据。'); } catch (error) { s.error = error.message; redraw(id); return; }
      s.pending = { ...request, receipt: null }; if (!persist(id)) { s.pending = null; s.error = '浏览器无法保留恢复编号，尚未提交。请先恢复本地存储可用性。'; redraw(id); return; }
      await write(id);
    }
    async function write(id) {
      const s = state(id); if (s.busy || !s.pending) return; const request = clone(s.pending); s.busy = true; s.error = ''; redraw(id);
      try {
        const result = await client.run(request.command, request.input);
        const r = applyReceipt(id, receipt(result.receipt, id, request));
        callbacks.notice?.(LABELS[r.status] + '：' + (r.message || ''), r.status !== 'saved');
        if (r.status === 'saved') { await load(id, false); const f = s.forms[request.form]; if (f && SETTINGS[request.form]) { f.baseRevision = s.context?.settingsRevision ?? f.baseRevision; f.dirty = false; f.confirmed = false; } await callbacks.refresh?.(id); }
      } catch (error) {
        s.error = '登记结果尚未确认：' + error.message + '。保留原编号和原内容，请先核对原登记。';
        applyReceipt(id, { creatorId: id, expectedSource: request.input.expectedSource, requestId: request.input.requestId, action: request.command, status: 'unknown', message: '请求尚未读回确认。', canRetry: true });
      } finally { s.busy = false; persist(id); redraw(id); }
    }
    async function reconcile(id, requestId) {
      const s = state(id); if (s.busy) return; s.busy = true; s.error = ''; redraw(id);
      try {
        const result = await client.run('workbench-fact-status', { creatorId: id, expectedSource: s.context.expectedSource, requestId, reconcile: true });
        if (result.creatorId !== id || !Array.isArray(result.receipts) || result.receipts.length !== 1 || result.receipts[0].requestId !== requestId) throw new Error('未读到对应的原登记回执。');
        const pending = s.pending; const r = applyReceipt(id, receipt(result.receipts[0], id, pending?.input.requestId === requestId ? pending : null));
        if (r.status === 'saved') { await load(id, false); if (pending && SETTINGS[pending.form] && s.forms[pending.form]) s.forms[pending.form].baseRevision = s.context?.settingsRevision ?? s.forms[pending.form].baseRevision; await callbacks.refresh?.(id); }
      } catch (error) { s.error = '原登记核对尚未完成：' + error.message; }
      finally { s.busy = false; persist(id); redraw(id); }
    }
    async function rebase(id, kind) { const s = state(id); if (s.busy || blocked(id)) return; await load(id, false); if (!s.error && s.context) { const f = form(id, kind); f.baseRevision = s.context.settingsRevision; f.status = ''; f.confirmed = false; f.message = '已读取最新版本，保留你的输入；请对照当前记录后重新确认。'; persist(id); } redraw(id); }
    function notices(id, root) {
      const s = state(id); if (s.error) root.append(el('p', s.error, 'operation-error')); if (s.storageError) root.append(el('p', '浏览器草稿暂存失败；请保留本页，避免丢失尚未保存内容。', 'operation-error'));
      if (blocked(id)) root.append(el('p', '本达人有待确认的人工登记。请先核对原编号，当前表单内容与原请求保持保留。', 'report-missing'));
      const history = el('details', undefined, 'fact-history'); history.append(el('summary', '最近人工登记回执'));
      for (const r of s.receipts.slice(0, 8)) {
        const row = el('div', undefined, 'fact-receipt'); row.append(el('strong', LABELS[r.status]), el('p', r.message || '', 'hint'), el('p', '登记编号：' + r.requestId, 'path'));
        if (['unknown', 'not_applied'].includes(r.status)) {
          row.append(button('核对原登记', () => reconcile(id, r.requestId), s.busy));
          if (s.pending?.input.requestId === r.requestId && r.canRetry !== false) row.append(button('使用原编号和内容重试', () => write(id), s.busy));
          else row.append(el('p', '此浏览器没有原请求内容，可先核对回执；不要另建替代登记。', 'hint'));
        }
        if (['unknown', 'not_applied'].includes(r.status)) root.append(row); else history.append(row);
      }
      if (history.children.length > 1) root.append(history);
      if (s.pending && !s.receipts.some(r => r.requestId === s.pending.input.requestId)) root.append(button('核对原登记', () => reconcile(id, s.pending.input.requestId), s.busy), button('使用原编号和内容重试', () => write(id), s.busy));
    }
    function formFooter(id, kind, root, title) {
      const s = state(id), f = form(id, kind);
      if (f.status) root.append(el('p', LABELS[f.status] + (f.message ? '：' + f.message : ''), f.status === 'saved' ? 'hint' : 'report-missing'));
      else if (f.message) root.append(el('p', f.message, 'hint'));
      if (SETTINGS[kind]) {
        root.append(el('p', '按达人设置版本 ' + f.baseRevision + ' 保存；当前读到版本 ' + s.context.settingsRevision + '。输入仅暂存在本浏览器。', 'hint'));
        if (f.status === 'conflict' || f.baseRevision !== s.context.settingsRevision) {
          const current = el('details'); current.append(el('summary', '对照当前工作台字段（保留我的输入）'));
          for (const [key, label] of SETTINGS[kind]) current.append(el('p', label + '：' + String(settingsValue(s.context.settings, key)), 'hint'));
          root.append(current, button('读取最新版本并保留我的输入', () => rebase(id, kind), s.busy || blocked(id)));
        }
      }
      if (!SETTINGS[kind] && f.status === 'saved') { root.append(button('开始另一条人工登记', () => { delete s.forms[kind]; if (kind === 'void') s.selectedEvent = null; persist(id); redraw(id); }, s.busy || blocked(id))); return; }
      root.append(confirmation(id, kind), button(title, () => submit(id, kind), s.busy || s.loading || blocked(id) || f.status === 'conflict'));
    }
    function renderSettings(id, kind, root) {
      const f = form(id, kind); const grid = el('div', undefined, 'fact-grid');
      for (const [key, label, type, max] of SETTINGS[kind]) grid.append(control(id, kind, key, label, type, max, type === 'fee' ? [['', '未知／尚未确认'], ['50', '50 美元'], ['100', '100 美元']] : null));
      root.append(grid);
      if (kind === 'cooperation') root.append(el('p', '50/100 是现有工作台字段的批次限制，不是永久商务政策或对外承诺。其他费用、视频数、授权期、原片、付款节点和发布日期请在备注中逐项待确认。', 'hint'));
      if (kind === 'verification') root.append(el('p', '核验标记由你依据资料确认；历史记录或有过触达不会自动勾选。核验任务尚未接入，可在原 MultiCC 任务补充整理依据。', 'hint'));
      if (kind === 'followup') root.append(el('p', '跟进前复查最新跨渠道回复；明确拒绝后停止触达。设置日期不会发消息，也不重置首次联系时间。', 'hint'));
      const basis = el('label', undefined, 'fact-field'); const input = el('textarea'); input.value = f.basis; input.rows = 2; input.maxLength = 2000; input.setAttribute('aria-label', '本次修改依据（长期依据请写合作备注）'); input.dataset.factBasis = kind; input.disabled = state(id).busy || blocked(id); input.addEventListener('input', () => { f.basis = input.value; f.dirty = true; f.confirmed = false; for (const c of document.querySelectorAll?.('[data-fact-confirm="' + kind + '"]') || []) c.checked = false; if (f.status === 'saved') { f.status = ''; f.message = ''; } persist(id); }); basis.append(el('span', '本次修改依据'), input); root.append(basis);
      formFooter(id, kind, root, '确认并保存人工设置');
    }
    function renderEvent(id, kind, root) {
      const choices = (kind === 'fulfilment' ? FULFILMENT : OUTREACH).map(v => [v, v]); const grid = el('div', undefined, 'fact-grid');
      grid.append(control(id, kind, 'channel', '发生渠道', 'text', 100, Object.entries(CHANNELS)), control(id, kind, 'type', '已发生的事实', 'text', 100, choices), control(id, kind, 'at', '实际发生时间（本机时区）', 'time'), control(id, kind, 'proof', '事实依据（截图、回执或可核对位置）', 'area', 6000), control(id, kind, 'note', '补充说明', 'area', 6000)); root.append(grid);
      root.append(el('p', kind === 'fulfilment' ? '寄样与已发片需要先有确认合作事实。物流、视频交付和付款证据记录在依据或备注；当前不自动同步物流或平台。' : '此处人工登记已发生事实，不发送消息。发送前先复查账号收件箱和跨渠道回复；平台受理不等于送达、已读或有效回复。所有登记均需实际依据。', 'hint'));
      formFooter(id, kind, root, '确认并登记事实');
    }
    function renderMessage(id, root) {
      const grid = el('div', undefined, 'fact-grid'); grid.append(control(id, 'message', 'channel', '消息渠道', 'text', 100, Object.entries(CHANNELS)), control(id, 'message', 'direction', '消息方向', 'text', 20, [['in', '对方来信'], ['out', '我方已发']]), control(id, 'message', 'kind', '消息类型', 'text', 30, [['正常', '正常消息'], ['自动回复', '自动回复']]), control(id, 'message', 'at', '消息实际时间（本机时区）', 'time'), control(id, 'message', 'sender', '发件人或账号', 'text', 300), control(id, 'message', 'subject', '主题（可空）', 'text', 300), control(id, 'message', 'body', '消息原文', 'area', 20000), control(id, 'message', 'zh', '中文摘要（可空）', 'area', 4000), control(id, 'message', 'source', '来源标识或证据位置', 'text', 300)); root.append(grid, el('p', '登记我方已发消息不执行发送；登记来信不自动新增“有效回复”事实，也不改变回复率。自动回复须如实标记。相同来源标识不得用于不同内容。', 'hint')); formFooter(id, 'message', root, '确认并登记往来消息');
    }
    function renderVoid(id, kind, root) {
      const s = state(id); const events = s.context.events.filter(e => !e.void_reason).sort((a, b) => String(b.created || '').localeCompare(String(a.created || ''))); const latest = events[0];
      if (latest && (kind === 'fulfilment' ? FULFILMENT.includes(latest.type) : !FULFILMENT.includes(latest.type))) {
        const box = el('details', undefined, 'fact-void'); box.append(el('summary', '撤销错误事实登记（保留原记录）'), el('p', '仅允许撤销最新创建的有效记录：' + latest.type + ' · ' + latest.at + '。不会删除历史或审计记录。', 'hint'));
        box.append(button('选择这条记录并填写撤销原因', () => { s.selectedEvent = latest.id; delete s.forms.void; persist(id); redraw(id); }, s.busy || blocked(id)));
        if (s.selectedEvent === latest.id) { box.open = true; box.append(control(id, 'void', 'reason', '撤销原因', 'area', 1000)); formFooter(id, 'void', box, '确认并撤销此事实'); }
        root.append(box);
      }
    }
    async function registerExport(id) {
      const s = state(id), x = s.exportState; if (!x?.result) return;
      try {
        const response = await window.fetch('/api/docs-registry', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'file', title: '达人工作台复盘导出 · ' + x.result.fileName, url: x.result.downloadUrl, source: 'plugin', note: '手动导出，当前导出范围；不等于完整备份' }) });
        if (!response.ok) throw new Error('登记接口未返回成功'); x.registered = true; x.registrationError = '';
      } catch (_) { x.registered = false; x.registrationError = '文件已生成，服务与文档登记暂未成功；下载入口仍可用。'; }
      persist(id); redraw(id);
    }
    async function exportFile(id) {
      const s = state(id); if (s.exportBusy) return;
      if (!s.exportState) s.exportState = { format: 'xlsx', exportId: null, result: null, error: '', registered: false };
      const x = s.exportState; if (x.result) return;
      if (!s.context?.expectedSource) { x.error = '尚未读取当前工作台来源，请先重新读取登记要求。'; redraw(id); return; }
      if (!x.exportId) { x.exportId = 'export_' + randomId(); x.expectedSource = s.context.expectedSource; }
      if (x.expectedSource !== s.context.expectedSource) { x.error = '当前工作台来源与原导出编号不一致，不能混用。'; redraw(id); return; }
      if (!persist(id)) { x.error = '无法保留导出编号，尚未请求导出。'; redraw(id); return; }
      s.exportBusy = true; x.error = ''; redraw(id);
      try {
        const r = await client.run('workbench-export', { format: x.format, exportId: x.exportId, expectedSource: x.expectedSource });
        const href = safeDownload(r.downloadUrl, window.location.origin);
        if (r.status !== 'ready' || r.exportId !== x.exportId || r.format !== x.format || r.scope !== 'all_creators' || !href || typeof r.fileName !== 'string') throw new Error('导出回执或下载地址不匹配。');
        x.result = { ...r, downloadUrl: href }; persist(id); await registerExport(id);
      } catch (error) { x.error = '导出结果尚未确认：' + error.message + '。再次点击会沿用原导出编号核对，不新建替代文件。'; }
      finally { s.exportBusy = false; persist(id); redraw(id); }
    }
    function renderExport(id, root) {
      const s = state(id); if (!s.exportState) s.exportState = { format: 'xlsx', exportId: null, result: null, error: '', registered: false }; const x = s.exportState;
      if (!s.context) root.append(button('读取当前工作台来源', () => load(id), s.loading));
      root.append(el('h3', '导出全部达人工作台记录'), el('p', '导出本地工作台支持范围的全部达人记录，不只当前达人；当前导出未包含的资料不会因此补齐，文件不等于完整备份。', 'hint'));
      const label = el('label', undefined, 'fact-field'), select = el('select'); select.setAttribute('aria-label', '导出格式');
      for (const [value, title] of [['xlsx', '表格（XLSX）'], ['zip', '工作台打包文件（ZIP）']]) { const o = el('option', title); o.value = value; select.append(o); }
      select.value = x.format; select.disabled = Boolean(x.exportId) || s.exportBusy; select.addEventListener('change', () => { x.format = select.value; persist(id); }); label.append(el('span', '文件格式'), select); root.append(label);
      if (x.error) root.append(el('p', x.error, 'operation-error'));
      if (x.result) {
        const a = el('a', '下载 ' + x.result.fileName, 'fact-export-link'); a.href = x.result.downloadUrl; a.setAttribute('download', x.result.fileName); root.append(a, el('p', x.result.warning || '范围以当前导出结果为准。', 'hint'));
        if (x.registered) root.append(el('p', '已登记到 MultiCC「服务与文档」。', 'hint'));
        if (x.registrationError) root.append(el('p', x.registrationError, 'report-missing'), button('重试登记文件', () => registerExport(id), s.exportBusy));
        root.append(button('开始另一份导出', () => { s.exportState = null; persist(id); redraw(id); }, s.exportBusy));
      } else root.append(button(s.exportBusy ? '正在生成导出…' : x.exportId ? '用原编号继续导出' : '导出全部达人记录', () => exportFile(id), s.exportBusy));
    }
    function render(id, kind) {
      const s = state(id), root = el('section', undefined, 'fact-panel'); root.dataset.factPanel = kind;
      notices(id, root);
      if (kind === 'export') { renderExport(id, root); return root; }
      if (!s.context) { root.append(el('p', s.loading ? '正在读取人工登记字段与版本…' : '人工登记要求尚未读取，暂不提供保存。', 'hint'), button('重新读取人工登记要求', () => load(id), s.loading)); return root; }
      if (SETTINGS[kind]) renderSettings(id, kind, root);
      else if (kind === 'message') renderMessage(id, root);
      else if (kind === 'outreach' || kind === 'fulfilment') { renderEvent(id, kind, root); renderVoid(id, kind, root); }
      return root;
    }
    return { state, load, render, submit, reconcile, rebase, write, persist, blocked, exportFile, registerExport, safeDownload, source, isBusy: () => [...states.values()].some(s => s.busy || s.exportBusy) };
  }
  return { create, SETTINGS, CHANNELS, safeDownload };
}));
