# LLP 0571: Goose session capture, implementation plan

**Type:** plan
**Status:** Draft
**Systems:** Sources, Plugins
**Author:** HypForge
**Date:** 2026-11-02
**Related:** LLP 0570, LLP 0122, LLP 0123, LLP 0449, LLP 0527, LLP 0403, LLP 0549
**Generated-by:** neutral

> [LLP 0570](./0570-goose-session-capture.design.md) is the technical design
> for a `@hypaware/goose` client adapter: a read-only poll and bounded
> backfill of Goose's own `sessions.db`, projected into `ai_gateway_messages`
> and reconciled per session because Goose rewrites stored history. This plan
> splits that design into tasks that each land on their own, with a test that
> proves the task and nothing more. It follows the hermes plan (LLP 0123),
> whose file and test layout the tasks copy.

## How this refines the design {#refinement}

The design settles the reader, projection, reconciliation, source, backfill,
privacy and status. This plan adds what only the tree shows:

- **Core edits are three lists, not a new seam.** Picker detection is the
  manifest `detect` block plus a `'goose'` entry in `INIT_SOURCE_CHOICES`
  (`src/core/commands/init.js`) and the `PickerSource` union
  (`src/core/cli/types.d.ts`), held together by
  `test/core/init-source-choices.test.js`. Goose has no client contribution,
  so it joins neither `INIT_CLIENT_CHOICES` nor the `--client` type, as
  hermes does not. Bundling is one line in `src/core/runtime/bundled.js`.
- **Product telemetry is untouched.** The adapter lists in
  `src/core/product_telemetry/{contract,collection,client}.js` name only six
  adapters; copilot, pi and droid already report as `other`, and Goose does
  too. Leaving `contract.js` alone keeps the change outside the server-suite
  gate. Adding a `goose` adapter label is a separate decision, not this plan.
- **No consented skills.** `CONSENTED_SKILLS` in
  `src/core/runtime/client_assets.js` stays hermes-only. Goose gets no
  client or skills contribution in V1 (LLP 0570 `#manifest`).
- **Smokes are discovered from `hypaware-core/smoke/flows/`**, so the new
  flow needs no registry edit.

## Sequencing {#sequencing}

T1 lands the plugin with a source that starts and does nothing, so every
later task is a behavior change behind an existing switch. T2 (picker) and
T3 (reader and projector) depend only on T1 and can land in either order.
T4 (source with reconciliation and exclusions) and T5 (backfill) both build
on T3; T5 reuses T4's watermark and admission helpers, so it waits for T4.
T6 (status) reads the health T4 reports. T7 (smoke) needs T4 and T5. T8
(docs) can be written alongside but lands after T7, so every command it shows
has run. T9 and T10 are validation on the packaged candidate, Linux sandbox
then Mac.

## Rating complexity: the hard parts, by name {#complexity}

- **Tiered detection (T4, complexity 4).** The index-only aggregate must stay
  index-only. The test builds a many-session fixture and asserts the tick
  reads no `content_json` on an unchanged session; if `EXPLAIN QUERY PLAN`
  shows a payload scan, the tick falls back to the LLP 0449 full digest and
  the PR says so (LLP 0570 `#reconciliation`).
- **Deterministic part ids under rewrite (T3, complexity 3).** The
  occurrence number per `message_id` has to survive `replace_conversation`
  re-inserting rows with new `id`s, and a null `message_id` must reconcile
  away, not duplicate.
- **Session exclusions on the poll (T4).** Copilot's admission check runs
  only on ticks with changed sessions, fails closed on a load error, and
  leaves the watermark entry unadvanced so `session unignore` recovers the
  session.
- **Read-commit guard (T4, T5).** One read transaction per session, and the
  watermark flushes only after the batch commits.

## Out of scope {#out-of-scope}

- A client or skills contribution for Goose. It would touch
  `hypaware-core/skills/` and `CONSENTED_SKILLS`, and needs its own ask.
- Sessions stored as `.jsonl` before Goose v1.10.0, and Goose Desktop-only
  paths.
- A `GOOSE_PATH_ROOT` resolver in the picker. Detection checks the default
  path; the config `sessions_db` key and the reader honor the override.
