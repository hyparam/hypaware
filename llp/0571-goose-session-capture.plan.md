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

T1 lands the plugin with a source that starts and does nothing, and with no
picker contribution, so every later task is a behavior change behind an
existing switch and `test/core/init-source-choices.test.js` stays green. T2
adds the manifest `picker` block together with the two lists that test holds
it to, so the picker never offers Goose before T2. T2 (picker) and
T3 (reader and projector) depend only on T1 and can land in either order.
T4 (source with reconciliation and exclusions) and T5 (backfill) both build
on T3; T5 reuses T4's watermark and admission helpers, so it waits for T4.
T6 (status) reads the health T4 reports. T7 (smoke) needs T4, T5 and T6,
because it asserts the `goose.poll` telemetry T6 adds. T8
(docs) can be written alongside but lands after T7, so every command it shows
has run. T9 and T10 are validation on the packaged candidate, Linux sandbox
then Mac.

## Rating complexity: the hard parts, by name {#complexity}

- **Range-read detection (T4, complexity 4).** The two range reads of LLP
  0570 `#reconciliation` must search, not scan. The test builds a fixture with
  many sessions and many messages, asserts `EXPLAIN QUERY PLAN` shows a
  `SEARCH` on the integer primary key and on the `updated_at` index, and
  asserts an unchanged session is not hashed. If either read scans, Build
  stops and returns to design review. The cursor advance under a partial
  budget is the subtle part: a session not admitted must hold `cursor_id`
  below its first new `id`.
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
- Sessions stored as `.jsonl` before Goose v1.10.0, Goose Desktop-only
  paths, and the older macOS `~/Library/Application Support/Block/goose/`
  location. Mac Part A observed the Linux default on macOS, so the resolver
  has one default; a user with a database at the older location sets
  `sessions_db` (LLP 0570 `#config`).
- A `GOOSE_PATH_ROOT` resolver in the picker. Detection checks the default
  path; the config `sessions_db` key and the reader honor the override.
