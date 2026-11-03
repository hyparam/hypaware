# LLP 0570: Goose session capture - technical design

**Type:** Design
**Status:** Draft
**Systems:** Sources, Plugins
**Author:** HypForge
**Date:** 2026-11-02
**Related:** LLP 0118, LLP 0119, LLP 0120, LLP 0121, LLP 0122, LLP 0123, LLP 0124, LLP 0449, LLP 0527, LLP 0359, LLP 0050, LLP 0070, LLP 0130, LLP 0131, LLP 0394, LLP 0403, LLP 0549, LLP 0553, LLP 0571

> Buildable design for a `@hypaware/goose` client adapter. Status stays Draft
> until the Build tasks in LLP 0571 land.
> `@ref LLP 0118 [constrained-by]`: same shape of capture as hermes, a pull
> from the product's own local store with no proxying.
> `@ref LLP 0119 [constrained-by]`: Goose is never modified or proxied;
> `sessions.db` is opened read-only.
> `@ref LLP 0120#row-semantics [implements]`: rows are `ai_gateway_messages`
> rows through `ai_gateway.projected_exchange`, not a new table.
> `@ref LLP 0122 [constrained-by]`: config, SQLite access, watermark sidecar,
> source and backfill provider follow the hermes design.
> `@ref LLP 0449 [implements]`: Goose rewrites stored history, so capture uses
> the session reconciliation scope, digest and read-to-commit guard.
> `@ref LLP 0527 [implements]`: each poll tick reconciles a budgeted batch.
> `@ref LLP 0359#sweep-context [constrained-by]`: `backfill.window_days`
> bounds the join-time import and the scheduled sweep.

## Context

Goose (aaif-goose/goose, Apache-2.0) is a local agent with a CLI and a
Desktop app. Since v1.10.0 both keep every session in one SQLite database,
`sessions.db`. The Research and Probe phases of mission HYP.0.243.1 ran Goose
v1.57.0 (tag commit `30bba951`) against a loopback fixture provider on Linux
and read its pinned source. The facts this design rests on:

- `sessions.db` is SQLite in WAL mode, `schema_version` 17, busy timeout 30
  s, files 0600 in 0700 directories.
- `sessions` holds one row per session: text id `YYYYMMDD_N`, `name`,
  `working_dir`, `session_type`, `created_at`, `updated_at`,
  `provider_name`, `model_config_json`, `parent_session_id` and token
  totals. `session_type` is one of `user`, `scheduled`, `sub_agent`,
  `hidden`, `terminal`, `gateway`, `acp`.
- `messages` holds one row per message: autoincrement `id`, `session_id`,
  `message_id`, `role`, `content_json`, `created_timestamp`,
  `metadata_json`. Indexes exist on `messages(session_id)`,
  `messages(session_id, created_timestamp, id)`, `messages(message_id)` and
  `sessions(updated_at DESC)`.
- A user turn has `message_id` `msg_<uuid>`. Every turn Goose also writes a
  user-role row with `turnContext: true` and `userVisible: false`, which is
  not human input. A tool call is an assistant `toolRequest` item and its
  result a user-role `toolResponse` with `structuredContent {stdout, stderr,
  exit_code}`. An assistant `message_id` is the provider's response id, so it
  is unique only within a session.
- Assistant `metadata_json` carries `inference {provider, requestedModel}`
  and `usage {inputTokens, outputTokens, totalTokens, ...}`.
  `usage_ledger` has one row per inference but no link to a message.
- `goose run --no-session` and `goose configure` checks still write a
  session, typed `hidden`.
- `sessions.name` is a model-generated title and can echo prompt text.
- Goose writes full request bodies to `state/logs/llm_request.*.jsonl`.
- Goose's OTLP export is protobuf only and carries no message content.
  HypAware's listener is JSON only. That lane is rejected.

What the source shows about writes, read in `session_manager.rs` at the
pinned tag, decides the detection design:

| Write | Rows | Bumps `sessions.updated_at` |
| --- | --- | --- |
| Append a message | INSERT | yes, in the same transaction |
| Upsert messages with an agent-visibility merge | INSERT or UPDATE `metadata_json` | yes |
| `replace_conversation` | DELETE all, re-INSERT with new `id`s | no |
| `truncate_conversation` | DELETE tail | no |
| `update_message_metadata` | UPDATE `metadata_json` in place | no |
| Tool-meta patch on a tool request | UPDATE `content_json` in place | no |