- The OTLP lane (protobuf only, no content) and any gateway lane.
- A `goose` product-telemetry adapter label (see #refinement).
- The upstream-watch registration. It is a Close item outside this repo.

## Tasks

- id: T1  branch: codex/goose-session-capture/T1  deps: []        complexity: 2  -- hypaware-core/plugins-workspace/goose/{hypaware.plugin.json,src/index.js,src/config.js,src/errors.js,src/types.d.ts}: manifest copied from hermes per LLP 0570#manifest (schema_version 1, hypaware_api ^1.0.0, node >=22.12, permissions read_home/read_state/write_state, requires @hypaware/ai-gateway ^2.0.0, picker `detect.settings_file` `.local/share/goose/sessions/sessions.db`, no client or skills contribution). `config.js` resolves `[goose] enabled, sessions_db, poll_interval` per LLP 0570#config, `~` expanded at resolve time, path order `sessions_db`, then `$GOOSE_PATH_ROOT/data/sessions/sessions.db`, then the platform default. `index.js` registers a source that starts and reports `ready` with zero rows. One line in src/core/runtime/bundled.js. Test: test/plugins/goose-manifest.test.js (manifest validates, bundled, no client contribution) and test/plugins/goose-config.test.js (defaults, override order, `~` expansion, relative `GOOSE_PATH_ROOT` ignored, bad `poll_interval` refused); `npm pack --dry-run` lists the plugin files.
- id: T2  branch: codex/goose-session-capture/T2  deps: [T1]      complexity: 1  -- src/core/commands/init.js `INIT_SOURCE_CHOICES` and src/core/cli/types.d.ts `PickerSource` gain `'goose'`, beside `'hermes'`. Not added to `INIT_CLIENT_CHOICES`. Test: test/core/init-source-choices.test.js holds the list against the catalog with Goose present; a new case in the same file checks the picker pre-checks Goose when the fixture HOME has `.local/share/goose/sessions/sessions.db` and does not when it is absent, and that detection opens no database.
- id: T3  branch: codex/goose-session-capture/T3  deps: [T1]      complexity: 3  -- hypaware-core/plugins-workspace/goose/src/{sessions_db.js,projector.js,git_repo.js}: `sessions_db.js` opens `node:sqlite` `DatabaseSync` read-only, never writes or checkpoints, retries `SQLITE_BUSY`/`SQLITE_LOCKED` 5 times 20 ms apart then fails with `sqlite_busy`, checks `schema_version` and required columns (`schema_unsupported` names the column), and skips `hidden` sessions in the query (D1). `projector.js` follows LLP 0570#projection: `turnContext` and non-user-visible items skipped, deterministic `part_id` from `message_id` + occurrence + content index with the `id` fallback, tool call and result parts, usage from `metadata_json.usage`, provider/model fallback, `entrypoint` `goose-<session_type>`, `sub_agent` linked by `parent_session_id` (D2), titles as content (D3). `git_repo.js` reuses the hermes helper shape. Test: test/plugins/goose-sessions-db.test.js (fixture db built with `node:sqlite` from probe schema v17: read-only open, busy retry bound, missing column error, hidden skipped) and test/plugins/goose-projector.test.js (each message shape, a `replace_conversation` rewrite yields the same part ids, a null `message_id` row, usage-policy skip).
- id: T4  branch: codex/goose-session-capture/T4  deps: [T3]      complexity: 4  -- hypaware-core/plugins-workspace/goose/src/{watermark.js,source.js}: watermark sidecar in `ctx.paths.stateDir` with `data_version` and per-session `{updated_at, max_id, row_count, digest}`; tick follows the four tiers of LLP 0570#reconciliation, commits through `reconcileRowsBatch` with scope `client_name = goose AND session_id`, under the LLP 0527 budget (64 sessions, 4096 rows), flushes the watermark once after commit, schedules a catch-up tick while sessions are pending, defers a session whose scope guard is held. Session exclusions per LLP 0570#privacy: load the `SessionIgnoreSet` at activation, Copilot's directory-signature then per-marker admission check only on ticks with changed sessions, fail closed on a load error, excluded session's entry not advanced. Test: test/plugins/goose-source.test.js (idle tick does one `data_version` read, append, rewrite, truncation, ignore-policy removal by empty snapshot), test/plugins/goose-batched-reconcile.test.js (budget caps, catch-up tick, many-session fixture shows unchanged sessions are not hashed), test/plugins/goose-read-commit-guard.test.js (failed commit leaves the watermark unchanged), and a session-exclusion admission case (ignored session not projected, unignore recovers it, load error projects nothing).
- id: T5  branch: codex/goose-session-capture/T5  deps: [T4]      complexity: 2  -- hypaware-core/plugins-workspace/goose/src/backfill.js: provider reusing the T3 reader and projector and T4's watermark and admission helpers; honors `backfill.window_days` for the join-time import and the scheduled sweep (LLP 0359#sweep-context) by `updated_at`; the sweep digests every session in the window to catch in-place edits; refreshes the ignore set at the start of each run; waits a bounded time on a held scope guard then fails that session with `cache_partition_mutation_busy`. Test: test/plugins/goose-backfill.test.js (window bound, repeat run reconciles without appending, in-place `content_json` edit picked up by the sweep, busy guard error).
- id: T6  branch: codex/goose-session-capture/T6  deps: [T4]      complexity: 2  -- hypaware-core/plugins-workspace/goose/src/source.js status: source health per LLP 0570#status for database missing, ready with no traffic, recording, busy (`sqlite_busy`), unsupported schema (`schema_unsupported`) and disabled; each tick logs `goose.poll` with `component`, `operation`, `status`, `sessions_changed`, `sessions_pending`, `rows`, `error_kind`, and never message text, titles or `working_dir` paths. Test: status cases added to test/plugins/goose-source.test.js, one per state, plus a log-line assertion that no fixture marker or path appears.
- id: T7  branch: codex/goose-session-capture/T7  deps: [T4, T5]  complexity: 3  -- hypaware-core/smoke/flows/goose_capture.js, modeled on hermes_backfill_roundtrip.js: boots `@hypaware/ai-gateway` + `@hypaware/goose` in a temp HYP_HOME with a fixture `sessions.db` under the fake HOME; runs the poll and `hyp backfill goose`; asserts the marker turn (user text, assistant text, tool call and result, usage) via SQL and `hyp query grep`, a rewritten session without duplicates, an idempotent rerun, a hidden session absent, a `.hypignore`d `working_dir` absent, and the `goose.poll` telemetry with a stable `DEV_RUN_ID`, `smoke_name` and `smoke_step`. Test: `npm run smoke -- goose_capture` green, and `source_optout_export_withhold` still green.
- id: T8  branch: codex/goose-session-capture/T8  deps: [T7]      complexity: 2  -- docs/integrations/goose.md (what is recorded, setup, history import, limits, the `llm_request.*.jsonl` disclosure, pre-1.10 and Desktop-only out of scope) modeled on docs/integrations/hermes.md; a row in the docs/INTEGRATIONS.md "Coding agents" table; README client list; docs/CLIENTS.md entry; docs/PRIVACY.md client table plus Goose in the session-exclusion lists (not in the "do not support this session control" sentence); docs/TROUBLESHOOTING.md missing-database, busy and schema entries and the sweep-cadence latency for in-place edits. No edits under hypaware-core/skills/. Test: every command in the new text run in the T9 sandbox; `npm test` (doc drift guards) green.
- id: T9  branch: codex/goose-session-capture/T9  deps: [T8]      complexity: 2  -- Validation, no code: `npm pack`, then `scripts/sandbox/hyp-sandbox` installs the tarball, runs `hyp init` with Goose picked, a real Goose v1.57.0 turn against the labeled loopback fixture, SQL readback, daemon restart, disable and re-enable, and `hyp status`; the receipt records the candidate sha256 and labels the run as loopback. Test: the receipt in the mission folder and the coverage rows it settles on Linux.
- id: T10 branch: codex/goose-session-capture/T10 deps: [T9]      complexity: 2  -- Mac Part B through the operator relay (MAC-JOB-goose.md Part B): a pinned, reviewed script runs the same packaged candidate on compat@macmini-new under a disposable HYP_HOME and HOME. Results are marked operator-run. Test: evidence copied back with a verifying SHA256SUMS, and the Mac column of every coverage row filled from it.
