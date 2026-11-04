#!/usr/bin/env node
'use strict';
// 合成飞书命令行：行为由 FAKE_LARK_STATE 指向的 JSON 控制，每次调用追加到同目录 calls.jsonl。不访问网络。
// 支持设置页的登录/发信测试，以及发件箱的建草稿、发草稿、核对已发送与测试回信。
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.FAKE_LARK_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(path.dirname(file), 'calls.jsonl'), JSON.stringify(args) + '\n');
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const out = v => { process.stdout.write((state.tip ? 'tip: synthetic hint\n' : '') + JSON.stringify(v) + '\n'); };
const fail = message => { process.stderr.write(JSON.stringify({ ok: false, error: { message } })); process.exit(1); };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const hang = () => { setTimeout(() => {}, 120000); };
const nextDraft = draft => {
  state.draftSeq = (state.draftSeq || 0) + 1;
  state.drafts = state.drafts || {};
  state.drafts[draft.draft_id] = draft;
  save();
  return draft;
};
const sentMessage = draft => {
  state.sent = (state.sent || 0) + 1;
  const message_id = 'MID' + state.sent;
  state.outbox = (state.outbox || []).concat([{ message_id, subject: draft.subject, to: draft.to, mailbox: draft.mailbox, body_plain_text: draft.body, date: new Date().toISOString() }]);
  delete (state.drafts || {})[draft.draft_id];
  save();
  return message_id;
};

if (args[0] === 'auth' && args[1] === 'status') {
  if (state.auth === 'garbage') { process.stdout.write('not json'); process.exit(0); }
  const user = state.auth === 'expired'
    ? { status: 'expired', available: false, userName: '合成用户' }
    : { status: 'needs_refresh', available: true, userName: '合成用户', openId: 'ou_secret_open_id', accessToken: 'SECRET_ACCESS_TOKEN', scope: state.scope ?? 'mail:user_mailbox.message:send mail:user_mailbox.message:readonly', refreshExpiresAt: '2099-01-01T00:00:00+08:00' };
  out({ identities: { bot: { status: 'ready' }, user }, identity: 'user' });
} else if (args[1] === 'user_mailboxes' && args[2] === 'accessible_mailboxes') {
  out({ ok: true, data: { accessible_mailboxes: state.mailboxes.map(a => ({ email_address: a, email_type: 'PUBLIC_MAILBOX' })) } });
} else if (args[1] === '+send') {
  state.sent = (state.sent || 0) + 1; save();
  if (state.send === 'hang') { hang(); return; }
  if (state.send === 'blocked') { out({ ok: true, data: { automation_send_disable_reason: 'admin disabled' } }); return; }
  if (state.send === 'error') { fail('synthetic failure'); }
  const subject = flag('--subject');
  state.outbox = (state.outbox || []).concat([{ message_id: 'MID' + state.sent, subject, to: flag('--to'), mailbox: flag('--mailbox') }]); save();
  out({ ok: true, data: { message_id: 'MID' + state.sent } });
} else if (args[1] === '+draft-create' || args[1] === '+reply') {
  if (state.draftCreate === 'error') fail('synthetic draft failure');
  if (state.draftCreate === 'hang') { hang(); return; }
  const mailbox = flag('--mailbox');
  const draft = nextDraft({
    draft_id: 'D' + state.draftSeq,
    to: flag('--to') || flag('--message-id') || '',
    subject: flag('--subject') || '',
    body: flag('--body') || '',
    mailbox,
    in_reply_to: flag('--message-id') || '',
  });
  if (state.draftCreate === 'no-id') { out({ ok: true, data: {} }); return; }
  if (state.draftDelayMs) setTimeout(() => out({ ok: true, data: { draft_id: draft.draft_id } }), state.draftDelayMs);
  else out({ ok: true, data: { draft_id: draft.draft_id } });
} else if (args[1] === '+draft-send') {
  const draftId = flag('--draft-id');
  const draft = (state.drafts || {})[draftId];
  const behaviour = state.draftSend || 'ok';
  if (behaviour === 'error') fail('synthetic draft send failure');
  if (behaviour === 'blocked') { out({ ok: true, data: { automation_send_disable_reason: 'admin disabled' } }); return; }
  if (!draft) fail('draft not found');
  if (behaviour === 'hang') { hang(); return; }
  const message_id = sentMessage(draft);
  if (behaviour === 'hang-sent') { hang(); return; }
  if (behaviour === 'no-id') { out({ ok: true, data: { results: [{ draft_id: draftId }] } }); return; }
  out({ ok: true, data: { results: [{ draft_id: draftId, message_id }] } });
} else if (args[1] === 'user_mailbox.drafts' && args[2] === 'get') {
  let params = {};
  try { params = JSON.parse(flag('--params') || '{}'); } catch (_) { params = {}; }
  if (params.draft_id && (state.drafts || {})[params.draft_id]) out({ ok: true, data: { draft_id: params.draft_id } });
  else fail('draft not found');
} else if (args[1] === 'user_mailbox.messages' && args[2] === 'send_status') {
  out({ ok: true, data: { details: [{ status: state.delivery ?? 4 }] } });
} else if (args[1] === '+triage') {
  const filter = JSON.parse(flag('--filter') || '{}');
  const query = flag('--query') || '';
  let messages = [];
  if (filter.folder === 'sent') {
    messages = state.sentFolder ? (state.outbox || []).map(m => ({ ...m, from: flag('--mailbox') })) : [];
  }
  if (filter.folder === 'inbox' && state.reply) {
    messages = (state.outbox || []).map(m => ({
      message_id: 'R' + m.message_id,
      subject: 'Re: ' + m.subject,
      from: 'Tester <' + (state.replyFrom || m.to || '') + '>',
      date: state.replyDate || '2026-11-04 10:00',
      body_plain_text: state.replyBody || '收到，已确认。',
    }));
  }
  const fromFilter = [].concat(filter.from || []).map(f => String(f).toLowerCase());
  if (fromFilter.length) messages = messages.filter(m => fromFilter.some(f => String(m.from || '').toLowerCase().includes(f)));
  out({ count: messages.length, messages: messages.filter(m => String(m.subject || '').includes(query)) });
} else if (args[1] === '+messages') {
  const ids = String(flag('--message-ids') || '').split(',').filter(Boolean);
  const messages = ids.map(id => {
    const base = id.replace(/^R/, '');
    const source = (state.outbox || []).find(m => m.message_id === base || 'R' + m.message_id === id) || {};
    return {
      message_id: id,
      subject: source.subject ? 'Re: ' + source.subject : '',
      from: 'Tester <' + (state.replyFrom || source.to || '') + '>',
      date: state.replyDate || '2026-11-04 10:00',
      body_plain_text: state.replyBody || '收到，已确认。',
    };
  });
  out({ ok: true, data: { messages } });
} else {
  process.stderr.write(JSON.stringify({ ok: false, error: { message: 'unexpected ' + args.join(' ') } }));
  process.exit(2);
}
