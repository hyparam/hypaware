# LLP 0574: Crush session capture, implementation plan

**Type:** plan
**Status:** Active
**Systems:** Sources, Plugins
**Author:** HypForge
**Date:** 2026-11-03
**Related:** LLP 0573, LLP 0570, LLP 0571, LLP 0122, LLP 0123, LLP 0449, LLP 0527, LLP 0403, LLP 0549
**Generated-by:** neutral

> [LLP 0573](./0573-crush-session-capture.design.md) is the technical design
> for a `@hypaware/crush` client adapter: a read-only poll and bounded
> backfill of every project's `.crush/crush.db`, found through Crush's
> `projects.json`, projected into `ai_gateway_messages` and reconciled per
> session because Crush updates stored messages in place. This plan splits
> that design into tasks that each land on their own, with a test that proves
> the task and nothing more. It follows the goose plan (LLP 0571), whose file
> and test layout the tasks copy.

## How this refines the design {#refinement}

The design settles discovery, the reader, projection, reconciliation, source,
backfill, privacy and status. This plan adds what only the tree shows:

- **Core edits are three lists, not a new seam**, as for goose. Picker
  detection is the manifest `detect` block plus a `'crush'` entry in
  `INIT_SOURCE_CHOICES` (`src/core/commands/init.js`) and the `PickerSource`
  union (`src/core/cli/types.d.ts`), held together by
  `test/core/init-source-choices.test.js`. Crush has no client contribution,
  so it joins neither `INIT_CLIENT_CHOICES` nor the `--client` type. Bundling
  is one line in `src/core/runtime/bundled.js`.
- **Product telemetry is untouched.** Crush reports as `other`, as goose does.
  `src/core/product_telemetry/contract.js` is not edited, which keeps the
  change outside the server-suite gate. A `crush` adapter label is a separate
  decision.
- **No consented skills.** `CONSENTED_SKILLS` in
  `src/core/runtime/client_assets.js` is not edited, and nothing under
  `hypaware-core/skills/` changes (LLP 0573 `#manifest`).
- **Reuse, not shared code.** `git_repo.js` and the busy-retry helpers are
  copied from goose with a note, as goose copied them from hermes. Hoisting
  them into core is a refactor outside this plan.
- **Smokes are discovered from `hypaware-core/smoke/flows/`**, so the new
  flow needs no registry edit.

## Sequencing {#sequencing}

