// 像素办公室首页：员工状态来自 office-status 的只读汇总；“模拟一天”只改页面显示，不发送任何东西。
(function (root) {
  'use strict';
  const App = root.GapawClient;
  const client = App.createClient(root.fetch.bind(root));
  const doc = root.document;
  // ---------- 发件箱与达人抽屉 ----------
  const STATUS_TEXT = { draft: '待发送', sending: '发送中', unknown: '结果待核对', accepted: '已发出，送达待核对', delivered: '已送达', bounced: '退信', blocked: '被拦截', cancelled: '已撤回' };
  const CHECKABLE = ['sending', 'unknown', 'accepted', 'delivered'];
  const node = (tag, text, cls) => { const n = doc.createElement(tag); if (text != null) n.textContent = String(text); if (cls) n.className = cls; return n; };
  const when = v => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
  const uuid = () => { try { if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID(); } catch (_) { /* 旧浏览器退回随机编号 */ } return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); };
  const teamFlow = root.GapawTeam.controller(client);
  let teamData = null;
  const homeActions = {
    openCreator: id => openCreator(id), openOutbox: () => openOutbox(),
    checkMail: () => { const b = doc.getElementById('sync'); return !b.disabled && b.onclick(); },
    refresh: () => refreshOverview(),
    openWork: id => openWork(id), openSettings: () => { root.location.href = './setup.html'; },
    openRehearsal: () => { root.location.href = './rehearsal.html'; },
  };
  async function refreshOverview() {
    try { const data = await client.run('office-status'); root.GapawHome.render(data, homeActions); if (root.OFFICE?.mode === 'real') root.GapawAttention.render(doc.getElementById('asks'), data, homeActions); }
    catch (e) { root.GapawHome.error(e.message, refreshOverview); }
  }
  async function openWork(id) {
    const box = drawer(); box.hidden = false;
    const close = node('button', '关闭', 'alt'); close.onclick = () => { box.hidden = true; };
    box.replaceChildren(node('p', '正在读取工单…'), close);
    try {
      const r = await client.run('work-get', { workId: id });
      const w = r.item;
      box.replaceChildren(node('h3', '工单 · ' + root.GapawTeam.STATES[w.state]), node('p', w.instruction), node('p', '工单编号：' + w.id, 'muted'));
      for (const s of r.submissions) {
        const section = node('section', null, 'compose'); section.append(node('h4', '候选建议 · 等你确认'), node('p', s.result.summary));
        for (const e of s.result.evidence) section.append(node('p', '依据：' + e, 'muted'));
        if (s.result.draft) section.append(node('h4', s.result.draft.subject), node('div', s.result.draft.body, 'body'));
        section.append(node('p', '候选已保存，尚未采用或发送。正式采用将接入后续影子决策流程。', 'muted')); box.append(section);
      }
      if (w.state !== 'cancelled') {
        const cancel = node('button', '作废工单', 'alt'); cancel.onclick = async () => {
          cancel.disabled = true;
          try { await client.run('work-cancel', { workId: id, expectedVersion: w.version }); await openWork(id); await refreshTeam(); }
          catch (e) { cancel.disabled = false; box.append(node('p', e.message)); }
        }; box.append(cancel);
      }
      box.append(close);
    } catch (e) { box.replaceChildren(node('p', e.message), close); }
  }
  function renderTeam(data) {
    teamData = data;
    const host = doc.getElementById('team-summary'); if (!host) return;
    host.replaceChildren(node('p', data.initialized ? '团队已配置。下面是已有工作的进展。' : '团队还未配置完成，可先查看已有业务记录。', 'muted'));
    const settings = node('a', data.initialized ? '查看角色任务与配置' : '去配置并初始化办公室'); settings.href = './setup.html#team-panel'; host.append(settings);
    const items = data.items || [];
    if (data.initialized) {
      const wake = node('button', '唤醒流转器', 'alt'); wake.disabled = !data.wakeWorkId;
      const msg = node('p', '', 'muted');
      wake.onclick = async () => { wake.disabled = true; try { const r = await teamFlow.wake(); msg.textContent = '宿主已受理流转请求，回执：' + r.receiptId + '。业务结果以工单交回为准。'; } catch (e) { msg.textContent = e.message; wake.disabled = false; } };
      host.append(wake, msg);
    }
    const refresh = node('button', '刷新工单', 'alt'); refresh.onclick = async () => { refresh.disabled = true; try { await refreshTeam(); } catch (e) { host.append(node('p', e.message)); refresh.disabled = false; } }; host.append(refresh);
    if (!items.length) host.append(node('p', '目前没有交给团队的新工作。已有邮件和往来记录仍可查看。', 'muted'));
    for (const w of items.slice(0, 12)) {
      const b = node('button', (root.GapawTeam.LABEL[w.staffKey] || '员工') + ' · ' + (root.GapawTeam.STATES[w.state] || w.state), 'alt');
      b.style.display = 'block'; b.onclick = () => openWork(w.id); host.append(b);
    }
    if (root.OFFICE?.updateTeam) root.OFFICE.updateTeam(data);
  }
  async function refreshTeam() { renderTeam(await client.run('team-status')); }
  function workComposer(creatorId) {
    const section = node('section', null, 'compose'); section.append(node('h4', '交给员工准备建议'));
    const select = node('select'); select.setAttribute('aria-label', '工单类型');
    const kinds = [['inbound', '来信分类'], ['negotiation', '议价与拟回复'], ['copy', '文案'], ['followup', '跟进'], ['outreach', '触达核对'], ['selection', '选人核验'], ['fulfilment', '确认与履约']];
    for (const [value, text] of kinds) { const o = node('option', text); o.value = value; select.append(o); }
    const instruction = node('textarea'); instruction.setAttribute('aria-label', '工单要求'); instruction.maxLength = 4000; instruction.value = '根据当前档案和最新往来给出建议，列出证据、缺失信息和需要我拍板的事项。只准备候选，不外发。';
    const b = node('button', '创建影子工单', 'primary'); const msg = node('p', '', 'muted');
    let payload;
    b.onclick = async () => {
      b.disabled = true; select.disabled = true; instruction.disabled = true;
      payload = payload || { requestId: 'manual-' + uuid(), source: 'manual-' + uuid(), creatorId, kind: select.value, instruction: instruction.value };
      try { const r = await client.run('work-create', payload); msg.textContent = '已创建工单 ' + r.item.id + '，到办公室任务区唤醒流转器。'; await refreshTeam(); }
      catch (e) { msg.textContent = e.message; b.disabled = false; b.textContent = '恢复创建工单'; }
    };
    section.append(select, instruction, b, msg); return section;
  }
  const replySubject = s => { const t = String(s || '').trim(); if (!t) return 'Re:'; return /^re\s*:/i.test(t) ? t : 'Re: ' + t; };
  const pendingCount = counts => (counts && (counts.draft || 0) + (counts.sending || 0) + (counts.unknown || 0)) || 0;
  function updateBadge(counts) {
    const b = doc.getElementById('outbox-badge'); if (!b) return;
    const n = pendingCount(counts || {}); b.textContent = n ? String(n) : ''; b.hidden = n <= 0;
  }
  function drawerEl(id) {
    let box = doc.getElementById(id);
    if (box) return box;
    box = doc.createElement('aside'); box.id = id; box.className = 'drawer'; box.hidden = true;
    box.setAttribute('role', 'dialog');
    doc.body.appendChild(box);
    return box;
  }
  const drawer = () => drawerEl('drawer');
  function gateLine(gate) {
    const g = gate || { mode: 'test', canSend: false, reason: '无法读取发件设置' };
    const p = node('p', null, 'gate-line');
    p.append(node('strong', g.mode === 'live' ? '正式模式' : '测试模式'));
    if (g.canSend) p.append(node('span', g.mode === 'live' ? '：会发给达人本人' : '：会发到测试收件邮箱 ' + (g.testRecipient || '（未设置）') + '，不会发给达人'));
    else {
      p.append(node('span', '：' + (g.reason || '发件设置未完成')));
      const a = doc.createElement('a'); a.href = './setup.html'; a.textContent = '去连接与设置';
      p.append(node('span', ' '), a);
    }
    return p;
  }
  function entryNode(e, opts) {
    const card = node('article', null, 'ob-entry');
    const head = node('div', null, 'ob-head');
    head.append(node('span', STATUS_TEXT[e.state] || e.state || '未知状态', 'ob-state ' + (e.state || '')));
    head.append(node('strong', e.final_subject || (e.preview && e.preview.subject) || e.subject || '（无主题）'));
    card.append(head);
    const time = e.sent_at || e.attempt_at || e.updated;
    const meta = [];
    if (time) meta.push('时间 ' + when(time));
    if (e.mode === 'live' || e.mode === 'test') meta.push(e.mode === 'live' ? '正式模式' : '测试模式');
    if (e.recipient) meta.push('收件人 ' + e.recipient);
    card.append(node('div', meta.join(' · '), 'meta'));
    if (e.error) card.append(node('div', '错误：' + e.error, 'ob-error'));
    if (e.reply_at) card.append(node('div', '测试回信' + (e.reply_subject ? ' · ' + e.reply_subject : '') + ' · ' + when(e.reply_at) + '\n' + (e.reply_body || ''), 'ob-reply'));
    const history = Array.isArray(e.history) ? e.history : [];
    if (history.length) {
      const det = doc.createElement('details');
      det.append(node('summary', '历史 ' + history.length + ' 条'));
      const ol = node('ol', null, 'ob-history');
      for (const h of history) ol.append(node('li', when(h.at) + ' · ' + (h.note || '')));
      det.append(ol); card.append(det);
    }
    const row = node('div', null, 'ob-actions');
    if (e.state === 'draft') {
      const edit = node('button', '编辑'); edit.type = 'button'; edit.onclick = () => opts.onEdit(e);
      const cancel = node('button', '撤回', 'alt'); cancel.type = 'button';
      cancel.onclick = () => opts.onAction(cancel, () => client.run('outbox-cancel', { id: e.id, revision: e.revision }), () => '草稿已撤回');
      row.append(edit, cancel);
    } else if (CHECKABLE.includes(e.state)) {
      const check = node('button', '核对结果'); check.type = 'button';
      check.onclick = () => opts.onAction(check, () => client.run('outbox-check', { id: e.id }), r => '核对完成：' + (STATUS_TEXT[r.state] || r.state));
      row.append(check);
    }
    if (row.children.length) card.append(row);
    return card;
  }
  function outboxListSection(data, opts) {
    const wrap = node('section', null, 'outbox-list');
    if (opts.title) wrap.append(node('h4', opts.title));
    const msg = node('p', '', 'muted ob-msg'); wrap.append(msg);
    const body = node('div'); wrap.append(body);
    const entryOptions = { onEdit: e => opts.onEdit(e) };
    const render = (d, note) => {
      msg.textContent = note || '';
      body.replaceChildren();
      const entries = Array.isArray(d.entries) ? d.entries : [];
      if (!entries.length) body.append(node('p', opts.empty || '还没有发件记录。', 'muted'));
      const onAction = async (btn, work, done) => {
        if (btn.disabled) return;
        btn.disabled = true; msg.textContent = '正在处理…';
        try {
          const r = await work();
          try { const fresh = await opts.reload(); render(fresh, done(r)); updateBadge(fresh.counts); if (root.OFFICE && root.OFFICE.updateOutbox) root.OFFICE.updateOutbox(fresh.counts); }
          catch (_) { render(d, done(r)); }
        } catch (e) {
          msg.textContent = '操作失败：' + (e && e.message || '未知原因');
          try { const fresh = await opts.reload(); render(fresh, msg.textContent); updateBadge(fresh.counts); if (root.OFFICE && root.OFFICE.updateOutbox) root.OFFICE.updateOutbox(fresh.counts); }
          catch (_) { /* 保留当前列表与错误提示 */ }
        }
      };
      for (const e of entries) body.append(entryNode(e, { onEdit: entryOptions.onEdit, onAction }));
    };
    render(data, '');
    return wrap;
  }
  function composeSection(c, gate, entry, opts) {
    const wrap = node('section', null, 'compose'); wrap.id = 'compose';
    wrap.append(node('h4', '写邮件'), gateLine(gate));
    const session = { clientId: uuid(), editingId: null, revision: null, saved: null, entry: null };
    let source = 'blank', subjectVal = '', bodyVal = '', replyVal = false;
    if (entry) {
      source = 'entry'; subjectVal = entry.subject || ''; bodyVal = entry.body || ''; replyVal = !!entry.reply_to;
      session.editingId = entry.id; session.revision = entry.revision; session.entry = entry;
    } else if (c.lastInbound) {
      source = 'inbound'; subjectVal = replySubject(c.lastInbound.subject); replyVal = true;
    } else if (c.emailDraft) {
      source = 'draft'; subjectVal = c.emailDraft.subject || ''; bodyVal = c.emailDraft.body || '';
    }
    const subject = doc.createElement('input'); subject.type = 'text'; subject.id = 'compose-subject'; subject.maxLength = 200; subject.value = subjectVal; subject.placeholder = '主题';
    const body = doc.createElement('textarea'); body.id = 'compose-body'; body.maxLength = 10000; body.value = bodyVal; body.placeholder = '正文';
    const sf = node('label', null, 'field'); sf.append(node('span', '主题'), subject);
    const bf = node('label', null, 'field'); bf.append(node('span', '正文'), body);
    wrap.append(sf, bf);
    let asReplyCb = null;
    if (c.lastInbound) {
      const lab = node('label', null, 'chk');
      asReplyCb = doc.createElement('input'); asReplyCb.type = 'checkbox'; asReplyCb.id = 'compose-asreply'; asReplyCb.checked = replyVal;
      lab.append(asReplyCb, node('span', '作为回复最近一封来信'));
      wrap.append(lab);
    }
    if (source === 'draft' || /【[^】]+】/.test(subjectVal + bodyVal)) wrap.append(node('p', '占位符发送时按合作设置填写', 'hint'));
    const read = () => ({ subject: subject.value, body: body.value, asReply: asReplyCb ? asReplyCb.checked : false });
    const snap = () => JSON.stringify(read());
    if (session.editingId) session.saved = snap();
    const row = node('div', null, 'row');
    const saveBtn = node('button', '保存草稿'); saveBtn.type = 'button';
    const sendBtn = node('button', '发送', 'primary'); sendBtn.type = 'button';
    const cancelBtn = node('button', '撤回', 'alt'); cancelBtn.type = 'button'; cancelBtn.hidden = !(entry && entry.state === 'draft');
    const note = node('p', '', 'muted'); note.id = 'compose-note';
    row.append(saveBtn, sendBtn, cancelBtn);
    wrap.append(row, note);
    let busy = false;
    const setBusy = b => { busy = b; saveBtn.disabled = b; cancelBtn.disabled = b; sendBtn.disabled = b || !gate.canSend; };
    if (!gate.canSend) sendBtn.disabled = true;
    const dirty = () => !session.editingId || snap() !== session.saved;
    async function save() {
      if (busy) return null;
      const v = read();
      if (!v.subject.trim() || !v.body.trim()) { note.textContent = '主题和正文都不能为空'; return null; }
      setBusy(true);
      try {
        const input = session.editingId
          ? { id: session.editingId, revision: session.revision, subject: v.subject, body: v.body, asReply: v.asReply }
          : { clientId: session.clientId, creatorId: c.id, subject: v.subject, body: v.body, asReply: v.asReply };
        const saved = await client.run('outbox-save', input);
        session.editingId = saved.id; session.revision = saved.revision; session.entry = saved; session.saved = snap();
        cancelBtn.hidden = saved.state !== 'draft';
        note.textContent = '草稿已保存 · ' + when(saved.updated || saved.created);
        await opts.onSaved();
        return saved;
      } catch (e) {
        note.textContent = '保存失败：' + (e && e.message || '未知原因');
        return null;
      } finally { setBusy(false); }
    }
    saveBtn.onclick = save;
    sendBtn.onclick = async () => {
      if (busy) return;
      let current = session.entry;
      if (dirty()) {
        current = await save();
        if (!current) return;
      } else if (session.editingId && opts.refreshEntry) {
        // 发送前重新读取规则：保存之后可能又来了新来信。
        try {
          const fresh = await opts.refreshEntry(session.editingId);
          if (fresh) {
            if (fresh.state !== 'draft') { note.textContent = '这封邮件已经发出或撤回，不能再发送'; return; }
            current = fresh; session.entry = fresh; session.revision = fresh.revision;
          }
        } catch (_) { /* 读取失败时沿用上次保存的规则 */ }
      }
      if (!current || current.state !== 'draft') { note.textContent = '这封邮件已经发出或撤回，不能再发送'; return; }
      confirmDialog(current, gate, { onSent: () => opts.onSent() });
    };
    cancelBtn.onclick = async () => {
      if (busy || !session.editingId) return;
      setBusy(true);
      try {
        await client.run('outbox-cancel', { id: session.editingId, revision: session.revision });
        note.textContent = '草稿已撤回';
        await opts.onSent();
      } catch (e) {
        note.textContent = '撤回失败：' + (e && e.message || '未知原因');
      } finally { setBusy(false); }
    };
    return wrap;
  }
  function confirmDialog(entry, gate, opts) {
    const old = doc.getElementById('confirm'); if (old) old.remove();
    const overlay = node('div', null, 'overlay'); overlay.id = 'confirm';
    const box = node('div', null, 'confirm-box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.append(node('h3', '确认发送'));
    const mode = entry.mode || (gate && gate.mode) || 'test';
    const modeText = mode === 'live'
      ? '正式模式：会发给达人本人。'
      : '测试模式：会发到测试收件邮箱 ' + ((gate && gate.testRecipient) || entry.recipient || '（未设置）') + '，不会发给达人。';
    const modeLine = node('p', modeText, 'confirm-mode'); modeLine.id = 'confirm-mode'; box.append(modeLine);
    const pv = entry.preview || { subject: entry.subject || '', body: entry.body || '' };
    const preview = node('div', null, 'confirm-preview');
    const subj = node('div', pv.subject || '（无主题）', 'subj'); subj.id = 'confirm-subject';
    const text = node('div', pv.body || '（无正文）', 'body'); text.id = 'confirm-body';
    preview.append(subj, text);
    box.append(preview);
    const rules = Array.isArray(entry.rules) ? entry.rules : [];
    if (rules.length) {
      const ul = node('ul', null, 'rules');
      for (const r of rules) {
        const ok = r.ok === true, liveOnly = r.liveOnly === true;
        const li = node('li', null, ok ? 'ok' : (mode === 'test' && liveOnly ? 'warn' : 'bad'));
        li.append(node('span', (ok ? '✓ ' : '✕ ') + (r.label || r.key || '')));
        if (r.message) li.append(node('span', '：' + r.message, 'rm'));
        if (!ok && mode === 'test' && liveOnly) li.append(node('em', '正式模式下会被拦下', 'live-note'));
        ul.append(li);
      }
      box.append(ul);
    }
    const blocking = rules.filter(r => r.ok !== true && (mode === 'live' || r.liveOnly !== true));
    const freshOnly = blocking.length === 1 && blocking[0].key === 'fresh';
    if (blocking.length) box.append(node('p', freshOnly ? '写这封信之后达人又来信了。请先看过新来信，或确认仍要发送。' : '有拦截项，先处理后再发送。', 'ob-error'));
    const actions = node('div', null, 'confirm-actions');
    const cancel = node('button', '取消', 'alt'); cancel.id = 'confirm-cancel'; cancel.type = 'button'; cancel.onclick = () => overlay.remove();
    const ack = node('button', '我已看过新来信，仍要发送', 'alt'); ack.id = 'confirm-ack'; ack.type = 'button'; ack.hidden = !freshOnly;
    const confirm = node('button', '确认发送', 'primary'); confirm.id = 'confirm-send'; confirm.type = 'button'; confirm.disabled = blocking.length > 0;
    actions.append(cancel, ack, confirm);
    box.append(actions);
    const status = node('p', '', 'confirm-status'); box.append(status);
    overlay.append(box); doc.body.append(overlay);
    let sending = false;
    const perform = async acknowledge => {
      if (sending || (!acknowledge && confirm.disabled)) return;
      sending = true; overlay.dataset.busy = '1';
      confirm.disabled = true; ack.disabled = true; cancel.disabled = true;
      status.textContent = '正在发送，请稍候…';
      try {
        const input = acknowledge ? { id: entry.id, revision: entry.revision, acknowledgeNewInbound: true } : { id: entry.id, revision: entry.revision };
        await client.run('outbox-send', input);
        overlay.remove();
        if (root.OFFICE && typeof root.OFFICE.sent === 'function') root.OFFICE.sent();
        await opts.onSent();
      } catch (e) {
        status.textContent = '发送结果未知，请稍后点“核对结果”，不会自动重发。' + (e && e.message ? '（' + e.message + '）' : '');
        cancel.disabled = false;
        try { await opts.onSent(); } catch (_) { /* 列表刷新失败时保留提示 */ }
      } finally {
        sending = false;
        if (overlay.isConnected) delete overlay.dataset.busy;
      }
    };
    confirm.onclick = () => perform(false);
    ack.onclick = () => perform(true);
  }
  async function openCreator(id, options) {
    const opts = options || {};
    const box = drawer(); box.hidden = false;
    const close = node('button', '关闭', 'alt'); close.type = 'button'; close.onclick = () => { box.hidden = true; };
    box.replaceChildren(node('p', '正在读取…', 'muted'), close);
    try {
      const c = await client.run('office-creator', { creatorId: id });
      let data;
      try { data = await client.run('outbox-list', { creatorId: id }); }
      catch (e) { data = { gate: { mode: 'test', canSend: false, reason: e && e.message || '无法读取发件设置' }, entries: [], counts: {} }; }
      const gate = data.gate || { mode: 'test', canSend: false, reason: '无法读取发件设置' };
      updateBadge(data.counts); if (root.OFFICE && root.OFFICE.updateOutbox) root.OFFICE.updateOutbox(data.counts);
      const head = node('div', null, 'dhead'); const h = node('h3', '@' + (c.handle || c.id)); h.id = 'drawer-title'; head.append(h, close);
      const parts = [head];
      parts.push(workComposer(id));
      if (c.negotiation) {
        const n = c.negotiation, dl = node('dl', null, 'neg');
        for (const [k, v] of [['状态', n.status], ['我方', n.ourOffer], ['对方要', n.theirAsk], ['下一步', n.nextStep]]) if (v) dl.append(node('dt', k), node('dd', v));
        parts.push(dl);
      }
      const list = node('ol', null, 'thread');
      for (const m of c.messages || []) {
        const li = node('li', null, m.direction === 'in' ? 'in' : 'out');
        li.append(node('div', (m.direction === 'in' ? '对方' : '我们') + ' · ' + (m.channel === 'email' ? '邮件' : m.channel || '') + ' · ' + when(m.at) + (m.kind && m.kind !== '正常' ? ' · ' + m.kind : ''), 'meta'));
        if (m.subject) li.append(node('div', m.subject, 'subj'));
        li.append(node('div', m.zh || m.body || '（无正文）', 'body'));
        list.append(li);
      }
      parts.push((c.messages || []).length ? list : node('p', '还没有往来记录。', 'muted'));
      parts.push(node('p', '往来只读查看；写邮件只在你确认后发送。', 'muted'));
      const editEntry = opts.editId ? (data.entries || []).find(e => e.id === opts.editId) : null;
      let refreshOutbox = async () => {};
      const outboxHost = node('div');
      const reload = async () => {
        const d = await client.run('outbox-list', { creatorId: id });
        updateBadge(d.counts); if (root.OFFICE && root.OFFICE.updateOutbox) root.OFFICE.updateOutbox(d.counts);
        return d;
      };
      const refreshEntry = async entryId => {
        const d = await reload();
        return (d.entries || []).find(e => e.id === entryId) || null;
      };
      const compose = composeSection(c, gate, editEntry, {
        onSaved: () => refreshOutbox(),
        onSent: () => openCreator(id),
        refreshEntry,
      });
      const sectionOpts = { title: '发件记录', empty: '还没有给这位达人的发件记录。', onEdit: e => openCreator(id, { editId: e.id }), reload };
      outboxHost.append(outboxListSection(data, sectionOpts));
      refreshOutbox = async () => {
        try { const d = await reload(); outboxHost.replaceChildren(outboxListSection(d, sectionOpts)); }
        catch (e) { /* 列表刷新失败时保留旧列表 */ }
      };
      parts.push(compose, outboxHost);
      box.replaceChildren(...parts);
      if (opts.editId) compose.scrollIntoView({ block: 'start' });
    } catch (e) {
      box.replaceChildren(node('p', '读取失败：' + (e && e.message || '未知原因'), 'muted'), close);
    }
  }
  async function openOutbox() {
    const panel = drawerEl('outbox-panel'); panel.hidden = false;
    const close = node('button', '关闭', 'alt'); close.type = 'button'; close.onclick = () => { panel.hidden = true; };
    panel.replaceChildren(node('p', '正在读取发件箱…', 'muted'), close);
    try {
      const data = await client.run('outbox-list', {});
      updateBadge(data.counts); if (root.OFFICE && root.OFFICE.updateOutbox) root.OFFICE.updateOutbox(data.counts);
      const head = node('div', null, 'dhead'); const h = node('h3', '发件箱'); h.id = 'outbox-title'; head.append(h, close);
      const host = node('div');
      const reload = async () => {
        const d = await client.run('outbox-list', {});
        updateBadge(d.counts); if (root.OFFICE && root.OFFICE.updateOutbox) root.OFFICE.updateOutbox(d.counts);
        return d;
      };
      host.append(outboxListSection(data, {
        empty: '还没有发件记录。',
        onEdit: e => { panel.hidden = true; openCreator(e.creator, { editId: e.id }); },
        reload,
      }));
      panel.replaceChildren(head, gateLine(data.gate), host);
    } catch (e) {
      panel.replaceChildren(node('p', '读取发件箱失败：' + (e && e.message || '未知原因'), 'muted'), close);
    }
  }
  root.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const confirm = doc.getElementById('confirm'); if (confirm && !confirm.dataset.busy) { confirm.remove(); return; }
    const b = doc.getElementById('drawer'); if (b) b.hidden = true;
    const p = doc.getElementById('outbox-panel'); if (p) p.hidden = true;
  });
  const SAMPLE = ['@sample_creator_a', '@sample_creator_b', '@sample_creator_c', '@sample_creator_d', '@sample_creator_e'];
  function start(S) {
  const W = 384, H = 216, CORR = 118, END = 21 * 60;
  const ROW_TOP = [72, 150], SEAT = [80, 158];
  const $ = id => document.getElementById(id);
  const cv = $('scene'), g = cv.getContext('2d'), ov = $('overlay');
  g.imageSmoothingEnabled = false;
  const hashMode = new URLSearchParams(location.hash.slice(1)).get('mode');
  const MODE = hashMode === 'demo' ? 'demo' : 'real';
  let speed = 2;
  const sampleData = S.silent.length < 45 || !S.negotiations.length;

  // ---------- 员工与地点 ----------
  const EMP = [
    { id: 'send', name: '小发', role: '触达', x: 92, row: 0, shirt: '#d0574a', hair: '#3b2a20', pants: '#34405a', skin: '#f1c9a5', breakAt: 13 * 60 },
    { id: 'follow', name: '小跟', role: '跟进', x: 152, row: 0, shirt: '#e09a3a', hair: '#1d1d1d', pants: '#3c3c48', skin: '#e9b98f', breakAt: 15 * 60 + 30 },
    { id: 'copy', name: '小文', role: '文案', x: 212, row: 0, shirt: '#5a8fcf', hair: '#7a4a2a', pants: '#2f3a4f', skin: '#f6d2b0', breakAt: 12 * 60 + 10 },
    { id: 'sel', name: '小选', role: '选人', x: 272, row: 0, shirt: '#58a06a', hair: '#2a2a2a', pants: '#3a3a3a', skin: '#e3b088', breakAt: 11 * 60 },
    { id: 'sort', name: '小拣', role: '来信分类', x: 92, row: 1, shirt: '#8a6bc4', hair: '#c08a3a', pants: '#33344a', skin: '#f1c9a5', breakAt: 14 * 60 },
    { id: 'deal', name: '小谈', role: '议价', x: 152, row: 1, shirt: '#2f8f88', hair: '#3b2a20', pants: '#2b2b38', skin: '#dba882', breakAt: 16 * 60 + 30 },
    { id: 'ful', name: '小履', role: '确认与履约', x: 212, row: 1, shirt: '#c4607f', hair: '#1d1d1d', pants: '#3a3046', skin: '#f6d2b0', breakAt: 12 * 60 + 40 },
  ];
  const E = Object.fromEntries(EMP.map(e => [e.id, e]));
  const LOC = {
    entry: { spot: { x: 17, y: 50 }, door: { x: 17, y: CORR } },
    mailbox: { spot: { x: 60, y: 92 }, door: { x: 60, y: CORR } },
    inbox: { spot: { x: 60, y: 146 }, door: { x: 60, y: CORR } },
    boss: { spot: { x: 300, y: 158 }, door: { x: 300, y: CORR } },
    coffee: { spot: { x: 350, y: 70 }, door: { x: 350, y: CORR } },
  };
  for (const e of EMP) {
    const y = SEAT[e.row];
    LOC[e.id] = { spot: { x: e.x, y }, side: { x: e.x + 22, y }, door: { x: e.x + 22, y: CORR } };
    LOC['to-' + e.id] = { spot: { x: e.x + 22, y }, door: { x: e.x + 22, y: CORR } };
  }

  // ---------- 真实数据 ----------
  const today = new Date(); const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const TODAY = iso(today);
  const realSilent = S.silent.map(s => '@' + s.handle);
  const silent = MODE === 'demo' && sampleData ? Array.from({ length: 60 }, (_, i) => realSilent[i] || SAMPLE[i % SAMPLE.length]) : realSilent;
  const silentTotal = S.silentTotal ?? realSilent.length;
  const negs = S.negotiations;
  const sampleNeg = { id: 'sample', handle: 'sample_creator_x', status: '示例谈判', theirAsk: '更高报价', ball: 'them' };
  const counterNeg = negs.find(n => n.ball === 'them' && !/无真人/.test(n.status || '')) || negs[0] || sampleNeg;
  const gw001 = negs.find(n => n.id === 'GW001') || negs[1] || counterNeg;
  const usNeg = negs.filter(n => n.ball === 'us' && !/无真人|结案/.test(n.status || ''));
  const missing = S.setup.items.filter(i => i.state === 'missing' || i.state === 'error' || i.state === 'action').filter(i => i.id !== 'browser').map(i => i.title);
  const noData = !S.workbench.initialized;
  const mailWhy = missing.length ? missing.join('、') + '未设置' : '';
  const STEP_EMP = { '选人': 'sel', '合作条件': 'deal', '文案': 'copy', '触达': 'send', '来信分类': 'sort', '议价': 'deal', '跟进': 'follow', '确认合作与履约': 'ful' };
  const stepToEmp = {}; const train = Object.fromEntries(EMP.map(e => [e.id, { total: 0, done: 0, open: [] }]));
  for (const s of S.rehearsal.steps || []) { const k = STEP_EMP[s.title]; if (!k) continue; stepToEmp[s.id] = k; train[k].total += s.total; train[k].done += s.done; }
  for (const it of S.rehearsal.open || []) { const k = stepToEmp[it.step]; if (k) train[k].open.push(it); }
  const hardOpen = (S.rehearsal.open || []).filter(i => i.kind === 'hard').length;

  // ---------- 运行状态 ----------
  let T = 0, simMin = 8 * 60 + 56, ended = false;
  if (MODE === 'real') { const n = new Date(); simMin = n.getHours() * 60 + n.getMinutes(); }
  const waits = [];
  const sleep = s => new Promise(r => waits.push({ t: T + s, r }));
  const until = m => new Promise(r => waits.push({ m, r }));
  const F = { ...S.funnel };
  const stat = { sent: 0, recv: 0, replies: 0, filed: 0 };
  const perEmp = Object.fromEntries(EMP.map(e => [e.id, 0]));
  const Q = Object.fromEntries(EMP.map(e => [e.id, []])); Q.inbox = []; Q.boss = [];
  const tokens = [];
  const C = {};
  for (const e of EMP) {
    const at = MODE === 'real' ? e.id : 'entry';
    const p = LOC[at].spot;
    C[e.id] = { e, x: p.x, y: p.y, at, path: [], carry: null, state: MODE === 'real' ? 'idle' : 'away', visible: MODE === 'real', face: 1, bubble: null, bubbleUntil: 0, bubbleKind: '', task: '还没上班', moving: false };
  }

  // ---------- 叠加层 ----------
  const place = (el, x, y) => { el.style.left = (x / W * 100) + '%'; el.style.top = (y / H * 100) + '%'; };
  const mk = (cls, html, x, y) => { const el = document.createElement('div'); el.className = cls; if (html != null) el.innerHTML = html; ov.appendChild(el); if (x != null) place(el, x, y); return el; };
  const board = mk('board px', '');
  mk('lbl', '寄出', 45, 92); mk('lbl', '来信筐', 42, 152); mk('lbl', '你的桌（老板）', 327, 149); mk('lbl', '咖啡', 350, 46);
  const tags = {};
  for (const e of EMP) tags[e.id] = mk('tag', '<i></i>' + e.name + '<span class="role"> · ' + e.role + '</span>', e.x, ROW_TOP[e.row] + 15);
  const bubs = {}; for (const e of EMP) { bubs[e.id] = mk('bub', ''); bubs[e.id].hidden = true; }
  const say = (ch, text, secs = 2.6, kind = '') => { ch.bubble = text; ch.bubbleUntil = T + secs; ch.bubbleKind = kind; };

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // ---------- 侧栏 ----------
  const feedEl = $('feed'); let feedCount = 0;
  const clockText = () => pad(Math.floor(simMin / 60)) + ':' + pad(Math.floor(simMin % 60));
  function feed(text, kind = '') {
    const li = document.createElement('li'); li.className = kind;
    const tm = document.createElement('time'); tm.className = 'px'; tm.textContent = clockText(); const sp = document.createElement('span'); sp.textContent = text; li.append(tm, sp);
    feedEl.prepend(li); feedCount++; $('feed-n').textContent = feedCount + ' 条';
    while (feedEl.children.length > 60) feedEl.lastChild.remove();
  }
  const asksEl = $('asks'); let askOpen = 0;
  function askCount() { $('ask-n').textContent = askOpen ? askOpen + ' 项' : ''; }
  function ask(title, why, opts = {}) {
    return new Promise(resolve => {
      const box = document.createElement('div'); box.className = 'ask' + (opts.info ? ' info' : '');
      box.innerHTML = '<div class="k"></div><div class="w"></div>' + (opts.meta ? '<div class="meta"></div>' : '') + '<div class="row"></div>';
      box.querySelector('.k').textContent = title; box.querySelector('.w').textContent = why;
      if (opts.meta) box.querySelector('.meta').textContent = opts.meta;
      const row = box.querySelector('.row');
      for (const [label, val, alt] of opts.buttons || [['确认', 'ok'], ['我来改', 'edit', true]]) {
        const b = document.createElement('button'); b.textContent = label; b.dataset.ask = val; if (alt) b.className = 'alt';
        b.onclick = () => {
          if (opts.info) { if (opts.open) opts.open(); else if (opts.href) root.location.href = opts.href; return; }
          box.className = 'ask done'; row.remove(); box.querySelector('.w').textContent = val === 'ok' ? '你已确认，' + (opts.after || '员工继续。') : '你改过后确认，差异已记住。';
          askOpen--; askCount(); resolve(val);
        };
        row.appendChild(b);
      }
      asksEl.prepend(box); askOpen++; askCount();
    });
  }
  function funnel() {
    const items = [['选人', F.creators], ['触达', F.contacted], ['回复', F.replied], ['谈判', F.negotiating], ['确认', F.confirmed]];
    $('funnel').innerHTML = items.map(([k, v], i) => (i ? '<span class="chip arrow">→</span>' : '') + '<span class="chip" data-k="' + k + '">' + k + '<b>' + v + '</b></span>').join('');
    board.innerHTML = '本周看板<span>触达 ' + F.contacted + ' · 回复 ' + F.replied + ' · 谈判 ' + F.negotiating + ' · 确认 ' + F.confirmed + '</span>' +
      (MODE === 'demo' ? '<small>今日 寄出 ' + stat.sent + ' · 收信 ' + stat.recv + '</small>' : '<small>' + (mailWhy ? '⚠ ' + esc(mailWhy) : '') + '</small>');
  }
  function bumpChip(k) { funnel(); const el = document.querySelector('.chip[data-k="' + k + '"]'); if (el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); } }

  // ---------- 日历 ----------
  function calendar() {
    const el = $('cal'); el.innerHTML = '';
    const start = new Date(today); start.setDate(start.getDate() - 9);
    let left = silent.length;
    for (let i = 0; i < 14; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i); const k = iso(d);
      const box = document.createElement('div'); box.className = 'd';
      const wk = '日一二三四五六'[d.getDay()];
      let body = '';
      if (k < TODAY) {
        const v = S.days[k];
        body = v ? '<em>寄出 ' + (v.sent || 0) + '</em><em>回复 ' + ((v.replies || 0) + (v.interested || 0)) + '</em>' : '<em class="z">没有动作</em>';
      } else {
        const n = Math.min(20, Math.max(0, left)); left -= n;
        if (k === TODAY) { box.classList.add('today'); body = MODE === 'demo' ? '<em id="cal-today">寄出 ' + stat.sent + '</em><em>收信 ' + stat.recv + '</em>' : '<em>跟进 ' + n + ' 位</em><em>' + (mailWhy ? '受阻' : '') + '</em>'; if (MODE === 'real' && mailWhy) box.classList.add('block'); }
        else { box.classList.add(MODE === 'real' && mailWhy ? 'block' : 'plan'); body = (n ? '<em>跟进 ' + n + ' 位</em>' : '') + (d.getDay() === 1 ? '<em>周复盘</em>' : '') + '<em>' + (MODE === 'real' && mailWhy ? '受阻' : '计划') + '</em>'; }
      }
      box.innerHTML = '<b>' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + (k === TODAY ? '今天' : wk) + '</b>' + body;
      el.appendChild(box);
    }
    requestAnimationFrame(() => { const td = el.querySelector('.today'); if (td && el.scrollWidth > el.clientWidth) el.scrollLeft = td.offsetLeft - el.offsetLeft - 8; });
  }

  // ---------- 员工档案 ----------
  let picked = 'deal';
  const STATE_TXT = { work: '工作中', wait: '等你', block: '受阻', idle: '空闲', away: '不在工位' };
  function who() {
    const ch = C[picked], e = ch.e, t = train[e.id];
    const pct = t.total ? Math.round(t.done / t.total * 100) : 0;
    $('who-body').innerHTML = '<div class="row"><span>员工</span><span>' + e.name + ' · ' + e.role + '</span></div>' +
      '<div class="row"><span>状态</span><span>' + STATE_TXT[ch.state] + '</span></div>' +
      '<div class="row"><span>在做</span><span></span></div>' +
      '<div class="row"><span>桌上待办</span><span>' + Q[e.id].length + ' 件</span></div>' +
      (MODE === 'demo' ? '<div class="row"><span>今天经手</span><span>' + perEmp[e.id] + ' 件</span></div>' : '') +
      '<div class="row"><span>带教进度</span><span>' + t.done + '/' + t.total + '</span></div><div class="bar"><i style="width:' + pct + '%"></i></div>' +
      (t.open.length ? '<ol class="q">' + t.open.slice(0, 4).map(q => '<li></li>').join('') + '</ol>' : '');
    $('who-body').children[2].lastChild.textContent = ch.task;
    const lis = $('who-body').querySelectorAll('.q li'); t.open.slice(0, 4).forEach((q, i) => { lis[i].textContent = (q.kind === 'hard' ? '【数值】' : '') + q.title; });
    if (MODE === 'real') {
      const task = teamData?.staff?.find(s => s.key === e.id)?.task;
      const link = node('a', task ? '打开员工角色任务' : '配置员工任务'); link.href = task?.url || './setup.html#team-panel'; link.target = '_blank'; link.rel = 'noopener'; $('who-body').append(link);
    }
  }
  cv.addEventListener('click', ev => {
    const r = cv.getBoundingClientRect(); const x = (ev.clientX - r.left) / r.width * W, y = (ev.clientY - r.top) / r.height * H;
    let best = null, bd = 400;
    for (const ch of Object.values(C)) { if (!ch.visible) continue; const d = (ch.x - x) ** 2 + (ch.y - 9 - y) ** 2; if (d < bd) { bd = d; best = ch; } }
    if (best) { picked = best.e.id; who(); }
  });

  // ---------- 行走 ----------
  function walk(ch, to) {
    const a = LOC[ch.at], b = LOC[to];
    const pts = [a.side, a.door, b.door, b.side, b.spot].filter(Boolean);
    const path = [];
    for (const p of pts) { const l = path[path.length - 1]; if (!l || l.x !== p.x || l.y !== p.y) path.push({ ...p }); }
    ch.path = path; ch.visible = true; ch.dest = to;
    return new Promise(r => { ch.onArrive = r; });
  }
  async function deliver(ch, to, item, label, line) {
    ch.carry = label; ch.state = 'work'; ch.task = line || ('送' + label + '给' + E[to].name);
    await walk(ch, 'to-' + to);
    Q[to].push(item); perEmp[ch.e.id]++;
    say(ch, '给你，' + E[to].name + '！', 1.4); ch.carry = null;
    await sleep(0.5);
    await walk(ch, ch.e.id);
  }
  function fly(from, to, dur = 1.4) { return new Promise(r => tokens.push({ from, to, t0: T, dur, r })); }

  // ---------- 绘制 ----------
  const px = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
  function sky() {
    if (simMin >= 19 * 60) return ['#1f2a4a', true];
    if (simMin >= 17 * 60 + 30) return ['#f2a65a', false];
    return ['#9fd3f0', false];
  }
  function drawRoom() {
    px(0, 44, W, H - 44, '#d8b98c');
    for (let y = 44, r = 0; y < H; y += 8, r++) { px(0, y, W, 1, '#c7a676'); for (let x = (r % 2) * 16; x < W; x += 32) px(x, y, 1, 8, '#c7a676'); }
    px(282, 122, 92, 58, '#6f8f78'); px(284, 124, 88, 54, '#7fa287'); px(288, 128, 80, 46, '#6f8f78');
    px(0, 0, W, 44, '#efe3c8'); px(0, 0, W, 3, '#d9c9a6'); px(0, 41, W, 4, '#8b6a4a');
    const [sk, night] = sky();
    for (const wx of [64, 104, 262]) {
      px(wx, 8, 30, 24, '#7a5a3c'); px(wx + 2, 10, 26, 20, sk);
      if (night) { px(wx + 6, 14, 1, 1, '#fff'); px(wx + 19, 21, 1, 1, '#fff'); px(wx + 12, 12, 1, 1, '#ffe'); }
      else { px(wx + 5, 14, 7, 2, '#ffffffaa'); px(wx + 8, 13, 4, 1, '#ffffffaa'); }
      px(wx + 14, 10, 2, 20, '#7a5a3c'); px(wx + 2, 19, 26, 2, '#7a5a3c'); px(wx - 1, 32, 32, 2, '#a07c56');
    }
    px(146, 5, 108, 30, '#8d8d8d'); px(148, 7, 104, 26, '#fbfbf7'); px(150, 33, 18, 2, '#666');
    // 挂钟
    px(304, 8, 16, 16, '#5a4632'); px(305, 9, 14, 14, '#fff');
    const m = simMin % 60, h = (simMin / 60) % 12;
    for (let i = 1; i <= 5; i++) { const a = m / 60 * Math.PI * 2 - Math.PI / 2; px(312 + Math.cos(a) * i, 16 + Math.sin(a) * i, 1, 1, '#222'); }
    for (let i = 1; i <= 3; i++) { const a = h / 12 * Math.PI * 2 - Math.PI / 2; px(312 + Math.cos(a) * i, 16 + Math.sin(a) * i, 1, 1, '#b33'); }
    // 门
    const doorOpen = Object.values(C).some(c => c.visible && c.y < 64 && c.x < 30);
    px(5, 11, 24, 33, '#5a3c26'); px(7, 13, 20, 31, doorOpen ? '#2b2018' : '#9a6a44');
    if (!doorOpen) { px(9, 16, 16, 10, '#a87850'); px(9, 29, 16, 12, '#a87850'); px(23, 28, 2, 2, '#e2c045'); }
    // 咖啡机
    px(342, 20, 18, 24, '#4d4f57'); px(344, 22, 14, 9, '#7c808b'); px(354, 24, 2, 2, Math.floor(T * 2) % 2 ? '#f55' : '#a33'); px(348, 36, 6, 6, '#fff'); px(349, 37, 4, 3, '#6b4226');
    // 绿植
    for (const [x, y] of [[362, 196], [6, 196], [262, 70]]) { px(x + 1, y - 10, 6, 4, '#4f9a55'); px(x - 1, y - 14, 4, 6, '#5fb065'); px(x + 5, y - 15, 4, 7, '#4f9a55'); px(x + 2, y - 18, 3, 6, '#6cc172'); px(x, y - 4, 8, 6, '#b5633c'); px(x, y - 4, 8, 1, '#d07a4e'); }
  }
  function pile(x, y, n, max = 8) { for (let i = 0; i < Math.min(n * 2, max); i++) px(x + (i % 2), y - i, 8, 1, i % 2 ? '#ffffff' : '#e4e4dc'); }
  function drawMailbox() {
    px(43, 84, 2, 6, '#333'); px(38, 66, 14, 18, '#c8382f'); px(39, 64, 12, 2, '#c8382f'); px(38, 66, 14, 1, '#e0574c'); px(41, 70, 8, 1, '#5a1a16'); px(41, 76, 8, 3, '#e8d3a0');
  }
  function drawInbox() {
    px(30, 138, 26, 4, '#b07a45'); px(30, 142, 26, 1, '#8a5a30'); px(32, 142, 2, 8, '#7a5230'); px(52, 142, 2, 8, '#7a5230');
    px(34, 133, 18, 5, '#6f7f8f'); px(34, 133, 18, 1, '#8c9cad'); pile(39, 132, Q.inbox.length, 10);
  }
  function drawBoss() {
    px(318, 116, 18, 14, '#2f2f3d'); px(318, 116, 18, 2, '#4a4a5c');
    px(294, 130, 66, 6, '#8a5a36'); px(294, 136, 66, 11, '#6e4528'); px(294, 136, 66, 1, '#5a3820');
    px(296, 147, 3, 6, '#5a3820'); px(355, 147, 3, 6, '#5a3820');
    px(298, 124, 16, 6, '#6f7f8f'); pile(302, 123, Q.boss.length, 10);
    px(338, 122, 14, 8, '#333740'); px(339, 123, 12, 6, '#4a4e59');
    px(322, 131, 12, 3, '#e2c045');
  }
  function drawChair(e) { const y = SEAT[e.row]; px(e.x - 6, y - 15, 12, 10, '#3b4a5c'); px(e.x - 6, y - 15, 12, 1, '#52647a'); }
  function drawDesk(e) {
    const top = ROW_TOP[e.row], x = e.x, ch = C[e.id];
    px(x - 16, top, 32, 5, '#c08a55'); px(x - 16, top + 5, 32, 9, '#9a6a40'); px(x - 16, top + 5, 32, 1, '#7d5432'); px(x + 8, top + 8, 4, 1, '#e2c045');
    px(x + 4, top - 8, 12, 8, '#353842'); px(x + 5, top - 7, 10, 6, '#454a56'); px(x + 9, top - 5, 2, 2, '#9aa3b8'); px(x + 2, top - 1, 15, 1, '#24262c');
    const seated = ch.visible && !ch.moving && ch.at === e.id;
    if (seated && ch.state === 'work') px(x + 4, top - 9, 12, 1, Math.floor(T * 6) % 2 ? '#9fe0ff' : '#c8f0ff');
    pile(x - 14, top - 1, Q[e.id].length, 10);
    px(x - 4, top - 3, 3, 3, '#fff'); px(x - 4, top - 3, 3, 1, '#6b4226');
  }
  function drawChar(ch) {
    if (!ch.visible) return;
    const e = ch.e, x = Math.round(ch.x), y = Math.round(ch.y);
    const ph = Math.floor(T * 8) % 2, seated = !ch.moving && ch.at === e.id;
    const lift = ch.moving ? (ph ? 1 : 0) : 0;
    px(x - 4, y, 8, 1, '#0000002a');
    px(x - 3, y - 6, 2, 6 - (ch.moving && ph ? 1 : 0), e.pants); px(x + 1, y - 6, 2, 6 - (ch.moving && !ph ? 1 : 0), e.pants);
    px(x - 3, y - 1 - (ch.moving && ph ? 1 : 0), 2, 1, '#2a2a2a'); px(x + 1, y - 1 - (ch.moving && !ph ? 1 : 0), 2, 1, '#2a2a2a');
    const by = y - 12 - lift;
    px(x - 4, by, 8, 6, e.shirt); px(x - 4, by, 8, 1, '#ffffff33');
    const raise = ch.state === 'wait' && seated && Math.floor(T * 1.5) % 3 !== 2;
    if (raise) { px(x + 4, by - 6, 2, 7, e.shirt); px(x + 4, by - 8, 2, 2, e.skin); }
    else if (seated && ch.state === 'work') { const k = Math.floor(T * 10) % 2; px(x - 5, by + 1, 1, 4, e.shirt); px(x + 4, by + 1, 1, 4, e.shirt); px(x - 5, by + 4 + k, 2, 1, e.skin); px(x + 3, by + 5 - k, 2, 1, e.skin); }
    else { px(x - 5, by + 1, 1, 5, e.shirt); px(x + 4, by + 1, 1, 5, e.shirt); px(x - 5, by + 6, 1, 1, e.skin); px(x + 4, by + 6, 1, 1, e.skin); }
    const hy = by - 6 + (ch.state === 'idle' && seated && Math.floor(T) % 4 === 0 ? 1 : 0);
    px(x - 3, hy, 6, 6, e.skin); px(x - 3, hy - 1, 6, 2, e.hair); px(x - 3, hy, 1, 3, e.hair); px(x + 2, hy, 1, 2, e.hair);
    const blinkNow = Math.floor(T * 3 + e.x) % 13 === 0;
    if (!blinkNow) { const f = ch.face > 0 ? 1 : 0; px(x - 2 + f, hy + 3, 1, 1, '#222'); px(x + 1 + f, hy + 3, 1, 1, '#222'); }
    if (ch.carry) { px(x - 3, by + 1, 7, 5, '#fffdf4'); px(x - 2, by + 2, 5, 1, '#b9b9b0'); px(x - 2, by + 4, 4, 1, '#b9b9b0'); px(x - 4, by + 3, 1, 2, e.skin); px(x + 4, by + 3, 1, 2, e.skin); }
    if (ch.state === 'block' && seated) { const bob = Math.floor(T * 3) % 2; px(x - 1, hy - 11 - bob, 2, 5, '#e5463a'); px(x - 1, hy - 5 - bob, 2, 2, '#e5463a'); }
    if (ch.state === 'idle' && seated && simMin > 9 * 60 + 30 && MODE === 'demo') { const z = Math.floor(T * 2) % 3; if (z) px(x + 4 + z, hy - 4 - z * 2, 2, 2, '#ffffffaa'); }
  }
  function drawEnvelope(x, y) { px(x - 3, y - 2, 7, 5, '#fffdf4'); px(x - 3, y - 2, 7, 1, '#d8d4c4'); px(x - 2, y - 1, 1, 1, '#d8d4c4'); px(x + 2, y - 1, 1, 1, '#d8d4c4'); px(x, y, 1, 1, '#c33'); }
  function draw() {
    drawRoom();
    const items = [];
    for (const e of EMP) { items.push([SEAT[e.row] - 0.5, () => drawChair(e)]); items.push([ROW_TOP[e.row] + 14, () => drawDesk(e)]); }
    items.push([90, drawMailbox], [150, drawInbox], [147, drawBoss], [115.5, () => { }]);
    for (const ch of Object.values(C)) items.push([ch.y, () => drawChar(ch)]);
    items.sort((a, b) => a[0] - b[0]).forEach(i => i[1]());
    for (const t of tokens) { const k = Math.min(1, (T - t.t0) / t.dur); const x = t.from.x + (t.to.x - t.from.x) * k; const y = t.from.y + (t.to.y - t.from.y) * k - Math.sin(k * Math.PI) * 18; drawEnvelope(x, y); }
    if (simMin >= 18 * 60 + 30) { const a = Math.min(0.42, (simMin - (18 * 60 + 30)) / 150 * 0.42); g.fillStyle = 'rgba(16,20,44,' + a + ')'; g.fillRect(0, 0, W, H); }
  }

  // ---------- 每帧 ----------
  const SPEED_PX = 80, RATE = 5;
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    T += dt * speed;
    if (MODE === 'demo') { if (!ended) simMin = Math.min(END + 30, simMin + dt * speed * RATE); }
    else { const d = new Date(); simMin = d.getHours() * 60 + d.getMinutes(); }
    for (let i = waits.length - 1; i >= 0; i--) { const w = waits[i]; if ((w.t != null && T >= w.t) || (w.m != null && simMin >= w.m)) { waits.splice(i, 1); w.r(); } }
    for (let i = tokens.length - 1; i >= 0; i--) { if (T - tokens[i].t0 >= tokens[i].dur) { const t = tokens.splice(i, 1)[0]; t.r(); } }
    for (const ch of Object.values(C)) {
      if (!ch.path.length) { ch.moving = false; continue; }
      ch.moving = true; let step = dt * speed * SPEED_PX;
      while (step > 0 && ch.path.length) {
        const p = ch.path[0], dx = p.x - ch.x, dy = p.y - ch.y, d = Math.hypot(dx, dy);
        if (dx) ch.face = dx > 0 ? 1 : -1;
        if (d <= step) { ch.x = p.x; ch.y = p.y; ch.path.shift(); step -= d; } else { ch.x += dx / d * step; ch.y += dy / d * step; step = 0; }
      }
      if (!ch.path.length) { ch.moving = false; ch.at = ch.dest; const r = ch.onArrive; ch.onArrive = null; if (r) r(); }
    }
    draw();
    for (const e of EMP) {
      const ch = C[e.id], b = bubs[e.id];
      const show = ch.visible && ch.bubble && T < ch.bubbleUntil;
      b.hidden = !show;
      if (show) { if (b.textContent !== ch.bubble) b.textContent = ch.bubble; b.className = 'bub' + (ch.bubbleKind ? ' ' + ch.bubbleKind : ''); const sw = ov.clientWidth, half = b.offsetWidth / 2; const lx = Math.max(half + 2, Math.min(sw - half - 2, ch.x / W * sw)); b.style.left = lx + 'px'; b.style.top = ((ch.y - 21) / H * 100) + '%'; }
      const dot = tags[e.id].firstChild; const st = ch.visible ? ch.state : 'away'; if (dot.className !== st) dot.className = st;
    }
    $('clock').textContent = clockText();
    if (Math.floor(T * 4) !== frame.k) { frame.k = Math.floor(T * 4); who(); }
    requestAnimationFrame(frame);
  }

  // ---------- 演示：模拟一天 ----------
  const sent = (n = 1) => { stat.sent += n; F.contacted = Math.max(F.contacted, S.funnel.contacted); const c = $('cal-today'); if (c) c.textContent = '寄出 ' + stat.sent; funnel(); };
  function incoming(item) { stat.recv++; funnel(); const c = document.querySelector('.cal .today em:nth-child(3)'); if (c) c.textContent = '收信 ' + stat.recv; return fly({ x: 17, y: 30 }, { x: 43, y: 132 }, 1.5).then(() => { Q.inbox.push(item); feed('来信筐：收到 ' + item.handle + ' 的来信'); }); }
  async function idleOrBreak(ch) {
    if (!ended && simMin >= ch.e.breakAt && !ch.hadBreak) {
      ch.hadBreak = true; ch.state = 'away'; ch.task = '去倒杯咖啡';
      await walk(ch, 'coffee'); say(ch, '☕ 续杯', 2); await sleep(2.2); await walk(ch, ch.e.id);
    }
    if (ch.state !== 'wait') { ch.state = 'idle'; ch.task = '手上没活，等下一件'; }
    await sleep(0.4);
  }
  async function selLoop() {
    const ch = C.sel; await until(9 * 60 + 5);
    ch.state = 'work'; ch.task = '挑今天该跟进的人'; say(ch, '筛名单：首封 ≥5 天未回的 ' + silent.length + ' 位', 2.2); await sleep(2.2);
    say(ch, '今天先跟进 20 位（每天上限 20）', 1.6); await sleep(1.6);
    await deliver(ch, 'copy', { kind: 'list', handles: silent.slice(0, 20) }, '名单×20', '送今日名单给小文');
    feed('小选：选出今天跟进的 20 位，交给小文');
    await until(13 * 60 + 40); ch.state = 'work'; ch.task = '查新候选的回本率'; say(ch, '按回本率给明天的候选排序…', 3); await sleep(4);
    say(ch, '明天名单备好了', 2, 'ok'); feed('小选：明天的候选已排好（未选入的不会联系）');
    while (!ended) await idleOrBreak(ch);
  }
  async function copyLoop() {
    const ch = C.copy;
    while (!ended) {
      const it = Q.copy.shift(); if (!it) { await idleOrBreak(ch); continue; }
      for (let i = 0; i < it.handles.length; i += 5) {
        const hs = it.handles.slice(i, i + 5); ch.state = 'work'; ch.task = '写跟进文案 ' + hs[0] + ' 等 5 位';
        say(ch, '写跟进：' + hs[0] + ' …', 1.6); await sleep(1.6);
        await deliver(ch, 'follow', { kind: 'batch', handles: hs }, '文案×5', '送 5 份文案给小跟');
      }
      feed('小文：20 份跟进文案写完，按你上次的语气');
    }
  }
  async function followLoop() {
    const ch = C.follow;
    while (!ended) {
      const it = Q.follow.shift(); if (!it) { await idleOrBreak(ch); continue; }
      ch.state = 'work'; ch.task = '核对 ' + it.handles[0] + ' 等 5 位的跟进间隔';
      say(ch, '核对：距上次 ≥5 天、未超 2 次 ✓', 1.4); await sleep(1.4);
      await deliver(ch, 'send', { kind: 'batch', handles: it.handles }, '待寄×5', '把核对过的 5 封交给小发');
    }
  }
  async function sendLoop() {
    const ch = C.send;
    while (!ended) {
      const it = Q.send.shift(); if (!it) { await idleOrBreak(ch); continue; }
      ch.state = 'work'; ch.carry = it.kind === 'batch' ? '信×' + it.handles.length : '回信'; ch.task = '去邮筒寄信';
      await walk(ch, 'mailbox'); ch.carry = null;
      const list = it.kind === 'batch' ? it.handles : [it.handle];
      for (const h of list) { say(ch, '寄出 → ' + h, 0.7); fly({ x: 45, y: 66 }, { x: 17, y: 22 }, 1.0); await sleep(0.4); sent(); perEmp.send++; }
      feed(it.kind === 'batch' ? '小发：寄出 ' + list.length + ' 封跟进（' + list[0] + ' 等）' : '小发：寄出给 ' + it.handle + ' 的回复（' + it.note + '）', 'ok');
      await walk(ch, 'send');
    }
  }
  async function sortLoop() {
    const ch = C.sort;
    while (!ended) {
      const it = Q.inbox.shift(); if (!it) { await idleOrBreak(ch); continue; }
      ch.state = 'work'; ch.task = '取来信'; await walk(ch, 'inbox'); ch.carry = '来信'; await walk(ch, 'sort'); ch.carry = null;
      ch.task = '读 ' + it.handle + ' 的来信'; say(ch, '读信：' + it.handle, 1.6); await sleep(1.8); perEmp.sort++;
      if (it.kind === 'auto') { say(ch, '秒回的报价单 → 自动回复，不算回复', 2.8); stat.filed++; feed('小拣：' + it.handle + ' 18 秒后回了报价单，判为自动回复，跟进日不变'); await sleep(2.8); }
      else if (it.kind === 'counter') { say(ch, '还价 ' + (it.ask || '') + ' → 交小谈', 2.4, 'warn'); feed('小拣：' + it.handle + ' 还价，转给小谈', 'you'); await sleep(1.2); await deliver(ch, 'deal', it, '还价信'); }
      else if (it.kind === 'interest') { say(ch, '有意向！→ 交小谈', 2.4, 'ok'); stat.replies++; F.replied++; bumpChip('回复'); feed('小拣：' + it.handle + ' 回复有意向', 'ok'); await sleep(1.2); await deliver(ch, 'deal', it, '意向信'); }
      else if (it.kind === 'sample') { say(ch, '申请样品 → 交小履', 2.4, 'ok'); feed('小拣：' + it.handle + ' 在联盟后台申请了样品'); await sleep(1.2); await deliver(ch, 'ful', it, '申样单'); }
    }
  }
  async function dealLoop() {
    const ch = C.deal;
    while (!ended) {
      const it = Q.deal.shift(); if (!it) { await idleOrBreak(ch); continue; }
      ch.state = 'work';
      if (it.kind === 'counter') {
        ch.task = '起草给 ' + it.handle + ' 的回复'; say(ch, '起草：坚持 $100/条，可加 30 天 Spark 授权', 3); await sleep(3.4);
        say(ch, '涉及金额，得老板签字', 2, 'warn'); await sleep(1.4);
        ch.carry = '草稿'; ch.task = '把草稿放到你桌上'; await walk(ch, 'boss'); ch.carry = null; Q.boss.push(it); await sleep(0.4);
        await walk(ch, 'deal'); ch.state = 'wait'; ch.task = '等你确认给 ' + it.handle + ' 的回复';
        feed('小谈：给 ' + it.handle + ' 的回复涉及金额，放在你桌上等签字', 'you');
        const r = await ask('确认回复 ' + it.handle, '对方要 ' + (it.ask || '更高报价') + '。草稿：坚持 $100/条，可加 30 天 Spark 授权；表现好再追加投流。', { after: '小谈把信交给小发寄出。', meta: '涉及报价，永远由你确认' });
        ch.state = 'work'; say(ch, r === 'ok' ? '收到！马上寄' : '按你改的寄', 1.6, 'ok');
        await walk(ch, 'boss'); Q.boss.shift(); ch.carry = '已签'; await walk(ch, 'deal'); ch.carry = null;
        await deliver(ch, 'send', { kind: 'reply', handle: it.handle, note: r === 'ok' ? '你已确认' : '你改过' }, '回信', '把签好的回信交给小发');
      } else if (it.kind === 'interest') {
        ch.task = '回复 ' + it.handle + ' 的意向'; say(ch, '回：发样品申请链接和合作说明（不涉及金额）', 3); await sleep(3.2);
        F.negotiating++; bumpChip('谈判');
        await deliver(ch, 'send', { kind: 'reply', handle: it.handle, note: '标准说明，无条件变化' }, '回信');
      }
    }
  }
  async function fulLoop() {
    const ch = C.ful;
    while (!ended) {
      const it = Q.ful.shift(); if (!it) { await idleOrBreak(ch); continue; }
      ch.state = 'work'; ch.task = '核对 ' + it.handle + ' 的合作条件'; say(ch, '核对：金额、条数、佣金、付款节点都书面同意了', 3); await sleep(3.2);
      ch.carry = '确认单'; ch.task = '把确认单放到你桌上'; await walk(ch, 'boss'); ch.carry = null; Q.boss.push(it); await sleep(0.4);
      await walk(ch, 'ful'); ch.state = 'wait'; ch.task = '等你确认 ' + it.handle + ' 的合作';
      feed('小履：' + it.handle + ' 已申样并给了地址，等你登记“确认合作”', 'you');
      await ask('登记 ' + it.handle + ' 为确认合作？', '对方已认可方案、申请样品并提供地址。确认后小履安排寄样并开始跟踪发布。', { after: '小履登记并安排寄样。', meta: '确认合作永远由你决定', buttons: [['确认合作', 'ok'], ['再等等', 'edit', true]] });
      await walk(ch, 'boss'); Q.boss.shift(); await walk(ch, 'ful');
      F.confirmed++; bumpChip('确认'); ch.state = 'work'; say(ch, '已登记，安排寄样 📦', 2.4, 'ok'); feed('小履：' + it.handle + ' 登记为确认合作，开始跟踪寄样', 'ok'); await sleep(2.4);
    }
  }
  async function mailSchedule() {
    await until(10 * 60 + 40); await incoming({ kind: 'auto', handle: silent[2] });
    await until(11 * 60 + 50); await incoming({ kind: 'counter', handle: '@' + counterNeg.handle, ask: (counterNeg.theirAsk || '').slice(0, 24) || '更高报价' });
    await until(14 * 60 + 50); await incoming({ kind: 'interest', handle: silent[30] });
    await until(16 * 60 + 10); await incoming({ kind: 'sample', handle: '@' + gw001.handle });
    await until(17 * 60 + 30); await incoming({ kind: 'auto', handle: silent[41] });
  }
  async function demo() {
    $('note').textContent = '演示：假设发件邮箱和测试邮箱已经设好，' + (sampleData ? '用示例账号' : '用你的真实名单') + '模拟一天（09:00–21:00）。不会发送任何东西，也不改任何数据。涉及金额和确认合作的，员工会把单子放到“你的桌”并举手，等你在右侧点确认。';
    await until(9 * 60);
    feed('上班了');
    EMP.forEach((e, i) => (async () => { await sleep(i * 0.4); const ch = C[e.id]; ch.task = '去工位'; ch.state = 'idle'; await walk(ch, e.id); say(ch, '早！', 1.2); })());
    await sleep(EMP.length * 0.4 + 3);
    [selLoop, copyLoop, followLoop, sendLoop, sortLoop, dealLoop, fulLoop].forEach(f => f());
    mailSchedule();
    await until(END); ended = true;
    feed('下班。今天寄出 ' + stat.sent + ' 封，收信 ' + stat.recv + ' 封，' + (askOpen ? '还有 ' + askOpen + ' 项等你确认' : '你的桌上没有待签的'));
    for (const ch of Object.values(C)) { if (ch.state === 'wait') { say(ch, '明天等你签字', 2.5, 'warn'); continue; } (async () => { await sleep(Math.random() * 1.5); while (ch.moving) await sleep(0.3); ch.state = 'away'; ch.task = '下班了'; say(ch, '下班～', 1.2); await walk(ch, 'entry'); ch.visible = false; })(); }
    await sleep(6);
    const box = document.createElement('div'); box.className = 'end';
    box.innerHTML = '<h3>今日小结</h3>寄出 ' + stat.sent + ' 封 · 收信 ' + stat.recv + ' 封<br>新增有意向 ' + stat.replies + ' 位 · 确认合作 ' + (F.confirmed - S.funnel.confirmed) + ' 位<br>' + (askOpen ? '还有 ' + askOpen + ' 项在你的桌上' : '你的桌上清空了') + '<br><button>再看一遍</button>';
    box.querySelector('button').onclick = () => location.reload();
    ov.appendChild(box);
  }

  // ---------- 真实状态 ----------
  function realMode() {
    $('note').className = 'note real';
    $('note').textContent = noData
      ? '真实状态：还没有业务数据，请先在连接与设置中准备数据。'
      : '真实状态：小人按插件工单显示当前工作。点击员工看进展；检查新回复时才会同步邮箱。';
    applyTeam(S.team || { staff: [], items: [] });
    Q.boss.push(...missing, ...(hardOpen ? ['h'] : []), ...usNeg.map(() => 'n'));
    root.GapawAttention.render(asksEl, S, homeActions);
    feed('真实状态：' + EMP.filter(e => C[e.id].state === 'block').length + ' 位受阻，' + EMP.filter(e => C[e.id].state === 'wait').length + ' 位等你');
    const blocked = EMP.filter(e => C[e.id].state === 'block').map(e => C[e.id]);
    const waiting = EMP.filter(e => C[e.id].state === 'wait').map(e => C[e.id]);
    (async () => {
      await sleep(1.5); let i = 0;
      for (;;) {
        const ch = blocked[i % blocked.length]; i++;
        if (ch) {
          say(ch, '卡住了：' + ch.task, 2.4, 'warn'); await sleep(2.4);
          ch.carry = '便条'; await walk(ch, 'boss'); say(ch, '老板，这个得你来设', 1.8, 'warn'); ch.carry = null; await sleep(1.6); await walk(ch, ch.e.id);
        }
        const w = waiting[i % waiting.length]; if (w) { say(w, w.task, 2.6); }
        await sleep(2.5);
      }
    })();
  }

  function applyTeam(data) {
    if (MODE !== 'real') return;
    for (const e of EMP) {
      const ch = C[e.id], task = (data.staff || []).find(s => s.key === e.id)?.task;
      const jobs = (data.items || []).filter(w => w.staffKey === e.id && w.state !== 'cancelled');
      const active = jobs.find(w => w.state === 'processing'), review = jobs.find(w => w.state === 'awaiting_review'), stale = jobs.find(w => w.state === 'stale');
      const pending = jobs.find(w => ['pending', 'claimed', 'dispatched'].includes(w.state));
      ch.state = !task ? 'block' : active ? 'work' : review ? 'wait' : stale ? 'block' : 'idle';
      ch.task = !task ? '还需要配置这位员工' : active ? '正在处理交给我的工作' : review ? '建议已准备好，等待审阅' : stale ? '资料有变化，需要重新核对' : pending ? '工作已排队，等待开始' : '暂时没有新工作';
      Q[e.id] = jobs.filter(w => ['pending', 'claimed', 'dispatched', 'processing'].includes(w.state));
    }
    who();
  }

  // ---------- 控件 ----------
  $('v-demo').setAttribute('aria-pressed', MODE === 'demo'); $('v-real').setAttribute('aria-pressed', MODE === 'real');
  $('demo-menu').open = MODE === 'demo';
  $('v-demo').onclick = () => { location.hash = 'mode=demo'; location.reload(); };
  $('v-real').onclick = () => { location.hash = ''; location.reload(); };
  $('speed').onclick = () => { speed = speed === 2 ? 4 : speed === 4 ? 1 : 2; $('speed').textContent = speed + '×'; };
  if (MODE === 'real') $('speed').hidden = true;
  if (!asksEl.children.length) asksEl.innerHTML = '';
  function renderOutboxAsk(counts) {
    if (MODE === 'real') return; // Real attention cards refresh with the full read model.
    const n = (counts && (counts.sending || 0) + (counts.unknown || 0)) || 0;
    let card = doc.getElementById('outbox-ask-card');
    if (!n) { if (card) card.remove(); return; }
    if (!card) {
      card = doc.createElement('div'); card.id = 'outbox-ask-card'; card.className = 'ask info';
      const k = doc.createElement('div'); k.className = 'k';
      const w = doc.createElement('div'); w.className = 'w'; w.textContent = '发送结果还没核对完，不会自动重发。';
      const row = doc.createElement('div'); row.className = 'row';
      const b = doc.createElement('button'); b.type = 'button'; b.textContent = '打开发件箱'; b.onclick = openOutbox;
      row.append(b); card.append(k, w, row);
    }
    card.querySelector('.k').textContent = n + ' 封信结果待核对';
    asksEl.prepend(card);
  }
  updateBadge(S.outbox); renderOutboxAsk(S.outbox);
  funnel(); calendar(); who();
  feedEl.innerHTML = '<li><span class="empty">还没有动态</span></li>';
  const origFeed = feed; let firstFeed = true;
  feed = function (t, k) { if (firstFeed) { feedEl.innerHTML = ''; firstFeed = false; } origFeed(t, k); };
  if (MODE === 'demo') demo(); else realMode();
  window.OFFICE = {
    speed: v => { speed = v; $('speed').textContent = v + '×'; }, pending: () => askOpen, time: () => simMin, mode: MODE,
    sent: () => { fly({ x: 300, y: 150 }, { x: 45, y: 66 }, 1.3); feed('发件箱：寄出一封邮件', 'ok'); },
    updateOutbox: counts => { renderOutboxAsk(counts); refreshOverview(); },
    updateTeam: applyTeam,
  };
  requestAnimationFrame(t => { last = t; frame(t); });
  }
  function syncButton() {
    const b = doc.getElementById('sync'); if (!b) return;
    b.onclick = async () => {
      b.disabled = true; const label = b.textContent; b.textContent = '同步中…';
      const note = doc.getElementById('note');
      try {
        const r = await client.run('mail-sync', { apply: true });
        const n = (r.imported || []).length, f = r.folders || {};
        note.className = 'note real';
        note.textContent = '邮件同步完成：新增收件 ' + (f.inbox?.new || 0) + ' 封、发件 ' + (f.sent?.new || 0) + ' 封；未匹配达人 ' + (r.unmatched || 0) + ' 封（只计数，不建档）。' + (n ? '正在刷新…' : '');
        await refreshOverview();
        if (n) setTimeout(() => root.location.reload(), 1200);
      } catch (e) {
        note.className = 'note real';
        note.textContent = '邮件同步失败：' + (e && e.message || '未知原因');
      } finally { b.disabled = false; b.textContent = label; }
    };
  }
  async function boot() {
    syncButton();
    const outboxBtn = doc.getElementById('outbox-btn'); if (outboxBtn) outboxBtn.onclick = openOutbox;
    doc.getElementById('home-outbox').onclick = openOutbox;
    const note = root.document.getElementById('note');
    try {
      const data = await client.run('office-status');
      root.GapawHome.render(data, homeActions);
      start(data);
      renderTeam(data.team || { initialized: false, staff: [], items: [] });
      if (root.location.hash === '#outbox') await openOutbox();
      if (root.location.hash === '#business-history') doc.getElementById('business-history').open = true;
    } catch (e) {
      root.GapawHome.error(e.message || '请稍后重试', () => root.location.reload());
      note.className = 'note real';
      note.textContent = '读取工作台数据失败：' + (e && e.message || '未知原因') + ' 可以刷新重试，或先进入“工作台”。';
    }
  }
  root.addEventListener('hashchange', () => {
    if (root.location.hash === '#outbox') openOutbox();
    if (root.location.hash === '#business-history') doc.getElementById('business-history').open = true;
  });
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
