#!/usr/bin/env node
'use strict';
// 合成飞书命令行：行为由 FAKE_LARK_STATE 指向的 JSON 控制，每次调用追加到同目录 calls.jsonl。不访问网络。
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.FAKE_LARK_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(path.dirname(file), 'calls.jsonl'), JSON.stringify(args) + '\n');
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const out = v => { process.stdout.write((state.tip ? 'tip: synthetic hint\n' : '') + JSON.stringify(v) + '\n'); };
const save = () => fs.writeFileSync(file, JSON.stringify(state));

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
  if (state.send === 'hang') { setTimeout(() => {}, 120000); return; }
  if (state.send === 'blocked') { out({ ok: true, data: { automation_send_disable_reason: 'admin disabled' } }); return; }
  if (state.send === 'error') { process.stderr.write(JSON.stringify({ ok: false, error: { message: 'synthetic failure' } })); process.exit(1); }
  const subject = flag('--subject');
  state.outbox = (state.outbox || []).concat([{ message_id: 'MID' + state.sent, subject, to: flag('--to') }]); save();
  out({ ok: true, data: { message_id: 'MID' + state.sent } });
} else if (args[1] === 'user_mailbox.messages' && args[2] === 'send_status') {
  out({ ok: true, data: { details: [{ status: state.delivery ?? 4 }] } });
} else if (args[1] === '+triage') {
  const filter = JSON.parse(flag('--filter'));
  const query = flag('--query');
  let messages = [];
  if (filter.folder === 'sent') messages = (state.sentFolder ? state.outbox || [] : []).map(m => ({ ...m, from: flag('--mailbox') }));
  if (filter.folder === 'inbox' && state.reply) messages = (state.outbox || []).map(m => ({ message_id: 'R' + m.message_id, subject: 'Re: ' + m.subject, from: 'Tester <' + (state.replyFrom || m.to) + '>', date: '2026-11-04 10:00' }));
  out({ count: messages.length, messages: messages.filter(m => m.subject.includes(query)) });
} else {
  process.stderr.write(JSON.stringify({ ok: false, error: { message: 'unexpected ' + args.join(' ') } }));
  process.exit(2);
}
