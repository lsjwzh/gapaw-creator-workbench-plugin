# Changelog

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
