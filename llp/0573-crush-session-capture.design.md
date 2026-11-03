# LLP 0573: Crush session capture - technical design

**Type:** Design
**Status:** Draft
**Systems:** Sources, Plugins
**Author:** HypForge
**Date:** 2026-11-03
**Related:** LLP 0570, LLP 0571, LLP 0118, LLP 0119, LLP 0120, LLP 0121, LLP 0122, LLP 0123, LLP 0124, LLP 0449, LLP 0527, LLP 0359, LLP 0035, LLP 0050, LLP 0070, LLP 0130, LLP 0131, LLP 0394, LLP 0403, LLP 0549, LLP 0553, LLP 0574

> Buildable design for a `@hypaware/crush` client adapter. Status stays Draft
> until the Build tasks in LLP 0574 land.
> `@ref LLP 0570 [constrained-by]`: the goose adapter is the template; this
> design names only where Crush differs and why.
> `@ref LLP 0118 [constrained-by]`: same shape of capture as hermes, a pull
> from the product's own local store with no proxying.
> `@ref LLP 0119 [constrained-by]`: Crush is never modified or proxied; every
> `crush.db` is opened read-only.
> `@ref LLP 0120#row-semantics [implements]`: rows are `ai_gateway_messages`
> rows through `ai_gateway.projected_exchange`, not a new table.
> `@ref LLP 0122 [constrained-by]`: config, SQLite access, watermark sidecar,
> source and backfill provider follow the hermes design.
> `@ref LLP 0449 [implements]`: Crush edits stored messages in place and
> deletes summaries, so capture uses the session reconciliation scope, digest
> and read-to-commit guard.
> `@ref LLP 0527 [implements]`: each poll tick reconciles a budgeted batch.
> `@ref LLP 0359#sweep-context [constrained-by]`: `backfill.window_days`
> bounds the join-time import and the scheduled sweep.
> `@ref LLP 0035#per-turn [constrained-by]`: Crush stores no per-turn usage,
> so no row carries LLP 0035 usage.

## Context

Crush (charmbracelet/crush, FSL-1.1-MIT) is a terminal coding agent with a
TUI and a headless `crush run`. The Research and Probe phases of mission
HYP.0.243.2 ran Crush v0.99.0 (tag commit `e38655aa`) against a loopback
fixture provider on Linux and read its pinned source. The probe drove only
headless `crush run` with one provider type (`completions`), so each fact
below is tagged: **[observed]** means the v0.99.0 Linux probe showed it
(mission `probe/PROBE.md`), **[source]** means it was read from the pinned
source and is a hypothesis until a fixture or validation run drives it. The
TUI, `crush server`, the session subcommands, other provider types,
summarize, cancel, and session delete and rename were not driven. The facts
this design rests on:

- **Storage is per project.** [observed] Each project gets `<git root>/.crush/` holding
  `crush.db` (SQLite, WAL mode), a `.gitignore` of `*`, and
  `logs/crush.log`. Starting Crush in a subdirectory uses the git root's
  data dir.
- **A global index names every project.** [observed for the default path and
  the entry shape; source for the variables] `projects.json` lives in the
  global data dir: `$CRUSH_GLOBAL_DATA` if set, else `$XDG_DATA_HOME/crush`,
  else `~/.local/share/crush`. Each entry is `{path, data_dir, last_accessed}`.
  Several entries can share one `data_dir` (a subdirectory start records its
  own `path`).
- **Schema.** [observed, except the history] Goose-style migrations in `goose_db_version`, latest applied
  `20260928000001`. Tables `sessions`, `messages`, `files`, `read_files`,
  `mcp_disabled_servers`, `mcp_enabled_servers`. The schema moved five times
  in four weeks before the pin [source: migration history].
- **`sessions`:** [observed] text `id` primary key, `parent_session_id`, `title` (not
  null), `message_count`, `prompt_tokens`, `completion_tokens`, `cost`,
  `updated_at` and `created_at` (integer seconds), `summary_message_id`,
  `todos`, `channel`. An `AFTER UPDATE` trigger sets `updated_at`. There is
  no index on `updated_at`; `idx_sessions_created_at` exists.
