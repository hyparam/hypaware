# LLP 0145: Shadow providers borrow the shadowed provider's credential

**Type:** Decision
**Status:** Superseded
**Systems:** Plugins, Gateway, Config
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0109 (OpenClaw client adapter), LLP 0152 (plugin-steered shadow providers), LLP 0144 (shadow provider per API shape)

> LLP 0109's injected provider authenticated with `${ANTHROPIC_API_KEY}`,
> which excludes exactly the users OpenClaw's Anthropic documentation steers
> people toward: Claude CLI reuse and `claude setup-token` subscription
> auth. Resolve the shadowed provider's own credential instead of demanding
> an environment variable.

> **Superseded-by [LLP 0168](./0168-config-override-replaces-plugin-steering.decision.md):**
> with the config override there is no shadow provider and nothing to
> borrow; the real provider's own credential applies natively (verified
> with a live setup-token turn, LLP 0167#verify-results). The goal, no
> vendor env var required for capture, is met by construction.

## Context

LLP 0109 listed this as a known v1 limitation, "OpenClaw auth-alias/keychain
credentials are not visible to a custom provider", and had attach warn when
`ANTHROPIC_API_KEY` was unset.

In practice this is not an edge case. OpenClaw's own Anthropic provider docs
present three auth routes, and two of them produce no API key: reusing a
local Claude CLI login, and pasting a `claude setup-token` OAuth token. A
user on either route who runs `hyp attach --client openclaw` gets a shadow
provider that cannot authenticate, and the failure surfaces as model calls
failing rather than as an attach error.

It also compounds with LLP 0144: extending capture to every API shape means
every vendor's credential, not just Anthropic's. `${OPENROUTER_API_KEY}`,
`${GROQ_API_KEY}` and so on multiply the same problem, and the environment
is the wrong place to look for any of them: OpenClaw supports SecretRef
sources and auth profiles precisely so credentials need not sit in the
environment.

A seam exists, and it is verified (openclaw source, 2026-07-29):

- `openclaw/plugin-sdk/provider-auth-runtime` **publicly exports**
  `resolveApiKeyForProvider({ provider, ... })`, callable with any provider
  id. Its OAuth branch returns the **live access token**, refreshing it
  under a lock when expired
  (`src/agents/auth-profiles/oauth.ts`, `resolveApiKeyForProfile`).
- Because the plugin owns the `hypaware-*` provider ids (LLP 0144), its
  `prepareRuntimeAuth` hook runs for them, and its return value
  `{ apiKey, baseUrl?, expiresAt? }` becomes the runtime credential.
  GitHub Copilot's bundled plugin uses exactly this pattern: resolve one
  credential, exchange it, return key + endpoint + expiry
  (`extensions/github-copilot/index.ts`).

One path that does **not** work, also verified: pointing a `hypaware-*`
provider at an `anthropic` auth profile via profile ordering. Profile
eligibility hard-fails on provider mismatch
(`src/agents/auth-profiles/order.ts`: `provider_mismatch`), and the only
aliases (`byteplus-plan` → `byteplus`) are hardcoded in core. The borrow
must happen inside `prepareRuntimeAuth`, not through the profile store.

## Options considered

1. **Keep requiring vendor env vars.** Rejected: excludes subscription and
   keychain users, and the failure mode is a broken turn rather than a clear
   refusal.
2. **Have HypAware read OpenClaw's credential storage directly**: auth
   profiles, keychain, `models.json`. Rejected: reaching into another
   product's private credential storage from outside its process is exactly
   the kind of coupling that breaks on upgrade, and it would mean HypAware
   handling secrets it has no need to hold.
3. **Resolve the shadowed provider's credential in-process, through the
   plugin API, and hand it to the shadow provider at runtime.** Chosen.

## Decision

- The plugin resolves the credential for the **real** provider it is
  shadowing, via `resolveProviderApiKey(<real provider id>)`, and supplies
  it for the shadow provider.
- Runtime credential supply goes through `prepareRuntimeAuth` on the
  plugin's own `hypaware-*` providers, so refresh and expiry ride
  OpenClaw's generic background-refresh path rather than being pinned at
  catalog-build time. This matters for OAuth tokens in long turns.
- No vendor API key is ever required in the environment as a precondition
  of capture.
- If the credential cannot be resolved for a given provider, the plugin
  **does not steer that provider**, the turn passes through and a warning
  is emitted, per the general rule in LLP 0149 (cause: `no_credential`).
- HypAware never persists a borrowed credential. It is passed through for
  the request and not written to HypAware state or recordings: the gateway
  already strips `x-hypaware-*` request headers before proxying and must
  likewise never project credential material into
  `ai_gateway_messages`.

## Consequences

- Subscription and keychain OpenClaw users become capturable, which is the
  single largest coverage gain in this set after LLP 0152.
- The plugin becomes a credential-handling component, which raises its
  review bar: it holds vendor credentials in memory for the duration of a
  request. This is materially different from LLP 0109's posture, where the
  credential was a config-interpolated env var HypAware never touched, and
  should be called out in the plugin's permissions.
- The refuse-to-steer rule makes coverage a first-class, observable
  property: an uncaptured provider produces a log line rather than silence.

## Open questions

- Does forwarding a borrowed credential through a local proxy violate any
  vendor terms that the direct path does not? Worth a deliberate answer
  rather than an assumption.

(The OAuth beta-header problem formerly listed here is settled by LLP 0148:
the plugin's own `wrapStreamFn` mirrors OpenClaw's header shaping
client-side, including the OAuth betas and the `context-1m`-under-OAuth
exclusion; the gateway needs no injection seam.)

## References

- LLP 0109, 0142, 0144
- `openclaw` repo: `src/plugins/types.ts`,
  `src/plugins/provider-runtime.ts`, `extensions/anthropic/stream-wrappers.ts`
- https://docs.openclaw.ai/providers/anthropic