So `updated_at` alone misses rewrites, truncations and in-place edits, and
`MAX(id)` detects a rewrite but is not an identity.

## Motivating scenario

A developer uses Goose in a repository for a day, with a few shell tool calls
per turn. Goose compacts one long session, which runs `replace_conversation`.
They expect `hyp query grep <marker>` to find each turn once, labeled as
Goose and attributed to the repository. Compaction must not double the
session's rows, a `--no-session` scratch run must not show up, and nothing
from a `.hypignore`d directory may be recorded. Their HypAware daemon must
stay cheap while Goose idles between turns.

## Ticket-to-workflow map

| Ticket requirement | Workflow seam | Section |
| --- | --- | --- |
| Goose appears in `hyp setup` (alias `hyp init`) | picker detection (LLP 0130), configure phase (LLP 0131) | #manifest |
| New turns arrive without user action | poll source | #source |
| Existing history arrives once, bounded | backfill provider, `backfill.window_days` | #backfill |
| Rewrites never duplicate rows | reconciliation scope | #reconciliation |
| Privacy controls hold | usage policy, local-only, hidden skip | #privacy |
| `hyp status` explains each state | source health (LLP 0394) | #status |
| Cost stays bounded | changed-session filter, tick budget | #cost |

## Decision

### Owner decisions {#owner-decisions}

The orchestrator accepted these defaults on 2026-11-02 (22:37Z). The reasons
come from the mission's coverage record.

- **D1. Skip `hidden` sessions.** They come from `--no-session` and from
  configure checks. A user who asks Goose not to keep a session does not
  expect HypAware to keep it. The skip is in the reader query, so their
  messages are never read.
- **D2. Import `sub_agent` sessions as their own sessions**, linked to the
  parent by `parent_session_id`. Folding them into the parent would interleave
  two transcripts and lose their own model and usage. The link is recorded in
  the projected exchange's provenance (LLP 0120 `#row-semantics`), so no new
  column is needed.
- **D3. Session titles are content.** `sessions.name` is model output and can
  echo the prompt. It is projected only where message text is, and under the
  same redaction, opt-out and export rules. It is never used in a log,
  span attribute, status line or file name.
- **D4. Authenticated inference is optional evidence.** Verify uses a
  CLI-login provider (for example `claude_code` or `codex`) only on a host
  where that login already exists and is checked first. Otherwise the run is
  labeled loopback-only. No new paid account.

### Plugin and manifest {#manifest}

A bundled plugin `@hypaware/goose` at
`hypaware-core/plugins-workspace/goose/`, with the hermes file set:
`src/index.js`, `config.js`, `sessions_db.js`, `projector.js`,
`backfill.js`, `source.js`, `watermark.js`, `errors.js`, `types.d.ts`. Repo
identity reuses the hermes `git_repo.js` logic. Build either imports it, if the
plugin boundary allows, or copies it with a note. A shared kernel helper would
be a separate change.

The manifest copies the hermes manifest field for field:

- `schema_version` 1, `hypaware_api` `^1.0.0`, runtime `node`,
  `node_engine` `>=22.12` (same `node:sqlite` floor), entrypoint
  `./src/index.js`.
- permissions `read_home`, `read_state`, `write_state`.
- requires `@hypaware/ai-gateway` `^2.0.0` for the projected exchange.
- `picker`: name, label `Goose`, summary "Records your Goose conversations
  and imports recent history. Makes no changes to Goose.", `detect {
  settings_file: ".local/share/goose/sessions/sessions.db" }`, `compose {
  plugin { name }, requires_gateway: true }`. One detect serves both
  platforms: the Mac probe (Part A, operator-run 2026-11-02T23:21Z, Goose
  1.57.0 on macOS 27.2 arm64, empty HOME, no `GOOSE_PATH_ROOT`) wrote the
  database at the same HOME-relative path as Linux. See #config for the
  older macOS location.
- `config_sections`: one, `goose`.
- `sources`: one, `goose`. A backfill provider registers the same way
  hermes's does.
- No `client` or `skills` contributions in V1. Hermes declares
  `client { skill_dir: ".hermes/skills" }` and installs the neutral skills
  there (LLP 0494). Goose's skill directory is not verified at the pinned
  tag, and adding a per-client skill copy would change files under
  `hypaware-core/skills/`, which needs its own owner ask. Both are a
  follow-up, listed in the plan's out-of-scope.

The plugin is added to the bundled list in `src/core/runtime/bundled.js`
next to hermes, so it ships in the package and activates like the other
bundled adapters.

It reuses these commands and adds none: the `hyp setup` picker (alias `hyp
init`) and its configure phase (LLP 0131), `hyp status`, `hyp backfill` and
the scheduled backfill sweep. Re-running `hyp setup --source goose` is
idempotent and keeps an explicit `goose.enabled = false`, as for hermes.

Detection is a path existence check, so it reads no rows and never runs
Goose. Limit: a custom `GOOSE_PATH_ROOT` is not seen by the picker, because
it lives in the user's shell, not the daemon's environment. Those users set
`sessions_db`. A resolver like opencode's XDG case (LLP 0306) can come later
if users ask for it.

### Config {#config}

```toml
[goose]
enabled = true
sessions_db = "/absolute/path/to/sessions.db"  # optional override
poll_interval = "60s"
```

All three keys and their validation are those of `[hermes]` (LLP 0122
`#config`):