- **`messages`:** [observed schema dump; rowid reuse is source] text `id`
  primary key over an implicit `rowid` (no `AUTOINCREMENT`, so the largest
  rowid can be reused after its row is deleted), `session_id` (foreign key, cascade delete), `role` (`user`,
  `assistant`, `tool`), `parts` (a JSON array), `model`, `provider`,
  `created_at`, `updated_at`, `finished_at`, `is_summary_message`. Insert and
  delete triggers keep `sessions.message_count`, which bumps
  `sessions.updated_at`. Indexes: `idx_messages_session_id`,
  `idx_messages_created_at`, `idx_messages_role_created_at`.
- **Parts** [observed: `text`, `tool_call`, `tool_result`, `finish`; the rest
  source] are `{"type", "data"}`: `text`, `reasoning`, `image_url`,
  `binary`, `tool_call` (`id`, `name`, `input` as a JSON string, `finished`),
  `tool_result` (`tool_call_id`, `name`, `content`, `metadata` as a JSON
  string, `is_error`), `finish` (`reason`, `time`) and `shell_command`
  (`command`, `output`, `exit_code`). A user message whose part is a
  `shell_command` is the user's own `!` shell run, not a prompt.
- **Ordering needs rowid.** [observed] All of one probe session's messages shared one
  `created_at` second. Crush orders by `created_at`; a reader adds `rowid`.
- **Tool results embed the working directory.** [observed] `content` ends with
  `<cwd>...</cwd>` and `metadata` holds `working_directory`.
- **Session usage is a gauge, not a total.** [observed: prompt minus
  completion stays 90 across steps in the Part A dry run; the mechanism,
  summarize and the parent roll-up are source] Each step sets
  `prompt_tokens` and `completion_tokens` to that step's values (agent
  `updateSessionTokenCounters`), and summarize sets `prompt_tokens` to 0.
  Only `cost` accumulates (`session.Cost += cost`), it is 0 under a flat-rate
  provider, and a parent's `cost` includes its task children's cost.
- **Sessions.** [source for the task id format; the separate title call is
  observed] A sub-agent task session has `parent_session_id` set and the
  id `<messageID>$$<toolCallID>`. A title session has the id `title-<parent>`.
- **Summaries.** [source] Summarize inserts an assistant message with
  `is_summary_message = 1` and points `summary_message_id` at it. Older
  messages are kept. If summarize fails, the summary message is deleted.
- **Streaming.** [source] An assistant message is created empty and updated in place
  as it streams. Updates are debounced; a terminal change flushes at once.
  `finished_at` is set only on assistant messages when they finish.
- **The request carries more than the DB keeps.** [observed] An injected context user
  message is sent to the provider and not stored.
- **Outbound.** [observed] With metrics and provider auto-update off, the only attempt
  was the `api.github.com` update check. Crush has no OTLP exporter.
  `crush.log` holds lifecycle lines, no content.

Which writes bump `sessions.updated_at` (the append row and the session
update trigger are observed; the other rows are source):

| Write | Rows | Bumps `updated_at` |
| --- | --- | --- |
| Append a message | new `messages` row | yes (insert trigger) |
| Stream into a message | `messages` row updated in place | no |
| Delete a message (failed summary) | `messages` row removed | yes (delete trigger) |
| Rename, usage, cost, todos, channel | `sessions` row updated | yes |
| Delete a session | session and its messages removed | n/a (row gone) |

## Motivating scenario

A developer works in three repositories with Crush during a day. Each
repository has its own `.crush/crush.db`. One session runs a sub-agent task
and later summarizes. They expect `hyp query grep <marker>` to find each turn
once, labeled as Crush and attributed to the right repository. A streamed
reply that Crush updated in place must arrive whole, not as a fragment plus a
duplicate. Nothing from a `.hypignore`d repository may be recorded, no file
contents from Crush's `files` table may appear, and no absolute path from a
tool result may be stored. Their daemon must stay cheap while forty other
projects listed in `projects.json` sit idle.

## Ticket-to-workflow map

| Ticket requirement | Workflow seam | Section |
| --- | --- | --- |
| Crush appears in `hyp setup` (alias `hyp init`) | picker detection (LLP 0130), configure phase (LLP 0131) | #manifest |
| Every project's sessions are found | `projects.json` discovery plus `data_dirs` | #discovery |
| New turns arrive without user action | poll source | #source |
| Existing history arrives once, bounded | backfill provider, `backfill.window_days` | #backfill |
| In-place updates never duplicate rows | reconciliation scope | #reconciliation |
| Privacy controls hold | usage policy, local-only, session exclusions, path strip, `files` never read | #privacy |
| `hyp status` explains each state | source health (LLP 0394) | #status |
| Cost stays bounded across many projects | per-DB stat gate, range reads, open budget, tick budget | #cost |

