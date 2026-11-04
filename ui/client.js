// 插件页面共用的宿主请求客户端与 MultiCC 任务派发（带回执对账，不重复投递）。
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GapawClient = api;
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const PLUGIN_ID = 'gapaw-creator-workbench';
  function createClient(fetcher) {
    async function request(path, body) {
      const options = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
      if (body !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
      let response;
      try { response = await fetcher(path, options); }
      catch (_) { throw new Error('网络连接失败。恢复连接后可重试，原任务编号会保留。'); }
      let value;
      try { value = await response.json(); }
      catch (_) { throw new Error('宿主返回了无法读取的内容，请确认已登录 MultiCC。'); }
      if (!response.ok || value?.ok === false) {
        const detail = typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message;
        const error = new Error(detail || '请求未成功（' + response.status + '）');
        error.status = response.status;
        for (const key of ['receiptId', 'taskId', 'notDelivered']) if (value?.[key] !== undefined) error[key] = value[key];
        throw error;
      }
      return value;
    }
    return { request, run: (command, input = {}) => request('/api/plugins/' + PLUGIN_ID + '/run', { command, input }) };
  }
  function completed(operation) { return operation.status === 'accepted'; }
  function createDispatcher(client) {
    const active = new Set();
    async function verifyWorkspace(operation) {
      const directories = await client.request('/api/directories');
      if (!Array.isArray(directories)) throw new Error('无法核对任务的原工作目录，请稍后重试。');
      const directory = directories.find(item => item.id === operation.workspace.dirId);
      if (!directory || directory.path !== operation.workspace.path) throw new Error('原工作目录已删除或改绑，已停止投递。请在宿主恢复原目录绑定后重试，或另发新任务。');
    }
    async function deliverMessage(operation) {
      const shellPath = '/api/task-shells/' + encodeURIComponent(operation.task.shellId);
      const shell = await client.request(shellPath);
      if (!Array.isArray(shell?.receipts)) throw new Error('无法读取原任务回执，已停止投递，请稍后重试。');
      const receipt = shell.receipts.find(item => item.clientMsgId === operation.dispatch.message.clientMsgId);
      if (receipt) {
        if (receipt.taskId !== operation.task.taskId) throw new Error('回执与原任务身份不一致，已停止投递。');
        if (receipt.status === 'accepted') return { taskId: receipt.taskId, receiptId: receipt.id };
        if (['failed', 'rejected'].includes(receipt.status)) return client.request(shellPath + '/receipts/' + encodeURIComponent(receipt.id) + '/retry', {});
        const error = new Error('原消息仍在等待宿主确认，尚不能标记已投递。稍后点击重试会重新检查回执。');
        error.receiptId = receipt.id; error.taskId = receipt.taskId; error.notDelivered = false; throw error;
      }
      if (operation.error?.receiptId) {
        if (operation.error.taskId && operation.error.taskId !== operation.task.taskId) throw new Error('保存的失败回执与原任务不一致，已停止投递。');
        return client.request(shellPath + '/receipts/' + encodeURIComponent(operation.error.receiptId) + '/retry', {});
      }
      return client.request('/api/task-shell-tasks/' + encodeURIComponent(operation.task.taskId) + '/messages', operation.dispatch.message);
    }
    async function dispatch(operation, onUpdate = () => {}) {
      if (active.has(operation.id)) throw new Error('这条任务正在发送，请等待当前请求完成。');
      if (completed(operation)) return operation;
      active.add(operation.id);
      let stage = operation.task?.taskId ? 'message' : 'create';
      try {
        if (!operation.task?.taskId) {
          await verifyWorkspace(operation);
          const response = await client.request('/api/air/tasks', operation.dispatch.create);
          const saved = await client.run('record-dispatch', { operationId: operation.id, stage: 'created', response });
          if (!saved.operation?.task?.taskId) throw new Error('任务创建结果未能持久保存；请重试恢复记录。');
          operation = saved.operation;
          onUpdate(operation);
        }
        stage = 'message';
        await verifyWorkspace(operation);
        const response = await deliverMessage(operation);
        const saved = await client.run('record-dispatch', { operationId: operation.id, stage: 'sent', response });
        if (!saved.operation || !completed(saved.operation)) throw new Error('投递回执未能持久保存；请重试恢复记录。');
        operation = saved.operation;
        onUpdate(operation);
        return operation;
      } catch (error) {
        try {
          const input = { operationId: operation.id, stage, message: error.message };
          if (stage === 'message' && error.receiptId && error.taskId && typeof error.notDelivered === 'boolean') {
            for (const key of ['receiptId', 'taskId', 'notDelivered']) input[key] = error[key];
          }
          const saved = await client.run('record-error', input);
          if (saved.operation) onUpdate(saved.operation);
        } catch (_) { /* 保存失败不授权进入下一阶段；界面保留原操作供幂等重试。 */ }
        throw error;
      } finally { active.delete(operation.id); }
    }
    return { dispatch, active };
  }
  return { PLUGIN_ID, createClient, createDispatcher, completed };
}));