| Key | Hermes precedent | Rule |
| --- | --- | --- |
| `enabled` | `hermes.enabled` | boolean |
| `sessions_db` | `hermes.state_db`, renamed for the file it points at | non-empty string; a leading `~` is expanded when the path is resolved, as hermes's `resolveStateDbPath` does, not by the validator |
| `poll_interval` | `hermes.poll_interval`, default 60 s | positive ms or a duration string |

Unknown keys are rejected as hermes rejects them. The busy-retry policy, the
tick budget, the hidden-session skip and the sweep cadence are code
constants, not keys. The one further key is the kernel-generic `backfill`
policy block (`on_join`, `window_days`, LLP 0037), which `#backfill` needs
for its window and which the shared validator checks. Hermes's own key set
rejects it; goose accepts it as antigravity and copilot do.

Path resolution order: `sessions_db` if set, then `$GOOSE_PATH_ROOT/data/
sessions/sessions.db` if that variable is set in the daemon's environment
and absolute, then the default `~/.local/share/goose/sessions/sessions.db`.
The default is the same on Linux and macOS (Part A observed it on macOS).
Goose's `paths.rs` mentions an older macOS location,
`~/Library/Application Support/Block/goose/`. Part A ran on an empty HOME, so
it could not observe a legacy install there, and the resolver does not fall
back to it. A user whose database is there sets `sessions_db`; the docs say
so. A daemon started by launchd or systemd does not inherit
`GOOSE_PATH_ROOT` from the user's shell, so those users also set
`sessions_db`.

### Reading sessions.db {#sqlite}

Like hermes (LLP 0122 `#sqlite`):

- open with `node:sqlite` `DatabaseSync` and `readOnly: true`;
- never write, never take a write lock, never run a checkpoint;
- retry `SQLITE_BUSY` and `SQLITE_LOCKED` up to 5 times, 20 ms apart, then
  fail the tick with `error_kind` `sqlite_busy`. The tick's watermark does
  not advance.

The reader checks `PRAGMA schema_version` and the columns it needs. A
missing required column is a `schema_unsupported` error naming the column.
An additive column is ignored.

Each reconcile reads one session inside one read transaction (LLP 0449
`#read-commit-guard`), so a session's metadata and messages come from one
snapshot.

### Projection {#projection}

One Goose message becomes zero or more parts. Key: `(session_id, part_id)`.

- `part_id` is deterministic from `message_id`, the occurrence number of
  that `message_id` within the session, and the content index. The occurrence
  number keeps two rows with the same provider id distinct. A row with a
  null `message_id` falls back to its `id`, which is not stable across a
  rewrite. That row is reconciled away and re-emitted, never duplicated.
- Rows with `turnContext: true` are skipped, and so are content items marked
  not user-visible.
- User text gives a user part. Assistant text gives an assistant part. A
  `toolRequest` gives a tool-call part (tool name and arguments). A
  `toolResponse` gives a tool-result part from `structuredContent`.
- Usage is taken from the assistant message's `metadata_json.usage`, one
  value per inference. `usage_ledger` is not joined, because it has no message
  link.
- Provider and model come from `metadata_json.inference`, falling back to
  `sessions.provider_name` and `model_config_json`.