## Decision

### Owner decisions {#owner-decisions}

The orchestrator accepted defaults for D1 to D8 on 2026-11-03 (22:03Z), with
the note that Design confirms feasibility and may overturn a default with a
reason here. D2 is overturned; the others stand as accepted.

- **D1. Discovery is `projects.json` plus an optional `data_dirs` list.** The
  index names every project Crush has opened, so no disk walk is needed. A
  `data_dirs` list (absolute paths to `.crush` directories) covers a moved
  global data dir that the daemon cannot see and a project whose index entry
  was lost. It mirrors goose's `sessions_db` override. The picker checks only
  the default index path. See #discovery.
- **D2. Usage: overturned. No row carries token usage.** The accepted default
  attached session totals to one row. The source shows the premise does not
  hold: `prompt_tokens` and `completion_tokens` are set, not added, on every
  step, so they describe the last step's context window, and summarize resets
  one of them to 0. Writing them as LLP 0035 usage on any row would report a
  gauge as consumption, and summing rows would be wrong whichever row carried
  them (LLP 0035 `#per-turn`, `#one-carrier`). Per-message usage stays absent,
  which LLP 0035 already allows for a client that does not expose it. The one
  accumulating figure, `cost`, is carried as
  `attributes.crush.session_cost_usd` on the last part of the latest
  assistant message of a root session only, because a parent's cost already
  includes its children's. It is omitted when 0, since a flat-rate provider
  reports 0 for real work. It is a Crush attribute, not a usage column, so no
  query that sums usage counts it. The docs say Crush exposes no per-turn
  usage.
- **D3. Import task sessions, skip title sessions.** A task session
  (`parent_session_id` set) is its own session, linked to its parent through
  provenance and `parent_thread_id`, as goose D2. A session whose id is
  `title-<parent>` is skipped in the reader query, so its messages are never
  read.
- **D4. Detect with cursors plus per-session state, order by
  `(created_at, rowid)`, and reconcile on any change.** An in-place update or
  a deleted summary re-projects the whole session, so a logical record is
  never duplicated. #reconciliation gives the exact rules, including the two
  that a rowid cursor alone would miss.
- **D5. Strip working-directory paths before a row is built.** The trailing
  `<cwd>...</cwd>` element of tool-result `content` and the
  `working_directory` key of tool-result `metadata` are removed in the
  projector. No path is logged.
- **D6. Never open the `files` or `read_files` tables.** `files` holds full
  file contents and history. The reader names its tables and columns in every
  query; no query uses `*` or touches those tables. A test asserts it.
- **D7. Session titles are content,** as goose D3: projected only where
  message text is, through `captureSessionTitle`, under the same redaction,
  opt-out and export rules, and never in a log, span, status line or file
  name.
- **D8. The docs disclose two Crush behaviors.** Crush checks
  `api.github.com` for updates unless that is turned off, and its stored
  transcript omits the context message it injects into each request, so the
  rows hold what the user and model wrote, not the whole request.

### Plugin and manifest {#manifest}

