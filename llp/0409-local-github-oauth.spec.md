# LLP 0409: Local GitHub OAuth and one-time imports

**Type:** Spec
**Status:** Draft
**Systems:** Plugins, Sources, CLI, Graph
**Author:** Phil / Codex
**Date:** 2026-09-15
**Extends:** LLP 0360
**Related:** LLP 0065, LLP 0361, LLP 0367, LLP 0374, LLP 0392

## Request

Implement the user-approved local OAuth device login and explicit one-time
repository import described in the September 14 handoff. This extends
LLP 0360#authentication's env/gh-only, no-persistence decision and
LLP 0360#inventory's positional-backfill narrowing rule.

## Authentication

`hyp github login [--no-browser]` uses GitHub's public OAuth client
`Ov23liHrANQp9z8TxjyB`, device flow, and `repo` scope for the existing private
repository endpoints. This scope includes write permissions although capture
only reads. Device and refresh requests require no client secret. Polling
honors interval, slowdown, expiry, denial, and cancellation. Every network
operation has a deadline and refuses redirects. Verify `/user` before saving
a login. Unattended capture only reports re-login instructions.

`hyp github status` reports the effective credential source and verified
account without printing credentials. `hyp github logout` removes local
tokens, retaining the explicit OAuth selection. It does not revoke GitHub's
grant; the user can revoke it in GitHub's Authorized OAuth Apps settings.

The configured environment token remains an explicit override. Otherwise,
selected OAuth wins, including when logged out, corrupt, expired, or revoked.
Only an installation that never selected OAuth can fall back to legacy `gh`.
Beginning login replaces prior credentials with a pending selection; failure
or cancellation cannot revive the former account. A generation identifies
each login/logout so a late login cannot overwrite a newer choice.

## Private state and refresh

Credentials reside under the plugin's `auth/` directory, explicitly mode
0700, with an atomically written mode 0600 `credentials.json`. Tokens never
enter configuration, activity, graph rows, logs, or error bodies. No additional
runtime dependency or keychain integration is introduced.

Reuse the LLP 0065 age-stale file mutex through the public core utility seam.
Re-read after acquiring it, rotate at most once, and compare the generation
and refresh token before committing. Network work inside this lock is bounded
below its stale threshold. Fresh credentials are resolved per API request
(never per activity row); daemon processes see a login/logout without restart.
Credential data and polling state have constant memory bounds.

## One-time imports

`hyp github backfill owner/repo ...` authorizes those repositories for one
full import even without session evidence. A `one_time_import` marker on the
existing repository cursor records this authorization, alongside the existing
bounded backfill continuation. Save authorization before fetching. Ordinary
ticks resume it until completion, then remove exceptional eligibility.
Exclusion cancels that eligibility. A later explicit backfill can start again.

Automatic inventory still follows existing permitted-session evidence and
withholding revalidation. OAuth accessibility adds no repositories. Existing
explicit `all_visible` configuration retains its meaning. Imports never write
to the observed-session index. The structural dataset, history horizon,
natural keys, export controls, and automatic graph projection are unchanged.
Repeat completed backfills still re-append, as LLP 0374 requires.

## Activation and verification

The existing plugin activation rules apply: commands are discoverable in
manifest help and inactive-command errors explain how to enable the plugin.
Login itself neither edits configuration nor starts a source or daemon.

Deterministic tests cover polling, private state, source precedence, refresh
contention, cancellation and superseded logins, daemon credential pickup,
exclusions, restart/resumption, and completion without subscription. Hermetic
capture proves structural rows and automatic graph projection. Real acceptance
uses a disposable sandbox and a human approving the device code at GitHub;
mocks do not establish app registration or installed-daemon behavior.

## References

- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