- `client_name` and `conversation_source` are `goose`. `entrypoint` is
  `goose-<session_type>`, for example `goose-user`, `goose-scheduled` or
  `goose-sub_agent`, so a query can tell them apart.
- Repository identity comes from `working_dir` through the git-repo helper.

There is no session-end part. Goose sessions have no `ended_at`, so the
hermes session-end part (LLP 0122 `#session-end-part`) does not apply.

### Reconciliation and watermark {#reconciliation}

Goose rewrites history, so capture follows LLP 0449, not append-only
dedupe. Each changed session is emitted as a full snapshot, with a
reconciliation scope of `client_name = goose AND session_id`. Both the poll
and backfill use the kernel's reconcile storage call, so equal rows keep their
ingest sequence and a full rewind removes the session's parts.

The watermark sidecar lives in `ctx.paths.stateDir`. It holds
`data_version`, a global message cursor `cursor_id`, an `updated_at` cursor
`cursor_updated_at`, and per session `{updated_at, max_id, digest}`. The
digest is SHA-256, streamed over session metadata and visible message
payloads. A failed commit never advances an entry or a cursor (LLP 0449
`#detection`), and an entry without a digest forces a reconcile.

**Deviation from LLP 0449 `#detection`, with the reason.** Hermes streams the
digest over every session's visible history whenever `data_version` moves. In
Goose, every appended message moves `data_version`, so a busy database would
re-hash every session each poll. Goose's write table (see #context) and its
autoincrement `messages.id` allow detection by range reads instead:

1. When `PRAGMA data_version` is unchanged, the tick does nothing.
2. When it moved, the tick reads two ranges, both excluding `hidden`
   sessions:
   - `messages` rows with `id > cursor_id`, giving each session's first new
     `id`. `id` is the integer primary key, so this is a range read over the
     new rows only. It sees appends, and `replace_conversation` re-inserts,
     because those rows get new `id`s.
   - `sessions` rows with `updated_at >= cursor_updated_at`, through the
     `sessions(updated_at DESC)` index. It sees the visibility-merge upsert,
     which bumps `updated_at` without a new row. The bound is inclusive so a
     write in the same second as the last tick is not missed.
3. For each candidate session, one index seek reads `MAX(id)`. A candidate
   whose stored `{updated_at, max_id}` both match is a no-op and is not
   hashed. Every other candidate is hashed and compared. An equal digest
   updates the stored entry without a commit.
4. The scheduled backfill sweep hashes every session in its scope and
   catches what steps 2 and 3 cannot see: a truncation with no later append,
   and an in-place edit of `metadata_json` or `content_json`, such as a
   metadata update or a tool-meta patch. Such a change can take up to one
   sweep interval to arrive. A truncation followed by any append in that
   session is caught on the next poll, because the append makes the session a
   candidate and its snapshot is reconciled in full.

On first start the cursors are set to the database's current `MAX(id)` and
`MAX(updated_at)`, so the poll does not walk history. History is the
backfill's job (#backfill).

**Watermark scope and bound.** The watermark keeps entries only for sessions
in the sweep's scope (#backfill). Each sweep prunes entries for sessions that
were deleted or left the scope. The sidecar is capped at 10,000 session
entries; past the cap the entry with the oldest `updated_at` is evicted. An
evicted session's next change finds no entry and forces one reconcile, which
is idempotent because equal rows keep their ingest sequence.

### Source {#source}