- The OTLP lane (protobuf only, no content) and any gateway lane.
- A `goose` product-telemetry adapter label (see #refinement).
- The upstream-watch registration (coverage row 2). Close owns it; it is
  outside this repo, so no task here carries it.

## Tasks

- id: T1  branch: codex/goose-session-capture/T1  deps: []        complexity: 2  -- hypaware-core/plugins-workspace/goose/{hypaware.plugin.json,src/index.js,src/config.js,src/errors.js,src/types.d.ts}: manifest copied from hermes per LLP 0570#manifest (schema_version 1, hypaware_api ^1.0.0, node >=22.12, permissions read_home/read_state/write_state, requires @hypaware/ai-gateway ^2.0.0, no `picker` block yet, no client or skills contribution). `config.js` resolves `[goose] enabled, sessions_db, poll_interval` per LLP 0570#config, `~` expanded at resolve time, path order `sessions_db`, then `$GOOSE_PATH_ROOT/data/sessions/sessions.db`, then `~/.local/share/goose/sessions/sessions.db` on both Linux and macOS (Mac Part A). `index.js` registers a source that starts and reports `ready` with zero rows. One line in src/core/runtime/bundled.js. Test: test/plugins/goose-manifest.test.js (manifest validates, bundled, no client contribution) and test/plugins/goose-config.test.js (defaults, the same default path with `process.platform` set to `linux` and `darwin`, override order, an absolute `GOOSE_PATH_ROOT` wins over the default, `~` expansion, relative `GOOSE_PATH_ROOT` ignored, a `sessions_db` that does not exist resolves without error and is reported by the source, bad `poll_interval` refused); `npm pack --dry-run` lists the plugin files.
- id: T2  branch: codex/goose-session-capture/T2  deps: [T1]      complexity: 2  -- The manifest gains its `picker` block (label `Goose`, summary "Records your Goose conversations and imports recent history. Makes no changes to Goose.", `detect.settings_file` `.local/share/goose/sessions/sessions.db`, `compose { plugin { name }, requires_gateway: true }`), and in the same commit src/core/commands/init.js `INIT_SOURCE_CHOICES` and src/core/cli/types.d.ts `PickerSource` gain `'goose'`, beside `'hermes'`. Not added to `INIT_CLIENT_CHOICES`. Test: test/core/init-source-choices.test.js holds the list against the catalog with Goose present; a new case in the same file checks the picker pre-checks Goose when the fixture HOME has `.local/share/goose/sessions/sessions.db` and does not when it is absent, and that detection opens no database. A setup case re-runs `hyp setup --source goose` on a config with `goose.enabled = false` and checks it stays off and the config is byte-identical, and adds Goose to a config that already has another client and checks that client's section is unchanged. The custom `GOOSE_PATH_ROOT` and stale-database cases are n/a here, because the picker checks only the default path (#out-of-scope); they are tested in T1. Done-when: the detect path is the one Mac Part A recorded in `run4-default-paths.txt`, read back from the evidence folder and quoted in the PR.
- id: T3  branch: codex/goose-session-capture/T3  deps: [T1]      complexity: 3  -- hypaware-core/plugins-workspace/goose/src/{sessions_db.js,projector.js,git_repo.js}: `sessions_db.js` opens `node:sqlite` `DatabaseSync` read-only, never writes or checkpoints, retries `SQLITE_BUSY`/`SQLITE_LOCKED` 5 times 20 ms apart then fails with `sqlite_busy`, checks `schema_version` and required columns (`schema_unsupported` names the column), and skips `hidden` sessions in the query (D1). `projector.js` follows LLP 0570#projection: `turnContext` and non-user-visible items skipped, deterministic `part_id` from `message_id` + occurrence + content index with the `id` fallback, tool call and result parts, usage from `metadata_json.usage`, provider/model fallback, `entrypoint` `goose-<session_type>`, `sub_agent` linked by `parent_session_id` (D2), titles as content (D3). `git_repo.js` reuses the hermes helper shape. Test: test/plugins/goose-sessions-db.test.js (fixture db built with `node:sqlite` from probe schema v17: read-only open, busy retry bound, missing column error, hidden skipped) and test/plugins/goose-projector.test.js (each message shape, a `replace_conversation` rewrite yields the same part ids, a null `message_id` row, usage-policy skip).
- id: T4  branch: codex/goose-session-capture/T4  deps: [T3]      complexity: 4  -- hypaware-core/plugins-workspace/goose/src/{watermark.js,source.js}: watermark sidecar in `ctx.paths.stateDir` with `data_version`, `cursor_id`, `cursor_updated_at` and per-session `{updated_at, max_id, digest}`, baselined to the current maxima on first start, pruned by the sweep and capped at 10,000 entries (oldest `updated_at` evicted); tick follows the steps of LLP 0570#reconciliation, admits in first-new-`id` order and advances the cursors per LLP 0570#source, commits through `reconcileRowsBatch` with scope `client_name = goose AND session_id`, under the LLP 0527 budget (64 sessions, 4096 rows), flushes the watermark once after commit, schedules a catch-up tick while sessions are pending, defers a session whose scope guard is held. Session exclusions per LLP 0570#privacy: load the `SessionIgnoreSet` at activation, Copilot's directory-signature then per-marker admission check only on ticks with changed sessions, fail closed on a load error, excluded session's entry not advanced. Test: test/plugins/goose-source.test.js (idle tick does one `data_version` read, append, `replace_conversation` rewrite, visibility-merge upsert, truncation followed by an append, first start does not walk history, ignore-policy removal by empty snapshot), test/plugins/goose-batched-reconcile.test.js (budget caps, catch-up tick, a partial budget holds `cursor_id` below the first unadmitted session and the catch-up tick commits it, a fixture with many sessions and many messages shows unchanged sessions are not hashed and `EXPLAIN QUERY PLAN` of both range reads is a `SEARCH`, the cap evicts the oldest entry and its next change reconciles idempotently), test/plugins/goose-read-commit-guard.test.js (failed commit leaves the watermark unchanged), and a session-exclusion admission case (ignored session not projected, unignore recovers it, load error projects nothing).
- id: T5  branch: codex/goose-session-capture/T5  deps: [T4]      complexity: 2  -- hypaware-core/plugins-workspace/goose/src/backfill.js: provider reusing the T3 reader and projector and T4's watermark and admission helpers; scope per LLP 0570#backfill: non-hidden sessions inside `backfill.window_days` by `updated_at` when set, every non-hidden session when unset, for the join-time import and the scheduled sweep (LLP 0359#sweep-context); the sweep digests every session in scope to catch in-place edits and bare truncations, and prunes watermark entries for deleted or out-of-scope sessions; refreshes the ignore set at the start of each run; waits a bounded time on a held scope guard then fails that session with `cache_partition_mutation_busy`. Test: test/plugins/goose-backfill.test.js (window bound, unset window imports every non-hidden session, repeat run reconciles without appending, in-place `content_json` edit and a bare truncation picked up by the sweep, a deleted session's entry pruned, busy guard error).
- id: T6  branch: codex/goose-session-capture/T6  deps: [T4]      complexity: 2  -- hypaware-core/plugins-workspace/goose/src/source.js status: source health per LLP 0570#status for database missing, ready with no traffic, recording, unreadable (`permission_denied`), busy (`sqlite_busy`), unsupported schema (`schema_unsupported`) and disabled; each tick logs `goose.poll` with `component`, `operation`, `status`, `sessions_changed`, `sessions_pending`, `rows`, `error_kind`, and never message text, titles or `working_dir` paths. messages as in the LLP 0570#status table (the hermes forms). Test: status cases added to test/plugins/goose-source.test.js, one per state, an unreadable case from a fixture database with mode 000, plus a log-line assertion that no fixture marker or path appears.
- id: T7  branch: codex/goose-session-capture/T7  deps: [T4, T5, T6] complexity: 3  -- hypaware-core/smoke/flows/goose_capture.js, modeled on hermes_backfill_roundtrip.js: boots `@hypaware/ai-gateway` + `@hypaware/goose` in a temp HYP_HOME with a fixture `sessions.db` under the fake HOME; runs the poll and `hyp backfill goose`; asserts the marker turn (user text, assistant text, tool call and result, usage) via SQL and `hyp query grep`, a rewritten session without duplicates, the session graph projection grouping the turn under the Goose `sessions.id`, an idempotent rerun, a hidden session absent, a `.hypignore`d `working_dir` absent, and the `goose.poll` telemetry with a stable `DEV_RUN_ID`, `smoke_name` and `smoke_step`. Test: `npm run smoke -- goose_capture` green, and `source_optout_export_withhold` still green.
- id: T8  branch: codex/goose-session-capture/T8  deps: [T7]      complexity: 2  -- docs/integrations/goose.md (what is recorded, setup, history import, limits, the `llm_request.*.jsonl` disclosure, pre-1.10, Desktop-only and the older macOS `Block/goose` location out of scope, and that a `GOOSE_PATH_ROOT` set in a shell is not seen by a daemon under launchd or systemd, so those users set `goose.sessions_db`) modeled on docs/integrations/hermes.md; a row in the docs/INTEGRATIONS.md "Coding agents" table; README client list; docs/CLIENTS.md entry; docs/PRIVACY.md client table plus Goose in the session-exclusion lists (not in the "do not support this session control" sentence); docs/TROUBLESHOOTING.md missing-database, busy and schema entries and the sweep-cadence latency for in-place edits. No edits under hypaware-core/skills/. Test: every command in the new text run in the T9 sandbox; `npm test` (doc drift guards) green.
- id: T9  branch: codex/goose-session-capture/T9  deps: [T8]      complexity: 2  -- Validation, no code: `npm pack`, then `scripts/sandbox/hyp-sandbox` installs the tarball, runs `hyp setup` with Goose picked, a real Goose v1.57.0 turn against the labeled loopback fixture, SQL readback, daemon restart, disable and re-enable, and `hyp status`. Row 5's upgrade case is n/a for this release because the plugin is new and has no earlier version to upgrade from; the receipt says so; the receipt records the candidate sha256 and labels the run as loopback. Test: the receipt in the mission folder and the coverage rows it settles on Linux.
- id: T10 branch: codex/goose-session-capture/T10 deps: [T9]      complexity: 2  -- Mac Part B through the operator relay (MAC-JOB-goose.md Part B): a pinned, reviewed script runs the same packaged candidate on compat@macmini-new under a disposable HYP_HOME and HOME. Results are marked operator-run. Test: evidence copied back with a verifying SHA256SUMS, and the Mac column of every coverage row filled from it.
