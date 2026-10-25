(function (root, factory) {
  const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api;
  else root.addEventListener('DOMContentLoaded', () => api.mount(root.document, root));
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function mount(document, window) {
    const $ = id => document.getElementById(id); const state = { loading: false, batches: [], batch: null, candidates: [], offset: 0, nextOffset: null, detailOffset: 0, detailNext: null, generation: 0 };
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const button = (text, callback) => { const n = el('button', text, 'secondary'); n.type = 'button'; n.disabled = state.loading; n.addEventListener('click', callback); return n; };
    async function run(command, input = {}) { const response = await window.fetch('/api/plugins/gapaw-creator-workbench/run', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, input }) }); const value = await response.json(); if (!response.ok || value.ok === false) throw new Error(typeof value.error === 'string' ? value.error : '工作台候选区暂不可读取。'); return value; }
    function notice(message, error = false) { $('candidate-notice').textContent = message; $('candidate-notice').className = error ? 'notice error' : 'notice'; }
    function validBatch(batch) { if (!batch || typeof batch.batchId !== 'string' || !batch.batchId || !batch.operationId || !batch.taskId || !batch.resultId || !Number.isSafeInteger(batch.resultRevision) || batch.status !== 'candidate_pending_verification') throw new Error('候选批次归属或状态不兼容，已停止展示。'); return batch; }
    function pagination(data, offset) { if (!Number.isSafeInteger(data.total) || data.total < 0 || data.offset !== offset || (data.nextOffset !== null && (!Number.isSafeInteger(data.nextOffset) || data.nextOffset <= offset))) throw new Error('候选分页格式不兼容。'); }
    async function list(offset = 0) {
      if (state.loading) return; state.loading = true; render();
      try { const status = await run('workbench-status'); if (status.ready !== true) throw new Error('工作台候选区尚未连接，请返回选人任务查看使用说明。'); const data = await run('workbench-list', { offset, limit: 20 }); pagination(data, offset); if (!Array.isArray(data.items)) throw new Error('候选批次列表不兼容。'); data.items.forEach(validBatch); state.batches = data.items; state.offset = offset; state.nextOffset = data.nextOffset; notice('共 ' + data.total + ' 个候选批次，均需继续核验。'); }
      catch (error) { notice('读取未确认；保留的旧列表不能视为最新：' + error.message, true); }
      finally { state.loading = false; render(); }
    }
    async function detail(batch, offset = 0) {
      if (state.loading) return; state.loading = true; const generation = ++state.generation; render();
      try { const data = await run('workbench-batch', { batchId: batch.batchId, offset, limit: 20 }); if (generation !== state.generation) return; validBatch(data.batch); pagination(data, offset); if (['batchId', 'businessStoreId', 'adoptionId', 'payloadHash', 'operationId', 'taskId', 'resultId', 'resultRevision'].some(key => data.batch[key] !== batch[key]) || !Array.isArray(data.candidates)) throw new Error('返回的候选不属于本次批次。'); for (const item of data.candidates) if (item.batchId !== batch.batchId || !item.reportedIdentity || item.verification !== 'unverified' || item.status !== 'candidate_pending_verification') throw new Error('返回的候选身份或核验状态不兼容。'); state.batch = data.batch; state.candidates = data.candidates; state.detailOffset = offset; state.detailNext = data.nextOffset; notice('正在查看已入库的待核验候选，未正式入选。'); }
      catch (error) { notice('详情读取失败，旧详情仅供参考：' + error.message, true); } finally { state.loading = false; render(); }
    }
    function safeURL(raw) { try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch (_) { return null; } }
    function rate(value) { if (value === null || value === undefined || value === '') return '未知'; const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) return '未知'; if (/[1-9]/.test(String(value).split(/[eE]/)[0]) && number * 100 < 0.0001) return '<0.0001%'; return (number * 100).toFixed(4) + '%'; }
    function render() {
      $('candidate-refresh').disabled = state.loading; const batches = $('candidate-batches'); batches.replaceChildren();
      if (!state.batches.length) batches.append(el('p', '当前没有可展示批次；空列表不代表平台没有达人。', 'hint'));
      for (const batch of state.batches) { const row = el('article', undefined, 'candidate-batch'); row.append(el('h3', '第 ' + batch.resultRevision + ' 版报告 · ' + batch.candidateCount + ' 位待核验候选'), el('p', '保存时间：' + (batch.createdAt || '未知') + ' · 批次 ' + batch.batchId, 'hint'), button('查看此批次', () => detail(batch))); batches.append(row); }
      const pages = $('candidate-batch-pages'); pages.replaceChildren(); if (state.offset > 0) pages.append(button('上一页批次', () => list(Math.max(0, state.offset - 20)))); if (state.nextOffset !== null) pages.append(button('下一页批次', () => list(state.nextOffset)));
      const target = $('candidate-detail'); target.replaceChildren(); if (!state.batch) return;
      target.append(el('h2', '候选详情 · 第 ' + state.batch.resultRevision + ' 版报告'), el('p', '身份和来源均来自待核验报告，尚未与旧达人档案合并。', 'browser-warning'));
      const metadata = state.batch.reportMetadata; if (metadata) target.append(el('p', '报告区间：' + (metadata.period?.start || '未知') + ' 至 ' + (metadata.period?.end || '未知') + ' · ' + (metadata.period?.timeZone || '时区未知') + ' · 币种：' + (metadata.currency || '未知'), 'hint'), el('p', '报告声明覆盖：' + (metadata.coverage || '未知'), 'hint'));
      if (state.batch.observationCount !== undefined) target.append(el('p', '随批次保存的来源观测：' + state.batch.observationCount + ' 份；观测与字段归属仍待核验。', 'hint'));
      for (const candidate of state.candidates) {
        const card = el('article', undefined, 'operation'); const identity = candidate.reportedIdentity; card.append(el('h3', identity.handle || identity.creatorId || '待核验达人'), el('p', '报告来源身份：' + identity.platform + ' · ' + identity.creatorId, 'hint'), el('p', candidate.reason || '未填写理由', 'report-context'));
        const url = safeURL(identity.profileUrl); if (url) { const a = el('a', '报告提供的主页 ↗'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; card.append(a); }
        const computed = candidate.computed?.summary || candidate.computed || {}; card.append(el('p', '报告内样本：' + (computed.totalVideos ?? '未知') + ' · 已知正结余：' + (computed.knownPositiveVideos ?? '未知'), 'report-context'));
        card.append(el('p', '回本命中 / 样本：' + (computed.breakEvenCount ?? '未知') + ' / ' + (computed.totalVideos ?? '未知') + ' · 扣广回本率：' + rate(computed.breakEvenRate) + ' · 平均结余：' + (computed.averageSurplus ?? '未知') + ' ' + (metadata?.currency || '币种未知'), 'report-context'));
        if (candidate.missingFields?.length) card.append(el('p', '缺项：' + candidate.missingFields.join('、'), 'report-missing'));
        const sources = el('details'); sources.append(el('summary', '报告附带来源（未核验）')); for (const source of candidate.sources || []) sources.append(el('p', (source.note || '来源说明未知') + ' · 声明时间：' + (source.capturedAt || '未知'), 'hint')); card.append(sources); target.append(card);
      }
      const paging = el('div', undefined, 'operation-actions'); if (state.detailOffset > 0) paging.append(button('上一页候选', () => detail(state.batch, Math.max(0, state.detailOffset - 20)))); if (state.detailNext !== null) paging.append(button('下一页候选', () => detail(state.batch, state.detailNext))); target.append(paging);
    }
    $('candidate-refresh').addEventListener('click', () => list()); list(); return { state, list, detail };
  }
  return { mount };
}));
