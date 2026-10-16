# LLP 0168: The config provider override replaces plugin steering

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway, Config
**Author:** Phil / Claude
**Date:** 2026-07-31
**Related:** LLP 0167 (the accepted RFC this decision realizes), LLP 0152 (superseded), LLP 0145, LLP 0148 (mooted), LLP 0144 (analysis carried over), LLP 0171 (requirements)

> OpenClaw's live capture lane is steered by two `models.providers`
> entries HypAware writes into `openclaw.json`, not by an OpenClaw-side
> plugin. The steering plugin package is deleted whole. Rationale,
> verified facts, and the exact entry shapes live in LLP 0167; this
> decision exists so downstream docs and code can cite the choice
> narrowly.

## Context

LLP 0152 chose an OpenClaw plugin (shadow providers plus a
`before_model_resolve` hook) over editing the user's config, after
rejecting per-model-ref rewrites as unboundedly stale. A per-provider
`baseUrl` override was not among its options, and it does not share the
fatal flaw: it steers at the provider level, so every ref on the
provider, present and future, resolves through the one overridden
entry. LLP 0167 verified the mechanism live ({#verify-results}):
explicit config entries merge over the built-in catalog, the
config-sourced `x-hypaware-upstream` header rides every request, native
auth (including a pasted subscription setup token) and native header
shaping apply, and the routing seam of issue #539 is not hit by the
`/v1`-shaped URLs.

## Decision

- Live OpenClaw capture for `anthropic/*` and `openai/*` is steered by
  the two config entries of LLP 0167#override-entries: `anthropic` at
  the gateway bare origin, `openai` at the gateway origin plus `/v1`,
  each carrying the static `x-hypaware-upstream` header and the
  mandatory `models: []`.
- The `@hypaware/openclaw-steering-plugin` package is deleted entirely,
  with its tests and manifest copy (LLP 0167#deletion-inventory).
- The gateway and the exchange projector are unchanged: the header
  arrives from config instead of from plugin code, and the existing
  precedence rung and projector gate keep working as shipped.

## Consequences

- LLP 0152 is **Superseded** by this decision. Its goal (the gateway as
  the capture path, total coverage of every model slot) stands; only
  the steering mechanism changed.
- LLP 0145 (credential borrowing) and LLP 0148 (the wire-parity
  mirror) are **mooted**: the real provider's own credentials and
  header shaping apply natively, so there is nothing to borrow or
  mirror. Both decisions are marked Superseded with forward refs here.
- LLP 0144's shape and canonical-vendor analysis carries over unchanged
  as the rationale for which providers get overridden; the shadow
  provider ids themselves cease to exist.
- Coverage of providers beyond the two canonical vendors is the
  transcript sweep's job (LLP 0170), not this lane's.

## References

- LLP 0167#override-entries, #motivation, #verify-results,
  #deletion-inventory
- LLP 0171 (the implementable requirements)
