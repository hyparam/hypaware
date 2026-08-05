# LLP 0194: Rows carry their own turn's provider, not the exchange's first

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway
**Author:** Brendan / Claude
**Date:** 2026-08-05
**Related:** LLP 0026, LLP 0035, LLP 0158, LLP 0193; issue #640

> `AiGatewayProjectedMessage` gains an optional per-message `provider`, and
> the gateway's row builder prefers it over the exchange-level value, the
> same precedence `model` has carried since LLP 0026. The OpenClaw backfill
> stamps it on every row from the turn's smeared effective backend, so a
> mixed-provider session stops reading as its first projected turn's vendor.

## Context {#context}

A backfilled OpenClaw exchange is a whole session, and an OpenClaw session
can switch models, and with them providers, mid-stream (the motivating
session mixed `openai`, `claude-cli`, and `ollama` turns; issue #640). The
projected exchange carries one `provider`, filled first-projected-turn-wins,
and the row builder stamped that single value onto every row. The session
file itself records `provider` per assistant record at full fidelity
(LLP 0158's reader surfaces it), so the flattening was purely a projection
artifact: after LLP 0193 landed the ollama turns, their rows read
`provider = 'openai'` while `model = 'gemma4:12b'`, folding ollama usage
into openai in every provider-keyed breakdown. The defect was documented in
a code comment ("only the `provider` column of the minority turns reads as
the majority's") but had no LLP; this is that record.

`model` solved the identical problem in LLP 0026: the transcript records the
per-line model on assistant messages, the per-message value wins where
present, and mixed-model sessions stay accurate. `provider` was the column
that precedence skipped.

## Decision {#decision}

- `AiGatewayProjectedMessage.provider?: string` joins the kernel contract.
- The gateway row builder resolves each row's provider as
  `message.provider ?? projection.provider`, mirroring `model`'s precedence
  exactly. Projectors that do not set the field are byte-for-byte unchanged,
  which covers every live projector: live capture is one request to one
  provider per exchange, where the exchange value is already exact.
- The OpenClaw backfill stamps `provider` on **every** row it projects, from
  the turn's smeared effective backend (the `partitionByBackend` resolution
  of LLP 0193), prompts and tool results included. This deliberately differs
  from `model`'s assistant-only convention: `provider` is non-nullable per
  row, so an unstamped minority-turn prompt would fall back to the exchange
  value and misattribute, which is the exact defect being fixed, while an
  unstamped user row's `model` is honestly null. The smeared backend is the
  same attribution the exclusion decision already trusts to keep CLI-turn
  prompts out.
- The exchange-level `provider` keeps its first-projected-turn value as the
  fallback for exchange-level consumers. Nothing else moves: `part_id`
  involves no provider, so identity, dedupe, and settlement are unaffected.

## Consequences {#consequences}

- Provider-keyed queries and token breakdowns attribute mixed sessions
  correctly from the next import onward.
- Already-imported rows keep the flattened value: backfill dedupe skips
  existing `part_id`s, so history upgrades only by purge-and-reimport, which
  this decision does not require. Accepted as-is; the affected population is
  rows imported in the LLP 0193-to-0194 window.
- The kernel contract change is additive; no projector or materializer
  outside the OpenClaw backfill needs to change.

## References

- LLP 0026 (per-message model precedence, the precedent)
- LLP 0158 (the reader that surfaces per-record `provider`)
- LLP 0193 (smeared effective backend; the change that surfaced this)
- Issue #640
