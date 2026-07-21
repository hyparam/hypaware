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

<a id="helper-contract"></a>**The helper is a generated wrapper that runs
`hyp claude-account credential`.** The contract, verified against the app
bundle: `inferenceCredentialHelper` is a single string that must be an
**absolute path to an executable, which Desktop runs with no arguments**,
reading trimmed stdout; exit code must be `0`. Because the app passes no
argv, the profile cannot reference `hyp claude-account credential` directly.
`@hypaware/claude-desktop` therefore generates a tiny wrapper executable that
`exec`s `hyp claude-account credential` and points the profile at the
wrapper's absolute path (the shape the personal-machine prototype already
proved). The wrapper is written under HypAware's state dir (`~/.hyp/...`),
never a macOS TCC-protected directory (Documents, Desktop, Downloads), and is
marked executable. Because Desktop launches it with the app's environment
(no non-default `HYP_HOME` / `HYP_CONFIG`), the wrapper exports the config env
captured at generation time so it resolves the same config the daemon uses no
matter who launches it.

`hyp claude-account credential` prints ONLY the credential to stdout as JSON
`{"token", "headers", "ttlSec"}`; helper-supplied headers merge over static
config (helper wins). Desktop caches for the advertised ttl
(`inferenceCredentialHelperTtlSec`, default 3600), silently refreshes ahead
of expiry, and re-runs the wrapper on an upstream 401. Subscription mode
returns the `anthropic-beta: oauth-2025-04-20` header beside the bearer
token; org-key mode returns the key for the profile's `x-api-key` scheme.
(`inferenceCustomHeaders` is the app's static alternative for constant
headers, but routing them through the helper keeps one code path and lets
the beta header follow the credential kind.)

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
