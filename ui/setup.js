(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./app.js') : root.GapawWorkbenchApp);
  if (node) module.exports = api;
  else root.addEventListener('DOMContentLoaded', () => {
    if (root.document.getElementById('setup-list')) api.mount(root.document, root);
    if (root.document.getElementById('wb-setup-banner')) api.banner(root.document, root);
  });
}(typeof window === 'undefined' ? globalThis : window, function (App) {
  'use strict';
  const STATE_LABEL = { ok: '可用', action: '需要处理', missing: '未配置', error: '读取失败', optional: '可选', skipped: '未检查' };
  const FEATURES = [['mailSync', '收件同步'], ['mailSend', '发送邮件'], ['selection', '选人']];
  const ITEM_TITLE = { data: '业务数据', mailLogin: '飞书邮箱登录', sender: '发件邮箱', testRecipient: '测试收件邮箱', browser: '浏览器与平台登录' };
  const BOX_TYPE = { USER_PRIMARY: '个人邮箱', PUBLIC_MAILBOX: '公共邮箱' };
  const CHANGE_LABEL = { senderMailbox: '发件邮箱', senderName: '发件人显示名', testRecipient: '测试收件邮箱', mode: '运行模式', limits: '发送上限', delegation: '放权参数', sync: '定时同步' };
  // 登录检测超过 10 分钟视为过期，打开页面时自动重测。
  const STALE_MS = 10 * 60 * 1000;

  function formatTime(value) {
    const d = new Date(value);
    return value && !Number.isNaN(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : '—';
  }
  function stale(check, now = Date.now()) {
    const t = check && Date.parse(check.checkedAt);
    return !t || now - t > STALE_MS;
  }
  function stateClass(state) { return state === 'ok' ? 'tag' : state === 'error' ? 'tag bad' : 'tag warn'; }

  function mount(document, window) {
    const client = App.createClient(window.fetch.bind(window));
    const $ = id => document.getElementById(id);
    let data = null, busy = false;
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = String(text); if (cls) n.className = cls; return n; };
    const button = (text, cls, fn, disabled = false) => { const b = el('button', text, cls); b.type = 'button'; b.disabled = busy || disabled; b.addEventListener('click', fn); return b; };
    const field = (label, input, hint) => { const w = el('div', undefined, 'setup-field'); const l = el('label', label); l.htmlFor = input.id; w.append(l, input); if (hint) w.append(el('p', hint, 'hint')); return w; };
    const input = (id, value, attrs = {}) => { const i = el('input'); i.id = id; i.value = value ?? ''; for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v); return i; };
    const linkTo = (text, href) => { const a = el('a', text); a.href = href; return a; };
    function notice(message, error = false) { const n = $('setup-summary'); n.textContent = message; n.className = error ? 'notice error' : 'notice'; }

    async function act(fn) {
      if (busy) return;
      // 只禁用按钮，不重绘：重绘会把尚未保存的输入换回旧值。
      busy = true;
      for (const b of document.querySelectorAll('#setup-list button')) b.disabled = true;
      try { await fn(); }
      catch (error) { notice(error.message, true); }
      finally { busy = false; await reload(false); }
    }
    async function reload(showSummary = true) {
      try { data = await client.run('setup-status'); render(showSummary); }
      catch (error) { notice('读取设置失败：' + error.message, true); }
    }
    async function save(values, extra = {}) {
      const r = await client.run('setup-save', { expectedVersion: data.version, values, ...extra });
      notice(r.changed ? '已保存。' + (r.notes?.length ? r.notes.join('；') : '') : '没有需要保存的修改。');
    }
    const item = id => data.items.find(i => i.id === id);

    function renderSummary() {
      notice(data.pending ? '还有 ' + data.pending + ' 项必需设置未完成：' + data.items.filter(i => i.required && i.state !== 'ok').map(i => i.title).join('、') + '。' : '邮件功能所需的设置已全部完成。');
    }
    function renderFeatures() {
      $('setup-features').replaceChildren(...FEATURES.map(([key, label]) => {
        const f = data.features[key]; const c = el('div', undefined, 'setup-feature');
        c.append(el('strong', label), el('span', f.ready ? '可用' : '缺少：' + f.blockers.map(b => ITEM_TITLE[b] || b).join('、'), f.ready ? 'tag' : 'tag warn'));
        return c;
      }));
    }
    function card(it, ...body) {
      const c = el('section', undefined, 'card setup-item'); c.id = 'setup-' + it.id; c.dataset.state = it.state;
      const head = el('div', undefined, 'setup-head');
      const title = el('div'); title.append(el('h2', it.title), el('p', '用于：' + it.requiredBy.join('、') + (it.required ? '' : '（非必需）'), 'hint'));
      head.append(title, el('span', STATE_LABEL[it.state] || it.state, stateClass(it.state)));
      c.append(head);
      if (it.summary) c.append(el('p', it.summary, 'setup-summary-line'));
      c.append(...body.filter(Boolean));
      return c;
    }
    const actions = (...nodes) => { const d = el('div', undefined, 'operation-actions'); d.append(...nodes.filter(Boolean)); return d; };

    function dataCard() { return card(item('data'), actions(linkTo('打开数据管理', './index.html#data'))); }
    function loginCard() {
      const it = item('mailLogin'), c = data.mailCheck;
      const parts = [];
      if (c?.login?.userName) parts.push(el('p', '登录账号：' + c.login.userName + '；邮件读取权限：' + (c.login.canRead ? '有' : '无') + '；发送权限：' + (c.login.canSend ? '有' : '无') + '。', 'hint'));
      if (c) parts.push(el('p', '上次检测：' + formatTime(c.checkedAt), 'hint'));
      if (it.state !== 'ok') {
        const steps = el('ol', undefined, 'setup-steps');
        const lines = c?.installed === false
          ? ['在本机安装飞书命令行 lark-cli。', '在终端运行 lark-cli auth login，按提示在飞书页面授权，勾选邮件读取与发送权限。', '回到这里点“重新检测”。']
          : ['在终端运行 lark-cli auth login。', '在打开的飞书页面完成授权，勾选邮件读取与发送权限。', '回到这里点“重新检测”。'];
        steps.append(...lines.map(t => el('li', t)));
        parts.push(steps);
      }
      parts.push(actions(button(c ? '重新检测' : '检测', 'secondary', () => act(async () => { const r = await client.run('mail-status'); notice(r.message); }))));
      return card(it, ...parts);
    }
    function senderCard() {
      const it = item('sender'), boxes = data.mailCheck?.mailboxes || [];
      const sel = el('select'); sel.id = 'setup-sender-mailbox';
      const blank = el('option', boxes.length ? '请选择发件邮箱' : '请先检测飞书邮箱登录'); blank.value = ''; sel.append(blank);
      for (const b of boxes) { const o = el('option', b.address + (BOX_TYPE[b.type] ? '（' + BOX_TYPE[b.type] + '）' : '')); o.value = b.address; sel.append(o); }
      const current = data.values.senderMailbox;
      if (current && !boxes.some(b => b.address === current)) { const o = el('option', current + '（当前不可访问）'); o.value = current; sel.append(o); }
      sel.value = current;
      const name = input('setup-sender-name', data.values.senderName, { maxlength: '60', placeholder: '例如 Gapaw Team（可选）' });
      return card(it,
        field('发件邮箱', sel, '只能从当前登录账号可访问的邮箱中选择。'),
        field('发件人显示名', name, '收件人看到的名字；可留空。'),
        actions(button('保存', 'primary', () => act(() => save({ senderMailbox: sel.value, senderName: name.value })), !boxes.length && !current)));
    }
    function testCard() {
      const it = item('testRecipient'), t = data.mailTest, v = data.values;
      const addr = input('setup-test-recipient', v.testRecipient, { type: 'email', maxlength: '254', placeholder: 'you@example.com' });
      const samePair = t && t.sender === v.senderMailbox && t.recipient === v.testRecipient;
      const parts = [field('测试收件邮箱', addr, '填一个你能登录的外部邮箱。测试模式下所有外发邮件都只会发到这里。')];
      if (samePair) {
        const info = el('div', undefined, 'setup-test');
        info.append(el('p', '测试编号：' + (t.token || '—') + '；发送时间：' + formatTime(t.startedAt) + '；上次核对：' + formatTime(t.checkedAt), 'hint'));
        if (t.error) info.append(el('p', t.error, 'operation-error'));
        if (['accepted', 'delivered'].includes(t.state)) info.append(el('p', '请登录 ' + t.recipient + '，直接回复主题为“' + t.subject + '”的邮件，然后点“检查回信”。'));
        parts.push(info);
      }
      const unsettled = samePair && ['sending', 'unknown'].includes(t.state);
      const ready = item('mailLogin').state === 'ok' && item('sender').state === 'ok' && v.testRecipient;
      parts.push(actions(
        button('保存', 'secondary', () => act(() => save({ testRecipient: addr.value }))),
        button('发送测试信', 'primary', () => {
          if (!window.confirm('将从 ' + v.senderMailbox + ' 向 ' + v.testRecipient + ' 发送一封连接测试信。确认发送？')) return;
          act(async () => { const r = await client.run('mail-test', { action: 'send', expectedVersion: data.version }); notice(r.error || '测试信已提交，请到测试邮箱回复后点“检查回信”。', !!r.error); });
        }, !ready || unsettled),
        samePair ? button('检查回信', 'secondary', () => act(async () => { const r = await client.run('mail-test', { action: 'check' }); notice(r.state === 'replied' ? '已收到测试邮箱的回信，收发测试通过。' : (r.error || '还没有收到回信，回复后再点一次。'), !!r.error); })) : null));
      if (!ready) parts.push(el('p', '需要先完成飞书邮箱登录和发件邮箱，并保存测试收件邮箱，才能发送测试信。', 'hint'));
      return card(it, ...parts);
    }
    function modeCard() {
      const it = item('mode'), live = data.values.mode === 'live';
      const canLive = item('testRecipient').state === 'ok' && item('mailLogin').state === 'ok';
      return card(it, actions(live
        ? button('切回测试模式', 'secondary', () => act(() => save({ mode: 'test' })))
        : button('切换到正式模式', 'secondary', () => {
          if (!window.confirm('正式模式下，外发邮件会发往达人的真实邮箱。确认切换？')) return;
          act(() => save({ mode: 'live' }, { confirmLive: true }));
        }, !canLive)), live || canLive ? null : el('p', '完成一次收发测试后才能切换到正式模式。', 'hint'));
    }
    function browserCard() { return card(item('browser'), actions(linkTo('前往选人页绑定实例并检测登录', './selection.html'))); }
    function numberField(id, label, value, min, max, hint) { return field(label, input(id, value, { type: 'number', min: String(min), max: String(max), step: '1' }), hint); }
    const num = id => Number($(id).value);
    function limitsCard() {
      const l = data.values.limits;
      return card(item('limits'), (() => { const g = el('div', undefined, 'setup-grid');
        g.append(numberField('setup-daily', '每日发送上限（封）', l.dailySend, 1, 200), numberField('setup-followups', '每位达人跟进次数上限', l.maxFollowups, 0, 5), numberField('setup-interval', '跟进最小间隔（天）', l.minIntervalDays, 1, 30),
          field('允许发送开始时间', input('setup-window-start', l.windowStart, { type: 'time' })), field('允许发送结束时间', input('setup-window-end', l.windowEnd, { type: 'time' })));
        return g; })(),
      actions(button('保存', 'secondary', () => act(() => save({ limits: { dailySend: num('setup-daily'), maxFollowups: num('setup-followups'), minIntervalDays: num('setup-interval'), windowStart: $('setup-window-start').value, windowEnd: $('setup-window-end').value } })))));
    }
    function delegationCard() {
      const d = data.values.delegation;
      return card(item('delegation'), (() => { const g = el('div', undefined, 'setup-grid');
        g.append(numberField('setup-streak', '连续通过次数', d.streak, 3, 50, '某个动作连续这么多次你都没有实质修改，插件才会提议放权。'), numberField('setup-creators', '至少覆盖达人数', d.creators, 1, 50), numberField('setup-undo', '自动外发撤回窗口（分钟）', d.undoMinutes, 0, 1440));
        return g; })(),
      el('p', '放权功能将在后续版本上线；这里先保存参数。', 'hint'),
      actions(button('保存', 'secondary', () => act(() => save({ delegation: { streak: num('setup-streak'), creators: num('setup-creators'), undoMinutes: num('setup-undo') } })))));
    }
    function syncCard() {
      const s = data.values.sync;
      const box = input('setup-sync-enabled', '', { type: 'checkbox' }); box.checked = s.enabled; box.className = 'setup-check';
      const wrap = el('label', undefined, 'setup-toggle'); wrap.append(box, document.createTextNode(' 开启定时同步收件'));
      return card(item('sync'), wrap, numberField('setup-sync-interval', '同步间隔（分钟）', s.intervalMinutes, 15, 1440),
        actions(button('保存', 'secondary', () => act(() => save({ sync: { enabled: box.checked, intervalMinutes: num('setup-sync-interval') } })))));
    }
    function renderHistory() {
      const list = data.history || [];
      $('setup-history').replaceChildren(...(list.length ? list.map(h => el('li', formatTime(h.at) + '：修改了' + h.changed.map(k => CHANGE_LABEL[k] || k).join('、') + (h.note ? '（' + h.note + '）' : ''))) : [el('li', '还没有修改记录。')]));
    }
    function render(showSummary = true) {
      if (!data) return;
      if (showSummary) renderSummary();
      renderFeatures();
      $('setup-list').replaceChildren(dataCard(), loginCard(), senderCard(), testCard(), modeCard(), browserCard(), limitsCard(), delegationCard(), syncCard());
      renderHistory();
    }

    (async () => {
      await reload();
      if (data && stale(data.mailCheck)) {
        notice('正在检测飞书邮箱登录…');
        await act(async () => { await client.run('mail-status'); });
        if (data) renderSummary();
      }
    })();
    return { reload };
  }

  // 首页顶部提示：必需设置未完成时显示，完成后隐藏。
  async function banner(document, window) {
    const node = document.getElementById('wb-setup-banner');
    try {
      const s = await App.createClient(window.fetch.bind(window)).run('setup-status', { brief: true });
      if (!s.pending) { node.hidden = true; return; }
      const a = document.createElement('a'); a.href = './setup.html'; a.textContent = '去设置';
      node.replaceChildren(document.createTextNode('还有 ' + s.pending + ' 项连接与设置未完成（' + s.items.filter(i => i.required && i.state !== 'ok').map(i => i.title).join('、') + '），相关功能暂不可用。'), a);
      node.hidden = false;
    } catch (_) { node.hidden = true; }
  }

  return { mount, banner, stale, formatTime };
}));
