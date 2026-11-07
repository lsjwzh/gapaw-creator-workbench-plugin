# Changelog

## 0.15.1

- Keep imported creator fees unset instead of inheriting the legacy campaign price. Preserve source notes in cooperation settings without treating imported data as verified commercial terms.
- Store optional target products with the import source and include them in preview validation. Product verification remains a separate explicit action.
- Keep imported email provenance in the source profile and batch record, so manual fact registration remains usable after an import.

## 0.15.0

- Make guided onboarding the plugin entry page. Save the product goal, existing creator scope and working agreement, review or edit the eight bound role prompts, and check host readiness before starting.
- Add a Rust office runtime with versioned settings, persistent work records and an explicit start/pause control. Starting registers one host scheduler job; closing the page does not stop queue coordination. Stable request identifiers recover lost scheduling and wake receipts without duplicate operations.
- Continue from selection to copywriting only after the current recipient accepts a validated native host delivery. Recover missed continuations through paginated delivery reads and retain complete draft candidates separately from official business tables.
- Present staff blockers with missing items and recommendations. Let the owner wait, exclude or request another review while unrelated work continues. Delayed receipts prompt investigation without invalidating legitimate late results.
- Invalidate affected recommendations after agreement or role changes, reject stale submissions, preserve history, and keep unsaved page inputs during status polling. Require the companion host delivery API and explicit user setup; do not start real role turns or send email during installation.

## 0.14.1

- Add a versioned selection brief for handoff from the selection task to the copywriting task. Build the payload from recorded candidates and current business facts; reject changed source data, altered payloads and mismatched role tasks.
- Integrate with the MultiCC task delivery tool for explicit recipient acceptance or return with missing items. Acceptance permits preparation of a candidate only; it does not approve business adoption or email sending.
- Add an upgrade action for existing office role instructions. Verify all eight task bindings, preserve custom roles and frozen creation plans, and use host role versions and stable request identifiers to recover interrupted updates without creating tasks or starting model turns.
- Require the host delivery interface before upgrading role instructions. Retain the current model and provider configuration and keep scheduled dispatch and automatic email sending disabled.

## 0.14.0

- Add a dedicated dispatcher and seven staff role tasks. Connections & Settings now selects the workspace, model and provider, registers a dedicated workspace when needed, and initializes the eight tasks without starting model turns. Frozen creation plans and stable request IDs recover partial initialization without creating duplicate tasks.
- Add a Rust work-item ledger in the existing business database: source deduplication, atomic claims, fixed dispatch requests, host acceptance receipts, scoped worker context and candidate submissions. A lost dispatch receipt remains recoverable even if the worker has already submitted its candidate.
- Reject candidate results when creator settings, drafts, messages, events or negotiation facts changed during execution. Validate task ownership and work versions, preserve idempotent submissions, and keep candidates separate from official business records and the outbox.
- Let users create shadow work from a creator's conversation, wake the dispatcher manually, inspect returned candidates and cancel work. The office shows recorded work states and links to the actual role tasks; task creation and host acceptance are never presented as completed business work.
- Keep real email testing deferred. Scheduled wakeups and automatic outbound messages remain disabled; candidate approval and adoption will follow in the next shadow-decision slice.

## 0.13.4

- Add an outbox so hand-written emails can be sent from the plugin (`outbox-list`, `outbox-save`, `outbox-send`, `outbox-check`, `outbox-cancel`). Sending creates a Feishu draft, records the draft ID, sends the draft, and checks the delivery status. The record is saved as "sending" before any mail call, and send is only called after the draft ID is stored, and a cross-process lock serializes sending and reconciliation. Unsettled mail is blocked from resending after a timeout, crash, or repeated click.
- Reconcile unsettled mail with unique matching evidence from the sent folder. Live mail requires matching sender, recipient, subject, time, and full plain-text body. A remaining remote draft does not prove a timed-out send was unsuccessful; it stays unsettled. Only interruptions before any draft ID was recorded can return to ready-to-send.
- Re-check hard rules right before sending: no explicit refusal, no earlier bounce, a registered creator address, no new reply since the email was written, no bare amounts, all placeholders filled, the daily limit, the sending window, the follow-up count, and the minimum interval.
- In test mode, force the recipient to the test address, tag the subject with a test reference and the body with a test notice, keep test mail out of the business messages and facts, and record the test recipient's reply on the outbox entry. In live mode, reply in the creator's thread when there is an incoming email, and record the sent message and send facts.
- Add a compose area and outbox list to the creator drawer, plus an outbox panel and a "results to reconcile" card on the home page.

