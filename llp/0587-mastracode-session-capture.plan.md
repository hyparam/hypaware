# LLP 0587: Mastra Code session capture, implementation plan

**Type:** plan
**Status:** Active
**Systems:** Sources, Plugins
**Author:** HypForge
**Date:** 2026-11-05
**Related:** LLP 0586, LLP 0573, LLP 0574, LLP 0570, LLP 0571, LLP 0122, LLP 0123, LLP 0449, LLP 0527, LLP 0403, LLP 0035
**Generated-by:** neutral

> [LLP 0586](./0586-mastracode-session-capture.design.md) is the technical
> design for a `@hypaware/mastracode` client adapter: a read-only, stat-gated
> poll and bounded backfill of Mastra Code's one `mastra.db`, projected into
> `ai_gateway_messages` and reconciled per thread because Mastra Code stores
> a whole multi-step turn in one assistant row. This plan splits that design
> into tasks that each land on their own, with a test that proves the task
> and nothing more. It follows the Crush plan (LLP 0574), whose file and test
> layout the tasks copy, less discovery: there is one database.
>
> Active 2026-11-06: T1-T10 are done; the results are in #validation-results.
> G-DOC and G-UW run at Close.

## How this refines the design {#refinement}

The design settles the reader, projection, reconciliation, source, backfill,
privacy and status. This plan adds what only the tree shows:

- **Core edits are three lists, not a new seam**, as for goose and crush.
  Picker detection is the manifest `detect` block plus a `'mastracode'` entry
  in `INIT_SOURCE_CHOICES` (`src/core/commands/init.js`) and the
  `PickerSource` union (`src/core/cli/types.d.ts`), held together by
  `test/core/init-source-choices.test.js`. Mastra Code has no client
  contribution, so it joins neither `INIT_CLIENT_CHOICES` nor the `--client`
  type. Bundling is one line in `src/core/runtime/bundled.js`.
- **Product telemetry is untouched.** Mastra Code reports as `other`, as goose
  and crush do. `src/core/product_telemetry/contract.js` is not edited, which
  keeps the change outside the server-suite gate. A `mastracode` adapter
  label is a separate decision.
- **No consented skills.** `CONSENTED_SKILLS` in
  `src/core/runtime/client_assets.js` is not edited, and nothing under
  `hypaware-core/skills/` changes (LLP 0586 `#manifest`).
- **Reuse, not shared code.** `git_repo.js` and the busy-retry helpers are
  copied from goose with a note. Hoisting them into core is a refactor
  outside this plan.
- **Smokes are discovered from `hypaware-core/smoke/flows/`**, so the new
  flow needs no registry edit.
- **The fixture database is built from the probe's `schema.sql`** for the two
  tables the reader names, with the indexes T3 reads from the pinned
  `@mastra/libsql` 1.29.0 source, and JSONB `metadata` written with
  `jsonb()`. The probe did not record indexes (LLP 0586 `#open-questions`),
  so T3 quotes the index DDL it found, with its source path, in the PR.

## Sequencing {#sequencing}

