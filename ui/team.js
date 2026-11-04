// 宿主协议适配；工单状态、角色计划与幂等编号由 Rust 插件生成。
(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./client.js') : root.GapawClient);
  if (node) module.exports = api;
  else { root.GapawTeam = api; root.addEventListener('DOMContentLoaded', () => { if (root.document.getElementById('team-panel')) api.mount(root.document, root); }); }
}(typeof window === 'undefined' ? globalThis : window, function (App) {
  'use strict';
  const LABEL = { dispatcher: '独立流转器', sel: '小选 · 选人', copy: '小文 · 文案', send: '小发 · 触达', follow: '小跟 · 跟进', sort: '小拣 · 来信分类', deal: '小谈 · 议价', ful: '小履 · 确认与履约' };
  const STATES = { pending: '待派发', claimed: '派发待核对', dispatched: '宿主已受理', processing: '处理中', awaiting_review: '候选待你确认', stale: '依据已过期', cancelled: '已作废' };
  function controller(client) {
    let busy = false;
    async function directory(config) {
      const list = await client.request('/api/directories');
      if (!Array.isArray(list) || !list.some(d => d.id === config.workspace.dirId && d.path === config.workspace.path)) throw new Error('办公室原工作目录已删除或改绑，已停止创建和派发。');
    }
    return {
      async initialize(onProgress = () => {}) {
        if (busy) throw new Error('办公室正在初始化，请等待。');
        busy = true;
        try {
          let data = await client.run('team-prepare');
          await directory(data.config);
          for (const row of data.staff) {
            if (row.task?.taskId) { onProgress(LABEL[row.key] + '已绑定'); continue; }
            await directory(data.config);
            const response = await client.request('/api/air/tasks', row.plan);
            // 创建响应丢失或保存失败，重试固定 plan，不生成新 clientMsgId。
            data = await client.run('team-record-task', { staffKey: row.key, response });
            onProgress(LABEL[row.key] + '已创建');
          }
          if (!data.initialized) throw new Error('办公室仍有任务未完成绑定，请重试恢复。');
          return data;
        } finally { busy = false; }
      },
      async createDirectory() {
        const info = await client.run('team-workspace');
        const list = await client.request('/api/directories');
        const existing = Array.isArray(list) && list.find(d => d.path === info.path);
        if (existing) return existing;
        // 宿主注册响应丢失后，下次先查询原路径，不重复登记。
        return client.request('/api/directories', { name: info.name, path: info.path, create: true });
      },
      async wake() {
        const data = await client.run('team-status');
        if (!data.initialized) throw new Error('请先初始化办公室角色任务。');
        await directory(data.config);
        const row = data.staff.find(s => s.key === 'dispatcher');
        if (!data.wakeWorkId) throw new Error('当前没有待派发工单。');
        // 每张工单固定一次唤醒编号。重按按钮只恢复原宿主消息。
        const id = data.wakeWorkId;
        return client.request('/api/task-shell-tasks/' + encodeURIComponent(row.task.taskId) + '/messages', {
          clientMsgId: id + '_wake_1', intent: 'work',
          text: '请从插件重新读取办公室状态，通过 work-next 领取并派发待处理工单；按角色协议最多处理 5 张。没有工单就结束，不创建定时任务、不对外发送消息。'
        });
      }
    };
  }
  function mount(doc, win) {
    const panel = doc.getElementById('team-panel');
    const client = App.createClient(win.fetch.bind(win)), flow = controller(client);
    const el = (tag, text, cls) => { const n = doc.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    let data, running = false;
    const message = el('p', '正在读取办公室配置…', 'hint'); message.setAttribute('role', 'status');
    const body = el('div'); panel.append(el('h2', '办公室与员工任务'), message, body);
    function button(text, fn) { const b = el('button', text, 'secondary'); b.type = 'button'; b.disabled = running; b.onclick = () => act(fn); return b; }
    async function act(fn) {
      if (running) return; running = true; panel.querySelectorAll('button,select,input').forEach(b => { b.disabled = true; });
      try { await fn(); data = await client.run('team-status'); message.textContent = '已保存。角色任务仅按工单工作，不会自动外发；定时唤醒未开启。'; }
      catch (e) { message.textContent = e.message; }
      finally {
        running = false;
        // 初始化可能已经在宿主建好部分任务；失败后也读回持久状态。
        try { data = await client.run('team-status'); } catch (_) { /* 保留错误提示和上次状态。 */ }
        await render();
      }
    }
    async function render() {
      body.replaceChildren(); if (!data) return;
      const cfg = data.config;
      body.append(el('p', data.initialized ? '独立流转器和 7 个员工角色任务已创建。任务受理与候选交回分别记账。' : '设置目录、模型和线路后，初始化独立流转器与 7 个员工。创建任务不会启动模型，也不会发送邮件。', 'hint'));
      if (!data.staff.length) {
        const form = el('div', null, 'setup-grid');
        const field = (title, control) => { const label = el('label', title); label.append(control); form.append(label); return control; };
        const dirs = field('工作目录', el('select')); dirs.id = 'team-directory';
        const automatic = el('option', '自动创建专属运营目录'); automatic.value = ''; dirs.append(automatic);
        const cli = field('运行环境', el('select')); cli.id = 'team-cli';
        for (const value of ['claude', 'codex-exp', 'codex']) { const o = el('option', value === 'claude' ? 'Claude Code' : value === 'codex-exp' ? 'Codex 实验环境' : 'Codex'); o.value = value; cli.append(o); }
        cli.value = cfg.runtime?.cli || 'codex-exp';
        const provider = field('模型线路', el('select')); provider.id = 'team-provider';
        const model = field('模型', el('input')); model.id = 'team-model'; model.maxLength = 300; model.placeholder = '从线路模型列表选择或填写模型名'; model.value = cfg.runtime?.model || '';
        const models = el('datalist'); models.id = 'team-models'; model.setAttribute('list', models.id); form.append(models);
        let catalog = [];
        async function providers() {
          provider.replaceChildren(); const blank = el('option', '请选择模型线路'); blank.value = ''; provider.append(blank);
          try {
            const r = await client.request('/api/providers?cli=' + encodeURIComponent(cli.value)); catalog = r.providers || [];
            for (const p of catalog) { const o = el('option', p.name || p.id); o.value = p.id; provider.append(o); }
            provider.value = cfg.runtime?.cli === cli.value ? cfg.runtime?.provider || '' : '';
            choices();
          } catch (e) { message.textContent = '无法读取宿主模型线路：' + e.message; }
        }
        function choices() {
          const p = catalog.find(p => p.id === provider.value); models.replaceChildren();
          for (const m of Array.isArray(p?.models) ? p.models : []) { const id = typeof m === 'string' ? m : m.id || m.model; if (id) { const o = el('option'); o.value = id; models.append(o); } }
        }
        provider.onchange = choices; cli.onchange = providers;
        body.append(form);
        try { const list = await client.request('/api/directories'); for (const d of list) { const o = el('option', d.name || d.path); o.value = d.id; o.dataset.path = d.path; dirs.append(o); } dirs.value = cfg.workspace?.dirId || ''; }
        catch (e) { message.textContent = e.message; }
        await providers();
        body.append(button('保存办公室配置', async () => {
          if (!provider.value || !model.value.trim()) throw new Error('请选择模型线路并填写模型。');
          let workspace;
          if (!dirs.value) { const d = await flow.createDirectory(); workspace = { dirId: d.id, path: d.path }; }
          else workspace = { dirId: dirs.value, path: dirs.selectedOptions[0].dataset.path };
          await client.run('team-configure', { expectedVersion: cfg.version, workspace, runtime: { cli: cli.value, provider: provider.value, model: model.value.trim() } });
        }));
      } else body.append(el('p', '工作目录：' + cfg.workspace.path + '；模型：' + cfg.runtime.model + '。任务创建计划已固定，重试会复用原编号。', 'hint'));
      if (data.configured && !data.initialized) body.append(button(data.staff.length ? '继续初始化办公室' : '初始化办公室', async () => { data = await flow.initialize(t => { message.textContent = t; }); }));
      const list = el('ul');
      for (const row of data.staff) { const li = el('li', LABEL[row.key] + '：'); if (row.task) { const a = el('a', '打开角色任务'); a.href = row.task.url; a.target = '_blank'; a.rel = 'noopener'; li.append(a); } else li.append(doc.createTextNode('等待创建')); list.append(li); }
      body.append(list, el('p', '定时唤醒未开启。先从达人抽屉创建影子工单，再手动唤醒流转器。交回候选暂不自动采用。', 'hint'));
    }
    (async () => { try { data = await client.run('team-status'); message.textContent = '办公室配置与任务绑定独立保存，不依赖测试收件邮箱。'; await render(); } catch (e) { message.textContent = e.message; } })();
  }
  return { controller, mount, LABEL, STATES };
}));
