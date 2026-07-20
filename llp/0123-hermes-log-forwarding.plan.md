# LLP 0123: hermes log forwarding - implementation plan

**Type:** Plan
**Status:** Draft
**Systems:** Sources, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0122, LLP 0118, LLP 0119, LLP 0120, LLP 0121, LLP 0124, LLP 0125

> Implementation steps for the `@hypaware/hermes` adapter designed in
> [LLP 0122](./0122-hermes-log-forwarding.design.md). Small,
> independently-mergeable tasks: reader and projector first (pure, heavily
> unit-tested), then backfill and source in parallel, then wiring and a
> hermetic smoke. Nothing touches the gateway, the cache schema, or the
> export driver.

## Pre-task gate

The Node floor is settled by
[LLP 0125](./0125-node-engines-floor-22.decision.md): T1 carries the
repo-wide `engines` bump to `>=22.12` and pins CI to a `setup-node` matrix
of Node 22 and 24, so `node:sqlite` is guaranteed present for every later
task's tests.

## Tasks

- id: T1  branch: task/hermes-log-forwarding/T1  deps: []          -- Engines + reader. Repo-wide `engines` bump to `>=22.12` and CI `setup-node` matrix (22, 24) (`@ref LLP 0125 [implements]`). Reader module `plugins-workspace/hermes/src/state_db.js` (`@ref LLP 0119 [implements]`, `@ref LLP 0122#sqlite [implements]`): read-only `node:sqlite` open with activation probe (absent builtin -> clear refusal message, never a crash), bounded SQLITE_BUSY retry, queries for sessions, messages-by-session, and the changed-session aggregate (`max(messages.id)` advanced or `ended_at` newly set vs watermark, LLP 0122#watermark). Plus `src/types.d.ts` (`HermesSessionRow`, `HermesMessageRow`, watermark shapes). Test fixture: a small generated `state.db` built by the test suite itself via `node:sqlite` mirroring the hermes schema (sessions + messages incl. tool calls, reasoning, NULL cwd). Traditional tests: readonly open, busy retry, changed-session detection, missing-file probe.
- id: T2  branch: task/hermes-log-forwarding/T2  deps: [T1]        -- Projector `src/projector.js` (`@ref LLP 0120 [implements]`, `@ref LLP 0122#projection [implements]`): full-session projection to `AiGatewayProjectedExchange` via `projectedExchangeItem`, deterministic `message_id`/`part_id` from (session id, message id, part index), `session_id = hermes-<id>` namespacing, provider normalization from billing fields, LLP 0035 usage mapping, tool-call/reasoning part expansion, `deriveRepoFromCwd` enrichment, hermes extras into `attributes`, channel-session scope stamping `cwd = ~/.hermes/channels/<source>` with real daemon cwd in `attributes` (`@ref LLP 0124 [implements]`, spec R10). Usage-policy skip via the shared resolver over the effective scope before projecting (`@ref LLP 0050 [implements]`, spec R3). Synthetic session-end part once `ended_at` is set: stable `part_id` from (session id, `session_end`), carrying `end_reason`, final totals, costs (`@ref LLP 0122#session-end-part [implements]`). Tests: golden projection of the T1 fixture, id determinism across re-runs (spec R2), ignored-cwd session skipped, channel session stamped + governed by a marked channel scope, NULL-cwd interactive session recorded, end part present exactly once for an ended session and absent for an open one.
- id: T3  branch: task/hermes-log-forwarding/T3  deps: [T2]        -- Backfill provider `src/backfill.js` (`@ref LLP 0122#backfill [implements]`): `ctx.backfills.register` contribution, `--since` windowing via `resolveWindow`/`filterByWindow`, one item per session, provenance carrying the state.db path. Tests: window filtering, empty-store no-op, provenance shape.
- id: T4  branch: task/hermes-log-forwarding/T4  deps: [T2]        -- Poll source `src/source.js` (`@ref LLP 0122#watermark [implements]`, `#source`): `startHermesSource` with missing-store idle mode (spec R9), watermark persistence in plugin kernel storage (per-session `{ max_message_id, ended_at }`), changed-sessions-only re-projection per tick incl. the `ended_at` transition trigger, `status()`/`reload()`/`stop()`, spans + structured logs per spec R7. Tests: idle probe, watermark advance, dedupe-reliant re-projection writes only the new tail (fake storage capturing appendRows), session ending with no new messages still triggers re-projection and lands the end part, stop closes cleanly.
- id: T5  branch: task/hermes-log-forwarding/T5  deps: [T3, T4]    -- Wiring: `hypaware.plugin.json` (`requires.plugins: ["@hypaware/ai-gateway"]`, contributes `config_sections`/`sources`, no datasets, `@ref LLP 0121 [implements]`), `src/config.js` `[hermes]` section validation (`state_db`, `poll_interval`, `enabled`), `src/index.js` `activate()` registering section + source + backfill, bundle/workspace registration beside claude/codex. Tests: manifest validation, config defaults and overrides.
- id: T6  branch: task/hermes-log-forwarding/T6  deps: [T5]        -- Hermetic smoke `hypaware-core/smoke/flows/hermes_backfill_roundtrip.js`: generate a fixture state.db in the temp HYP_HOME, run `hyp backfill hermes`, assert `ai_gateway_messages` rows land with `client_name = 'hermes'`, deterministic ids on a second run (zero new rows), an ignored-cwd session absent, and the internal telemetry (`component: 'hermes'` span with rows-appended count) present. Stable `DEV_RUN_ID`/`smoke_name`/`smoke_step`; register in the smoke flow index.

## Notes

- T3 and T4 are independent after T2 and can run in parallel; T5 merges the
  surfaces; T6 closes the loop end-to-end.
- The LLP cluster (0118-0123) rides the first implementation PR; status flips
  (Draft -> Accepted -> Active) stay author-owned and are not tasks.
- No task modifies `@hypaware/ai-gateway`, the cache schema, settlement, or
  any sink: the adapter is purely additive at the plugin seam.