T1 lands the plugin with config and a source that starts and does nothing,
and with no picker contribution, so `test/core/init-source-choices.test.js`
stays green and every later task is a behavior change behind an existing
switch. T2 adds the manifest `picker` block with the two lists that test
holds it to, and waits on gate G-A (Mac Part A) for the macOS default path.
T3 (reader, projector and the usage proof) depends only on T1; T2 (picker)
depends on T1 and G-A; they can land in either order. T4 (source with the stat gate, reconciliation
and exclusions) builds on T3. T5 (backfill) reuses T4's watermark and
admission helpers, so it waits for T4. T6 (status) reads the health T4
reports. T7 (smoke) needs T4, T5 and T6, because it asserts the
`mastracode.poll` telemetry T6 adds. T8 (docs) can be written alongside but
lands after T7, so every command it shows has run. T9 and T10 are validation
on the packaged candidate, Linux sandbox then Mac. Three gate rows sit
outside the repo's branches: G-A before T2, and G-DOC and G-UW at Close
(#tasks).

## Rating complexity: the hard parts, by name {#complexity}

- **The usage proof (T3, complexity 4).** LLP 0586 D4 ships no LLP 0035
  usage unless T3 shows, from the pinned `@mastra/core` 1.82.0 source and the
  probe samples, that `tokenUsage` is written once per turn in the same
  transaction as that turn's assistant row and starts from zero for it. The
  PR quotes the source lines and the a2/a3 sample values either way. If the
  proof fails, T3 ships the `attributes.mastracode.process_token_usage`
  attribute (the latest process's counter, not a thread total) and no usage fields, and the guardian's Q5 answer is recorded in
  the PR. If it holds, T3 ships the mapping in LLP 0586 `#open-questions`
  and LLP 0586 is amended first.
- **The `EXPLAIN QUERY PLAN` gate (T3 and T4).** The `mastra_messages` rowid
  range read and the per-thread count-and-max read must be a `SEARCH`; the
  `mastra_threads` read is an accepted scan. The probe recorded no index, so
  if the pinned `@mastra/libsql` creates no index on `thread_id`, or either
  required read scans, Build stops and returns to design review.
- **Rewrites that add no row (T4, complexity 4).** LLP 0586
  `#reconciliation` replaces goose's `data_version` with a stat signature
  and adds the open-thread rule: a thread whose digest changed stays a
  candidate on every changed-database tick until a hash finds it unchanged,
  and is never pending. The per-database `floor` keeps old, out-of-window,
  pruned and evicted threads from being hashed by the poll. Each rule needs a
  fixture that reproduces it: an assistant row rewritten in place with the
  same `rowid` and no `updatedAt` bump, and one deleted and re-inserted.
- **The stat gate on a real WAL (T4).** The test commits through a separate
  writer connection, including after a checkpoint and WAL reset, and asserts
  the signature moves each time. If it does not, T4 takes the design's
  fallback (a `data_version` read on a short-lived connection) and says so in
  the PR. The tests start both with and without a `-wal`, record the
  signature after the reader closes, and cover the race where a commit lands
  during the read.
- **JSONB and the SQLite minimum (T3).** `metadata` reads only through
  `json(metadata)` on SQLite 3.45 or newer. The reader checks
  `sqlite_version()` on open and reports `sqlite_unsupported` below it; the
  test stubs the version check, because CI's node bundles a newer SQLite.
- **Read-commit guard (T4, T5).** One read transaction per thread, and the
  watermark flushes only after the batch commits.

## Out of scope {#out-of-scope}

- The gateway lane (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`), a follow-up
  (LLP 0586 D2).
- Remote Turso and Postgres stores (`MASTRA_DB_URL`); reported as
  `remote_store_unsupported` and documented (D8).
- A client or skills contribution for Mastra Code. It would touch
  `hypaware-core/skills/` and `CONSENTED_SKILLS`, and needs its own ask.
- Writing any Mastra Code file, including `settings.json` to turn off
  PostHog (D3).
- Reading any table other than `mastra_threads` and `mastra_messages`, or
  `settings.json`, `auth.json`, `mastra-vectors.db` or the observability
  store (D7).
- Per-turn usage unless T3's proof holds (D4).
- A `mastracode` product-telemetry adapter label (see #refinement).
- Code for the upstream-watch registration (coverage row 2) and the
  `mastracode-part-a` Mac recipe. Both live outside this repo; gate rows G-A
  and G-UW (#tasks) own them, with an owner, evidence path and done-when
  each.

## Coverage {#coverage}

Carried from the mission `COVERAGE.md` and LLP 0586 `#coverage-map`. The
Linux and Mac columns are filled at T9 and T10.

| Row | Seam | Task | Linux | Mac |
| --- | --- | --- | --- | --- |
| 1 Product | pinned version and identity assumption (D1) | T8, T9 | probe 0.49.0 | G-A |
| 2 Upstream watch | `mastracode` entry in `targets.json` | G-UW | n/a | n/a |
| 3 Detection | manifest `detect`, picker lists, path resolution | T1, T2 | T9 | G-A, T10 |
| 4 Onboarding | picker and `hyp setup` configure phase | T2, T7 | T9 | T10 |
| 5 Lifecycle | `enabled`, read-only reader, no writes (D3) | T1, T3 | T9 | T10 |
| 6 Collection | reader, projector, reconciliation | T3, T4 | T9 | T10 |
| 7 History | backfill, window, sweep, restart | T5 | T9 | T10 |
| 8 Privacy | policy, exclusions, local-only, D6 drop, D7 guard, titles | T3, T4, T7 | T9 | T10 |
| 9 Query | `ai_gateway_messages` rows, session graph | T7 | T9 | T10 |
| 10 Status | source health per LLP 0586 `#status` | T6 | T9 | T10 |
| 11 Cost | stat gate, rowid range read, budget, cap, `EXPLAIN` | T3, T4 | fixture | T10 gate check |
| 12 Docs | integration page and disclosures (D8) | T8 | T9 | n/a |
| 13 Packaging | bundled list, `npm pack` | T1, T9 | T9 | T10 |

## Tasks

Gate rows carry no branch: they are mission rows outside this repo, each with
an owner, an evidence path in the mission folder and a done-when.

- id: G-A   branch: none  deps: []        complexity: 1  -- Mac Part A through a reviewed, product-pinned `mastracode-part-a` recipe on the shared runner (the reviewed recipe handoff; no edit to the runner): two reviews, then the operator install, then a separate run go. Mastra Code 0.49.0 installed from the pinned tarball (shasum `42495347`) under a disposable HOME, headless turns against the labeled loopback fixture with `MASTRA_TELEMETRY_DISABLED=1`. Owner: the mission seat that invokes the run. Evidence: mac-job/partA/evidence/ with a SHA256SUMS that verifies. Done-when: `compare.json` is `ok`; the macOS default database path, the two tables' columns and indexes, the JSONB read through `json(metadata)` on the Mac's node, and which `-wal` and `-shm` files a read-only open creates are read back from that folder; LLP 0586 is amended first if any differs from Linux.
- id: G-DOC branch: none  deps: [T9]      complexity: 1  -- Documentation handoff (FLOW documentation handoff gate) at the reviewed head: one documentarian child row, and closeout is blocked on it. T8 covers repo docs only. Owner: the orchestrator queues it, the documentarian works it. Done-when: the child row is closed with its result recorded in PROGRESS.md.
- id: G-UW  branch: none  deps: [T10]     complexity: 1  -- Upstream-watch registration at Close, per upstream-watch/HANDOFF.md (coverage row 2), id `mastracode`, npm package `mastracode`. Owner: the mission at Close. Done-when: the watch entry is read back on upstream-watch main and recorded in COVERAGE.md row 2.
- id: T1  branch: codex/mastracode-session-capture/T1  deps: []        complexity: 2  -- hypaware-core/plugins-workspace/mastracode/{hypaware.plugin.json,src/index.js,src/config.js,src/errors.js,src/types.d.ts}: manifest copied from goose per LLP 0586#manifest (no `picker` block yet, no client or skills contribution, `node_engine` `">=22.12"`). `config.js` resolves `[mastracode] enabled, db_path, poll_interval` per LLP 0586#config (unknown keys refused, the generic `backfill` block accepted, `~` expanded at resolve time) and the database path in the order `db_path`, `$MASTRA_DB_PATH`, `$MASTRA_APP_DATA_DIR/mastra.db`, `$XDG_DATA_HOME/mastracode/mastra.db`, the platform default (absolute environment values only; `darwin` `~/Library/Application Support/mastracode/mastra.db`, `win32` `%APPDATA%\mastracode\mastra.db`, otherwise `~/.local/share/mastracode/mastra.db`, per LLP 0586#detect-platforms), `enabled` true unless set to `false`, and reports `MASTRA_DB_URL` as remote. `index.js` registers a source that starts and reports `ready` with zero rows. One line in src/core/runtime/bundled.js. Test: test/plugins/mastracode-manifest.test.js (manifest validates, bundled, no client contribution), test/plugins/mastracode-config.test.js (defaults, `enabled` true when absent and false only when `false`, the platform default for each of `darwin`, `win32` and `linux`, each resolution step with each variable set and unset, a relative variable ignored, `~` expansion, `MASTRA_DB_URL` gives remote, bad `poll_interval` and an unknown key refused, `backfill` accepted); `npm pack --dry-run` lists the plugin files.
- id: T2  branch: codex/mastracode-session-capture/T2  deps: [T1, G-A] complexity: 2  -- The manifest gains its `picker` block (label `Mastra Code`, summary "Records your Mastra Code conversations and imports recent history. Makes no changes to Mastra Code.", `detect.settings_file` `.local/share/mastracode/mastra.db`, `compose { plugin { name }, requires_gateway: true }`, no `platforms` field, so Windows is still offered, per LLP 0586#detect-platforms), and in the same commit src/core/commands/init.js `INIT_SOURCE_CHOICES` and src/core/cli/types.d.ts `PickerSource` gain `'mastracode'`, beside `'goose'` and `'crush'`. Not added to `INIT_CLIENT_CHOICES`. Test: test/core/init-source-choices.test.js holds the list against the catalog with Mastra Code present; a new case checks the picker pre-checks Mastra Code when the fixture HOME has `.local/share/mastracode/mastra.db` and does not when it is absent, and that detection opens no database; a fixture HOME holding only `Library/Application Support/mastracode/mastra.db` is not pre-checked (the recorded macOS gap) and Mastra Code is still offered. A setup case re-runs `hyp setup --source mastracode` on a config with `mastracode.enabled = false` and checks it stays off and the config is byte-identical, and another adds Mastra Code to a config that already has other clients and checks their sections are byte-identical. Done-when: G-A's recorded macOS path, read back from mac-job/partA/evidence/, is quoted in the PR. If it is the documented `~/Library/Application Support/mastracode/`, nothing changes and the macOS gap stays; if it differs, LLP 0586 is amended and T1's resolver default fixed before T2 lands. `detect` keeps the Linux probe either way.
- id: T3  branch: codex/mastracode-session-capture/T3  deps: [T1]      complexity: 4  -- hypaware-core/plugins-workspace/mastracode/src/{mastra_db.js,projector.js,git_repo.js}: `mastra_db.js` opens `node:sqlite` `DatabaseSync` read-only, never writes or checkpoints, checks `sqlite_version()` is at least 3.45 (`sqlite_unsupported`), retries `SQLITE_BUSY`/`SQLITE_LOCKED` 5 times 20 ms apart then fails with `sqlite_busy`, checks both tables and every column it reads (`schema_unsupported` names it), names its columns in every query, reads `metadata` through `json(metadata)`, and never names another table (D7). `projector.js` follows LLP 0586#projection: `mastracodeScopeId`, `(createdAt, rowid)` order, part ids from the thread id, message id and part index, a user part only from `signal`/`user` rows (other signals skipped and counted), assistant text, a tool-call part per `tool-invocation` and a tool-result part only when its `state` is `result`, no error flag (the part has no error field), `data-sandbox-exit` skipped and counted, `step-start` model, `data-workspace-metadata` dropped (D6), unknown parts and `reasoning` skipped and counted, the model and provider fallbacks, `client_name`, `conversation_source` and `entrypoint` `mastracode`, `cwd` and repository from `projectPath` through `git_repo.js` (copied from goose), no `resourceId` or owner hash, titles through `captureSessionTitle`, and usage per D4. The PR carries the prune granularity read from the pinned source (whole threads, messages or both, LLP 0586#prune), the D4 proof (source lines from the pinned `@mastra/core` 1.82.0 and the a2/a3 sample values) and the index DDL from the pinned `@mastra/libsql` 1.29.0 with its source path. Test: test/plugins/mastracode-db.test.js (fixture database built with `node:sqlite` from the probe `schema.sql` for the two tables plus the T3 index DDL, JSONB metadata written with `jsonb()`: the read-only open writes no content, starting both with and without a `-wal`; busy retry bound; missing column error; a stubbed old `sqlite_version()` gives `sqlite_unsupported`; a guard that fails if any query text names a table other than the two, or if the reader opens any path other than the database; `EXPLAIN QUERY PLAN` of the rowid range read and the per-thread count-and-max read is a `SEARCH`) and test/plugins/mastracode-projector.test.js (the a4 sample shapes rebuilt synthetically: a multi-step assistant row with two tool invocations gives its parts in order, a rewritten row keeps its part ids as it grows, a non-user signal is not a prompt, no value from a `data-workspace-metadata` part (its `filesystem` and `sandbox` objects) appears in any part's text, args, result or attributes, and `cwd` and `source_path` are the only path-bearing columns, a `tool-invocation` whose `state` is not `result` gives only its tool-call part, no tool-result part sets an error flag, a `data-sandbox-exit` part is skipped and counted, a skipped unknown part counted, the model fallback order, no usage fields when D4 is not proven or the proven mapping when it is, the `process_token_usage` attribute on the last part of the latest assistant message only, usage-policy skip).
- id: T4  branch: codex/mastracode-session-capture/T4  deps: [T3]      complexity: 4  -- hypaware-core/plugins-workspace/mastracode/src/{watermark.js,source.js}: watermark sidecar in `ctx.paths.stateDir` with `{stat_sig, max_rowid, floor}` and per-thread `{updated_at, message_count, max_rowid, open, digest}`, baselined to the current maxima and `floor` on first start, pruned by the sweep and capped at 10,000 thread entries (oldest `updated_at` evicted); eviction and pruning raise `floor`. Tick follows LLP 0586#reconciliation and #source: stat `mastra.db` and `-wal` (not `-shm`), open only on a changed signature, the rowid range read and the threads read, the candidate rules including the `floor` rule and the open-thread rule (open threads are never pending), the before-open and after-close stats with the signature recorded after close only when every candidate was admitted, admit in `updatedAt` order under the LLP 0527 budget (64 threads, 4096 rows), commit through `reconcileRowsBatch` with scope `client_name = mastracode AND session_id`, flush the watermark once after commit, catch-up tick while non-open candidates are pending, a held scope guard defers the thread, shutdown awaits the in-flight tick. Session exclusions per LLP 0586#privacy, as goose. Test: test/plugins/mastracode-source.test.js (idle tick opens nothing, a commit during the read leaves the database to reopen next tick, append, an assistant row rewritten in place with the same `rowid` and no `updatedAt` bump reconciles to one whole turn, a row deleted and re-inserted reconciles to one, a `-c` continuation appends to the same thread, first start does not walk history, an out-of-window thread is not hashed on later ticks, an open thread is re-hashed only until a hash finds it unchanged and schedules no catch-up tick, restart with the watermark on disk does not re-import, ignore-policy removal by empty snapshot, the stat signature moves on every commit through a separate writer including after a checkpoint and WAL reset, a failed commit leaves the watermark unchanged, messages deleted from a live thread are removed from the cache on its next reconcile and a thread deleted upstream keeps its cached rows (LLP 0586#prune), no connection is open after shutdown) and test/plugins/mastracode-batched-reconcile.test.js (budget caps, catch-up tick commits the leftovers with no further write, a fixture with many threads and messages shows settled unchanged threads are not hashed, the cap evicts the oldest entry and the evicted thread is not hashed again until it changes), and a session-exclusion admission case (ignored thread not projected, unignore recovers it, load error projects nothing).
- id: T5  branch: codex/mastracode-session-capture/T5  deps: [T4]      complexity: 2  -- hypaware-core/plugins-workspace/mastracode/src/backfill.js: provider reusing the T3 reader and projector and T4's watermark and admission helpers; scope per LLP 0586#backfill (threads inside `backfill.window_days` by `updatedAt` when set, every thread when unset), one connection, for the join-time import and the scheduled sweep (LLP 0359#sweep-context); the sweep digests every thread in scope and prunes entries for deleted or out-of-scope threads; refreshes the ignore set at the start of each run; waits a bounded time on a held scope guard then fails that thread with `cache_partition_mutation_busy`. Test: test/plugins/mastracode-backfill.test.js (window bound, unset window imports every thread, repeat run reconciles without appending, an in-place edit after the last write picked up by the sweep, threads written while the daemon was down recovered by the next sweep, a pruned entry raises `floor` and is not hashed by the poll, the sweep removes messages pruned from a live thread, a thread deleted upstream keeps its cached rows and loses only its watermark entry, busy guard error).
- id: T6  branch: codex/mastracode-session-capture/T6  deps: [T4]      complexity: 2  -- hypaware-core/plugins-workspace/mastracode/src/source.js status: source health per the LLP 0586#status table, one state per row; each tick logs `mastracode.poll` with `component`, `operation`, `status`, `changed`, `threads_changed`, `threads_pending`, `parts_skipped`, `rows`, `error_kind`, and never message text, titles, `projectPath` or the database path. Test: status cases added to test/plugins/mastracode-source.test.js, one per state, an unreadable case from a fixture database with mode 000, a `MASTRA_DB_URL` case that opens no file, plus a log-line assertion that no fixture marker or path appears.
- id: T7  branch: codex/mastracode-session-capture/T7  deps: [T4, T5, T6] complexity: 3  -- hypaware-core/smoke/flows/mastracode_capture.js, modeled on goose_capture.js and crush_capture.js: boots `@hypaware/ai-gateway` + `@hypaware/mastracode` in a temp HYP_HOME with a fixture `mastra.db` under the fake HOME holding two threads in two project directories; runs the poll and `hyp backfill mastracode`; asserts the marker turn (user text, assistant text, two tool calls and results in order) via SQL and `hyp query grep`, a rewritten assistant row without duplicates, a continued thread, an idempotent rerun, a `.hypignore`d project absent, a local-only project's rows withheld from export, the session graph grouping the turn by thread id, no value from the fixture's `data-workspace-metadata` part in any row, and the `mastracode.poll` telemetry with a stable `DEV_RUN_ID`, `smoke_name` and `smoke_step`. Also adds Mastra Code to `walkthrough_picker_to_first_query`. Test: `npm run smoke -- mastracode_capture` and `npm run smoke -- walkthrough_picker_to_first_query` green, and `source_optout_export_withhold` still green.
- id: T8  branch: codex/mastracode-session-capture/T8  deps: [T7]      complexity: 2  -- docs/integrations/mastracode.md (the package and pinned version named; what is recorded, setup, history import, limits: usage per D4 (the latest process's counter, not a thread total, unless T3 proved per-turn usage), the D8 disclosures (90-day chat retention, with the sentence "HypAware keeps a thread Mastra Code deletes, but drops messages Mastra Code prunes from a thread still in use" adjusted to T3's prune granularity, one factual PostHog sentence with `MASTRA_TELEMETRY_DISABLED=1`, deny mode still runs tools, remote stores unsupported, titles as content), the macOS picker that does not pre-check Mastra Code, Windows offered but unvalidated, `db_path` for a moved database or a daemon under launchd or systemd, and the sweep-cadence latency for late in-place edits) modeled on docs/integrations/goose.md; a row in the docs/INTEGRATIONS.md "Coding agents" table; README client list; docs/CLIENTS.md entry; docs/PRIVACY.md client table, Mastra Code in the session-exclusion lists, and the files HypAware never reads; docs/TROUBLESHOOTING.md entries for each degraded state in LLP 0586#status. No edits under hypaware-core/skills/. Test: every command in the new text run in the T9 sandbox; `npm test` (doc drift guards) green.
- id: T9  branch: codex/mastracode-session-capture/T9  deps: [T8]      complexity: 2  -- Validation, no code: `npm pack`, then `scripts/sandbox/hyp-sandbox` installs the tarball, runs `hyp setup` with Mastra Code picked, real Mastra Code 0.49.0 turns from the pinned tarball in two project directories against the labeled loopback fixture with `MASTRA_TELEMETRY_DISABLED=1`: a prompt with a tool call, SQL and `hyp query grep` readback, a `-c` continue that appends with no duplicates, a turn while the daemon is stopped that is recovered after it starts, a daemon restart that does not re-import, a `.hypignore`d project and a session ignore checked on the real product, disable and re-enable, `hyp status` diagnostics, and cleanup. Row 5's upgrade case is n/a because the plugin is new; the receipt says so. Test: the receipt at validation/T9-linux/RECEIPT.md in the mission folder records the candidate and base sha, the package and Mastra Code tarball shasums, versions, every command with its exit status, limits, and the loopback label, and names the coverage rows it settles on Linux.
- id: T10 branch: codex/mastracode-session-capture/T10 deps: [T9]      complexity: 2  -- Mac Part B: a product-pinned, reviewed `mastracode-part-b` recipe registered through the shared runner (as G-A) runs the same packaged candidate on the Mac under a disposable HYP_HOME and HOME, with T9's journey steps labeled loopback where they apply, plus the checkpoint-and-reset stat-gate check and the reader side-effect check from LLP 0586#sqlite: which files a read-only open creates and their sizes, that an idle read leaves `mastra.db` and `-wal` size, mtime and inode unchanged, and that the next idle tick opens nothing. The invoking seat records its own invocation. A relay, if one happens, is recorded in OPERATOR-ASSISTANCE.md as an intervention, not as the plan path. Test: evidence in mac-job/partB/evidence/ with a verifying SHA256SUMS, recording the candidate sha256 and the actor, and the Mac column of every coverage row filled from it. Done-when: the results above are read back from that folder; if macOS differs from Linux, LLP 0586 is amended before Close.

### Validation results {#validation-results}

Recorded 2026-11-06. T1-T8 landed in #2920. T9 and T10 ran the same packaged
candidate on Linux and macOS.

| Task | Platform | Result | Evidence |
| --- | --- | --- | --- |
| T1-T8 | CI | Landed in #2920 (merge 65be3a76, landing head 470025b2) | The merge queue run on 470025b2 (the second attempt; the first failed on an unrelated `daemon-pid-identity` timing flake) |
| T9 | Linux x86_64, `hyp-sandbox`, Mastra Code 0.49.0, loopback fixture provider | Passed. Coverage rows 4 to 10, 12 and 13 settled; row 11 stays on its cost model and fixture tests, with no regression seen | Sandbox run of the 1.49.0 tarball from 470025b2 (sha256 `5a48b7a1`), the mission receipt validation/T9-linux/RECEIPT.md |
| T10 | macOS 27.2 arm64, the dedicated Mac test account, Mastra Code 0.49.0, loopback fixture provider, seat-run through the shared runner | Passed: 60 checks pass, 0 fail, 0 skip, exit 0, and the summary matches the Linux dry run of the same recipe on all 32 compared facts | Part B run `mastracode-partB-20261106T041637Z-43698` of the same tarball (`5a48b7a1`), recipe `mastracode-part-b-v1` (manifest `ce6318b0`, approved in upstream-watch#11); all 96 SHA256SUMS entries verified after fetch |

What the runs show for #sqlite and #cost, on both platforms:

- After a clean close (a TRUNCATE checkpoint by the last connection) left no
  sidecars, the daemon's first read-only open created a 0-byte `-wal` and a
  32768-byte `-shm`, the case LLP 0586 `#sqlite` names. The change gate
  leaves `-shm` out and records the signature after the reader closes, so
  the next tick opened nothing.
- Over 27 idle samples 5 s apart, the `mastra.db` and `-wal` size, mtime
  and inode and the `-shm` mtime did not move.
- On a synthetic scratch database with a writer held open, the stat
  signature moved on every spaced commit, including after a checkpoint and
  WAL reset.

What the runs do not prove:

- Both platforms used a labeled loopback provider in headless `-p` runs, so
  they prove Mastra Code's storage and HypAware's capture, not authenticated
  inference or the TUI.
- On a Mastra Code-only install `hyp session ignore` exits 3 because no
  gateway port is bound, as on any poll-source-only install (#2860). `hyp privacy ignore <dir>`
  works and was checked on both platforms.
- Neither run measured CPU or memory; row 11 rests on the cost model and the
  fixture tests. The missing, busy, remote-store and schema states, history
  pruning and upgrade are fixture-only on both platforms (upgrade has no
  earlier Mastra Code-capable release to start from).

Nothing LLP 0586 or this plan decided changes.