`startGooseSource` follows LLP 0122 `#source` and LLP 0527. Start awaits one
bounded tick. Ticks then run every `poll_interval`. The poll has no time
window: it selects sessions by change (#reconciliation step 2), so it touches
only sessions written since the cursors. A tick admits changed sessions in
order of their first new `id` (sessions found only by `updated_at` after
them, oldest first), at most 64, and stops admitting at 4096 projected rows.
It commits one batch through `reconcileRowsBatch`, flushes the watermark once
after the commit, and schedules a catch-up tick one second later while
sessions are pending. After the commit, `cursor_id` advances to just below
the smallest first new `id` among sessions not admitted, or to the largest
`id` read when all were admitted; `cursor_updated_at` advances only when every
candidate was admitted. The catch-up tick finds the pending sessions again;
sessions it already committed are found too and skipped by step 3. A session whose scope
guard another writer holds is deferred and holds the cursors the same way.

### Backfill {#backfill}

The backfill provider reuses the same reader and projector. Its scope, for
the join-time import and the scheduled sweep (LLP 0359 `#sweep-context`), is
the non-`hidden` sessions whose `updated_at` falls inside
`backfill.window_days` when it is set, and every non-`hidden` session when it
is unset, as for hermes. A re-run reconciles and does not append, so a repeat
import is idempotent. It waits a bounded time on a held scope guard, then fails that session with
`cache_partition_mutation_busy`, as hermes does.

### Privacy {#privacy}

- **Usage policy (LLP 0050):** a session whose `working_dir` resolves to
  `ignore` is skipped in both the poll and backfill, before projection. A
  session that becomes ignored has its rows removed by an empty snapshot,
  under the usage-policy rules of LLP 0449.
- **Local-only (LLP 0070):** rows carry the standard machine-local marking,
  so export withholds them through the existing seam.
- **Session exclusions (LLP 0403 `#storage`):** activation loads the durable
  `SessionIgnoreSet`, as NanoClaw and Copilot do (LLP 0553 `#privacy`,
  LLP 0549 `#session-controls`). The backfill refreshes it at the start of
  each run. The poll reuses Copilot's admission check, and only on ticks
  where step 2 of #reconciliation found changed sessions, so an idle tick
  reads nothing: stat the store directory and refresh when its signature
  moved, then stat the session's own marker, which decides membership both
  ways. The Goose `sessions.id` is the checked id, before projection. An
  excluded session is not projected and its watermark entry does not advance,
  so after `session unignore` the session's next change or the next sweep
  recovers it; the cursors move past it, so the next tick alone does not. Rows captured
  before the ignore are left as they are, as for every recorder under
  LLP 0403. A load error fails closed: the tick and the run project nothing,
  advance no cursor, and status shows the error. The control path is the ai-gateway `session
  ignore` command with an explicit Goose session id. LLP 0549's database-only
  controls do not cover Goose: they apply only when every registered client is
  database-only and no gateway capability is active, and Goose registers no
  client while a Goose-only install still activates an idle gateway that binds
  no port. On such an install the command exits status-unknown and saves
  nothing, and directory markings are the working control. Writing the store
  directly when no recorder is listening is a change to the shared session
  command, left to a follow-up. LLP 0403
  `#backfill` leaves Hermes outside session opt-out. Goose opts in, because
  the store, the check and the controls already exist and skipping them would
  let an ignored session keep recording.
- **Hidden sessions:** skipped in the reader query (D1).
- **Titles:** treated as content (D3).
- **What HypAware does not read:** `llm_request.*.jsonl`, Goose's config and
  keyring, and its logs. The docs say Goose itself writes full prompts to
  those request logs.
- **Diagnostics:** logs and spans carry ids, counts and error kinds, never
  message text, titles or `working_dir` paths.

### Status {#status}

The source reports its own health (LLP 0394): `state`, `message`,
`rowsWritten`, `lastError`.

| State | Source health | `hyp status` message |
| --- | --- | --- |
| Database missing | `ready`, rowsWritten 0 | no goose installation detected at `<path>` |
| Ready, no traffic | `ready`, rowsWritten 0 | polling `<path>` every `<N>`ms, no sessions yet |
| Recording | `ready`, rowsWritten > 0 | polling `<path>` every `<N>`ms |
| Unreadable | `degraded`, `error_kind` `permission_denied` | cannot read the database at `<path>` |
| Locked or busy | `degraded`, `error_kind` `sqlite_busy` | database busy, retrying next poll |
| Unsupported schema | `degraded`, `error_kind` `schema_unsupported` | names the missing column |
| Disabled | source not started (`enabled = false`) | goose ongoing capture disabled (goose.enabled = false) |

The database path appears in status, as for hermes. Logs never carry it
(#privacy).

Each tick logs `goose.poll` with `component=goose`, `operation`,
`status`, `sessions_changed`, `sessions_pending`, `rows` and
`error_kind`.

### Cost {#cost}

- An idle database costs one `PRAGMA data_version` per poll.
- A changed database costs the two range reads of #reconciliation, which are
  O(message rows written since the last tick) plus O(sessions whose
  `updated_at` moved), and one `MAX(id)` index seek per candidate. Nothing
  here reads a payload or grows with history.
- Each changed session then costs a streamed digest and, when the digest
  moved, a projection, both O(that session's length). This is inherent to
  snapshot reconciliation (LLP 0449 emits the whole session), and it is paid
  at most once per `poll_interval` per active session, not once per message.
  A long, busy session is the expensive case; the budget caps how many are
  done per tick.
- The scheduled sweep streams every session in its scope once per sweep:
  O(messages in scope), bounded by `backfill.window_days` when set and by the
  whole database when unset.
- Session exclusions add two `stat` calls and a Set lookup per changed
  session, plus a directory refresh only when the store changed; the refresh
  is bounded by LLP 0403's limits (10,000 ids, 4 MiB).
- A tick's reconcile is capped by the LLP 0527 budget (64 sessions, 4096 rows
  plus the last session's projection).
- Memory holds one session's projection at a time while hashing. The batch
  holds up to the budget's projections until commit. The watermark holds at
  most 10,000 small entries and two cursors.
- What grows with the backlog: the per-session digest grows with that
  session's length, and the sweep and backfill grow with the messages in
  scope. A large first import is spread over catch-up ticks. Iceberg manifest
  metadata and deletion masks grow with cache size (LLP 0449 Cost and
  verification). These are bounded by the backfill window and the budget, not
  constant.

## Coverage map

| Coverage row | Seam | Test |
| --- | --- | --- |
| 1 Product | pinned version in docs and the upstream-watch entry | Mac Part A, Linux probe |
| 2 Upstream watch | `targets.json` entry at Close | upstream-watch `npm test` |
| 3 Detection | manifest `detect`, `INIT_SOURCE_CHOICES`, `PickerSource` | `test/core/init-source-choices.test.js` present and absent cases, walkthrough smoke |
| 4 Onboarding | picker and the `hyp setup` configure phase | `walkthrough_picker_to_first_query` with Goose, repeat `hyp setup --source goose` keeps `enabled = false` |
| 5 Lifecycle | `enabled`, read-only reader | config test, smoke disable step |
| 6 Collection | projector, reconciliation | projector and reconcile tests on fixture dbs, `goose_capture` smoke |
| 7 History | backfill, window, busy retry | backfill and sessions-db tests |
| 8 Privacy | policy skip, session exclusions, hidden skip, title rule | projector policy tests, session-exclusion admission test, `source_optout_export_withhold` |
| 9 Query | `ai_gateway_messages` rows | smoke SQL and grep readback |
| 10 Status | source health | source status tests |
| 11 Cost | `data_version` gate, range reads, watermark cap, budget | source tick tests on a fixture with many sessions and many messages |
| 12 Docs | `docs/integrations/goose.md`, `docs/INTEGRATIONS.md` row, README, CLIENTS, PRIVACY, TROUBLESHOOTING | doc commands run in the sandbox |
| 13 Packaging | bundled list, `npm pack` | `npm pack --dry-run`, sandbox, Mac Part B |

The docs use the current layout, with `docs/integrations/hermes.md` as the
model: a `docs/integrations/goose.md` page (what is recorded, setup, history
import, limits), a row in the `docs/INTEGRATIONS.md` "Coding agents" table,
and the README client list. `docs/PRIVACY.md` gains Goose in its client table
and joins the lists of recorders whose exclusions persist and whose backfill
honors them, not the sentence naming clients without session control, since
Goose honors session exclusions (#privacy). `docs/TROUBLESHOOTING.md` gets the
missing-database, busy and schema entries from #status and the sweep-cadence
latency for in-place edits.

## Consequences

- Goose rows look like hermes rows: same table, same reconcile behavior and
  same privacy seams. Query and export need no change.
- In-place edits arrive at sweep cadence, not poll cadence. The latency is
  stated in the docs' troubleshooting entry.
- Sessions written before v1.10.0 (`.jsonl` files), Goose Desktop-only
  paths and the older macOS `Library/Application Support/Block/goose`
  location are out of scope. The docs say so and point to `sessions_db`.
- A Goose schema change that renames a needed column degrades the source with
  a named error rather than writing wrong rows. Upstream-watch flags new
  releases for review.

## Open questions {#open-questions}

- Settled: the macOS default path. Part A observed the Linux path on macOS
  (#manifest, #config).
- Build measures the two range reads with `EXPLAIN QUERY PLAN` on a fixture
  with many messages: the `messages` read must search by the integer primary
  key and the `sessions` read by the `updated_at` index, not scan. If either
  scans, Build stops and returns to design review rather than shipping it.