## 0.13.3

- Retire the previous ten-module workbench, draft tasks, ROI selection, legacy report and candidate pages. The pixel office (`ui/index.html`), Connections & Settings, and Shadow Rehearsal are the only pages. The business database, history, and backend commands are kept as the data layer; shared request and MultiCC task-dispatch helpers move to `ui/client.js`.
- Move data management into Connections & Settings: create an empty workbench, import an existing ledger, or refresh from the original ledger.
- Add `preview-workbench-refresh` and `refresh-workbench`. A refresh is allowed only when the plugin database is unchanged since the last import (per-table digests in the import receipt). It previews per-table counts, backs up the current database, keeps the business identity, replaces the database atomically, and records a new receipt.
- Add `creator-import-preview` and `creator-import` to register creators contacted outside the original ledger, together with their send facts. Imports are validated, digest-confirmed, conflict-checked, and idempotent.
- Add `mail-sync`, which incrementally lists the sender mailbox's inbox and sent folders through `lark-cli`. It keeps only mail exchanged with known creator addresses, deduplicates by message ID and by subject and time against older records, counts unmatched mail without creating creators, and stores a sync cursor. Preview mode writes nothing.
- On the home page, add a "Sync mail now" button, new-mail cards for creators without a negotiation, and a read-only creator drawer (`office-creator`) showing negotiation status and recent messages. The reply funnel now also counts synced replies from real people.

## 0.13.2

- Make a pixel-art office the plugin home page. Seven AI staff sit along the workflow (selection, copy, follow-up, sending, inbox sorting, negotiation, fulfilment) next to a mailbox, an inbox tray, and your desk. The previous workbench remains available as a secondary page with all its features.
- Show the real state by default: who is blocked by missing settings, who is waiting for rehearsal answers, and which negotiations are waiting for your reply. Cards on your desk link to Connections & Settings, Shadow Rehearsal, and the negotiation overview. A 14-day calendar shows past activity and the follow-up plan.
- Add a "Simulate a day" mode that animates staff working, carrying files between desks, sending and receiving mail, and raising their hands for decisions that need you. Simulation only changes the page: it sends nothing and changes no data. It uses sample handles when there is too little real data.
- Add the read-only `office-status` command, implemented in Rust, that summarizes daily activity, funnel counts, negotiations, unanswered creators, rehearsal progress, and setup status. It never returns email addresses or message bodies.

## 0.13.1

- Add a Shadow Rehearsal page that turns the previous campaign into a guided simulation. A rehearsal pack lists, for each main workflow step (selection, terms, copy, outreach, reply classification, negotiation, follow-up, confirmation), the questions automation needs answered, the AI's prefill from past records, its confidence, conflicts, and evidence.
- Answer each question by accepting the prefill, entering your own value, marking it unsure, or marking it not applicable. Objective values (fees, rates, limits) are used only after explicit confirmation; unsure and not-applicable answers are never used.
- Replay real incoming messages from the local workbench next to the AI's suggestion and the reply actually sent at the time, then choose the AI suggestion, the historical reply, or your own approach. Differences are listed separately for review. Condition changes are always marked as requiring your confirmation.
- Store rehearsal packs as immutable, hash-checked imports and answers as an append-only history with request IDs and revision checks. The page reads the business database read-only, sends nothing, and changes no creator records.

## 0.13.0

