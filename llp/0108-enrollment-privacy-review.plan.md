# LLP 0108: enrollment privacy review - implementation plan

**Type:** plan
**Status:** Active
**Systems:** CLI, Onboarding, Usage-Policy, Sinks, Plugins, Query
**Related:** LLP 0100, LLP 0101, LLP 0102, LLP 0103, LLP 0104, LLP 0105, LLP 0106, LLP 0107
**Generated-by:** neutral
**Date:** 2026-07-13

> Implementation steps for the enrollment privacy review specified in
> [LLP 0100](./0100-enrollment-privacy-review.spec.md) and settled by
> decisions [LLP 0101](./0101-first-sync-review-window.decision.md) through
> [LLP 0107](./0107-skills-ride-attach.decision.md). Per this repo's
> decision-first convention there is no design doc: the decisions carry the
> rationale, and spec coverage closes through the code `@ref`s each task
> lands ([LLP 0100 §refs](./0100-enrollment-privacy-review.spec.md#refs)).
> Nine small, independently-mergeable tasks with three independent roots:
> the class-per-entry store (T1), the deadline hold (T5), and
> skills-at-attach (T7). The security-critical query-seam filter (T4) and
> the destructive verb (T3) hang off T1; the skill itself (T9) lands last,
> once the verbs it drives exist.

## Task notes

### T1 - machine-local policy classes (LLP 0103)

The foundation. `src/core/usage-policy/local_only.js` becomes a
class-per-entry store: on-disk version 2, `entries: [{ dir, class }]` with
`class` one of `ignore | local-only | full`; version-1 `dirs` arrays migrate
on read as all-`local-only` (exactly what those files meant). Keep the
LLP 0071/0080 fail-safe: missing file reads as empty, present-but-malformed
throws `LocalOnlyListUnreadableError`. `src/core/usage-policy/matcher.js`
generalizes `matchList`/`readListDirsSync` from "membership means
local-only" to "the governing entry's class", still merged
most-restrictive-wins with the `.hypignore` walk (`CLASS_RANK` is already
total over the three classes); an explicit `full` entry resolves identically
to the implicit default but is surfaced (e.g. a `hasExplicitEntry(dir)` or
entry-listing read API) so the classification hook (T8) can distinguish
"asked and answered" from "never asked". Critically, a machine-local
`ignore` must bind at the *capture* seam: the five adapter resolver
construction sites that today call `createUsagePolicyResolver()` bare
(`hypaware-core/plugins-workspace/claude/src/projector.js`, `settle.js`,
`backfill.js`; `codex/src/exchange-projector.js`, `backfill.js`) must be
plumbed the machine-local list path the way
`src/core/runtime/activation.js:65` already does for the export seam, or
review-driven `ignore` marks would silently not stop recording. Update
`src/core/usage-policy/types.d.ts` and the barrel. Tests: v1 migration,
class round-trip, most-restrictive merge per class, capture-seam drop for a
machine-local `ignore`, corrupt-file fail-safe unchanged.
Carries `@ref LLP 0103 [implements]` on the store and the resolver merge.

### T2 - class-aware marking verbs (LLP 0103 §cli)

`src/core/commands/clients.js` (`runIgnore`/`runUnignore` and their arg
parsers) plus usage strings in `src/core/cli/core_commands.js`. Bare
`hyp ignore <path>` keeps its LLP 0049 dotfile meaning unchanged. New
machine-local forms, all writing T1 entries and never repo files (LLP 0071,
LLP 0100 R6): `hyp ignore --private [path]` writes an `ignore` entry;
`hyp ignore --local-only [path]` keeps its meaning (now a `local-only`
entry); an explicit-sync spelling (this task picks it; suggest
`hyp ignore --sync [path]`, mirrored in help text) writes a `full` entry.
`hyp unignore` grows symmetric removal per class. `hyp ignore --check`
names which source governs (dotfile vs machine-local entry, and the class),
per LLP 0103's consequences; the residual-rows count now points at
`hyp purge` (T3) once it exists, wording can land here with a plain
mention. Marking stays non-destructive in every form (LLP 0104 boundary).
Tests: each flag writes/removes the right entry class, idempotency,
`--check` source naming, dotfile behavior untouched.
Carries `@ref LLP 0103 [implements]` on the new flags.

### T3 - `hyp purge` (LLP 0104)

New `src/core/commands/purge.js` registered in
`src/core/cli/core_commands.js`, with the rewrite machinery in
`src/core/cache/storage.js` / `src/core/cache/iceberg/store.js`. Targets:
`hyp purge <path>` (rows whose `cwd` equals or descends from the path,
reusing `isEqualOrDescendant`, regardless of class), `--session <id>`
(cheapest: `session_id` is the partition key, LLP 0030), `--ignored`
(every row whose `cwd` currently resolves to `ignore` from either source),
`--all`; bare `hyp purge` errors with usage. Cache-only: never contacts
sinks or the remote. Mechanics this task owns (no design doc follows):
partition rewrite with fresh `part_id` identity for rewritten parts,
watermark/settlement-buffer interaction (a purge must not resurrect rows
via a stale watermark or wedge incremental reads), and the forward-sink
dedupe check LLP 0104's consequences flag (purge-then-re-record must not
mint server-side duplicate identities). Resurrection warning: purging a
subtree still resolving `full` warns that the next backfill re-imports it
and suggests marking `ignore` first; purge of an `ignore`d subtree is
durable because the capture seam blocks re-import. Confirmation prompt on
TTY (destructive verb), `--yes` for scripts. Structured telemetry
(`purge.*` with row/part counts, hashed targets). Tests: each target
shape, subtree segment-awareness, warn paths, watermark integrity after
rewrite; a smoke modeled on `cache_lifecycle_maintenance.js` proving
purged rows are gone from query results and the next tick exports nothing
for them. Carries `@ref LLP 0104 [implements]` on the verb and the rewrite.

### T4 - query-seam local-only visibility (LLP 0105) - security critical

The transcript-leak closure. One filter at the shared read path, never
per-command (LLP 0049 R4 spirit): `executeQuerySql` in
`src/core/query/sql.js` (which `hyp query`, the context-graph verb
`hypaware-core/plugins-workspace/context-graph/src/query.js`, and the MCP
tools all funnel through) consults the shared resolver twice, per-row on
the row's `cwd` and once for the caller's `cwd`, excluding `local-only`
rows unless caller class >= row class on the restrictiveness lattice
(include for `local-only` and `ignore` callers, exclude for `full`).
Unknown caller (no derivable `cwd`, e.g. an MCP request without one)
excludes - the fail-closed backstop; plumb the caller `cwd` through
`src/core/commands/query.js`, `src/core/commands/mcp.js` and
`src/core/mcp/server.js` so the case stays rare. `--include-local-only`
on the query verbs as the informed-consent override; help text names the
transcript-capture consequence; bundled skills never pass it. Withheld
rows are reported as a count on stderr (never the content), keeping the
never-silent ethos. Resolve LLP 0105 §graph-provenance here: graph
projection rows without per-row `cwd` provenance get content-bearing
properties suppressed on mixed-provenance rows (or provenance columns
propagated, whichever the projection's cost allows; the invariant is the
constraint). New hermetic smoke modeled on
`hypaware-core/smoke/flows/local_only_export_withhold.js`: seed rows from
a synced and a local-only cwd, query from a synced caller context, assert
the local-only rows are absent, the withheld count is reported, a
local-only caller sees everything, and `--include-local-only` restores
them. Tests: lattice truth table, unknown-caller exclusion, count
reporting, override plumbing. Carries `@ref LLP 0105 [implements]` at the
filter, `@ref LLP 0105#unknown [implements]` at the backstop.

### T5 - first-sync deadline hold + picker retirement (LLP 0101, LLP 0102)

Generalize `src/core/usage-policy/pick_pending.js` into a first-sync hold
(rename, e.g. `first_sync_hold.js` writing
`usage-policy/first-sync-hold.json`): the deadline is stored *inside* the
marker (an hours-long hold must survive incidental touches, so mtime
freshness no longer applies), computed as the next local 11:59pm rolled to
the following day when less than 4 hours away (LLP 0101 §deadline).
Fail-open polarity unchanged: unreadable or malformed reads as absent; a
past deadline reads as absent and is opportunistically unlinked.
`src/core/sinks/driver.js` `tick()` swaps `isPickPending` for the deadline
check, holding whole ticks driver-wide while `now < deadline`
(`held` reason in `src/core/sinks/types.d.ts` renamed accordingly).
`src/core/cli/remote_commands.js`: the attended fresh-enroll fork writes
the hold BEFORE `enrollCentralSink` (LLP 0100 R2; the LLP 0093 ordering
comment already marks the spot), no clear-on-exit (the hold runs to its
deadline, LLP 0101 §no-release - delete the `finally` clear);
`hyp join` and re-logins hold nothing (LLP 0101 §which). Retire the picker
per LLP 0102: delete `ENROLLMENT_PICKER_ENABLED`, the picker entry points
in `src/core/commands/local_only.js` (`runLocalOnlyPicker`,
`MAX_SHOWN_CANDIDATES`, the multiselect wiring - keep
`listCapturedDirectories`, `CAPTURE_DATASET` and the durable hint, which
survive as the skill's survey substrate), the captured-directory wait and
`freshenCaptureEnumeration` in `remote_commands.js`, and the picker's
unit-tested wiring. Update the LLP 0093 refs in the surviving hold code to
point at 0101. Tests: deadline computation incl. the 4-hour floor and DST
edges, hold ordering vs `enrollCentralSink` (the existing ordering
assertion adapts), tick held/released across the deadline, fail-open on
corrupt marker, join/re-login write no hold. Carries
`@ref LLP 0101 [implements]` on the hold write and deadline computation,
`@ref LLP 0101#hold [implements]` on the driver check (LLP 0100 §refs).

### T6 - login deadline message (R1) + `hyp status` deadline (R9)

`src/core/cli/remote_commands.js`: the enrolling fork prints the deadline
as an absolute local time, states that the first sync includes backfilled
history, and gives the skill invocation hint (the LLP 0100 §flow example
copy); the same message goes to stderr on a non-TTY login, nothing
prompts (LLP 0063 D3 stands). `src/core/commands/status.js` (and the
report collector it reads): while the hold is live, show the pending
first-sync deadline in text and `--json` renders, so a held machine is
never a silent state; expired or absent hold shows nothing. The message
copy is consent-surface copy: pin it with tests like the other consent
surfaces. Tests: TTY and non-TTY message content, status with live /
expired / absent hold. Carries
`@ref LLP 0100#requirements [implements]: R1` on the message and
`: R9` on the status surface.

### T7 - skills ride attach (LLP 0107)

Attach materializes the client's registered skills, not just hooks, on
both paths: manual `runAttach` in `src/core/commands/clients.js` (factor
the per-client materialization out of `runSkillsInstall` so both share
one implementation) and the org-driven reconciler
(`src/core/config/action_attach.js` / `action_reconciler.js`), which also
re-materializes when the pulled config changes the plugin or client set
(LLP 0107 §currency). Org-driven installs record what they materialized
in the existing attach marker so `hyp leave`
(`src/core/commands/central.js`) removes them with the settings edits;
manually attached skills carry no marker and stay; manual detach leaves
manually installed skills alone (reversal is strictly marker-driven,
LLP 0107 §reversal). No server contact: skill bytes come from locally
installed plugin packages. `hyp skills install` remains the standalone
manual path, unchanged. Update the LLP 0063 D3 pre-auth notice copy to
name helper skills among the dotfile touches (LLP 0107 §consent). Tests:
manual attach installs skills, reconciler installs and re-materializes on
config change, leave removes marker-tracked skills only, detach spares
manual installs. Carries `@ref LLP 0107 [implements]` on the shared
materialization and the reconciler wiring.

### T8 - session-start classification hook (LLP 0106)

A new attach-installed hook, alongside the existing session-context hook:
Claude side in `hypaware-core/plugins-workspace/claude/src/` (settings.js
hook wiring + a hook command; Claude's SessionStart hook protocol can
block with a prompt), Codex side degrading to a firm first-prompt nag
within its thinner hook surface (LLP 0106 "force is per-client
mechanics"; this task resolves the exact mechanism per client). Behavior:
on an enrolled machine (a central sink exists; inert otherwise, LLP 0106
§enrolled-only), an interactive session whose `cwd` has no explicit
governing class asks the user to classify: sync / local-only / ignore,
writing the answer through the same CLI verbs as everyone else
(`hyp ignore --private`, `--local-only`, the T2 explicit-sync spelling),
landing an LLP 0103 entry so the question is asked once per directory;
choosing sync writes the explicit `full` entry that suppresses the next
prompt. Headless / non-interactive sessions proceed under the implicit
default, leave the folder unclassified, and the hook must never hang or
fail a non-interactive run. The prompt copy is many users' first contact
with the class vocabulary: pin it with tests. Tests: unclassified +
interactive asks once, explicit entry suppresses, unenrolled inert,
non-interactive passthrough, answer lands via the verbs. Carries
`@ref LLP 0106 [implements]` on the hook; rides the LLP 0044 marker
perimeter so `hyp leave` disables it (T7's machinery).

### T9 - the `hypaware-privacy` skill, Claude + Codex (LLP 0100 §skill, R3-R8)

Skill sources at
`hypaware-core/plugins-workspace/claude/skills/hypaware-privacy/SKILL.md`
and `hypaware-core/plugins-workspace/codex/skills/hypaware-privacy/SKILL.md`
(one shared body, per LLP 0107's "sharing one skill source"; modeled on
`hypaware-ignore` / `hypaware-query`), registered in both
`hypaware.plugin.json` manifests (R8). The six-step job in order
(LLP 0100 §skill): (1) protect itself - opt the session out via the
gateway control endpoint (`/_hypaware/ignore/session`, LLP 0066) and
*verify* it took effect; on failure say so and continue only with explicit
consent (R3). Claude has `CLAUDE_CODE_SESSION_ID`; the Codex variant must
establish its own session-id discovery (Codex has no `hypaware-ignore`
skill today - the opt-out call is embedded in this skill, and finding the
Codex session id, e.g. from the rollout metadata `session_id`, is this
task's main risk). (2) check backfill settlement before surveying, warn
and offer to wait (the LLP 0094 failure mode). (3) survey: the
LLP 0069 §enumerate query (the `listCapturedDirectories` SQL over
`ai_gateway_messages` survives in `src/core/commands/local_only.js`) via
`hyp query`, then sample content per directory for credentials, personal
material, and identifiable-people discussion. (4) explain the three
classes in plain language before the first marking (R5). (5) propose as
short redacted excerpts, masking credential bodies, preferring names of
files/dirs over content (R4); apply nothing without per-item confirmation.
(6) apply only via the T2 verbs and offer `hyp purge` (T3) as a separately
confirmed step for every `ignore`d directory and flagged session (R6, R7);
never author policy files. Also states the LLP 0105 §scope honesty (hyp
surfaces only). Verification: a hermetic smoke or scripted walkthrough
asserting the skill doc's commands run against a seeded cache
(settlement check, enumerate, mark, purge), modeled on
`session_optout_capture_drop.js`. Carries
`@ref LLP 0100#skill [implements]` in both skill sources (LLP 0100 §refs).

## Tasks
- id: T1  branch: task/enrollment-privacy-review/T1  deps: []            complexity: 4  -- Machine-local store v2 with per-entry class (ignore|local-only|full), v1 migrate-on-read, resolver merge by entry class, explicit-full read API for the hook, and capture-seam plumbing so machine-local ignore actually stops recording (LLP 0103)
- id: T2  branch: task/enrollment-privacy-review/T2  deps: [T1]          complexity: 3  -- Class-aware marking verbs: hyp ignore --private / --local-only / explicit-sync spelling writing machine-local entries, symmetric unignore, --check names the governing source; dotfile meaning untouched, marking stays non-destructive (LLP 0103 cli)
- id: T3  branch: task/enrollment-privacy-review/T3  deps: [T1]          complexity: 4  -- hyp purge destructive verb: by path subtree, --session, --ignored sweep, --all; cache-only partition rewrite with part_id identity, watermark/settlement integrity, resurrection warning, dedupe check (LLP 0104)
- id: T4  branch: task/enrollment-privacy-review/T4  deps: [T1]          complexity: 5  -- Query-seam local-only visibility: one shared filter at executeQuerySql for query/graph/MCP, caller-class lattice test, unknown-caller excludes, --include-local-only override, withheld count, graph mixed-provenance handling, leak-closure smoke (LLP 0105, security critical)
- id: T5  branch: task/enrollment-privacy-review/T5  deps: []            complexity: 4  -- First-sync deadline hold: pick_pending generalized to an in-marker absolute deadline (next local 11:59pm, +1 day under 4h), written before enrollCentralSink, driver holds whole ticks, no early release; picker path deleted per LLP 0102 (LLP 0101)
- id: T6  branch: task/enrollment-privacy-review/T6  deps: [T5]          complexity: 2  -- Login prints the absolute deadline + backfill statement + skill hint on TTY and non-TTY stderr (R1); hyp status shows the pending first-sync deadline while the hold is live (R9); copy pinned by tests (LLP 0100)
- id: T7  branch: task/enrollment-privacy-review/T7  deps: []            complexity: 4  -- Skills ride attach: manual attach and the reconciler share one skill materialization, reconciler re-materializes on plugin/client-set change, org-driven installs marker-tracked and reversed by hyp leave, manual installs spared (LLP 0107)
- id: T8  branch: task/enrollment-privacy-review/T8  deps: [T2, T7]      complexity: 4  -- Session-start classification hook: enrolled machines only, interactive sessions in an unclassified cwd asked to classify once (sync/local-only/ignore) via the T2 verbs, Claude blocking prompt / Codex degraded nag, headless passthrough (LLP 0106)
- id: T9  branch: task/enrollment-privacy-review/T9  deps: [T2, T3, T7]  complexity: 4  -- hypaware-privacy skill for Claude and Codex: six-step job (self opt-out + verify, settlement check, survey, explain classes, redacted propose+confirm, apply via verbs + offered purge), registered in both plugin manifests (LLP 0100 skill, R3-R8)

## Notes

- **Three independent roots** (T1, T5, T7) can proceed in parallel; T4 is
  the security-critical path and deserves the most careful review; T9 is
  deliberately last-in-order so the skill documents verbs that exist.
- **No design doc** by convention: where a decision deferred mechanics "to
  the design doc" (LLP 0104 rewrite mechanics, LLP 0106 per-client force
  mechanics, LLP 0103 explicit-sync spelling), the owning task above
  resolves them, and the resolution lands as code plus `@ref`s.
- **Spec coverage** of LLP 0100 closes via the code `@ref`s named per task
  (LLP 0100 §refs), not via a design LLP.
- **Complexity** is rated for the hardest part of each task: T4 needs
  judgment about seam placement and graph provenance; T1/T3/T5/T7/T8/T9
  are worker-grade with real subtlety; T2/T6 are contained.
