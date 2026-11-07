// Homepage presentation only. All progress is supplied by the Rust read model.
(function (root) {
  'use strict';
  const doc = root.document;
  const make = (tag, text, cls) => { const e = doc.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const time = value => { const d = new Date(value); return value && !Number.isNaN(d.getTime()) ? d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚无记录'; };
  const states = { sending: '发送中，正在核对', unknown: '发送结果待核对', accepted: '已发出，送达待核对', delivered: '邮件已送达', bounced: '邮件退信', blocked: '邮件被拦截' };
  function action(text, run, primary = false) {
    const b = make('button', text, primary ? 'home-button primary' : 'home-button'); b.type = 'button';
    b.onclick = async () => { if (b.disabled) return; b.disabled = true; try { await run(); } finally { b.disabled = false; } }; return b;
  }
  function render(data, actions) {
    const host = doc.getElementById('home-overview'); if (!host) return;
    host.replaceChildren(); host.setAttribute('aria-busy', 'false');
    const demo = new URLSearchParams(root.location.hash.slice(1)).get('mode') === 'demo';
    if (demo) {
      host.append(make('p', '使用演示 · 以下动画不代表真实进展', 'home-eyebrow'), make('h2', '看看团队如何配合'), make('p', '演示不会发信或修改业务记录。查看真实进度，请返回工作总览。', 'home-lead'), action('返回真实业务', () => { root.location.hash = ''; root.location.reload(); }, true));
      host.querySelector('h2').id = 'home-title';
      return;
    }
    const recent = data.recentOutreach?.[0], setup = data.setup || {};
    const incoming = [...(data.newMail || []), ...(data.negotiations || []).filter(n => n.ball === 'us' && !/无真人|结案/.test(n.status || ''))];
    const pending = (data.outbox?.sending || 0) + (data.outbox?.unknown || 0);
    const goSettings = () => { root.location.href = './setup.html'; };
    const goWork = () => { root.location.href = './onboarding.html'; };
    let title, description, label, run;
    if (!data.workbench?.initialized) {
      title = '从第一位达人开始'; description = '先准备业务资料和联系渠道，再把候选核验、文案准备交给团队。'; label = '准备业务资料'; run = goSettings;
    } else if (pending) {
      title = '先核对这次发送的结果'; description = pending + ' 封邮件结果还未确定。先查看回执，再决定下一步。'; label = '核对发送结果'; run = actions.openOutbox;
    } else if (recent?.replyAt) {
      title = '有回复了，看看对方怎么说'; description = '@' + (recent.handle || recent.creatorId) + ' 的后续来信已进入业务记录。'; label = '查看回复与下一步'; run = () => actions.openCreator(recent.creatorId);
    } else if (recent && ['bounced', 'blocked', 'accepted'].includes(recent.state)) {
      title = recent.state === 'accepted' ? '邮件已发出，核对一下是否送达' : '这封邮件需要处理'; description = '先查看投递记录，再决定后续联系安排。'; label = '查看投递记录'; run = actions.openOutbox;
    } else if (recent) {
      title = recent.cooperationConfirmed ? '查看合作后的安排' : '已经联系，下一步看回复';
      description = recent.cooperationConfirmed ? '这位达人已有合作确认记录，可查看往来与后续约定。' : '最近联系了 @' + (recent.handle || recent.creatorId) + '。本地尚无这封信之后的真人回复。';
      label = setup.mailSyncReady && !recent.cooperationConfirmed ? '检查新回复' : '查看最新往来';
      run = label === '检查新回复' ? actions.checkMail : () => actions.openCreator(recent.creatorId);
    } else if (incoming.length) {
      title = '先看看待处理的往来'; description = '本地记录中有来信或报价等待处理，包含历史迁入的往来。'; label = '查看往来'; run = () => actions.openCreator(incoming[0].id);
    } else if (data.outbox?.draft) {
      title = '有邮件草稿等你审阅'; description = '看过收件人和正文，再决定是否发送。'; label = '审阅邮件'; run = actions.openOutbox;
    } else {
      title = '继续推进你的达人合作'; description = '已有 ' + (data.funnel?.creators || 0) + ' 位达人记录。可以安排下一轮候选核验和文案准备。'; label = '安排下一轮工作'; run = goWork;
    }
    const intro = make('div', null, 'home-intro');
    intro.append(make('p', '工作总览 / 下一步', 'home-eyebrow'));
    const heading = make('h2', title); heading.id = 'home-title'; intro.append(heading, make('p', description, 'home-lead'));
    const buttons = make('div', null, 'home-actions'); const primary = action(label, run, true); primary.id = 'home-next'; buttons.append(primary);
    if (recent && run !== actions.openOutbox) buttons.append(action('查看投递记录', actions.openOutbox));
    intro.append(buttons);
    const freshness = make('p', (setup.syncEnabled ? '已配置定时收信检查' : '收信检查：手动') + ' · 最近同步：' + time(setup.lastSyncAt), 'home-freshness'); freshness.id = 'home-freshness'; intro.append(freshness);
    intro.append(make('p', setup.mode === 'live' ? '正式发送模式 · 每封邮件仍需确认' : '当前为测试模式 · 新发送会进入测试邮箱', 'home-mode'));
    const progress = make('section', null, 'home-progress'); progress.setAttribute('aria-label', '最近的联系进展');
    progress.append(make('p', '最近一封正式邮件', 'home-eyebrow'));
    if (recent) {
      progress.append(make('h3', '@' + (recent.handle || recent.creatorId)));
      const badge = make('span', states[recent.state] || '状态待核对', 'home-status ' + (recent.state === 'delivered' ? 'good' : '')); badge.id = 'home-delivery'; progress.append(badge);
      progress.append(make('p', time(recent.sentAt), 'home-freshness'));
      const steps = make('ol', null, 'home-steps');
      for (const [text, done] of [['已送达', recent.state === 'delivered'], ['有回复', !!recent.replyAt], ['确认合作', recent.cooperationConfirmed]]) { const li = make('li', text, done ? 'done' : ''); li.prepend(make('span', done ? '✓' : '○')); steps.append(li); }
      progress.append(steps, make('p', '按已登记事实展示；收信情况以最近同步为准。', 'scope-note'), action('打开这位达人的记录', () => actions.openCreator(recent.creatorId)));
    } else {
      progress.append(make('h3', '还没有正式投递记录'), make('p', '测试邮件和历史迁入数据不计入这里。已有往来可从下方业务记录查看。', 'home-lead'));
    }
    const layout = make('div', null, 'home-layout'); layout.append(intro, progress); host.append(layout);
    const refresh = action('刷新进度', actions.refresh); refresh.classList.add('home-refresh'); host.append(refresh);
  }
  function error(message, retry) {
    const host = doc.getElementById('home-overview'); host.setAttribute('aria-busy', 'false');
    const title = make('h2', '暂时无法读取进度'); title.id = 'home-title';
    host.replaceChildren(title, make('p', message, 'home-lead'), action('重新读取进度', retry, true));
  }
  root.GapawHome = { render, error };
})(window);
