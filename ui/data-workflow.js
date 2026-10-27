(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GapawDataWorkflow = api;
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const labels = { handle: '账号名', nickname: '昵称', followers: '粉丝数', videoGmv: '视频成交额', videoGmvCurrencySymbol: '视频金额原始符号', liveGmv: '直播成交额', liveGmvCurrencySymbol: '直播金额原始符号', medGmv: '来源 med 成交指标', medGmvCurrencySymbol: 'med 指标原始符号', unitsSold: '成交件数', averageViews: '平均播放量', engagement: '互动指标', publishedAt: '发布时间', sales: '销量', revenue: '成交额', advertisingFlag: '广告标记', advertisingRevenueRatio: '广告成交占比' };
  function create(document, window, client, operationFor, redraw) {
    const states = new Map();
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const button = (text, action, disabled = false) => { const n = el('button', text, 'secondary'); n.type = 'button'; n.disabled = disabled; n.addEventListener('click', action); return n; };
    function state(id) { if (!states.has(id)) states.set(id, { loading: false, snapshots: [], selected: new Set(), initialized: false, error: '', templates: [], draft: { generation: 0, loading: false, payload: null, snapshot: null, error: '', saved: false }, plans: [], plan: null, preview: null, workbench: null, attempt: null }); return states.get(id); }
    function operation(id) { const op = operationFor(id); if (!op?.task?.taskId) throw new Error('未找到原任务，请刷新任务记录。'); return op; }
    function identity(value, op) { if (!value || value.operationId !== op.id || value.taskId !== op.task.taskId) throw new Error('返回资料不属于本次操作和任务，已停止展示。'); }
    function snapshot(value, op, input) {
      identity(value, op);
      if (value.schemaVersion !== 1 || typeof value.observationId !== 'string' || !Array.isArray(value.items) || value.items.length > 100 || value.source?.mode !== 'imported_response' || value.source.verified !== false || value.coverage?.complete !== false) throw new Error('来源观测格式不兼容，不能作为已核验资料保存。');
      if (typeof value.inputHash !== 'string' || !value.inputHash || !['partial', 'unknown'].includes(value.coverage.status) || !value.items.every(item => item.sourceIdentity && typeof item.sourceIdentity.sourceId === 'string' && typeof item.sourceIdentity.namespace === 'string' && item.fields && Object.values(item.fields).every(field => field && field.verification === 'unverified' && (field.rawDisplay === null || typeof field.rawDisplay === 'string') && (field.decimalValue === null || typeof field.decimalValue === 'string')))) throw new Error('来源观测字段格式不兼容。');
      if (input && (value.observationId !== input.observationId || value.adapter !== input.adapter)) throw new Error('预览回执与本次文件不一致。');
      return value;
    }
    async function readObservations(id) {
      const s = state(id); if (s.loading) return; s.loading = true; s.error = ''; redraw();
      try { const op = operation(id); const data = await client.run('get-observations', { operationId: id, taskId: op.task.taskId }); identity(data, op); if (!Array.isArray(data.snapshots) || data.snapshots.length > 100) throw new Error('来源观测列表格式不兼容。'); for (const item of data.snapshots) snapshot(item, op); s.snapshots = data.snapshots; const oldSelected = JSON.stringify([...s.selected].sort()); s.selected = new Set(data.snapshots.filter(item => !s.initialized || s.selected.has(item.observationId)).map(item => item.observationId)); s.initialized = true; if (oldSelected !== JSON.stringify([...s.selected].sort())) s.preview = null; }
      catch (error) { s.error = '观测刷新未确认，保留上次资料：' + error.message; }
      finally { s.loading = false; redraw(); }
    }
    async function templates(id) {
      const s = state(id); if (s.loading) return; s.loading = true; s.error = ''; redraw();
      try { const op = operation(id); const data = await client.run('observation-contract', { operationId: id, taskId: op.task.taskId }); if (data.operationId !== undefined) identity(data, op); if (!Array.isArray(data.templates)) throw new Error('观测格式说明不兼容。'); for (const template of data.templates) identity(template.submissionTemplate, op); s.templates = data.templates; }
      catch (error) { s.error = error.message; } finally { s.loading = false; redraw(); }
    }
    async function choose(id, file) {
      const s = state(id); if (!file || s.loading) return; const d = s.draft; const generation = ++d.generation;
      Object.assign(d, { loading: true, payload: null, snapshot: null, error: '', saved: false, name: file.name }); redraw();
      try {
        if (!/\.json$/i.test(file.name || '') || !Number.isFinite(file.size) || file.size > 524288) throw new Error('请选择不超过 512 KiB 的 JSON 平台响应文件。');
        const text = await file.text(); if (new TextEncoder().encode(text).length > 524288) throw new Error('文件超过 512 KiB。');
        let input; try { input = JSON.parse(text); } catch (_) { throw new Error('文件不是有效的 JSON。'); } const op = operation(id); identity(input, op); if (typeof input.observationId !== 'string' || !input.observationId) throw new Error('文件缺少观测编号。');
        if (generation !== d.generation) return; d.payload = text;
        const response = await client.run('preview-observation', { rawJson: d.payload }); if (generation !== d.generation) return;
        if (response.canCollectPlatforms !== false || typeof response.replay !== 'boolean') throw new Error('观测预览状态不兼容。');
        d.snapshot = snapshot(response.snapshot, op, input); d.replay = response.replay;
      } catch (error) { if (generation === d.generation) d.error = '预览失败：' + error.message; }
      finally { if (generation === d.generation) { d.loading = false; redraw(); } }
    }
    async function saveObservation(id) {
      const s = state(id); const d = s.draft; if (s.loading || d.loading || d.saved || !d.snapshot || !d.payload) return;
      s.loading = true; d.error = ''; redraw();
      try { const op = operation(id); const input = JSON.parse(d.payload); identity(input, op); const response = await client.run('submit-observation', { rawJson: d.payload }); if (response.canCollectPlatforms !== false) throw new Error('保存回执格式不兼容。'); const saved = snapshot(response.snapshot, op, input); if (saved.inputHash !== d.snapshot.inputHash) throw new Error('保存回执与预览内容不一致。'); d.saved = true;
        try { const data = await client.run('get-observations', { operationId: id, taskId: op.task.taskId }); identity(data, op); if (!Array.isArray(data.snapshots)) throw new Error('读回格式不兼容。'); for (const item of data.snapshots) snapshot(item, op); if (!data.snapshots.some(item => item.observationId === saved.observationId && item.inputHash === saved.inputHash)) throw new Error('未读到对应观测。'); s.snapshots = data.snapshots; s.selected.add(saved.observationId); s.initialized = true; s.preview = null; }
        catch (error) { d.error = '已收到保存回执，待刷新观测确认：' + error.message; }
      } catch (error) { d.error = '保存未确认，请使用原观测编号重试：' + error.message; }
      finally { s.loading = false; redraw(); }
    }
    function verifyPlan(plan, op, expected) {
      identity(plan, op);
      if (!plan.adoptionId || !plan.resultId || !Number.isSafeInteger(plan.resultRevision) || !plan.payloadHash || !plan.businessStoreId || !['prepared', 'verification_pending', 'verified', 'submission_unknown'].includes(plan.status)) throw new Error('工作台保存状态格式不兼容。');
      if (!Array.isArray(plan.observationIds) || plan.observationIds.length > 100 || plan.observationIds.some(id => typeof id !== 'string' || !id) || new Set(plan.observationIds).size !== plan.observationIds.length) throw new Error('工作台计划的来源观测列表不兼容。');
      if (expected && ['adoptionId', 'operationId', 'taskId', 'resultId', 'resultRevision', 'payloadHash', 'businessStoreId'].some(key => plan[key] !== expected[key])) throw new Error('工作台回执不属于本次报告或预览，已停止确认。');
      if (plan.status === 'verified' && plan.receipt?.status !== 'candidate_pending_verification') throw new Error('工作台入库状态尚未读回确认。');
      return plan;
    }
    function verifyPreview(preview, plan) {
      if (!preview || preview.payloadHash !== plan.payloadHash || preview.businessStoreId !== plan.businessStoreId || preview.canAdopt !== true || preview.verification !== 'unverified' || !Number.isSafeInteger(preview.candidateCount)) throw new Error('工作台预览回执不兼容。'); return preview;
    }
    async function restore(id) {
      const s = state(id); if (s.loading) return; s.loading = true; s.error = ''; redraw();
      try { const op = operation(id); const response = await client.run('get-adoption', { operationId: id }); if (!Array.isArray(response.plans)) throw new Error('工作台记录格式不兼容。'); s.plans = response.plans.map(plan => verifyPlan(plan, op)).sort((a, b) => b.resultRevision - a.resultRevision); const active = s.plans.find(plan => ['submission_unknown', 'verification_pending'].includes(plan.status) && plan.preview) || s.plans.find(plan => plan.status === 'prepared' && plan.preview) || s.plans.find(plan => plan.adoptionId === s.plan?.adoptionId) || s.plans.find(plan => plan.preview); const preview = active?.preview ? verifyPreview(active.preview, active) : null; s.plan = active || null; s.preview = preview; }
      catch (error) { s.error = '工作台状态未确认：' + error.message; } finally { s.loading = false; redraw(); }
    }
    async function prepare(id) {
      const s = state(id); if (s.loading || s.draft.loading) return; s.loading = true; s.error = ''; s.preview = null; redraw();
      try {
        const op = operation(id); s.workbench = await client.run('workbench-status'); if (s.workbench.ready !== true || !s.workbench.available || !s.workbench.configured) throw new Error('工作台候选区尚未连接。请按使用说明连接后重试。');
        const latest = await client.run('get-result', { operationId: id }); if (!latest.record) throw new Error('请先保存本次报告，再预览工作台候选。'); identity(latest.record, op); if (!latest.record.resultId || !Number.isSafeInteger(latest.record.revision)) throw new Error('请先保存本次报告，再预览工作台候选。');
        const ids = [...s.selected].sort(); if (ids.length > 100) throw new Error('一次最多附带 100 份已保存来源观测。');
        const key = JSON.stringify([latest.record.resultId, latest.record.revision, ids]);
        if (s.attempt?.key !== key) s.attempt = { key, adoptionId: 'adoption_' + window.crypto.randomUUID() };
        const response = await client.run('prepare-adoption', { operationId: id, taskId: op.task.taskId, resultId: latest.record.resultId, adoptionId: s.attempt.adoptionId, observationIds: ids });
        const plan = verifyPlan(response.plan, op); if (plan.adoptionId !== s.attempt.adoptionId || plan.resultId !== latest.record.resultId || plan.resultRevision !== latest.record.revision || plan.businessStoreId !== s.workbench.businessStoreId || JSON.stringify(plan.observationIds) !== JSON.stringify(ids)) throw new Error('工作台预览与最新报告或所选来源观测不一致。');
        const p = verifyPreview(response.preview, plan);
        s.plan = plan; s.preview = p; putPlan(s, plan);
      } catch (error) { s.error = error.message; } finally { s.loading = false; redraw(); }
    }
    function putPlan(s, plan) { const at = s.plans.findIndex(item => item.adoptionId === plan.adoptionId); if (at < 0) s.plans.unshift(plan); else s.plans[at] = plan; }
    async function adopt(id, reconcileId) {
      const s = state(id); if (s.loading) return; const expected = reconcileId ? s.plans.find(plan => plan.adoptionId === reconcileId) : s.plan;
      if (!expected || (!reconcileId && (!s.preview || expected.status === 'verified'))) return;
      s.loading = true; s.error = ''; let attempted = false; redraw();
      try { const op = operation(id); if (!reconcileId && expected.status === 'prepared') { const latest = await client.run('get-result', { operationId: id }); identity(latest.record, op); if (latest.record.resultId !== expected.resultId || latest.record.revision !== expected.resultRevision) { s.preview = null; throw new Error('已有更新的报告，请重新预览最新报告；原计划会保留。'); } } attempted = !reconcileId; const response = await client.run(reconcileId ? 'reconcile-adoption' : 'adopt-result', reconcileId ? { adoptionId: expected.adoptionId } : { adoptionId: expected.adoptionId, expectedPayloadHash: expected.payloadHash }); const plan = verifyPlan(response.plan, op, expected); putPlan(s, plan); if (s.plan?.adoptionId === plan.adoptionId) s.plan = plan; }
      catch (error) { if (attempted) { const unknown = { ...expected, status: 'submission_unknown' }; putPlan(s, unknown); if (s.plan?.adoptionId === expected.adoptionId) s.plan = unknown; } s.error = '工作台保存结果待确认：' + error.message + ' 请核对原回执；重试沿用本次编号。'; }
      finally { s.loading = false; redraw(); }
    }
    function renderSnapshot(value) {
      const d = el('details', undefined, 'observation-snapshot'); d.append(el('summary', (value.source.provider === 'affiliate' ? 'TikTok Affiliate' : value.source.provider === 'kalodata' ? 'Kalodata' : value.source.provider) + ' · 导入平台响应 · ' + value.items.length + ' 条'));
      const context = value.context || {}; d.append(el('p', '市场：' + (context.country || '未知') + ' · 币种：' + (context.currency || '未知') + ' · 区间：' + (context.period?.start || '未知') + ' 至 ' + (context.period?.end || '未知') + ' · 时区：' + (context.period?.timeZone || '未知'), 'hint'));
      d.append(el('p', '声明观测时间：' + value.capturedAt + '（未核验）', 'hint'), el('p', '覆盖：' + (value.coverage.status === 'partial' ? '部分样本' : '未知') + '；不证明全量或真实零结果。', 'browser-warning'));
      for (const warning of value.warnings || []) d.append(el('p', typeof warning === 'string' ? warning : JSON.stringify(warning), 'browser-warning'));
      for (const item of value.items) {
        const box = el('div', undefined, 'observation-item'); box.append(el('strong', item.sourceIdentity.namespace + ' · ' + item.sourceIdentity.sourceId));
        if (item.creatorIdentity) box.append(el('p', '来源达人：' + item.creatorIdentity.namespace + ' · ' + item.creatorIdentity.sourceId, 'hint'));
        for (const [key, field] of Object.entries(item.fields || {})) { const unit = {text:'文本',count:'数量',source_currency:'来源币种未确认',ratio_unknown:'比例单位未知',date_unknown:'日期口径未知',flag:'来源标记'}[field.unit] || '未知'; box.append(el('p', (labels[key] || key) + ' · 标准数值：' + (field.decimalValue ?? '未知') + ' · 原始显示：' + (field.rawDisplay ?? '未知') + ' · 单位：' + unit + ' · ' + (field.estimated === 'third_party_estimate' ? '第三方估算' : '估算属性未知') + ' · 未核验', 'hint'), el('p', '原响应字段：' + field.sourcePath, 'path')); }
        d.append(box);
      }
      return d;
    }
    function render(op) {
      const s = state(op.id); const root = el('section', undefined, 'data-workflow'); root.append(el('h3', '平台响应与工作台候选'), el('p', '导入已有平台响应保留来源观测，不代表实时采集，也不会自动生成回本率。', 'hint'));
      const actions = el('div', undefined, 'operation-actions'); const file = el('input'); file.type = 'file'; file.hidden = true; file.accept = '.json,application/json'; file.addEventListener('change', event => choose(op.id, event.target.files?.[0]));
      actions.append(button('选择平台响应并预览', () => file.click(), s.loading), file, button('查看观测格式示例', () => templates(op.id), s.loading), button('刷新已保存观测', () => readObservations(op.id), s.loading), button('查看工作台保存记录', () => restore(op.id), s.loading)); root.append(actions);
      if (s.error) root.append(el('p', s.error, 'operation-error'));
      for (const template of s.templates) { const d = el('details'); d.append(el('summary', template.label), el('p', template.description, 'hint'), el('pre', JSON.stringify(template.submissionTemplate, null, 2), 'snapshot')); root.append(d); }
      const draft = s.draft;
      if (draft.name) { const panel = el('div', undefined, 'result-preflight'); panel.append(el('h3', '来源观测预览'), el('p', draft.name, 'path')); if (draft.loading) panel.append(el('p', '正在只读预览，尚未保存…', 'hint')); if (draft.snapshot) panel.append(renderSnapshot(draft.snapshot)); if (draft.error) panel.append(el('p', draft.error, 'operation-error')); panel.append(button(draft.saved ? '已收到观测保存回执' : '保存来源观测', () => saveObservation(op.id), s.loading || draft.loading || draft.saved || !draft.snapshot)); root.append(panel); }
      const saved = el('details', undefined, 'saved-observations'); saved.append(el('summary', '已保存来源观测（' + s.snapshots.length + '，最多附带 100 份）'));
      if (!s.snapshots.length) saved.append(el('p', '点击刷新查看原任务保存的观测；未加载不代表没有观测。', 'hint'));
      for (const item of s.snapshots) { const label = el('label', undefined, 'observation-choice'); const check = el('input'); check.type = 'checkbox'; check.checked = s.selected.has(item.observationId); check.disabled = s.loading; check.addEventListener('change', () => { if (check.checked) s.selected.add(item.observationId); else s.selected.delete(item.observationId); s.preview = null; redraw(); }); label.append(check, el('span', '附带观测 ' + item.observationId)); saved.append(label, renderSnapshot(item)); } root.append(saved);
      root.append(el('p', '报告保存和工作台入库是两个步骤。这里将最新已保存报告写为待核验候选，不正式入选，也不更新旧达人档案。', 'hint'), button('预览工作台待核验候选', () => prepare(op.id), s.loading || draft.loading));
      if (s.workbench?.ready === false) { const a = el('a', '查看连接使用说明 ↗'); a.href = './connection-help.html'; a.target = '_blank'; a.rel = 'noopener noreferrer'; root.append(a); }
      if (s.preview && s.plan) { const panel = el('div', undefined, 'result-preflight'); panel.append(el('h3', '第 ' + s.plan.resultRevision + ' 版报告 · ' + s.preview.candidateCount + ' 位待核验候选'), el('p', '本计划已固定的来源观测：' + s.plan.observationIds.length + ' 份。恢复和重试沿用此附件集合。', 'hint')); for (const warning of s.preview.warnings || []) panel.append(el('p', typeof warning === 'string' ? warning : JSON.stringify(warning), 'browser-warning')); if (s.preview.handleConflicts?.length) panel.append(el('p', '存在账号名冲突，需要人工核验；不会自动合并旧档案。', 'browser-warning')); panel.append(button(s.plan.status === 'verified' ? '已写入待核验候选' : '保存为工作台待核验候选', () => adopt(op.id), s.loading || s.plan.status === 'verified')); root.append(panel); }
      for (const plan of s.plans) { const p = el('div', undefined, 'adoption-state'); p.append(el('p', '第 ' + plan.resultRevision + ' 版 · ' + ({ prepared: '已预览，尚未写入工作台', verification_pending: '已收到回执，待读回确认', submission_unknown: '保存结果未知，待核对原回执', verified: '已写入工作台待核验候选（未正式入选）' }[plan.status]), 'hint')); if (typeof plan.message === 'string' && plan.message) p.append(el('p', plan.message, 'hint')); if (plan.status !== 'verified') p.append(button('核对原回执', () => adopt(op.id, plan.adoptionId), s.loading)); root.append(p); }
      const link = el('a', '打开工作台待核验候选区 ↗'); link.href = './candidates.html'; link.target = '_blank'; link.rel = 'noopener noreferrer'; root.append(link); return root;
    }
    return { states, state, render, choose, saveObservation, readObservations, templates, prepare, adopt, restore };
  }
  return { create };
}));