- Add a Connections & Settings page that gathers every prerequisite in one checklist: local business data, Feishu mail sign-in, sender mailbox, test recipient, run mode, sending limits, delegation parameters, scheduled sync, and the browser/platform check. Each item shows its state, the features that depend on it, and the next step.
- Block only the features that depend on a missing item. Show a banner on the home page while required settings are incomplete and link to the page from every navigation bar.
- Detect the local `lark-cli` installation, user sign-in, and mail read/send scopes, and list the mailboxes the signed-in account can access. Return only display-safe fields; tokens and account IDs are never returned or stored.
- Choose the sender mailbox only from accessible mailboxes. Store settings with a version number and change history, and reject stale or out-of-range values.
- Send a connection test email to the test recipient only when the user clicks the button. Record the attempt before sending, treat timeouts and unreadable responses as unknown, refuse to resend until the result is reconciled against the Sent folder, report bounces and administrator blocks, and accept only replies from the test recipient.
- Start in test mode. Switching to live mode requires explicit confirmation and a passed send-and-reply test with the current mailboxes; changing either mailbox returns to test mode.
- Inbox sync, outbound business email, and delegation are not active yet; their parameters are saved for upcoming releases.

## 0.12.0

- Replace manual platform account and evidence forms with browser-bound automatic identity checks and explicit page selection. Keep login inside the selected browser profile.
- Observe narrowly projected identity responses in temporary background pages through a separate public browser protocol. Distinguish sign-in, verification challenges, access denial, missing pages, and unavailable browser capabilities.
- Bind checks to the browser process lifecycle, expire cached results after two minutes, and recheck before starting each conversation turn. Reject account, shop, and market changes for existing tasks.
- Use the public read bridge bundled with Chrome Proxy Launcher 1.6.4 in MultiCC, retaining the same commands and protocol. Determine compatibility from capabilities rather than the product version; running instances with page access do not need a restart solely for this update.
- Retire the local 1.6.3 companion build entry point and retain its patches and isolated verification sources for historical reference. Maintain future browser plugin changes through the MultiCC repository's branch and commit workflow instead of overwriting its plugin directory.
- Include the cross-border TikTok Shop Affiliate origin in platform discovery and require an authenticated identity response before marking it ready.
- Recognize Kalodata visitor identity responses alongside sign-in controls and TikTok Shop registration redirects. Public ranking responses and masked metrics do not establish authenticated data access.
- Validate the public command chain with fresh Chrome profiles and synthetic HTTPS responses. Live platform verification remains pending; identity checks do not establish access to every screening metric or reporting window.

## 0.11.0

- Add a conversational selection workspace with host provider and model catalogs, persistent task history, same-task follow-ups, and recoverable message delivery.
- Store immutable structured candidate lists with source evidence, explicit unknown values, reporting windows, version comparisons, and continuation from earlier versions.
- Preview and adopt selected candidates into the local workbench in one transaction. Preserve existing cooperation settings and facts, reject ambiguous identities, skip repeated adoption, and recover receipts after refresh.
- Show adopted selection evidence in creator profiles and preserve unknown fixed fees.
- Add browser-bound manual readiness confirmation with a four-hour expiry, explicit invalidation, and account/market/readable-field checks. Automatic platform login probing and live collection are not integrated.
- Keep the previous report workflow available as a separate history entry. Validate the new flow using isolated browser scenarios and synthetic host responses.

## 0.10.1

- Discover browser instances through the host plugin API and the public list command. Support Chrome Proxy Launcher 1.6.3 without coupling compatibility to its product version.
- Validate instance metadata and retain only safe fields. Reject unavailable or malformed catalogs without falling back to private configuration files.
- Preserve task-bound identities and require explicit rebinding when source metadata changes.
- Distinguish available instance discovery from page access and platform login checks, which are not integrated with the current public API.
- Add an interactive selection workspace prototype with configuration controls, dependency checks, conversation history, candidate versions, and adoption previews using synthetic data only.