A bundled plugin `@hypaware/crush` at
`hypaware-core/plugins-workspace/crush/`, with the goose file set:
`src/index.js`, `config.js`, `discovery.js`, `crush_db.js`, `projector.js`,
`backfill.js`, `source.js`, `watermark.js`, `errors.js`, `git_repo.js`,
`types.d.ts`. `discovery.js` is the one new module (#discovery). `git_repo.js`
is copied from goose with a note, as goose copied it from hermes.

The manifest copies the goose manifest field for field, with these values:

- name `@hypaware/crush`, `picker` label `Crush`, summary "Records your Crush
  conversations and imports recent history. Makes no changes to Crush.",
  `detect { settings_file: ".local/share/crush/projects.json" }`, `compose {
  plugin { name }, requires_gateway: true }`. Mac Part A confirms the macOS
  default before Build relies on it (#open-questions).
- `config_sections`: one, `crush`. `sources`: one, `crush`, plus a backfill
  provider registered as goose's is.
- No `client` or `skills` contribution, for the goose reason: a per-client
  skill copy changes files under `hypaware-core/skills/`, which needs its own
  owner ask. Listed in the plan's out-of-scope.

The plugin joins the bundled list in `src/core/runtime/bundled.js` next to
goose. It reuses `hyp setup` and its configure phase, `hyp status`, `hyp
backfill` and the scheduled sweep, and adds no command. Re-running the picker
with Crush selected is idempotent and keeps an explicit
`crush.enabled = false`, as for goose.

Detection is a path existence check, so it reads no rows and never runs
Crush. A custom `CRUSH_GLOBAL_DATA` or `XDG_DATA_HOME` lives in the user's
shell and is not seen by the picker; those users set `data_dirs`.

### Config {#config}

```toml
[crush]
enabled = true
data_dirs = ["/absolute/path/to/project/.crush"]  # optional
poll_interval = "60s"
```

| Key | Goose precedent | Rule |
| --- | --- | --- |
| `enabled` | `goose.enabled` | boolean |
| `data_dirs` | `goose.sessions_db`, as a list because Crush has a database per project | array of non-empty strings; a leading `~` is expanded when the path is resolved, not by the validator; at most 256 entries |
| `poll_interval` | `goose.poll_interval`, default 60 s | positive ms or a duration string |

Unknown keys are rejected. The kernel-generic `backfill` block (`on_join`,
`window_days`, LLP 0037) is accepted, as goose, antigravity and copilot accept
it. The busy retry, both budgets, the title-session skip, the watermark cap
and the sweep cadence are code constants, not keys.

The index path is `$CRUSH_GLOBAL_DATA/projects.json` when that variable is
set in the daemon's environment and absolute, else
`$XDG_DATA_HOME/crush/projects.json` on the same condition, else
`~/.local/share/crush/projects.json`. A daemon started by launchd or systemd
does not inherit either variable, so those users set `data_dirs`.

### Discovery {#discovery}

The database set is the union of the index and `data_dirs`:

1. Read `projects.json` when its stat signature (size, mtime, inode) moved
   since the last read, else reuse the cached list. A missing index is not an
   error: `data_dirs` may still name databases, and status says which case
   applies (#status). A malformed index is a `degraded` state with
   `error_kind` `index_unreadable`; the last good list stays in use.
2. Take each entry's `data_dir`, add each `data_dirs` entry, resolve each to
   its real path and deduplicate by it. Several index entries share one
   `data_dir`; they are one database.
3. The database is `<data_dir>/crush.db`. A `data_dir` whose `crush.db` does
   not exist is a stale entry: it is counted and skipped, not an error.
4. The project directory, for repository identity and usage policy, is the
   `data_dir`'s parent, which is the git root Crush chose.

The set is capped at 1,024 databases; past the cap the extra entries are
counted in status and skipped, in index order. A later project added to
`projects.json` is found on the next tick after the index changes.

**Session id collision.** Copying a project directory copies its
`crush.db`, so two databases can hold the same session id. The first
database to commit a session id owns it, recorded in the watermark; the same
id seen in another database is skipped and counted, and status shows
`session_collision` until the duplicate goes away. Rows are never merged
across databases.

### Reading crush.db {#sqlite}

As goose (LLP 0570 `#sqlite`): `node:sqlite` `DatabaseSync` with
`readOnly: true`; never write, never take a write lock, never checkpoint;
retry `SQLITE_BUSY` and `SQLITE_LOCKED` up to 5 times, 20 ms apart, then
fail that database for the tick with `error_kind` `sqlite_busy` and leave
its watermark as it was.

A read-only reader writes no content and never checkpoints, but it is not
free of side effects on the directory. The steward's Linux self-check
(node 24.2 `node:sqlite`, 2026-11-03, not yet confirmed on macOS) showed:

- a read-only open alone creates nothing;
- the first read of a WAL database that has no `crush.db-wal` creates an
  empty `crush.db-wal` (0 bytes) and a 32 KiB `crush.db-shm`, and both stay
  after the reader closes;
- every later read rewrites the `-shm` mtime, while `crush.db` and
  `crush.db-wal` stay unchanged across idle reads;
- a writer's commit grows `crush.db-wal`, and a writer's clean close
  checkpoints and removes both files.

So the reader creates SQLite's own empty WAL index files in `.crush/` when
they are absent, and Crush removes them on its next clean close. The change
gate (#reconciliation) leaves `-shm` out and records the signature after the
reader closes, so the reader's own files never read as a commit. T10 (LLP
0574) repeats the check on macOS.

The reader checks that `goose_db_version` exists and that every column it
reads exists. A missing table or column is `schema_unsupported`, naming it.
An additive column or a newer migration is ignored, so upstream additions do
not stop capture; upstream-watch flags new releases for review.

A database is opened when the tick needs it and closed before the tick ends.
Connections are not kept between ticks (#reconciliation explains why). Each
session is read inside one read transaction (LLP 0449
`#read-commit-guard`), so its metadata and messages come from one snapshot.

### Projection {#projection}

One Crush message becomes zero or more parts, in `(created_at, rowid)`
order. Key: `(session_id, part_id)`.

- `session_id` is `crushScopeId(id)`, `crush-<id>`, as `gooseScopeId` does,
  so a Crush id never collides with another client's.
- `part_id` is deterministic from the Crush message `id` and the part index.
  Crush message ids are UUIDs that survive in-place updates, so a streamed
  message keeps its part ids as it grows.
- User `text` gives a user part. A user message with a `shell_command` part
  gives a tool-call part (`bash`, the command) and a tool-result part (output
  and exit code), both with `attributes.crush.user_shell = true`, so it is not
  counted as a prompt.
- Assistant `text` gives an assistant part, `reasoning` gives a reasoning
  part, and `tool_call` gives a tool-call part (name, parsed `input`).
- A `tool` message's `tool_result` gives a tool-result part from `content`
  after the D5 strip, with `is_error` carried.
- `image_url` and `binary` parts give a placeholder naming the type and MIME
  type, never the bytes or the URL. `finish` parts give no part; their reason
  rides on the message's last part.
- A summary message (`is_summary_message = 1`) gives an assistant part with
  `attributes.crush.summary = true`.
- Provider and model come from the message's `provider` and `model`
  columns.
- `client_name` and `conversation_source` are `crush`. `entrypoint` is
  `crush` for a root session and `crush-task` for a task session, whose
  `parent_thread_id` is `crushScopeId(parent_session_id)`.
- Repository identity comes from the project directory (#discovery) through
  the git-repo helper.
- Provenance carries `client_name`, the native session id, and the database
  path as `source_path`, which stays in the row and is never logged.
- No usage (D2). The root-session cost attribute is set as D2 says.

There is no session-end part: Crush sessions have no `ended_at`, so LLP 0122
`#session-end-part` does not apply.

### Reconciliation and watermark {#reconciliation}

Crush edits messages in place and deletes failed summaries, so capture
follows LLP 0449. Each changed session is emitted as a full snapshot with the
scope `client_name = crush AND session_id`, through the kernel's reconcile
storage call, for the poll and backfill alike.

The watermark sidecar lives in `ctx.paths.stateDir`. It holds:

- per database: `{stat_sig, max_rowid, floor}`, where `stat_sig` is the size,
  mtime in nanoseconds and inode of `crush.db` and `crush.db-wal` (never
  `-shm`, #sqlite), and `floor` is an `updated_at` second at or below which
  a session with no entry is history, not a candidate;
- per session: `{db, updated_at, message_count, max_rowid, open, digest}`,
  where `open` records that the session's latest message, in the last
  projection, was an assistant message with `finished_at` null.

A failed commit advances nothing (LLP 0449 `#detection`), and an entry
without a digest forces a reconcile.

**Deviation from LLP 0449 `#detection` and from goose's `data_version` gate,
with the reason.** Goose gates on `PRAGMA data_version`. That pragma only
compares within one connection, so using it across ticks means holding one
open connection, file descriptor and page cache per project database, which
grows with the projects a user has ever opened. Crush also has no
autoincrement id and no `updated_at` index. The design instead gates on file
metadata and reads by `rowid`:

1. **Per-database gate.** Each tick stats `crush.db` and `crush.db-wal`. An
   unchanged signature is taken to mean nothing was committed, so the
   database is not opened. That rests on a hypothesis (#open-questions):
   every WAL commit grows or rewrites the WAL, and a checkpoint rewrites the
   main file, so the signature moves. The Linux self-check saw a commit move
   the WAL; the checkpoint-and-reset case is tested in T3 and T4 on Linux and
   in T10 on macOS. A false positive only costs one open. An opened
   database is stat-checked twice, before the open and after the reader
   closes. When the two agree, or differ only by the reader's own empty `-wal` (#sqlite), the
   after-close signature is recorded. Otherwise a writer committed during the
   read, and the before-open signature is kept so the next tick opens it
   again.
2. **Changed database.** Two reads:
   - `messages WHERE rowid > max_rowid` (excluding title sessions), giving the
     sessions with new rows. This must be a rowid range search.
   - `sessions` metadata (`id`, `updated_at`, `message_count`,
     `parent_session_id`), excluding title sessions. With no `updated_at`
     index this is a scan of the sessions table, which is small (one row per
     session, no payload) and is read only in a database whose signature
     moved. This is accepted and stated in #cost.
3. **Candidates** are sessions with new rows, sessions whose `updated_at` or
   `message_count` differ from their entry, sessions with no entry whose
   `updated_at` is above the database's `floor`, and sessions whose entry is
   `open`. A session with no entry at or below the floor and no new rows is
   history (#backfill) or an entry the sweep pruned or the cap evicted, and is
   not hashed. For each candidate, one seek on `idx_messages_session_id`
   reads `MAX(rowid)`.
4. **Skip without hashing** only when `updated_at`, `message_count` and
   `max_rowid` all match and the entry is settled: its stored `updated_at` is
   before the second the tick observed. An unsettled entry is hashed. This
   guards one case the counts miss: a summary deleted and a message appended
   in the same second can reuse the deleted row's rowid and leave the count
   unchanged.
5. **Open sessions stay candidates, within a bound.** Streaming updates
   rewrite an assistant message in place without bumping `updated_at`, so a
   session whose latest message is an unfinished assistant message is hashed
   on every tick where its database changed. Writes to the message change the
   WAL, so step 1 lets them through. `open` clears when the message has
   `finished_at`, when a later message exists in the session, or when a
   sweep finds the session's digest equal to its entry (nothing streamed
   since the last hash, as after a crash or cancel mid-stream). So a message
   that never finishes is hashed until the next sweep at most. Open sessions
   are never pending (#source) and never schedule a catch-up tick.
6. **The scheduled sweep** hashes every session in scope and catches any
   other in-place edit, up to one sweep interval late.

A hashed candidate whose digest is unchanged updates its entry without a
commit. Its `max_rowid` cursor for the database advances only past sessions
that were committed or found unchanged.

On first start each database's cursor is set to its current `MAX(rowid)`,
its `floor` to the second the baseline observed, and its signature recorded,
so the poll neither walks nor hashes history; history is the backfill's job
(#backfill). A database first seen later (a new index entry) gets the same
treatment, and the next backfill or sweep imports its history.

**Watermark scope and bound.** Entries exist only for sessions in the sweep's
scope; each sweep prunes deleted and out-of-scope sessions and databases no
longer in the set. The sidecar is capped at 10,000 session entries; past the
cap the entry with the oldest `updated_at` is evicted. Evicting or pruning an
entry raises its database's `floor` to at least that entry's `updated_at`,
so the session does not come back as a no-entry candidate on every tick;
its next change bumps `updated_at` past the floor and forces one idempotent
reconcile. Database entries are bounded by the 1,024-database cap.

### Source {#source}

`startCrushSource` follows LLP 0570 `#source`. Start awaits one bounded
tick, then ticks every `poll_interval`. Each tick:

- refreshes discovery (#discovery);
- stats every database in the set, in a round-robin order that starts after
  the last database the previous tick opened;
- opens at most 16 changed databases. A changed database left unopened keeps
  its old signature, so the next tick sees it as changed again;
- admits candidate sessions across the opened databases, at most 64, and
  stops admitting at 4096 projected rows (LLP 0527);
- commits one batch through `reconcileRowsBatch`, flushes the watermark once
  after the commit, and schedules a catch-up tick one second later while
  anything is pending. Pending means a changed database the 16-open budget
  left unopened, or a candidate session the 64-session or 4096-row budget
  left unadmitted. Open sessions (#reconciliation step 5) are not pending.

A session whose scope guard another writer holds is deferred and holds its
database's cursor and signature, as in goose.

### Backfill {#backfill}

The backfill provider reuses the discovery, reader and projector. Its scope,
for the join-time import and the scheduled sweep (LLP 0359
`#sweep-context`), is every non-title session in every database in the set
whose `updated_at` falls inside `backfill.window_days` when it is set, and
every non-title session when it is unset. It walks databases one at a time,
so one connection is open at a time. A re-run reconciles and does not append.
It waits a bounded time on a held scope guard, then fails that session with
`cache_partition_mutation_busy`, as goose does.

### Privacy {#privacy}

- **Usage policy (LLP 0050):** a database whose project directory resolves
  to `ignore` is not opened by the poll or backfill. A project that becomes
  ignored has its sessions' rows removed by empty snapshots, under the
  usage-policy rules of LLP 0449.
- **Local-only (LLP 0070):** rows carry the standard machine-local marking,
  so export withholds them through the existing seam.
- **Session exclusions (LLP 0403 `#storage`):** as goose (LLP 0570
  `#privacy`): the durable `SessionIgnoreSet` is loaded at activation and per
  backfill run; the poll uses Copilot's admission check only on ticks with
  candidates; the checked id is `crushScopeId(id)`; a load error fails closed.
  An excluded session is not projected and its entry does not advance. The
  control is `hyp session ignore` with that id; on a Crush-only install it
  exits status-unknown, as on a Goose-only install (#2860), and directory
  markings are the working control.
- **Working-directory paths (D5):** stripped in the projector before a row is
  built.
- **What HypAware does not read (D6):** the `files` and `read_files` tables,
  `crush.json` config, `crush.log`, and any provider credential.
- **Title sessions:** skipped in the reader query (D3). **Titles:** content
  (D7).
- **Diagnostics:** logs and spans carry counts, ids and error kinds, never
  message text, titles, project paths or database paths.

### Status {#status}

The source reports its own health (LLP 0394).

| State | Source health | `hyp status` message |
| --- | --- | --- |
| No index and no `data_dirs` | `ready`, rowsWritten 0 | no crush installation detected at `<index path>` |
| Index, no projects | `ready`, rowsWritten 0 | crush index at `<index path>` lists no projects yet |
| Ready, no traffic | `ready`, rowsWritten 0 | polling `<N>` crush projects every `<N>`ms, no sessions yet |
| Recording | `ready`, rowsWritten > 0 | polling `<N>` crush projects every `<N>`ms |
| Stale index entries | unchanged state | appends `<N>` listed projects have no crush.db |
| Index unreadable | `degraded`, `error_kind` `index_unreadable` | cannot read the crush index at `<index path>` |
| A database unreadable | `degraded`, `error_kind` `permission_denied` | cannot read `<N>` crush databases |
| Locked or busy | `degraded`, `error_kind` `sqlite_busy` | `<N>` crush databases busy, retrying next poll |
| Unsupported schema | `degraded`, `error_kind` `schema_unsupported` | names the missing table or column and the count of databases |
| Session id collision | `degraded`, `error_kind` `session_collision` | `<N>` sessions appear in more than one crush database |
| Over the database cap | `degraded`, `error_kind` `too_many_projects` | `<N>` crush projects skipped over the 1,024 limit |
| Disabled | source not started | crush ongoing capture disabled (crush.enabled = false) |

Status shows the index path only, as goose shows its database path. Per-
database failures are counted, not listed, so a status line does not list a
user's projects.

Each tick logs `crush.poll` with `component=crush`, `operation`, `status`,
`dbs_total`, `dbs_changed`, `dbs_opened`, `dbs_pending`,
`sessions_changed`, `sessions_pending`, `rows` and `error_kind`.

### Cost {#cost}

- **Idle.** Two `stat` calls per database per tick and one for the index:
  O(projects), no open, no read. With 100 projects and a 60 s poll that is
  201 stats a minute.
- **A changed database** costs one open, the rowid range read (O(new rows)),
  the sessions scan (O(sessions in that database), small rows, no payload)
  and one index seek per candidate. At most 16 databases are opened per tick.
  A session with no entry is a candidate only above the database's `floor`,
  so old history and pruned or evicted entries are never hashed by the poll.
- **Each changed session** costs a streamed digest and, when it moved, a
  projection, both O(that session's length). Open sessions are re-hashed on
  each changed-database tick until their latest message finishes, a later
  message exists, or a sweep finds them unchanged, so a long streaming reply
  in a long session is the expensive case and a message that never finishes
  costs at most one sweep interval of re-hashing. The 64-session and 4096-row budget
  caps a tick.
- **The scheduled sweep** streams every session in scope once per sweep,
  one database at a time: O(messages in scope), bounded by
  `backfill.window_days` when set.
- **Memory** holds one connection and one session's projection while
  hashing, the batch's projections until commit, the cached index (at most
  1,024 database entries), and a watermark of at most 10,000 session entries.
  No connection or page cache is held between ticks.
- **What grows:** idle cost grows linearly with project count (stats only);
  per-tick work grows with changed sessions and their length; the sweep grows
  with messages in scope; Iceberg metadata grows with cache size (LLP 0449).
  Each is bounded by the caps and budgets above, not constant.

## Coverage map

| Coverage row | Seam | Test |
| --- | --- | --- |
| 1 Product | pinned version in docs and the upstream-watch entry | Mac Part A, Linux probe |
| 2 Upstream watch | `targets.json` entry at Close | upstream-watch `npm test` |
| 3 Detection | manifest `detect`, `INIT_SOURCE_CHOICES`, `PickerSource`; index path resolution | `test/core/init-source-choices.test.js` present and absent cases; config tests for `CRUSH_GLOBAL_DATA`, `XDG_DATA_HOME` and stale entries |
| 4 Onboarding | picker and the `hyp setup` configure phase | `walkthrough_picker_to_first_query` with Crush; a repeat picker run keeps `enabled = false`; adding Crush to an existing install leaves other clients' config untouched |
| 5 Lifecycle | `enabled`, read-only reader | config test, smoke disable step; the reader creates SQLite's own empty `-wal` and `-shm` in `.crush/` when absent and writes no content, and Crush removes them on its next clean close; tests cover starts with and without `-wal` |
| 6 Collection | discovery, projector, reconciliation | projector tests (parts, shell command, summary, task and title sessions, cost attribute, no usage); reconcile tests for streaming update, deleted summary and rowid reuse; `crush_capture` smoke |
| 7 History | backfill, window, busy retry, late project, restart | backfill and crush-db tests; a project added to the index mid-run; a restart does not re-import; the sweep recovers sessions written while the daemon was down |
| 8 Privacy | policy skip, session exclusions, local-only, D5 strip, D6 table guard, title rule | projector policy tests, exclusion admission test, a Crush local-only case in the smoke, a test that fails if any query names `files` or `read_files`, `source_optout_export_withhold` |
| 9 Query | `ai_gateway_messages` rows, session graph | smoke SQL and grep readback; the session graph groups by Crush session id |
| 10 Status | source health | source status tests for each row of #status |
| 11 Cost | stat gate, rowid range read, open budget, tick budget, watermark cap | source tick tests on fixtures with many databases, sessions and messages; `EXPLAIN QUERY PLAN` check |
| 12 Docs | `docs/integrations/crush.md`, `docs/INTEGRATIONS.md` row, README, CLIENTS, PRIVACY, TROUBLESHOOTING | doc commands run in the sandbox |
| 13 Packaging | bundled list, `npm pack` | `npm pack --dry-run`, sandbox, Mac Part B |

The docs follow `docs/integrations/goose.md`: what is recorded, setup,
history import, limits (no per-turn usage, the cost attribute, the omitted
context message, the update check, `data_dirs` for a moved data dir).
`docs/PRIVACY.md` gains Crush in its client table and the lists of recorders
whose exclusions persist and whose backfill honors them, and states that the
`files` table is never read. `docs/TROUBLESHOOTING.md` gets the entries in
#status and the sweep-cadence latency for in-place edits outside streaming.

## Consequences

- Crush rows look like goose rows: same table, same reconcile behavior, same
  privacy seams. Query and export need no change.
- Crush rows carry no token usage. A usage report shows Crush turns with
  null usage and, for root sessions, a cost attribute.
- Idle cost is O(projects) stats rather than O(1), the price of a database
  per project. It stays small and is bounded by the database cap.
- In-place edits other than streaming arrive at sweep cadence. The docs say
  so.
- A schema change that removes a needed column degrades the source with a
  named error rather than writing wrong rows.

## Open questions {#open-questions}

- Mac Part A (gate G-A in LLP 0574) settles the macOS default index path,
  `projects.json` shape and the migration version before T2's detect value
  is relied on. If the Mac default differs, T2 changes `detect` and the
  resolver default, and this design is amended before T2 lands.
- Build measures the reads with `EXPLAIN QUERY PLAN` on a fixture with many
  messages: the `messages` range read must search by rowid and the
  `MAX(rowid)` read must use `idx_messages_session_id`. The sessions read is
  an accepted scan. If either required search scans, Build stops and returns
  to design review rather than shipping it.
- The stat gate is partly observed: the Linux self-check (#sqlite) saw idle
  reads leave `crush.db` and `-wal` unchanged and a commit move the `-wal`.
  Still open: that every commit moves the `crush.db` or `crush.db-wal`
  signature, including a WAL reset after checkpoint. T3 and T4 test that on
  Linux, and T10 (Mac Part B) on macOS. If it does not hold, the gate falls back to a
  per-tick `data_version` read on a short-lived connection, which costs one
  open per database per tick and is bounded by the database cap.
