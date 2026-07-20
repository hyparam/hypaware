# LLP 0116: The Desktop credential is presented by the client; the gateway stays passthrough

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0016, LLP 0115, LLP 0117

> A Desktop attach (LLP 0115) must get an Anthropic credential onto each
> request. Three placements were on the table: the gateway injects it, the
> pushed profile embeds it, or the client obtains it at request time through
> Desktop's helper-script credential kind. This decision picks client-side
> presentation via the helper, which keeps LLP 0016's auth-agnostic
> passthrough gateway intact and keeps the pushed profile free of secrets.

## Context

LLP 0016 makes the gateway deliberately credential-ignorant: it forwards
headers untouched and knows nothing about any client. Every attached client
today (Claude CLI, Codex) presents its own credential and the gateway
passes it through; recording redacts `authorization` and the other secret
headers at capture (the recorder's frozen redact set).

An earlier sketch of this design added a gateway credential-injection seam
(a `registerCredentialProvider` hook) so one central login could also cover
Claude Code. That Claude Code half was explicitly dropped from scope. With
Desktop the only consumer, Desktop's own credential-kind surface already
supports a **helper script**: a command the app runs to obtain the
credential, with caching and 401-triggered re-run built in.

## Options

1. **Gateway injects the credential** - a typed provider hook fills in
   `authorization` for the anthropic upstream when the inbound request
   lacks it. Departs from LLP 0016 passthrough, adds a secret-bearing code
   path inside the gateway, and its main payoff (covering Claude Code
   centrally) is out of scope.
2. **Embed the secret in the pushed profile** - works only for the static
   org key, turns the profile into a secret artifact (every rotation is a
   fleet-wide re-push), and cannot express per-user subscription
   credentials at all.
3. **Helper-script credential kind, for every mode** - the profile names a
   helper command; the helper resolves whatever credential fleet policy
   selects (LLP 0117) at request time on the local machine.

## Decision

<a id="client-presents-credential"></a>**Option 3.** Desktop presents its
own credential like every other attached client, obtained through the
helper-script credential kind. The gateway remains a pure passthrough; no
LLP 0016 departure, no injection seam.

<a id="profile-carries-no-secret"></a>**The pushed profile carries no
secret.** In both credential modes the profile holds only the helper
command reference. The org key or subscription token lives on the machine,
under the credential store's discipline (LLP 0117), never in the MDM
payload. Credential rotation is local: the next helper run returns the new
value, no profile re-push.

<a id="helper-contract"></a>**The helper is `hyp claude-account
credential` under Desktop's helper contract.** The contract, as probed from
the app: print ONLY the credential to stdout, either a bare token or JSON
`{"token", "headers"}`; helper-supplied headers merge over static config
(helper wins); Desktop caches for the advertised ttl, refreshes at
min(2 min, ttl/2), and re-runs the helper on an upstream 401. The helper
must not live under a macOS TCC-protected directory (Documents, Desktop,
Downloads). Subscription mode rides the JSON form to add the
`anthropic-beta: oauth-2025-04-20` header beside the bearer token; org-key
mode returns the key for the profile's configured auth scheme.

## Consequences

- The gateway's recorder already redacts `authorization` / `x-api-key` at
  capture, so client-presented credentials never land readable in
  `ai_gateway_messages`; nothing new to scrub.
- The helper's stdout is a secret. It must never be logged, and the
  command must fail with a nonzero exit and an empty stdout rather than
  print diagnostics where the app expects the credential.
- If central login for Claude Code is ever revisited, gateway injection
  becomes live again as its own decision; nothing here precludes it, this
  decision only records that Desktop alone does not justify it.
