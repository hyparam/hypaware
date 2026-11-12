# LLP 0586: Mastra Code session capture - technical design

**Type:** Design
**Status:** Active
**Systems:** Sources, Plugins
**Author:** HypForge
**Date:** 2026-11-05
**Extended-by:** [LLP 0603](./0603-mastracode-session-token-snapshots.spec.md#accounting) extends D4 with recorded session-usage snapshots.
**Related:** LLP 0570, LLP 0571, LLP 0573, LLP 0574, LLP 0118, LLP 0119, LLP 0120, LLP 0121, LLP 0122, LLP 0123, LLP 0124, LLP 0449, LLP 0527, LLP 0359, LLP 0035, LLP 0050, LLP 0070, LLP 0130, LLP 0131, LLP 0394, LLP 0403, LLP 0587

> Buildable design for a `@hypaware/mastracode` client adapter.
> Active 2026-11-06: every Build task in LLP 0587 has landed; the Linux and
> Mac results are recorded in
> [LLP 0587#validation-results](./0587-mastracode-session-capture.plan.md#validation-results).
> `@ref LLP 0570 [constrained-by]`: the goose adapter is the template; this
> design names only where Mastra Code differs and why.
> `@ref LLP 0573 [constrained-by]`: the Crush adapter is the precedent for a
> stat-gated, short-lived read-only connection and for a usage gauge that is
> carried as an attribute, not as usage.
> `@ref LLP 0118 [constrained-by]`: same shape of capture as hermes, a pull
> from the product's own local store with no proxying.
> `@ref LLP 0119 [constrained-by]`: Mastra Code is never modified or
> proxied; `mastra.db` is opened read-only.
> `@ref LLP 0120#row-semantics [implements]`: rows are `ai_gateway_messages`
> rows through `ai_gateway.projected_exchange`, not a new table.
> `@ref LLP 0122 [constrained-by]`: config, SQLite access, watermark sidecar,
> source and backfill provider follow the hermes design.
> `@ref LLP 0449 [implements]`: Mastra Code stores a whole multi-step
> assistant turn in one row, so capture uses the session reconciliation
> scope, digest and read-to-commit guard.
> `@ref LLP 0527#tick-budget [implements]`: each poll tick reconciles a
> budgeted batch.
> `@ref LLP 0359#sweep-context [constrained-by]`: `backfill.window_days`
> bounds the join-time import and the scheduled sweep.
> `@ref LLP 0035#per-turn [constrained-by]`: Mastra Code stores a
> per-process gauge, not per-turn usage, so no row carries LLP 0035 usage unless T3
> proves differencing deterministic.

## Context

Mastra Code (npm `mastracode`, Apache-2.0, repository mastra-ai/mastra) is a
terminal coding agent built on the Mastra framework. The Research and Probe
phases of mission OPR.99.0.2 read its pinned package and ran it on Linux
against a loopback fixture provider (mission `probe/PROBE.md`). Facts are
tagged **[observed]** (seen in the probe runs), **[source]** (read in the
pinned package) or **[doc]** (stated in upstream documentation only).

**Identity assumption, stated visibly.** The ticket names "Mastra Code".
This design takes that to be the `mastracode` npm package from mastra-ai.
If any later evidence names a different product, Build stops and the
orchestrator raises it (D1).

- **[observed]** Version 0.49.0, published 2026-11-03T23:56:38Z, tarball
  shasum `42495347712bdaa42bdd9fb3abe222a0811bcd4d`, commit `6e8dfcb8`,
  depending on `@mastra/core` 1.82.0 and `@mastra/libsql` 1.29.0. About 89
  versions so far, roughly weekly. Node >= 22.19.0. The install is 855
  packages and 1.1 GB (PROBE.md Isolation, Bounds).
- **[observed]** One local SQLite database holds every thread:
  `~/.local/share/mastracode/mastra.db` on Linux, honoring `XDG_DATA_HOME`,
  in WAL mode with `-wal` and `-shm` files. The directory also holds
  `mastra-vectors.db`, `settings.json`, `auth.json` and `locks/`. Nothing is
  written in the working directory. After four runs the `-wal` was 1.8 MB
  and had not been checkpointed at exit (PROBE.md Storage).
- **[doc]** The macOS default is `~/Library/Application Support/mastracode/`
  and the Windows default `%APPDATA%\mastracode\`. `MASTRA_APP_DATA_DIR`
  moves the directory, `MASTRA_DB_PATH` moves the database,
  `MASTRA_DB_URL` (with `MASTRA_DB_AUTH_TOKEN`) selects a remote Turso or
  Postgres store, and `MASTRA_OBSERVABILITY_DB_PATH` moves the
  observability store.
- **[observed]** The database has 40 `mastra_*` tables. Capture needs two:
  - `mastra_threads(id PRIMARY KEY, resourceId, title, metadata JSONB,
    createdAt, updatedAt)`, one row per thread;
  - `mastra_messages(id PRIMARY KEY, thread_id, content, role, type,
    createdAt, resourceId)`, one row per message, with SQLite's implicit
    `rowid` (no `AUTOINCREMENT`) and no `updatedAt` column.

  The probe's `schema.sql` holds no `CREATE INDEX`, and the probe database
  was not retained, so which indexes exist is unknown (#open-questions).
- **[observed]** `metadata` is stored as SQLite JSONB and reads back only
  through `json(metadata)`, which needs SQLite 3.45 or newer. Node 24.2's
  `node:sqlite` (SQLite 3.50.0) reads it, with an `ExperimentalWarning`; the
  system `sqlite3` 3.40.1 cannot.
- **[observed]** Thread `metadata` carries `currentModeId`,
  `currentModelId` (`mastracode/<provider>/<model>`), `projectPath` (the
  absolute working directory), an owner hash, and `tokenUsage
  {promptTokens, completionTokens, totalTokens, cachedInputTokens,
  cacheCreationInputTokens, reasoningTokens, raw}`, where `raw` is the last
  step's provider usage.
- **[observed]** A user message is `role = signal`, `type = user`, with text
  parts. An assistant message is `role = assistant`, `type = v2`, and holds
  a **whole multi-step turn in one row**: `step-start {model}`,
  `tool-invocation` (tool name, args and result together), `text`, and a
  `data-workspace-metadata` part that carries absolute paths.
  `content.metadata` carries `{modelId, provider, traceId}`. No message
  carries usage.
- **[observed]** Across the runs, `tokenUsage` summed the steps within a
  turn and did not accumulate across turns: run a2 left 203/23/226, and run
  a3, a `-c` continuation of the same thread, left 101/11/112. The likely
  mechanism is a per-process accumulator persisted on the thread, so an
  interactive session may accumulate across its turns. It is a gauge whose
  span is not recorded.
- **[observed]** A run that failed on an unknown model (a1, exit 1) still
  created a thread.
- **[observed]** `--permission-mode deny` still ran a shell tool. Headless
  hooks fire only `PreToolUse` and `PostToolUse`. Observability export is off
  by default. PostHog product analytics are on by default and
  `MASTRA_TELEMETRY_DISABLED=1` turns them off (PROBE.md Hooks, Runs).
- **[doc]** Retention: chat history 90 days, traces 14 days, workflow
  snapshots 30 days.
- **Hypothesis.** Whether the assistant row is rewritten in place as a turn
  streams, whether a rewrite keeps the row's `rowid`, and whether it bumps
  the thread's `updatedAt` were not observed, because each probe run was one
  headless turn.

Lane B, routing Mastra Code's provider traffic through the gateway with
`OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` (PROBE.md Gateway seams), is a
follow-up and not part of this design (D2).

## Motivating scenario

A developer uses Mastra Code in two repositories during a day, continuing one
thread with `-c` after lunch. They expect `hyp query grep <marker>` to find
each turn once, labeled as Mastra Code and attributed to the right
repository. A multi-step turn that ran three shell commands must arrive with
its tool calls and results in order, and a turn that was still streaming
when the daemon read it must settle to one copy, not a fragment plus a
duplicate. Nothing from a `.hypignore`d repository may be recorded, no
absolute path from Mastra Code's workspace metadata may be stored, and
HypAware must never read Mastra Code's `settings.json` or `auth.json`. The
daemon must stay cheap while Mastra Code sits idle.

## Ticket-to-workflow map

| Ticket requirement | Workflow seam | Section |
| --- | --- | --- |
| Mastra Code appears in `hyp setup` (alias `hyp init`) | picker detection (LLP 0130), configure phase (LLP 0131) | #manifest |
| The database is found | path resolution with `db_path` override | #config |
| New turns arrive without user action | poll source | #source |
| Existing history arrives once, bounded | backfill provider, `backfill.window_days` | #backfill |
| A rewritten turn never duplicates rows | reconciliation scope | #reconciliation |
| Privacy controls hold | usage policy, local-only, session exclusions, path drop, not-read list | #privacy |
| `hyp status` explains each state | source health (LLP 0394) | #status |
| Cost stays bounded | stat gate, range reads, tick budget | #cost |

## Decision

### Owner decisions {#owner-decisions}

The orchestrator disposed the seven Research questions on 2026-11-05
(mission record `DISPOSITIONS-research-q10.md`). D1 to D8 restate them as
design decisions; D4 is the one Design narrows, with the reason given.

- **D1. Proceed as Mastra Code, assumption stated visibly.** The adapter
  targets the `mastracode` npm package (#context). The docs name the package
  and the pinned version. Evidence naming another product stops Build.
- **D2. Storage lane only.** Capture reads `mastra.db` read-only through
  `node:sqlite` (#sqlite). The gateway lane is a follow-up.
- **D3. No writes to Mastra Code's files.** HypAware never writes
  `settings.json`, `~/.mastracode`, a project `.mastracode` directory or the
  database. Setup only enables the source.
- **D4. Usage: no LLP 0035 usage columns unless differencing is proven.**
  The disposition allows per-turn usage by differencing where it is
  deterministic. The probe shows `tokenUsage` is a gauge whose span (one
  process, one turn or several) is not recorded with it, and a3 reset it on
  a continued thread, so a difference between two observations can be
  negative, or can cover a turn the daemon never saw. Design therefore
  ships the Crush answer (LLP 0573 D2) by default: the thread's
  `tokenUsage` (the six counters `promptTokens`, `completionTokens`,
  `totalTokens`, `cachedInputTokens`, `cacheCreationInputTokens` and
  `reasoningTokens`, never `raw`) is carried as
  `attributes.mastracode.process_token_usage` on the last part of the latest
  assistant message, and no row carries LLP 0035 usage, so no query that
  sums usage counts it. The attribute is the running counter Mastra Code keeps
  on the thread, written on every step. In 0.49.0 a continued thread adds to
  it rather than resetting it (the a3 reset was not reproduced: the Linux and
  Mac probe runs both took 203/23 to 306/36 on `-c`), but a swallowed write
  failure can leave it short, so it is neither a per-turn value nor a
  guaranteed thread total. T3 (LLP 0587) tried the proof against the pinned
  `@mastra/core` source and the probe samples, and all three conditions
  below fail, so the default ships. Differencing ships only if
  T3 shows the gauge is written once per turn, in the same transaction as
  that turn's assistant row, and accumulates from zero for exactly that
  turn; then the turn's usage is the gauge read with that row, under LLP
  0035 `#net-input` and `#one-carrier`. Otherwise the docs state that
  Mastra Code rows carry no per-turn usage, only that running
  counter. This is guardian question Q5.
- **D5. Detect with a stat gate, a rowid cursor and per-thread state, and
  reconcile a whole thread on any change** (LLP 0449). #reconciliation gives
  the rules.
- **D6. Drop workspace metadata before a row is built.** The
  `data-workspace-metadata` part is never projected, and `projectPath` is
  used only to derive `cwd` and repository identity. No path is logged.
- **D7. Read only two tables.** The reader names `mastra_threads` and
  `mastra_messages` and their columns in every query. It never opens
  `settings.json`, `auth.json`, `mastra-vectors.db`, the observability
  store, or any other `mastra_*` table. A test asserts it.
- **D8. The docs disclose five Mastra Code behaviors:** chat history is kept
  90 days by Mastra Code, so a backfill finds at most that much; PostHog
  product analytics are on by default and `MASTRA_TELEMETRY_DISABLED=1`
  turns them off (one factual sentence); `--permission-mode deny` does not
  stop tools from running; remote Turso and Postgres stores are not
  supported; and thread titles are recorded as content. The retention
  disclosure also says what HypAware keeps (#prune):
  HypAware keeps a thread Mastra Code deletes, but drops messages Mastra
  Code prunes from a thread still in use.

### Plugin and manifest {#manifest}

A bundled plugin `@hypaware/mastracode` at
`hypaware-core/plugins-workspace/mastracode/`, with the goose file set less
discovery: `src/index.js`, `config.js`, `mastra_db.js`, `projector.js`,
`backfill.js`, `source.js`, `watermark.js`, `errors.js`, `git_repo.js`,
`types.d.ts`. There is one database, so there is no `discovery.js`.
`git_repo.js` is copied from goose with a note, as goose copied it from
hermes.

The manifest copies the goose manifest field for field, with these values:

- name `@hypaware/mastracode`, `picker` label `Mastra Code`, summary
  "Records your Mastra Code conversations and imports recent history. Makes
  no changes to Mastra Code.", `detect { settings_file:
  ".local/share/mastracode/mastra.db" }`, `compose { plugin { name },
  requires_gateway: true }`, and no `platforms` field, as goose.
- `node_engine` stays `">=22.12"`, as goose. The runtime check in #sqlite
  covers the JSONB minimum.
- `config_sections`: one, `mastracode`. `sources`: one, `mastracode`, plus a
  backfill provider registered as goose's is.
- No `client` or `skills` contribution, for the goose reason: a per-client
  skill copy changes files under `hypaware-core/skills/`, which needs its own
  owner ask. Listed in the plan's out-of-scope.

The plugin joins the bundled list in `src/core/runtime/bundled.js` next to
goose and crush. It reuses `hyp setup` and its configure phase, `hyp status`,
`hyp backfill` and the scheduled sweep, and adds no command. Re-running the
picker with Mastra Code selected is idempotent and keeps an explicit
`mastracode.enabled = false`, as for goose.

Detection checks that the database's directory exists, so it reads no rows
and never runs Mastra Code. A moved data directory lives in the user's shell
and is not seen by the picker; those users set `db_path`.

**Detection is one HOME-relative probe {#detect-platforms}.** The kernel's
`detect.settings_file` is a single path under HOME with no per-platform
variant, so `detect` names the Linux default only. The per-platform default
lives in the config resolver (#config step 5), which is code. The outcomes:

- **Linux:** the probe matches the default, so the picker pre-checks Mastra
  Code when its database exists.
- **macOS:** the probe misses `~/Library/Application Support/mastracode/`,
  so the picker offers Mastra Code unchecked. Picking it works, because the
  resolver finds the macOS default. This gap is accepted and recorded in
  #open-questions and the T8 docs. A per-platform `detect` would be a
  separate kernel design. G-A has two outcomes: if it confirms the
  documented macOS path, nothing here changes and the gap stays; if it shows
  a different path, the resolver default is amended before T2 lands.
- **Windows:** the row sets no `platforms` gate. LLP 0368 `#platform-gate`
  reserves the gate for an operating system with no capture path at all,
  and Windows has a documented one (`%APPDATA%\mastracode\`, #context), so
  Mastra Code is offered unchecked as on macOS and the resolver uses that
  default. No run validates Windows; the T8 docs say so and #open-questions
  records it.

### Config {#config}

```toml
[mastracode]
enabled = true
db_path = "/absolute/path/to/mastra.db"  # optional
poll_interval = "60s"
```

| Key | Goose precedent | Rule |
| --- | --- | --- |
| `enabled` | `goose.enabled`, default true (`resolveGooseEnabled`) | boolean, default true: absent means on and only `false` turns capture off |
| `db_path` | `goose.sessions_db` | non-empty string; a leading `~` is expanded when the path is resolved, not by the validator |
| `poll_interval` | `goose.poll_interval`, default 60 s | positive ms or a duration string |

Unknown keys are rejected. The kernel-generic `backfill` block (`on_join`,
`window_days`, LLP 0037) is accepted, as goose and crush accept it. The busy
retry, both budgets, the watermark cap and the sweep cadence are code
constants, not keys.

The database path is the first that applies:

1. `mastracode.db_path`;
2. `$MASTRA_DB_PATH`;
3. `$MASTRA_APP_DATA_DIR/mastra.db`;
4. `$XDG_DATA_HOME/mastracode/mastra.db` (Linux only: Mastra Code ignores
   it on macOS and Windows);
5. the platform default (#context).

An environment value counts only when it is set in the daemon's environment
and absolute. A daemon started by launchd or systemd inherits none of them,
so a user who moved the database sets `db_path`. When `MASTRA_DB_URL` is set
in the daemon's environment, Mastra Code writes to a remote store, so the
source reports `remote_store_unsupported` and reads no local file, even if
one exists, because it would be stale.

### Reading mastra.db {#sqlite}

As goose (LLP 0570 `#sqlite`): `node:sqlite` `DatabaseSync` with
`readOnly: true`; never write, never take a write lock, never checkpoint;
retry `SQLITE_BUSY` and `SQLITE_LOCKED` up to 5 times, 20 ms apart, then fail
the tick with `error_kind` `sqlite_busy` and leave the watermark as it was.

On open the reader checks `sqlite_version()` is at least 3.45, the first
release that reads JSONB through `json()`. Below that the source reports
`sqlite_unsupported` and stops reading, rather than writing rows with no
metadata. The `ExperimentalWarning` `node:sqlite` prints on the node versions
the engine allows is the one goose and crush already accept.

The reader checks that both tables and every column it reads exist. A
missing table or column is `schema_unsupported`, naming it. An additive
column or table is ignored, so upstream additions do not stop capture;
upstream-watch flags new releases for review.

The connection is opened when a tick needs it and closed before the tick
ends, as crush. Each thread is read inside one read transaction (LLP 0449
`#read-commit-guard`), so its metadata and messages come from one snapshot.

The crush self-check found a read-only reader can create SQLite's own empty
`-wal` and `-shm` when they are absent (LLP 0573 `#sqlite`). Mastra Code left
its `-wal` in place at exit in the probe, so the case may be rare, but the
change gate still leaves `-shm` out and records the signature after the
reader closes. Gate G-A repeats the check on macOS.

### Projection {#projection}

One Mastra Code message becomes zero or more parts, in `(createdAt, rowid)`
order. Key: `(session_id, part_id)`.

- `session_id` is `mastracodeScopeId(threadId)`, `mastracode-<threadId>`, as
  `gooseScopeId` does, so a Mastra Code id never collides with another
  client's.
- `part_id` is deterministic from the thread id, the message `id` and the
  part index. Message ids are UUIDs, so a rewritten assistant row keeps its
  part ids as it grows.
- A user message (`role = signal`, `type = user`) gives a user part from its
  text parts. Other `signal` types are skipped and counted, never projected
  as prompts.
- An assistant message gives, in content order: an assistant part per
  `text` part, and per `tool-invocation` part a tool-call part (tool name,
  parsed args) followed by a tool-result part (result) when the invocation's
  `state` is `result`. An invocation in any other state gives only its
  tool-call part, and the open-thread rule (#reconciliation step 5) reads it
  again when it completes.
  `step-start` gives no part; its model rides on the parts of its step.
  `data-workspace-metadata` gives no part (D6). Any other part type,
  `reasoning` included, is skipped and counted (#open-questions).
- **No error flag.** Mastra Code's `tool-invocation` part carries no error
  field, so a tool-result part sets none. The one error signal in the probe,
  `data-sandbox-exit`, is a separate part and stays skipped and counted;
  joining it to its invocation by `toolCallId` is a later change
  (#open-questions).
- The model is the step's `step-start` model, else `content.metadata.modelId`,
  else the thread's `currentModelId`. The provider is `content.metadata.provider`
  else the provider segment of the model id.
- `client_name`, `conversation_source` and `entrypoint` are `mastracode`.
  Mastra Code has no sub-agent sessions in the probe, so there is no second
  entrypoint.
- `cwd` is the thread's `projectPath`, and repository identity comes from it
  through the git-repo helper. It is the marking #privacy's local-only
  withholding and usage policy read. `resourceId` and the owner hash are not
  projected.
- Provenance carries `client_name`, the native thread id, and the database
  path as `source_path`, which stays in the row and is never logged.
- Usage as D4.

There is no session-end part: threads have no end marker, so LLP 0122
`#session-end-part` does not apply.

### Reconciliation and watermark {#reconciliation}

Mastra Code stores a whole multi-step turn in one assistant row, so capture
follows LLP 0449. Each changed thread is emitted as a full snapshot with the
scope `client_name = mastracode AND session_id`, through the kernel's
reconcile storage call, for the poll and backfill alike.

The watermark sidecar lives in `ctx.paths.stateDir`. It holds:

- for the database: `{stat_sig, max_rowid, floor}`, where `stat_sig` is the
  size, mtime in nanoseconds and inode of `mastra.db` and `mastra.db-wal`
  (never `-shm`), and `floor` is an `updatedAt` value at or below which a
  thread with no entry is history, not a candidate;
- per thread: `{updated_at, message_count, max_rowid, open, digest}`, where
  `open` records that the thread's digest changed on its last reconcile.

A failed commit advances nothing (LLP 0449 `#detection`), and an entry
without a digest forces a reconcile.

**Deviation from LLP 0449 `#detection` and from goose's `data_version`
gate, with the reason.** Goose holds one connection and gates on `PRAGMA
data_version`. This design follows crush instead and gates on file metadata
with a short-lived connection: no file descriptor or page cache is held
between ticks, a replaced database is seen by its inode, and the idle cost is
two stats. With one database the held connection would be affordable, but
the stat gate also needs no new reasoning, and LLP 0573 already carries it.

1. **Gate.** Each tick stats `mastra.db` and `mastra.db-wal`. An unchanged
   signature is taken to mean nothing was committed, so the database is not
   opened. That rests on the crush hypothesis (every WAL commit grows or
   rewrites the WAL, and a checkpoint rewrites the main file), tested in T4
   on Linux and in G-A on macOS. If it fails, the gate falls back to a
   per-tick `data_version` read on a short-lived connection. A false
   positive only costs one open. The signature is recorded after the reader
   closes, only when it agrees with the before-open one (or differs only by
   the reader's own empty `-wal`) and every candidate was admitted;
   otherwise the before-open signature is kept and the next tick reads
   again.
2. **Changed database.** Two reads:
   - `mastra_messages WHERE rowid > max_rowid`, selecting `thread_id` only,
     giving the threads with new rows. This must be a rowid range search.
   - `mastra_threads` `id` and `updatedAt`. With no known index on
     `updatedAt` this is a scan of the threads table, which is one small row
     per thread (the JSONB `metadata` is not selected here) and is read only
     when the signature moved. This is accepted and stated in #cost.
3. **Candidates** are threads with new rows, threads whose `updatedAt`
   differs from their entry, threads with no entry whose `updatedAt` is
   above the `floor`, and threads whose entry is `open`. For each candidate,
   one read gets `COUNT(*)` and `MAX(rowid)` for the thread, which must
   search an index on `thread_id` (#open-questions).
4. **Skip without hashing** only when `updatedAt`, the count and
   `max_rowid` all match and the entry is not `open`.
5. **Open threads stay candidates until they settle.** A rewrite of the
   assistant row in place adds no row and may not bump `updatedAt`
   (#context, hypothesis), so a thread whose digest changed on its last
   reconcile is hashed again on every tick where the database changed.
   `open` clears when a hash finds the digest equal to the entry. A rewrite
   that finishes between two changed-database ticks is therefore read on
   the next one; a rewrite after the last write the daemon saw is caught by
   the sweep. Open threads are never pending (#source) and never schedule a
   catch-up tick.
6. **The scheduled sweep** hashes every thread in scope and catches any
   other in-place edit, up to one sweep interval late.

On first start the cursor is set to the current `MAX(rowid)`, the `floor` to
the greatest `updatedAt` observed, and the signature recorded, so the poll
neither walks nor hashes history; history is the backfill's job
(#backfill).

**Mastra Code's 90-day prune** {#prune}. Mastra Code deletes old chat
data (D8), and the two ways it can do so give two outcomes:

- **Messages pruned from a thread that still exists** are removed from the
  cache on that thread's next reconcile, because the reconcile is a full
  snapshot of the thread (LLP 0449 `#reconciliation`). The poll sees it when
  the thread next changes; otherwise the sweep does.
- **A thread pruned whole** keeps its cached rows. The sweep prunes only its
  watermark entry and raises the `floor`; whole-session deletion is outside
  the reconcile protocol (LLP 0449 Boundaries).

Whether the prune removes whole threads, single messages or both is not
known from the probe (#open-questions); T3 reads it from the pinned source
and the docs state the outcome either way.

**Watermark scope and bound.** Entries exist only for threads in the sweep's
scope; each sweep prunes deleted and out-of-scope threads. The sidecar is
capped at 10,000 thread entries; past the cap the entry with the oldest
`updated_at` is evicted, and evicting or pruning raises the `floor` to at
least that entry's `updated_at`, as crush.

### Source {#source}

`startMastracodeSource` follows LLP 0570 `#source`. Start awaits one bounded
tick, then ticks every `poll_interval`. Each tick:

- resolves the database path (#config) and stats it;
- when the signature moved, opens the database, admits candidate threads in
  `updatedAt` order, at most 64 threads, and stops admitting at 4096
  projected rows (LLP 0527 `#tick-budget`);
- commits one batch through `reconcileRowsBatch`, flushes the watermark once
  after the commit, and schedules a catch-up tick one second later while a
  non-open candidate was left unadmitted.

A thread whose scope guard another writer holds is deferred and holds the
cursor and signature, as in goose. Shutdown awaits the in-flight tick, which
closes its connection before it resolves, so no connection outlives the
source.

### Backfill {#backfill}

The backfill provider reuses the reader and projector. Its scope, for the
join-time import and the scheduled sweep (LLP 0359 `#sweep-context`), is
every thread whose `updatedAt` falls inside `backfill.window_days` when it
is set, and every thread when it is unset. Mastra Code's own 90-day chat
retention bounds what exists (D8), and its prune follows #prune. It reads one thread at a time on one
connection. A re-run reconciles and does not append. It waits a bounded
time on a held scope guard, then fails that thread with
`cache_partition_mutation_busy`, as goose does.

### Privacy {#privacy}

- **Usage policy (LLP 0050):** a thread whose `projectPath` resolves to
  `ignore` is not projected by the poll or backfill. A directory that
  becomes ignored has its threads' rows removed by empty snapshots, under
  the usage-policy rules of LLP 0449.
- **Local-only (LLP 0070):** rows carry the standard machine-local marking,
  so export withholds them through the existing seam.
- **Session exclusions (LLP 0403 `#storage`):** as goose (LLP 0570
  `#privacy`): the durable `SessionIgnoreSet` is loaded at activation and
  per backfill run; the poll uses Copilot's admission check only on ticks
  with candidates; the checked id is `mastracodeScopeId(threadId)`; a load
  error fails closed. An excluded thread is not projected and its entry does
  not advance. The control is `hyp session ignore` with that id; on a
  Mastra-Code-only install it exits status-unknown, as on a Goose-only
  install (#2860), and directory markings are the working control.
- **Workspace paths (D6):** the `data-workspace-metadata` part is dropped in
  the projector before a row is built, so no value from it (its
  `filesystem` and `sandbox` objects) appears in any row. `cwd`
  (`projectPath`) and `source_path` are the only path-bearing columns.
- **What HypAware does not read (D7):** `settings.json`, `auth.json`,
  `mastra-vectors.db`, the observability store, `~/.mastracode`, project
  `.mastracode` directories, and every table other than the two named.
- **Titles:** content, as goose D3: projected only through
  `captureSessionTitle`, under the same redaction, opt-out and export rules.
- **Diagnostics:** logs and spans carry counts, ids and error kinds, never
  message text, titles, `projectPath` or the database path.

### Status {#status}

The source reports its own health (LLP 0394).

| State | Source health | `hyp status` message |
| --- | --- | --- |
| No database | `ready`, rowsWritten 0 | no mastracode installation detected at `<db path>` |
| Ready, no traffic | `ready`, rowsWritten 0 | polling mastracode every `<N>`ms, no threads yet |
| Recording | `ready`, rowsWritten > 0 | polling mastracode every `<N>`ms |
| Unreadable | `degraded`, `error_kind` `permission_denied` | cannot read the mastracode database at `<db path>` |
| Locked or busy | `degraded`, `error_kind` `sqlite_busy` | mastracode database busy, retrying next poll |
| Unsupported schema | `degraded`, `error_kind` `schema_unsupported` | names the missing table or column |
| Old SQLite | `degraded`, `error_kind` `sqlite_unsupported` | needs SQLite 3.45 or newer, found `<version>` |
| Remote store | `degraded`, `error_kind` `remote_store_unsupported` | MASTRA_DB_URL is set; remote stores are not supported |
| Disabled | source not started | mastracode ongoing capture disabled (mastracode.enabled = false) |

Each tick logs `mastracode.poll` with `component=mastracode`, `operation`,
`status`, `changed`, `threads_changed`, `threads_pending`, `parts_skipped`,
`rows` and `error_kind`.

### Cost {#cost}

- **Idle.** Two `stat` calls per tick, no open, no read. Constant, whatever
  the history size.
- **A changed database** costs one open, the rowid range read (O(new rows)),
  the threads scan (O(threads), small rows), and one count-and-max read per
  candidate.
- **Each changed thread** costs a streamed digest and, when it moved, a
  projection, both O(that thread's length). An open thread is re-hashed on
  each changed-database tick until a hash finds it unchanged, so a long
  thread being written is the expensive case. The 64-thread and 4096-row
  budget caps a tick.
- **The scheduled sweep** streams every thread in scope once per sweep:
  O(messages in scope), bounded by `backfill.window_days` when set and by
  Mastra Code's 90-day retention.
- **Memory** holds one connection and one thread's projection while
  hashing, the batch's projections until commit, and a watermark of at most
  10,000 thread entries. No connection or page cache is held between ticks.
- **What grows:** idle cost does not grow; per-tick work grows with changed
  threads and their length; the sweep and the join-time import grow with the
  backlog in scope; Iceberg metadata grows with cache size (LLP 0449). Each
  is bounded by the budgets, caps and retention above.

## Coverage map

| Coverage row | Seam | Test |
| --- | --- | --- |
| 1 Product | pinned version and identity assumption in docs and the upstream-watch entry | Linux probe, G-A |
| 2 Upstream watch | `mastracode` entry in `targets.json` at Close (G-UW) | upstream-watch `npm test` |
| 3 Detection | manifest `detect`, `INIT_SOURCE_CHOICES`, `PickerSource`; path resolution | `test/core/init-source-choices.test.js` present and absent cases; config tests for each step of #config and `MASTRA_DB_URL` |
| 4 Onboarding | picker and the `hyp setup` configure phase | `walkthrough_picker_to_first_query` with Mastra Code; a repeat picker run keeps `enabled = false`; other clients' config untouched |
| 5 Lifecycle | `enabled`, read-only reader, D3 | config test, smoke disable step; a test that no Mastra Code file is written |
| 6 Collection | reader, projector, reconciliation | projector tests (user signal, multi-step assistant row, tool-invocation pairs, skipped parts, model fallback, usage per D4); reconcile tests for a rewritten assistant row and a continued thread; `mastracode_capture` smoke |
| 7 History | backfill, window, busy retry, restart | backfill tests; a restart does not re-import; the sweep recovers threads written while the daemon was down |
| 8 Privacy | policy skip, session exclusions, local-only, D6 drop, D7 table guard, title rule | projector policy tests, exclusion admission test, a local-only case in the smoke, a test that fails if any query names another table or opens another file, `source_optout_export_withhold` |
| 9 Query | `ai_gateway_messages` rows, session graph | smoke SQL and grep readback; the session graph groups by thread id |
| 10 Status | source health | source status tests for each row of #status |
| 11 Cost | stat gate, rowid range read, tick budget, watermark cap | source tick tests on a fixture with many threads and messages; `EXPLAIN QUERY PLAN` check |
| 12 Docs | `docs/integrations/mastracode.md`, `docs/INTEGRATIONS.md` row, README, CLIENTS, PRIVACY, TROUBLESHOOTING | doc commands run in the sandbox |
| 13 Packaging | bundled list, `npm pack` | `npm pack --dry-run`, sandbox, Mac recipe run |

The docs follow `docs/integrations/goose.md`: what is recorded, setup,
history import, and limits (usage per D4, the D8 disclosures, `db_path` for
a moved database). `docs/PRIVACY.md` gains Mastra Code in its client table
and the lists of recorders whose exclusions persist and whose backfill
honors them, and names the files HypAware never reads.
`docs/TROUBLESHOOTING.md` gets the entries in #status.

## Consequences

- Mastra Code rows look like goose and crush rows: same table, same
  reconcile behavior, same privacy seams. Query and export need no change.
- Unless T3 proves differencing, Mastra Code rows carry no LLP 0035 usage; a
  usage report shows Mastra Code turns with null usage and the latest
  process's token counter attribute, which is not a thread total.
- Idle cost is two stats per poll.
- Remote stores and the gateway lane are not covered; the docs say so.
- A schema change that removes a needed column degrades the source with a
  named error rather than writing wrong rows.

## Open questions {#open-questions}

For the guardian design review:

- **Q5, differencing proof.** Can T3 show from the pinned `@mastra/core`
  1.82.0 source and the probe samples that `tokenUsage` is written once per
  turn with that turn's assistant row and starts from zero for it (D4)? If
  not, the docs describe the latest process's counter, not a thread total
  (D4), and no row carries LLP 0035 usage.
  If it is proven, is the cache mapping right: input = `promptTokens` minus
  `cachedInputTokens` floored at 0 (LLP 0035 `#net-input`), cache read =
  `cachedInputTokens`, cache write = `cacheCreationInputTokens`, output =
  `completionTokens`, reasoning = `reasoningTokens`? Is `promptTokens`
  gross of cached input for every provider Mastra Code supports?
- **Indexes.** The probe recorded no index. Build reads the pinned
  `@mastra/libsql` 1.29.0 source for the indexes it creates and checks the
  reads with `EXPLAIN QUERY PLAN` on a fixture: the messages read must
  search by rowid and the per-thread count-and-max must use an index on
  `thread_id`. The threads read is an accepted scan. If a required search
  scans, Build stops and returns to design review rather than shipping it.
- **In-place rewrites.** Does a streaming turn rewrite the assistant row in
  place, keeping its `rowid`, and does it bump `updatedAt`? #reconciliation
  step 5 covers all three answers; T3 pins the one the source shows, and
  if a rewrite deletes and re-inserts the row, the rowid cursor already
  sees it.
- **Stat gate.** Does every commit move the `mastra.db` or `-wal`
  signature, including a WAL reset after checkpoint? T4 on Linux, G-A on
  macOS; fallback as #reconciliation step 1.
- **macOS path and read side effects.** G-A confirms the macOS default
  directory, the JSONB read on the Mac's node, and which `-wal` and `-shm`
  files a read-only open creates. If G-A confirms the documented path,
  nothing changes and the macOS picker gap (#detect-platforms) stays; if it
  shows a different path, the resolver default and this design are amended
  before T2 lands. `detect` keeps the Linux probe either way.
- **Windows.** Mastra Code is offered on Windows with the documented
  `%APPDATA%\mastracode\` default and no `platforms` gate
  (#detect-platforms), but no run validates it. Is a Windows probe wanted
  before release, or is the docs disclosure enough?
- **Prune granularity.** Does Mastra Code's 90-day retention delete whole
  threads, single messages, or both? T3 reads it from the pinned source;
  #prune states the outcome for each.
- **Tool errors.** The `tool-invocation` part has no error field
  (#projection). Should a later change join `data-sandbox-exit` to its
  invocation by `toolCallId` to set an error flag, or does it stay
  skipped and counted?
- **SQLite minimum.** Is a runtime `sqlite_unsupported` check enough, or
  should `node_engine` rise to the first node whose bundled SQLite is 3.45
  or newer?
- **Reasoning parts.** The probe saw none. Should `reasoning` parts be
  projected as reasoning parts, as crush does, once a sample shows their
  shape, or stay skipped and counted?
- **Deny mode.** Is the D8 note that `--permission-mode deny` still ran a
  tool a doc disclosure only, or should it be raised upstream?
- **Remote stores.** Is `remote_store_unsupported` on `MASTRA_DB_URL` the
  right signal, given a launchd or systemd daemon will rarely see the
  variable?
- **Identity.** The D1 assumption stands unless evidence names another
  product.
