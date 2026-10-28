# Changelog

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
