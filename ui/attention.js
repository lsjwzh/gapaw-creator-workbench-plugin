// Presentation of Rust's read-only attention groups. No messages or facts change.
(function (root) {
  'use strict';
  const make = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const time = value => { const d = new Date(value); return value && Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间待核对'; };
  function card(title, description, label, action) {
    const box = make('div', null, 'ask info'); box.append(make('div', title, 'k'), make('div', description, 'w'));
    const row = make('div', null, 'row'), b = make('button', label); b.type = 'button'; b.onclick = action; row.append(b); box.append(row); return box;
  }
  function render(host, data, actions) {
    if (!host) return;
    const opened = new Set(Array.from(host.querySelectorAll('details[open][data-attention-key]')).map(d => d.dataset.attentionKey));
    host.replaceChildren();
    const groups = data.attention;
    if (!groups) { host.append(make('p', '待处理列表暂时不可用，请刷新进度。', 'scope-note')); document.getElementById('ask-n').textContent = '暂不可用'; return; }
    let count = 0;
    function section(key, title, note, cards, collapsed = false) {
      if (!cards.length) return;
      count += cards.length;
      const wrap = make(collapsed ? 'details' : 'section', null, 'attention-group'); wrap.dataset.attentionGroup = key;
      if (collapsed) { wrap.dataset.attentionKey = key; wrap.open = opened.has(key); }
      wrap.append(make(collapsed ? 'summary' : 'h3', title + ' · ' + cards.length), make('p', note, 'scope-note'));
      wrap.append(...cards.slice(0, 5));
      if (cards.length > 5) {
        const more = make('details', null, 'attention-more'); more.dataset.attentionKey = key + '-more'; more.open = opened.has(key + '-more');
        more.append(make('summary', '查看其余 ' + (cards.length - 5) + ' 项'), ...cards.slice(5)); wrap.append(more);
      }
      host.append(wrap);
    }
    const urgent = [], setup = data.setup || {}, team = data.team || {};
    const unsettled = (data.outbox?.sending || 0) + (data.outbox?.unknown || 0);
    if (unsettled) {
      const entry = card(unsettled + ' 封信结果待核对', '先核对发送回执，避免重复联系。', '打开发件箱', actions.openOutbox);
      entry.id = 'outbox-ask-card'; urgent.push(entry);
    }
    for (const w of team.items || []) if (['stale', 'blocked'].includes(w.state)) urgent.push(card('团队工作需要核对', w.state === 'stale' ? '依据已变化，需重新查看候选与来源。' : '员工记录了阻塞事项，先查看缺项。', '查看工单', () => actions.openWork(w.id)));
    const missing = (setup.items || []).filter(i => i.id !== 'browser' && ['missing', 'error', 'action'].includes(i.state));
    if (!data.workbench?.initialized) urgent.push(card('先准备业务数据', '迁入已有达人记录，或建立空白工作台。', '去连接与设置', actions.openSettings));
    if (missing.length) urgent.push(card('连接待设置：' + missing.map(i => i.title).join('、'), '这些设置影响对应功能，先查看具体缺项。', '去连接与设置', actions.openSettings));
    section('urgent', '先核对这些事项', '发送异常、员工卡点和连接缺项。', urgent);
    const mailCard = m => card((m.kind === 'negotiation' ? '回复 @' : '待查看来信 @') + (m.handle || m.id),
      (m.kind === 'negotiation' ? (m.status || '协商往来') + (m.theirAsk ? '；对方要 ' + m.theirAsk : '') : m.subject || '（无主题）') + ' · ' + time(m.at),
      m.kind === 'negotiation' ? '查看往来' : '查看来信', () => actions.openCreator(m.id));
    section('negotiations', '需要回复的协商', '最后一条往来来自对方；等待较久的排在前面。', (groups.negotiations || []).map(mailCard));
    section('undated', '时间需要核对', '记录缺少有效时间或时间晚于当前，先打开原文核对。', (groups.undated || []).map(mailCard));
    section('recent', '最近 7 天的来信', '按最后来信时间倒序；收信情况以最近同步为准。', (groups.recent || []).map(mailCard));
    section('earlier', '较早的往来', '最后来信在 7 天前，仍待查看。收起仅减少页面占用，不代表已处理。', (groups.earlier || []).map(mailCard), true);
    const hard = (data.rehearsal?.open || []).filter(i => i.kind === 'hard').length;
    section('preparation', '准备后续工作', '按后续工作需要补齐约定。', hard ? [card(hard + ' 个数值要你拍板', '首报价、佣金和付款节点等仍需明确。', '去回答', actions.openRehearsal)] : [], true);
    document.getElementById('ask-n').textContent = count ? count + ' 项（含收起项）' : '暂无待处理';
    if (!count) host.append(make('p', '本地记录暂无需要处理的事项；收信情况以最近同步为准。', 'scope-note'));
  }
  root.GapawAttention = { render };
})(window);
