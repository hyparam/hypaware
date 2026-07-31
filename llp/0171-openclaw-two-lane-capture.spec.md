# LLP 0171: OpenClaw two-lane capture

**Type:** Spec
**Status:** Accepted
**Systems:** Plugins, Gateway, Config, Sources
**Author:** Phil / Claude
**Date:** 2026-07-31
**Related:** LLP 0167 (the accepted RFC), LLP 0168, LLP 0169, LLP 0170 (the decisions this spec makes implementable), LLP 0157 (the prior spec; R8, R9, R10, R11, R14 remain binding), LLP 0163, LLP 0044, LLP 0045

> Requirements for implementing LLP 0168 (config override), LLP 0169
> (attach surface), and LLP 0170 (scheduled sweep), replacing the dead
> half of LLP 0157. The decisions are settled and cited, not restated.
> One deliverable set: the reworked `@hypaware/openclaw` adapter
> (attach/detach module, sweep schedule), the core `json_path` revival,
> the steering-plugin deletion, and the acceptance and onboarding
> rewrites.

## Carried-over requirements {#carried-over}

LLP 0157's R8 (projector shapes behind the header gate), R9 (the one
LLP 0158 reader), R10 (backfill policy gate and CLI-backend exclusion),
R11 (identity-identical routes deduping to zero), and R14 (settlement
resolves cwd and applies the policy drop) remain binding, unchanged.
LLP 0157's R1 through R6 are void with the steering plugin, R7 is
reversed by R5 below, R12 is replaced by R11 below, and R13 is retired
(LLP 0170: no ledger).

## Requirements {#requirements}

- **R1.** Attach MUST write exactly the two `models.providers` entries
  of LLP 0167#override-entries: `anthropic` at the gateway bare origin,
  `openai` at the gateway origin plus `/v1`, each with the static
  `x-hypaware-upstream` header and `models: []`, the port resolved from
  the active gateway config. It MUST NOT write anything else into
  `openclaw.json`.
- **R2.** Attach MUST refuse, with an explanation, when
  `models.providers.anthropic` or `models.providers.openai` already
  exists. A refusal during attach-on-join MUST surface as a warning and
  MUST NOT fail the join (LLP 0169).
- **R3.** Detach MUST delete an entry only when its `baseUrl` is the
  gateway's, MUST back up rather than discard a present-but-unexpected
  or mangled entry (LLP 0163), and MUST delete the written provider
  keys from every `agents/<id>/agent/models.json` (LLP 0169: the caches
  do not self-heal and stay live for routing).
- **R4.** Attach and detach MUST end by printing the
  `openclaw gateway restart` instruction (LLP 0169: a running gateway
  does not apply `models.providers` changes).
- **R5.** The manifest MUST register `attach_probe` in the `json_path`
  format keyed on the marker header, and core MUST restore the
  `json_path` branches in `src/core/config/client_detach_disk.js` and
  `src/core/daemon/status.js`, so `hyp detach` and `hyp status` work
  through the standard disk-driven contract (LLP 0045, fixing the
  OpenClaw half of #544).
- **R6.** The plugin MUST register the runtime clients adapter so
  attach-on-join covers OpenClaw with the same `attach.on_join`
  semantics as Claude and Codex (LLP 0044, LLP 0169).
- **R7.** The daemon MUST run the OpenClaw backfill provider on a
  schedule, default every 5 minutes, tunable in the plugin's `backfill`
  config section, and the sweep MUST skip session files whose mtime is
  inside the quiesce window (LLP 0170). A sweep over already-captured
  turns MUST net zero writes.
- **R8.** The sweep MUST NOT ship before the issue #543 envelope fix
  is merged; without it the reader projects nothing and the lane is
  silently empty.
- **R9.** The `openclaw-steering-plugin/` package and
  `test/plugins/openclaw-steering-plugin.test.js` MUST be deleted in
  the same change set; nothing may import from either afterward
  (LLP 0167#deletion-inventory).
- **R10.** The gateway, the exchange projector, settlement, match key,
  reader, and backfill projection MUST be unchanged by this change set;
  the projector's gate keeps reading `x-hypaware-upstream`, now
  config-sourced (LLP 0168).
- **R11.** `docs/ACCEPTANCE.md` `openclaw_capture` MUST be rewritten
  per LLP 0167#deletion-inventory: attach-flow steps, a sweep step in
  which a turn on a non-overridden provider lands within the interval,
  a zero-duplicate assertion for a turn both lanes captured, and
  re-confirmation of verify items 1, 3, and 4 on a binary at or above
  the 2026.4.24 floor. A human MUST run it before the adapter ships.
- **R12.** The picker line items MUST carry the LLP 0167#onboarding
  copy: Claude's names the OpenClaw `claude-cli/<model>` case
  explicitly; OpenClaw's states the two capture tiers.

## Non-goals {#non-goals}

Per LLP 0167#future: overrides beyond the two canonical vendors, an
`fs.watch` live tail, the trajectory-file and probe-session streams,
a refuse-instead-of-capture mode, and OpenClaw-to-child-CLI session
correlation.

## References

- LLP 0167 (rationale and verified facts), LLP 0168, LLP 0169, LLP 0170
- LLP 0157 (carried-over requirements), issue #543 (prerequisite fix)
- `docs/ACCEPTANCE.md`