T1 lands the plugin with discovery and a source that starts and does
nothing, and with no picker contribution, so `test/core/init-source-choices.test.js`
stays green and every later task is a behavior change behind an existing
switch. T2 adds the manifest `picker` block with the two lists that test holds
it to, and waits on gate G-A (Mac Part A) for the macOS default path. T2 (picker) and T3
(reader and projector) depend only on T1 and can land in either order. T4
(source with the stat gate, reconciliation and exclusions) builds on T3. T5
(backfill) reuses T4's watermark and admission helpers, so it waits for T4. T6
(status) reads the health T4 reports. T7 (smoke) needs T4, T5 and T6, because
it asserts the `crush.poll` telemetry T6 adds. T8 (docs) can be written
alongside but lands after T7, so every command it shows has run. T9 and T10
are validation on the packaged candidate, Linux sandbox then Mac. Three gate
rows sit outside the repo's branches: G-A before T2, and G-DOC and G-UW at
Close (#tasks).

## Rating complexity: the hard parts, by name {#complexity}

- **The change gate and the two rowid holes (T4, complexity 4).** LLP 0573
  `#reconciliation` replaces goose's `data_version` with a stat signature and
  adds two rules a rowid cursor alone would miss: the same-second unsettled
  rule (a deleted summary and an append that reuses its rowid) and the
  open-session rule (streaming updates that do not bump `updated_at`), and
  two bounds on repeat work: the per-database `floor` (a session with no
  entry is a candidate only above it, so old, out-of-window, pruned and
  evicted sessions are never hashed by the poll) and the open-session bound
  (cleared by `finished_at`, a later message, or a sweep that finds the
  digest unchanged; never pending). Each needs a fixture that reproduces it. The `EXPLAIN QUERY PLAN` gate applies:
  the `messages` rowid range read and the per-session `MAX(rowid)` seek must
  be a `SEARCH`; the `sessions` read is an accepted scan. If either required
  read scans, Build stops and returns to design review.
- **Many databases on one tick (T4).** The 16-open budget, the round-robin
  start over the set sorted by real path (so an index reorder cannot move a
  changed database behind it), and holding the old signature of an unopened database and of an
  opened one with a candidate the session or row budget left unadmitted
  (open sessions included), so a database is never marked seen without its
  candidates being read.
- **The stat gate on a real WAL (T4).** The test commits through a separate
  writer connection, including after a checkpoint and WAL reset, and asserts
  the signature moves each time. If it does not, T4 takes the design's
  fallback (a `data_version` read on a short-lived connection) and says so in
  the PR. The reader's own open creates SQLite's empty `-wal` and `-shm`
  when they are absent (LLP 0573 #sqlite), so the tests start both with and
  without a `-wal`, record the signature after the reader closes, and cover
  the race where a commit lands during the read (the before-open and
  after-close stats disagree, so the database is reopened next tick).
- **Session id collisions (T4).** A copied project directory gives two
  databases with the same session ids; the first committer owns them and the
  duplicate is counted, never merged.
- **Shell-command and summary parts (T3, complexity 3).** A user
  `shell_command` must not count as a prompt, and a summary that is later
  deleted must reconcile away.
- **Read-commit guard (T4, T5).** One read transaction per session, and the
  watermark flushes only after the batch commits.

## Out of scope {#out-of-scope}

- A client or skills contribution for Crush. It would touch
  `hypaware-core/skills/` and `CONSENTED_SKILLS`, and needs its own ask.
- Any token usage on rows (LLP 0573 D2). Crush exposes no per-turn usage; only
  the root-session cost attribute ships.
- Reading Crush's `files` or `read_files` tables, `crush.json`, or
  `crush.log` (D6).
- A `CRUSH_GLOBAL_DATA` or `XDG_DATA_HOME` resolver in the picker. Detection
  checks the default path; the config resolver honors both variables when the
  daemon sees them, and `data_dirs` covers the rest.
- A disk walk for `.crush` directories not listed in `projects.json` or
  `data_dirs`.
- A `crush` product-telemetry adapter label (see #refinement).
- Code for the upstream-watch registration (coverage row 2) and the
  `crush-part-a` Mac recipe. Both live outside this repo; gate rows G-A and
  G-UW (#tasks) own them, with an owner, evidence path and done-when each.

## Tasks

Gate rows carry no branch: they are mission rows outside this repo, each with
an owner, an evidence path in the mission folder and a done-when.

- id: G-A   branch: none  deps: []        complexity: 1  -- Mac Part A (MAC-JOB-crush.md Part A) through the reviewed `crush-part-a` recipe on the shared runner: row crush-macjob-review (two reviews), then the operator install, then a separate run go. Owner: the mission seat that invokes the run. Evidence: mac-job/partA/evidence/ (MAC-JOB-crush.md step 5) with a SHA256SUMS that verifies. Done-when: `compare.json` is `ok`, the macOS default index path, `projects.json` shape and migration version are read back from that folder, and LLP 0573 is amended first if any differs from Linux.
- id: G-DOC branch: none  deps: [T9]      complexity: 1  -- Documentation handoff (FLOW documentation handoff gate) at the reviewed head: one documentarian child row, and closeout is blocked on it. T8 covers repo docs only. Owner: the orchestrator queues it, the documentarian works it. Done-when: the child row is closed with its result recorded in PROGRESS.md.
- id: G-UW  branch: none  deps: [T10]     complexity: 1  -- Upstream-watch registration at Close, per upstream-watch/HANDOFF.md (coverage row 2). Owner: the mission at Close. Done-when: the crush watch entry is read back on upstream-watch main and recorded in COVERAGE.md row 2.
- id: T1  branch: codex/crush-session-capture/T1  deps: []        complexity: 2  -- hypaware-core/plugins-workspace/crush/{hypaware.plugin.json,src/index.js,src/config.js,src/discovery.js,src/errors.js,src/types.d.ts}: manifest copied from goose per LLP 0573#manifest (no `picker` block yet, no client or skills contribution). `config.js` resolves `[crush] enabled, data_dirs, poll_interval` per LLP 0573#config (unknown keys refused, the generic `backfill` block accepted, at most 256 `data_dirs`, `~` expanded at resolve time) and the index path in the order `$CRUSH_GLOBAL_DATA`, `$XDG_DATA_HOME/crush`, `~/.local/share/crush` (absolute values only). `discovery.js` follows LLP 0573#discovery: reread `projects.json` only when its stat signature moves, keep the last good list on a malformed index, union with `data_dirs`, dedupe by real path, count and skip a `data_dir` without `crush.db`, cap at 1,024. `index.js` registers a source that starts and reports `ready` with zero rows. One line in src/core/runtime/bundled.js. Test: test/plugins/crush-manifest.test.js (manifest validates, bundled, no client contribution), test/plugins/crush-config.test.js (defaults, the index order with each variable set and unset, a relative variable ignored, `~` expansion, bad `poll_interval` and an over-long `data_dirs` refused, `backfill` accepted), test/plugins/crush-discovery.test.js (two index entries sharing one `data_dir` give one database, a stale entry counted, a malformed index keeps the last good list, an unchanged index is not reread, the cap); `npm pack --dry-run` lists the plugin files.
- id: T2  branch: codex/crush-session-capture/T2  deps: [T1, G-A] complexity: 2  -- The manifest gains its `picker` block (label `Crush`, summary "Records your Crush conversations and imports recent history. Makes no changes to Crush.", `detect.settings_file` `.local/share/crush/projects.json`, `compose { plugin { name }, requires_gateway: true }`), and in the same commit src/core/commands/init.js `INIT_SOURCE_CHOICES` and src/core/cli/types.d.ts `PickerSource` gain `'crush'`, beside `'goose'`. Not added to `INIT_CLIENT_CHOICES`. Test: test/core/init-source-choices.test.js holds the list against the catalog with Crush present; a new case checks the picker pre-checks Crush when the fixture HOME has `.local/share/crush/projects.json` and does not when it is absent, and that detection opens no database. A setup case re-runs `hyp setup --source crush` on a config with `crush.enabled = false` and checks it stays off and the config is byte-identical, and another adds Crush to a config that already has other clients and checks their sections are byte-identical. Done-when: the detect path and T1's resolver default are the macOS default G-A recorded, read back from mac-job/partA/evidence/ and quoted in the PR; if either differs from the Linux default, LLP 0573 is amended and T1's resolver fixed first.
- id: T3  branch: codex/crush-session-capture/T3  deps: [T1]      complexity: 3  -- hypaware-core/plugins-workspace/crush/src/{crush_db.js,projector.js,git_repo.js}: `crush_db.js` opens `node:sqlite` `DatabaseSync` read-only, never writes or checkpoints, retries `SQLITE_BUSY`/`SQLITE_LOCKED` 5 times 20 ms apart then fails with `sqlite_busy`, checks `goose_db_version` and every column it reads (`schema_unsupported` names it), names its columns in every query, never touches `files` or `read_files`, and skips `title-` sessions in the query (D3). `projector.js` follows LLP 0573#projection: `crushScopeId`, `(created_at, rowid)` order, part ids from the Crush message id and part index, text, reasoning, tool call and tool result parts, the user `shell_command` pair marked `crush.user_shell`, `image_url`/`binary` placeholders, `finish` folded into the last part, summary messages marked `crush.summary`, the D5 strip of `<cwd>` and `working_directory`, provider and model from the columns, `entrypoint` `crush` or `crush-task` with `parent_thread_id`, no usage, the root-session cost attribute omitted at 0 (D2), titles through `captureSessionTitle` (D7). `git_repo.js` copies the goose helper. Test: test/plugins/crush-db.test.js (fixture database built with `node:sqlite` from the v0.99.0 schema: the read-only open writes no content, starting both with and without a `-wal`: `crush.db` and an existing `-wal` keep their bytes, and an absent `-wal` and `-shm` are created empty by SQLite and nothing else is created, busy retry bound, missing column error, title sessions skipped, a guard that fails if any query text names `files` or `read_files`) and test/plugins/crush-projector.test.js (each part shape, a streamed message keeps its part ids as it grows, a shell command is not a prompt, a summary part, a task session's `parent_thread_id`, cost on a root session only and absent at 0, no usage fields, no path in any part, usage-policy skip).
- id: T4  branch: codex/crush-session-capture/T4  deps: [T3]      complexity: 4  -- hypaware-core/plugins-workspace/crush/src/{watermark.js,source.js}: watermark sidecar in `ctx.paths.stateDir` with per-database `{stat_sig, max_rowid, floor}` and per-session `{db, updated_at, message_count, max_rowid, open, digest}`, baselined to the current maxima and `floor` on first start and for a database first seen later, pruned by the sweep and capped at 10,000 session entries (oldest `updated_at` evicted); eviction and pruning raise `floor` to at least the entry's `updated_at`. Tick follows LLP 0573#reconciliation and #source: stat every database, open at most 16 changed ones from a round-robin start, rowid range read and sessions read per opened database, candidate rules including the `floor` rule for sessions with no entry, the same-second unsettled rule and the bounded open-session rule (open sessions are never pending), the before-open and after-close stats with the signature recorded after close only when every candidate in the database was admitted (otherwise the before-open signature is kept, open sessions included), databases opened one at a time and admitted in turn, admit under the LLP 0527 budget (64 sessions, 4096 rows), commit through `reconcileRowsBatch` with scope `client_name = crush AND session_id`, flush the watermark once after commit, catch-up tick while databases or sessions are pending, an unopened changed database keeps its old signature, a held scope guard defers the session, the first database to commit a session id owns it. Session exclusions per LLP 0573#privacy, as goose. Test: test/plugins/crush-source.test.js (idle tick opens no database, a database with no `-wal` opened once and the next idle tick opens nothing, a commit during the read leaves the database to reopen next tick, append, a streamed in-place update with no `updated_at` bump reconciles to one whole message, a deleted summary reconciles away, a delete and append in one second that reuse a rowid, first start does not walk history (a database with old sessions changes after the first start and only the new session is hashed), an out-of-window session is not hashed on later ticks, a never-finished assistant message is re-hashed only until the next sweep and schedules no catch-up tick, restart with the watermark on disk does not re-import, ignore-policy removal by empty snapshot, a copied project counted as `session_collision`, the stat signature moves on every commit through a separate writer including after a checkpoint, a failed commit leaves the watermark unchanged) and test/plugins/crush-batched-reconcile.test.js (budget caps, the 16-open budget and round-robin with 40 databases (the cycle is sorted by real path; `projects.json` is reordered between ticks and every changed database is still opened within 40 ticks; the last database opened leaves the set and the next tick starts at the next real path; a restart starts the cycle at the first real path), an unopened database read on the next tick, catch-up tick, one database with more than 64 candidates whose leftovers are committed on the catch-up tick with no further write, an open session left unadmitted on the tick of its final `finished_at` write that is read on the next tick with no further write, a database that always has leftovers does not keep the other changed databases from opening, a fixture with many sessions and many messages shows settled unchanged sessions are not hashed and `EXPLAIN QUERY PLAN` of the rowid range read and the `MAX(rowid)` seek is a `SEARCH`, the cap evicts the oldest entry, the evicted session is not hashed again until it changes, and its next change reconciles idempotently), and a session-exclusion admission case (ignored session not projected, unignore recovers it, load error projects nothing).
- id: T5  branch: codex/crush-session-capture/T5  deps: [T4]      complexity: 2  -- hypaware-core/plugins-workspace/crush/src/backfill.js: provider reusing the T1 discovery, T3 reader and projector and T4's watermark and admission helpers; scope per LLP 0573#backfill (non-title sessions inside `backfill.window_days` by `updated_at` when set, every non-title session when unset), one database open at a time, for the join-time import and the scheduled sweep (LLP 0359#sweep-context); the sweep digests every session in scope and prunes entries for deleted or out-of-scope sessions and for databases no longer in the set; refreshes the ignore set at the start of each run; waits a bounded time on a held scope guard then fails that session with `cache_partition_mutation_busy`. Test: test/plugins/crush-backfill.test.js (window bound, unset window imports every non-title session across several databases, repeat run reconciles without appending, an in-place edit outside streaming picked up by the sweep, a project added to the index between runs, sessions written while the daemon was down recovered by the next sweep, a pruned entry raises `floor` and is not hashed by the poll, a deleted session's entry pruned, busy guard error).
- id: T6  branch: codex/crush-session-capture/T6  deps: [T4]      complexity: 2  -- hypaware-core/plugins-workspace/crush/src/source.js status: source health per the LLP 0573#status table, one state per row; each tick logs `crush.poll` with `component`, `operation`, `status`, `dbs_total`, `dbs_changed`, `dbs_opened`, `dbs_pending`, `sessions_changed`, `sessions_pending`, `rows`, `error_kind`, and never message text, titles, project paths or database paths. Test: status cases added to test/plugins/crush-source.test.js, one per state, an unreadable case from a fixture database with mode 000, plus a log-line assertion that no fixture marker or path appears.
- id: T7  branch: codex/crush-session-capture/T7  deps: [T4, T5, T6] complexity: 3  -- hypaware-core/smoke/flows/crush_capture.js, modeled on goose_capture.js: boots `@hypaware/ai-gateway` + `@hypaware/crush` in a temp HYP_HOME with a fixture `projects.json` naming two projects, each with a fixture `crush.db`, under the fake HOME; runs the poll and `hyp backfill crush`; asserts the marker turn (user text, assistant text, tool call and result, no usage) via SQL and `hyp query grep`, an in-place update without duplicates, a task session linked to its parent, an idempotent rerun, a title session absent, a `.hypignore`d project absent, a local-only Crush project's rows withheld from export, the session graph grouping the turn by Crush session id, no `<cwd>` path in any row, and the `crush.poll` telemetry with a stable `DEV_RUN_ID`, `smoke_name` and `smoke_step`. Also adds Crush to `walkthrough_picker_to_first_query`. Test: `npm run smoke -- crush_capture` and `npm run smoke -- walkthrough_picker_to_first_query` green, and `source_optout_export_withhold` still green.
- id: T8  branch: codex/crush-session-capture/T8  deps: [T7]      complexity: 2  -- docs/integrations/crush.md (what is recorded, setup, history import, limits: no per-turn usage and the cost attribute, the omitted injected context message, the `api.github.com` update check and how Crush turns it off, `data_dirs` for a moved data dir or a daemon under launchd or systemd, the sweep-cadence latency for in-place edits, and one line that the reader may leave an empty `crush.db-wal` and a 32 KiB `crush.db-shm` in `.crush/`, SQLite's own index files with no content, until Crush's next clean close) modeled on docs/integrations/goose.md; a row in the docs/INTEGRATIONS.md "Coding agents" table; README client list; docs/CLIENTS.md entry; docs/PRIVACY.md client table, Crush in the session-exclusion lists, and that the `files` table is never read; docs/TROUBLESHOOTING.md entries for each degraded state in LLP 0573#status, plus the same one line on the `-wal` and `-shm` files. No edits under hypaware-core/skills/. Test: every command in the new text run in the T9 sandbox; `npm test` (doc drift guards) green.
- id: T9  branch: codex/crush-session-capture/T9  deps: [T8]      complexity: 2  -- Validation, no code: `npm pack`, then `scripts/sandbox/hyp-sandbox` installs the tarball, runs `hyp setup` with Crush picked, real Crush v0.99.0 turns in two projects against the labeled loopback fixture (metrics and provider auto-update off): a prompt with a tool call, SQL and `hyp query grep` readback, a `crush run -C` continue that appends with no duplicates, a turn while the daemon is stopped that is recovered after it starts, a daemon restart that does not re-import, a `.hypignore`d project and a session ignore checked on the real product, disable and re-enable, `hyp status` diagnostics, and cleanup. Row 5's upgrade case is n/a because the plugin is new; the receipt says so. Test: the receipt at validation/T9-linux/RECEIPT.md in the mission folder records the candidate and base sha, the package and Crush binary sha256, versions, every command with its exit status, limits, and the loopback label, and names the coverage rows it settles on Linux.
- id: T10 branch: codex/crush-session-capture/T10 deps: [T9]      complexity: 2  -- Mac Part B (MAC-JOB-crush.md Part B): a pinned, reviewed recipe registered through the shared runner (as G-A) runs the same packaged candidate on the Mac under a disposable HYP_HOME and HOME, with T9's journey steps labeled loopback where they apply, plus the checkpoint-and-reset stat-gate check and the reader side-effect check from LLP 0573#sqlite: which files the first read of a database with no `-wal` creates and their sizes, that an idle read leaves `crush.db` and `-wal` size, mtime and inode unchanged, and that the next idle tick opens nothing. The invoking seat records its own invocation. A relay, if one happens, is recorded in OPERATOR-ASSISTANCE.md as an intervention, not as the plan path. Test: evidence in mac-job/partB/evidence/ with a verifying SHA256SUMS, recording the candidate sha256 and the actor, and the Mac column of every coverage row filled from it. Done-when: the Part B recipe, when it is built, carries the reader side-effect and checkpoint-and-reset checks above, and their results are read back from that folder; if macOS differs from Linux, LLP 0573 is amended before Close.

### Validation results {#validation-results}

Recorded 2026-11-04. T1-T8 landed in #2868; T9 ran the packaged candidate on
Linux and T10 ran packaged master on macOS. Paths are in the mission folder.

| Task | Platform | Result | Evidence |
| --- | --- | --- | --- |
| T1-T8 | CI | Landed in #2868 (merge 202e3b80, landing head fd76a24a) | The merge queue run on 202e3b80 (CI 41781412486) and the push run on master (CI 41781941586) |
| T9 | Linux x86_64, `hyp-sandbox` with mock systemctl, Crush v0.99.0, loopback fixture provider | Passed. Every command exited as expected; `hyp session ignore` exits 3 on a Crush-only install, as the docs say. Settles coverage rows 4 to 10, 12 and 13 on Linux. | `validation/T9-linux/RECEIPT.md`: the 1.48.0 tarball packed from the PR head ede32770 (base 576db198), sha256 `12b6e430`, Crush binary `51a53155`, marker `HYPPROBE-20261104T053425Z-6c8b84e6`. The delta from ede32770 to the landing head is status wording only |
| T10 | macOS 27.2 arm64, the dedicated Mac test account, Crush v0.99.0 Darwin arm64, loopback fixture provider, operator-run (Codex operator through the HypForge caller, receipt `MAC-OPERATOR-20261104.md`) | Passed: 48 checks pass, 0 fail, 0 skip, 4 observations, exit 0. The first read of a database with no `-wal` leaves a 0-byte `-wal` and a 32768-byte `-shm`, as on Linux; an idle read leaves `crush.db` and `-wal` unchanged and the next idle tick opens nothing; the checkpoint-and-reset gate check passes 7 of 7 spaced steps | Part B run `run-20261104T210719Z-84efe037` under `mac-job/partB/`, master 202e3b80 packed as 1.48.0, sha256 `8f192436` (not the T9 tarball), Crush binary `8c1dfa5f`; all 68 SHA256SUMS entries verified after copy-back. Part A run `run-20261104T210614Z-5301710c` under `mac-job/partA/`: 48 of 48 comparison fields match Linux, 26 entries verified |

What the runs do not prove:

- Both platforms used a labeled loopback provider through headless
  `crush run`, so they prove Crush's storage and HypAware's capture, not
  authenticated inference, the TUI or `crush server`.
- T10 ran packaged master, not the T9 tarball, so the two platforms ran
  different packages of the same plugin code.
- On a Crush-only install `hyp session ignore` exits 3 because no gateway
  port is bound; `hyp privacy ignore <dir>` works and was checked on both
  platforms.
- Neither run read the cost attribute, provider/model or repo identity back
  from captured rows; both read rows by session, role, part type and
  entrypoint. Those fields rest on the fixture tests and the `crush_capture`
  smoke (Crush stores no per-response usage). Summarize, cancel, delete and task sub-sessions, the missing-index,
  locked and unsupported-schema states, and upgrade are fixture-only on both
  platforms (upgrade has no earlier Crush-capable release to start from).
- CPU and memory rest on the T4 fixture measurements; neither run measured
  the cost of many databases.

Nothing LLP 0573 or this plan decided changes.
