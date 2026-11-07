// Local form state only: filtering never saves a goal or changes its selection.
(function (root) {
  'use strict';
  let sequence = 0;
  const states = new WeakMap();
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const name = row => row.handle ? '@' + row.handle : row.id;
  const normalize = value => String(value || '').trim().replace(/^@/, '').toLocaleLowerCase();
  function mount(parent, rows, values) {
    const state = states.get(values) || { query: '', filter: 'all', limit: 40 };
    states.set(values, state);
    const box = el('section', null, 'candidate-picker'); box.setAttribute('aria-label', '本轮候选');
    const heading = el('h4', '选择本轮复核的已有候选');
    const count = el('p', null, 'candidate-count'); count.setAttribute('role', 'status');
    const tools = el('div', null, 'candidate-tools');
    const searchId = 'candidate-search-' + (++sequence);
    const label = el('label', '搜索达人账号或编号'); label.htmlFor = searchId;
    const search = el('input'); search.id = searchId; search.type = 'search'; search.className = 'candidate-search'; search.placeholder = '输入 @账号 或达人编号'; search.value = state.query;
    const reset = el('button', '清除搜索', 'quiet'); reset.type = 'button';
    tools.append(label, search, reset);
    const filters = el('div', null, 'candidate-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '候选筛选');
    const filterButtons = new Map();
    for (const [key, text] of [['all', '全部'], ['selected', '已选'], ['unselected', '未选']]) {
      const b = el('button', text, 'quiet'); b.type = 'button'; b.onclick = () => { state.filter = key; state.limit = 40; draw(); }; filters.append(b); filterButtons.set(key, b);
    }
    const selected = el('div', null, 'candidate-selected'); selected.setAttribute('aria-label', '已选名单');
    const results = el('p', null, 'candidate-results'); results.setAttribute('role', 'status');
    const list = el('div', null, 'candidate-list'); list.id = 'candidate-list';
    const more = el('button', '再显示 40 位', 'quiet candidate-more'); more.type = 'button';
    const names = new Map(rows.map(row => [row.id, name(row)]));
    function draw() {
      const ids = new Set(values.creatorIds), full = ids.size >= 20;
      count.textContent = '已选 ' + ids.size + ' / 20 位' + (full ? ' · 已达上限，可先取消一位再选' : ' · 切换筛选会保留已选');
      for (const [key, b] of filterButtons) b.setAttribute('aria-pressed', String(key === state.filter));
      selected.replaceChildren();
      if (!ids.size) selected.append(el('span', '尚未选择候选', 'detail'));
      for (const id of ids) {
        const b = el('button', (names.get(id) || id) + ' ×', 'candidate-chip'); b.type = 'button'; b.setAttribute('aria-label', '取消选择 ' + (names.get(id) || id));
        b.onclick = () => { values.creatorIds = values.creatorIds.filter(x => x !== id); draw(); search.focus(); }; selected.append(b);
      }
      const query = normalize(state.query);
      const matches = rows.filter(row => (!query || normalize(row.handle).includes(query) || normalize(row.id).includes(query)) && (state.filter === 'all' || ids.has(row.id) === (state.filter === 'selected')));
      results.textContent = matches.length ? '找到 ' + matches.length + ' 位 · 显示 ' + Math.min(state.limit, matches.length) + ' 位' : '没有符合当前搜索与筛选的达人。可清除搜索或切换到“全部”；已选名单仍保留。';
      list.replaceChildren();
      for (const row of matches.slice(0, state.limit)) {
        const l = el('label'), input = el('input'); input.type = 'checkbox'; input.value = row.id; input.checked = ids.has(row.id); input.disabled = full && !input.checked;
        const text = el('span', name(row) + ' · ' + row.id); l.append(input, text);
        input.onchange = () => {
          if (input.checked && values.creatorIds.length < 20) values.creatorIds.push(row.id);
          else values.creatorIds = values.creatorIds.filter(id => id !== row.id);
          const index = Array.from(list.querySelectorAll('input')).indexOf(input);
          draw();
          const targets = Array.from(list.querySelectorAll('input:not(:disabled)'));
          (targets.find(x => x.value === row.id) || targets[Math.min(index, targets.length - 1)] || search).focus({ preventScroll: true });
        };
        list.append(l);
      }
      list.hidden = !matches.length; more.hidden = matches.length <= state.limit; reset.hidden = !state.query;
    }
    search.oninput = () => { state.query = search.value; state.limit = 40; draw(); };
    reset.onclick = () => { state.query = ''; search.value = ''; state.limit = 40; draw(); search.focus(); };
    more.onclick = () => { state.limit += 40; draw(); };
    box.append(heading, count, selected, tools, filters, results, list, more); parent.append(box); draw();
  }
  root.GapawCandidates = { mount };
})(window);
