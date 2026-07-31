# LLP 0148: Wire parity is enforced in the plugin; the gateway stays a recorder

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0016 (ai-gateway), LLP 0152 (plugin-steered shadow providers), LLP 0144 (shadow provider per API shape), LLP 0145 (borrowed credentials)

> Steering a turn onto a shadow provider must not change what the model
> receives or returns. OpenClaw applies its Anthropic-only request shaping
> through a hook that only runs for the provider *named* `anthropic`, so the
> shadow provider loses it, and some of what it loses breaks auth and
> correctness, not just speed. Parity is a requirement, and it lives in the
> OpenClaw-side plugin, not the gateway.

## Context

OpenClaw's Anthropic plugin shapes requests in its `wrapStreamFn`
(`extensions/anthropic/index.ts`), which is owner-scoped: it runs only for
the provider id `anthropic`. Two of its wrappers additionally refuse to act
unless the base URL is the public `api.anthropic.com`. On a `hypaware-*`
shadow provider, none of it runs. What that costs per call:

- **OAuth beta headers** (`oauth-2025-04-20`, `claude-code-20250219`):
  without them, subscription-authenticated calls fail outright.
- **Default beta headers** (fine-grained tool streaming, interleaved
  thinking): without them, tool-call streaming and thinking behavior
  degrade, a correctness change, possibly silent.
- **`/fast` service tier**: turns quietly get slower.

A capture layer that changes the behavior being captured undermines its own
record. So the principle this decision fixes: **a parity gap between the
steered and unsteered wire is a capture bug, not a documented loss.**

The enforcement point was the real question. An earlier sketch split the
work: auth-critical headers at the gateway, config-dependent shaping in
the plugin. Reading the existing ai-gateway ruled that out as unnecessary:

- The gateway's `matchUpstream` already supports header-driven per-request
  routing via preset match functions (`ai-gateway/src/proxy.js`), so
  multi-vendor forwarding needs no gateway change (LLP 0144).
- Beta headers are ordinary `anthropic-beta` request headers. Set
  client-side, they pass through `forwardHeaders` untouched (only
  `x-hypaware-*` is stripped). The gateway needs no injection seam.
- The `/fast` signal lives in OpenClaw config and never reaches the wire,
  so the gateway *couldn't* restore it anyway.

Everything therefore points to one place: the plugin owns the `hypaware-*`
provider ids, so **its own `wrapStreamFn` runs for them**, the exact seam
OpenClaw's Anthropic plugin uses, available to us for our providers.

## Decision

- The OpenClaw-side plugin's `wrapStreamFn` for `hypaware-anthropic`
  mirrors OpenClaw's Anthropic request shaping: merge the beta header set
  (OAuth betas when the borrowed credential is OAuth, defaults otherwise,
  `context-1m` per the user's opt-in **except** under OAuth, matching
  OpenClaw's own exclusion) and inject `service_tier` from the same config
  keys OpenClaw's plugin reads.
- The **existing** `hypaware.ai-gateway ^2.0.0` capability is used
  unchanged: same proxy, same presets mechanism, same recorder, same
  header stripping. No new gateway, no capability bump.
- Parity gaps discovered later are treated as bugs in the plugin, fixed by
  extending the mirror, never re-classified as acceptable losses.
- Scope note: parity mirroring is per API shape. `openai-completions`
  currently has no known OpenClaw-side shaping to mirror; if OpenClaw grows
  some, the same rule applies.

## Consequences

- The mirror is a copy of OpenClaw plugin logic (~30 lines today) and can
  drift when OpenClaw changes its shaping. The release checklist for the
  plugin must include diffing `extensions/anthropic/stream-wrappers.ts`
  against the mirror. Drift risk is the price of the rename-based steering
  design (LLP 0152) and is accepted.
- The gateway remains vendor-neutral and dumb, which keeps LLP 0016's
  boundary intact: adapters own client-specific behavior.

## Open questions

- ~~The `PI_AI_*` beta constants in OpenClaw's plugin suggest the underlying
  `pi-ai` library may add the default betas itself when no wrapper runs
  (it can detect OAuth by key shape).~~ **Answered at implementation
  (LLP 0161 Section 10, LLP 0162 T2), and it is true.** `pi-ai@0.73.1`'s
  Anthropic provider adds both default betas from its own flags and prepends
  the two OAuth betas whenever the key matches `sk-ant-oat`, the same
  predicate OpenClaw uses. The mirror shrank as anticipated: it now installs
  only under OpenClaw's own `needsAnthropicBetaWrapper` condition, since
  merging unconditionally would *add* the interleaved beta on adaptive-thinking
  models that pi-ai deliberately omits it for, which is a parity change in the
  other direction. The merge is a header-name-keyed `Set` union and stays
  idempotent regardless.

## References

- LLP 0016, 0142, 0144, 0145
- `openclaw` repo: `extensions/anthropic/index.ts`,
  `extensions/anthropic/stream-wrappers.ts`
- `hypaware-core/plugins-workspace/ai-gateway/src/proxy.js`
