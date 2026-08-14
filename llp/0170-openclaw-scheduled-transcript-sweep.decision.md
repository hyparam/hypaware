# LLP 0170: The scheduled transcript sweep

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources
**Author:** Phil / Claude
**Date:** 2026-07-31
**Related:** LLP 0167 (the accepted RFC this decision realizes), LLP 0149 (superseded), LLP 0158 (the one reader), LLP 0159 (route agreement, extended by the quiesce window), LLP 0146 (deferrals, now live-lane-only), LLP 0147 (sibling territory, unchanged), LLP 0171 (requirements)

> The OpenClaw session-file backfill runs on a daemon schedule, every
> 5 minutes by default, so every OpenClaw turn on every provider is
> captured at transcript fidelity without anything installed or
> configured on the OpenClaw side. Overlap with the live gateway lane
> nets to zero writes through settlement plus `part_id` dedupe. "Lane A
> is not recording" becomes a self-healing state, not a detectable one.

## Context

The session JSONL carries everything a row needs, for every provider
identically: native ids, timestamps, full content, and per assistant
message the model, provider, api, stop reason, and usage
(LLP 0157#backfill, re-verified in LLP 0167). Appends are incremental
during the session. The daemon already runs cron-matched periodic work
(the sink driver), and backfill re-runs are no-ops through the existing
dedupe, so the sweep is scheduling an existing job, not building a new
capture lane.

## Decision

- The backfill provider runs on a daemon schedule, **every 5 minutes**
  by default, tunable in the plugin's `backfill` config section.
- **Quiesce window**: the sweep skips session files whose mtime is
  within the settlement flush interval plus margin, so it never imports
  a turn whose live twin has not yet settled to native identity. The
  cost is nothing: a recently-active session is the one the live lane
  is capturing in real time, and on unattached machines there is no
  twin to race.
- The sweep is the completeness lane. It covers unattached machines,
  the restart-pending window, every provider outside the two overridden
  vendors (the LLP 0146 families, ollama, and future providers), and
  pre-attach history, with no mode switch and no detection logic.
- **No escaped-traffic ledger is maintained.** The coverage statement
  is: every OpenClaw turn is captured at least at transcript fidelity
  within the sweep interval; `anthropic/*` and `openai/*` turns are
  additionally captured live at wire fidelity when attached. What each
  lane covers is clear from config inspection. The backfill's
  `excluded_backend` events remain only as the LLP 0147
  sibling-territory boundary marker.

## Consequences

- LLP 0149 is **Superseded**: the pass-through-and-warn behavior was
  steering-plugin code, and the plugin is deleted. Its principle that
  capture must never fail a user's turn carries forward, satisfied
  structurally (nothing runs in OpenClaw's request path at all).
- LLP 0146's deferral list stops describing a coverage hole; it now
  describes only which providers lack the live wire lane. Its
  Consequences line "users on Bedrock or Vertex get no OpenClaw
  capture" no longer holds; they get transcript capture.
- LLP 0159's route-agreement design gains the quiesce window as its
  live-session guard; settlement and the match-key machinery are kept,
  they are the hinge the two lanes dedupe on.
- The sweep depends on the issue #543 envelope fix: until the reader
  reads the nested `message` envelope, the sweep projects nothing.
- An `fs.watch` live tail behind the same LLP 0158 reader remains a
  future latency upgrade (LLP 0167#future), not part of this decision.

## References

- LLP 0167#sweep-lane, #future
- LLP 0171 (the implementable requirements)
- `src/core/sinks/driver.js` (the cron-matched scheduling precedent)
