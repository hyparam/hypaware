# LLP 0080: local-only directory selection — technical design

**Type:** design
**Status:** Superseded
**Systems:** Sinks, CLI, Onboarding, Config
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-07-06
**Related:** LLP 0069, LLP 0070, LLP 0071, LLP 0072, LLP 0050, LLP 0063

> Buildable design for the interactive `local-only` directory selection at
> enrollment.
> `@ref LLP 0069 [implements]` — realizes the spec (picker, machine-local list,
> export-seam withholding; R1–R9).
> `@ref LLP 0070 [constrained-by]` — `local-only` is enforced at the shared export
> read (`storage.readRowsSince`), derived from each row's `cwd`; no cache-schema
> change; the cursor advances across dropped rows.
> `@ref LLP 0071 [constrained-by]` — the list is one machine-local file under
> `HYP_HOME` state, never a repo dotfile and never layered/central config.
> `@ref LLP 0072 [constrained-by]` — the picker is a skippable, TTY-gated,
> post-enrollment refinement that defaults to excluding nothing; never a consent
> gate.
>
> **Suspended-by [LLP 0094](./0094-enrollment-picker-suspended.decision.md):**
> the enrollment picker trigger this design wires into `hyp remote login` is
> currently disabled pending redesign (the fresh-enroll candidate wait raced
> the first backfill; the bounded 50-item presentation is also being
> rethought). The machine-local list and export-seam withholding remain live.
>
> **Superseded-by [LLP 0102](./0102-skill-replaces-enrollment-picker.decision.md):**
> the in-login picker this design specifies is retired permanently; the
> replacement acquisition path is the review window plus the
> `hypaware-privacy` skill ([LLP 0100](./0100-enrollment-privacy-review.spec.md)).
> The non-picker substrate (machine-local list, export-seam withholding,
> durable CLI) lives on under LLP 0069/0070/0071.

## Overview

Four pieces, all reusing existing machinery:

1. a **machine-local list store** in `src/core/usage-policy/` (new `local_only.js`);
2. the shared resolver (`src/core/usage-policy/matcher.js`) gains the list as a
   **second source** and `local-only` becomes an implemented class;
3. the **export seam**: `storage.readRowsSince` (`src/core/cache/storage.js`)
   drops `local-only` rows from what it yields to sinks while still surfacing
   their `after` continuation ("drop-but-advance"), with the three consumer
   call sites updated (central forward sink, `openIncrementalRows` for the
   s3/local-fs blob sinks, and the format-iceberg table format rerouted onto
   this seam);
4. the **attended surfaces**: a candidate-directory enumeration query, the
   picker in `hyp remote login` (reusing the existing `src/core/cli/tui/`
   `multiselect`), the durable `hyp ignore --local-only` verb family, and a
   `hyp status` line.

Nothing touches the capture path, the cache schema, the gateway, or the
adapters — `local-only` differs from `ignore` precisely in that the row is
recorded normally and withheld only at export ([LLP 0070](./0070-local-only-export-seam.decision.md)).

## The machine-local list store {#store}

New module `src/core/usage-policy/local_only.js`:

- **Path.** `localOnlyListPath(stateDir)` →
  `<stateDir>/usage-policy/local-only.json`, where `stateDir` is
  `readObservabilityEnv(env).stateDir` (`$HYP_HOME/hypaware`,
  `src/core/observability/env.js`). It is `HYP_HOME` state, so it survives
  cache rebuilds and `hyp leave` ([LLP 0071 consequences](./0071-machine-local-exclusion-list.decision.md#consequences)).
- **Format.** Exactly LLP 0071's sketch: `{ "version": 1, "dirs": [
  "/abs/path", ... ] }`. Entries are normalized absolute paths
  (`path.resolve`), deduplicated, sorted; paths need not exist on disk or be
  git repos (R4).
- **API.** `readLocalOnlyDirs({ stateDir, fs? })` → `string[]` — a missing
  file is the common case and returns `[]`; a present-but-unparseable file
  **throws** (see [fail-safe](#fail-safe)). `writeLocalOnlyDirs({ stateDir,
  dirs, fs? })` — `mkdir -p` the parent, write tmp + rename (the same
  atomic-write discipline other `HYP_HOME` state uses, e.g.
  `src/core/sinks/watermarks.js`).

### Fail-safe: a corrupt list fails the export tick, loudly {#fail-safe}

An unreadable/unparseable `local-only.json` is an uninterpretable privacy
signal. Resolving it as "empty list" would silently forward directories the
user marked private (expose more — forbidden by
[LLP 0049 §fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe));
silently dropping **and advancing the cursor past** every row would durably
skip rows the user never excluded. So the store throws, the resolver
propagates, and `readRowsSince` lets the error fail the partition read: the
sink's existing per-partition failure path retries next tick with the
watermark untouched. Suppress more, lose nothing, self-heal on fix, and the
failure is a structured error naming the file — never a silent state.

## The resolver gains a second source {#resolver}

Per [LLP 0070 §resolver](./0070-local-only-export-seam.decision.md#resolver),
`createUsagePolicyResolver` (`src/core/usage-policy/matcher.js`) is extended,
not duplicated:

```js
// @ref LLP 0070#resolver [implements] — one shared resolver, two sources, most-restrictive class wins
// @ref LLP 0071 [implements] — the machine-local list is the second source
createUsagePolicyResolver({ readFileSync, existsSync, now, ttlMs, localOnlyListPath })
```

- When `localOnlyListPath` is set, `resolve(cwd)` computes both the existing
  `.hypignore` ancestor walk **and** list membership — `cwd` equals or is a
  path-segment descendant of a listed dir (the [LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)
  ancestor rule; segment-aware, so `/a/bc` is not under `/a/b`) — and returns
  the most restrictive class: `ignore` > `local-only` > `full`.
- A list-governed result is `{ class: 'local-only', governedBy:
  <localOnlyListPath>, declared: 'local-only' }`, so `--check` and logs can
  name the governing source uniformly.
- The parsed list is memoized with the same short TTL as the per-`cwd` memo
  (`CACHE_TTL_MS`, 5s), so the export hot path does one file read per TTL
  window and a list edit is honored by a running daemon within the window —
  the same staleness bound `.hypignore` already has
  ([LLP 0052 §matcher](./0052-hypignore-usage-policy.design.md#matcher)).
- `format.js`: `IMPLEMENTED` gains `'local-only'` — the growth LLP 0052
  anticipated ("grows additively when local-only ships"). A committable
  `.hypignore` declaring `local-only` now resolves to `local-only` instead of
  clamping to `ignore`. This is the loosening-the-user-asked-for that
  [LLP 0070 consequences](./0070-local-only-export-seam.decision.md#consequences)
  explicitly blesses (upgrading only ever exposes *less* than the declared
  intent, never more), and keeps the dotfile form available for users who
  deliberately want the shared, committable variant
  ([LLP 0071 alternatives](./0071-machine-local-exclusion-list.decision.md)).

## Export-seam enforcement: drop-but-advance {#export-seam}

### The filter in `readRowsSince` {#filter}

`createQueryStorageService` (`src/core/cache/storage.js`) gains an optional
`usagePolicyResolver`; the single construction site
(`src/core/runtime/activation.js:55`) defaults it to
`createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir) })`
so every kernel boot enforces the policy without per-caller opt-in. Inside
`readRowsSince`:

```js
// @ref LLP 0070#enforce [implements] — per-row export filter, derived from the row's cwd at export time
// @ref LLP 0069#enforce [implements]
const cwd = row.cwd
if (typeof cwd === 'string' && cwd !== '' && resolver.resolve(cwd).class !== 'full') {
  yield { after, dropped: true }   // no row payload — cursor still advances
  continue
}
yield { row, after }
```

- The check runs before internal-field stripping, keyed on the row's existing
  `cwd` column — no schema change, retroactive over already-cached and
  backfilled rows by construction (R5, [LLP 0070 §derive](./0070-local-only-export-seam.decision.md#derive)).
- Rows without a `cwd` (logs/traces/metrics/proxy datasets) pass through
  untouched — directory exclusion is structurally a no-op for them
  ([LLP 0069 non-goal 3](./0069-local-only-dir-selection.spec.md#non-goals)).
- Dropping on `class !== 'full'` (not `=== 'local-only'`) also withholds the
  *residual* cached rows of a directory `.hypignore`d after capture — the
  most-restrictive ordering of [LLP 0070 §resolver](./0070-local-only-export-seam.decision.md#resolver)
  applied at the seam: `ignore` is a strictly stronger privacy signal than
  `local-only`, so forwarding its residue would be perverse.
- The resolver's per-`cwd` TTL memo makes this one cached map hit per row and
  one real resolve per distinct directory per window
  ([LLP 0070 §granularity](./0070-local-only-export-seam.decision.md#granularity)).
- `readRows` (the full-scan sibling) is **not** filtered: its callers are
  capture-side settlement/dedupe reads (`ai-gateway/src/dataset.js`,
  `message_projector.js`) and local indexing (`vector-search`) that must see
  every cached row — filtering there would corrupt dedupe and break the
  "locally queryable" half of `local-only`. The one `readRows` caller that
  *is* an export path is rerouted below ([iceberg](#iceberg)).

### Yield shape and the kernel contract {#yield}

`QueryStorageService.readRowsSince` (`hypaware-plugin-kernel-types.d.ts:1172`)
changes its element type to a discriminated union:

```ts
AsyncIterable<
  | { row: Record<string, unknown>, after: SinkContinuation, dropped?: undefined }
  | { row?: undefined, after: SinkContinuation, dropped: true }
>
```

A drop-only entry carries the running high-water `after` and nothing else: the
payload never exists off the cache read, so no sink can forward it by
accident, yet every consumer can advance its cursor across it — the invariant
[LLP 0070 §incremental](./0070-local-only-export-seam.decision.md#incremental)
fixes. Both in-repo consumers are updated in the same change (the type is
load-bearing).

### Central forward sink {#central}

`forwardPartition` (`hypaware-core/plugins-workspace/central/src/sink.js:306`):

```js
// @ref LLP 0070#incremental [constrained-by] — the cursor advances across dropped rows
for await (const entry of storage.readRowsSince(tablePath, { since, includeLegacy })) {
  lastAfter = entry.after
  if (entry.dropped) { droppedRowCount += 1; continue }
  // ...existing chunk buffering of entry.row...
}
```

and the end-of-partition watermark gate widens from `shippedRowCount > 0` to
`shippedRowCount > 0 || droppedRowCount > 0`. Ship-first/advance-second is
preserved: a dropped row is never shipped, so advancing past it needs no ack;
a failed chunk POST still throws before the watermark write, so a partial
partition still never checkpoints. A partition tail of `local-only` rows
therefore checkpoints once and is durably passed — not re-scanned each tick,
not re-sent on un-exclusion ([LLP 0069 R5](./0069-local-only-dir-selection.spec.md#requirements)).
The partition-level log gains `dropped_row_count`.

### Blob sinks via `openIncrementalRows` {#blob}

`openIncrementalRows` (`src/core/sinks/incremental.js`) skips drop-only
entries in its `rows()` stream while advancing `state.lastAfter` on every
entry (including trailing drops after the last real row), counts them in a new
`droppedRowCount`, and decides `empty` by peeking past leading drops to the
first **payload** row. New reader field: `droppedRowCount`.

The s3 and local-fs sinks (`s3/src/index.js:281`, `local-fs/src/index.js:119`)
change their skip-empty branch: when `reader.empty && reader.droppedRowCount >
0`, write the watermark to `reader.lastAfter` before `continue` — a drop-only
tick must checkpoint, or the tail re-scans forever. A non-empty export already
persists `reader.lastAfter` after the durable PUT, which now includes drops in
its high-water. `withSeqRangeFilename` is unchanged: the range keys on
consumed seqs, so a crash-retry reproduces the same object key.

### format-iceberg: reroute the last full-scan export {#iceberg}

The format-iceberg table format's `openRows`
(`hypaware-core/plugins-workspace/format-iceberg/src/table-format.js:446`)
reads whole partitions via the unfiltered `storage.readRows` — the one export
path not on the shared seam, and it would leak `local-only` rows. It is
rerouted onto `readRowsSince` with no `since` (a full scan: `continuationToSeq`
treats absent as `0n`, `includeLegacy: true`), skipping drop-only entries and
discarding `after` tokens — the table format is snapshot/marker-based, not
watermark-based, so there is no cursor to advance. This makes "every sink
funnels through the one filtered seam"
([LLP 0070 §why-export](./0070-local-only-export-seam.decision.md#why-export))
true by construction rather than by convention.

Local query is untouched: `executeQuerySql` → squirreling → parquet source
never calls `readRowsSince`, so `local-only` rows stay fully queryable — the
structural property LLP 0070 relies on.

## Enumerating candidate directories {#enumerate}

New module `src/core/commands/local_only.js` (sibling of
`src/core/commands/clients.js`, whose `countResidualCachedRows` sets the
pattern):

```js
// @ref LLP 0069#enumerate [implements] — distinct captured cwds, local cache only
export async function listCapturedDirectories({ query, storage, config })
```

- One `executeQuerySql` call (`src/core/query/index.js`, `refresh: 'never'`):
  `SELECT cwd, repo_root, COUNT(*) AS rows, MAX(date) AS last_seen FROM
  ai_gateway_messages WHERE cwd IS NOT NULL GROUP BY cwd, repo_root ORDER BY
  last_seen DESC` — read from this machine's cache, never the remote (R2).
- Results are collapsed to one candidate per distinct `cwd` (a Codex `cwd`
  has a null `repo_root` by design and groups by `cwd` alone; a `cwd` seen
  under several `repo_root`s keeps the most recent), carrying `repo_root`,
  row count, and last-seen for display (R3).
- **Bounded presentation** (resolves the spec's open questions): the picker
  shows at most the **50** most-recently-active candidates; more prints a
  one-line `…and N more — manage with 'hyp ignore --local-only <path>'`. The
  aggregate itself is tiny (distinct-`cwd` cardinality), so LLP 0054 bounded
  execution is not implicated at this size; if the engine refuses or errors,
  enumeration is **best-effort**: return `null`, and the picker is skipped
  with the durable-command hint — a failed enumeration must never block
  enrollment (same catch-to-null discipline as `countResidualCachedRows`).

## The picker {#picker}

`runLocalOnlyPicker({ ctx, stateDir })` in `src/core/commands/local_only.js`:

- **TTY gate** (R1, [LLP 0072 §tty](./0072-enrollment-dir-picker.decision.md#tty)):
  runs only when stdin and stderr are interactive TTYs; otherwise prints the
  one-line durable-command hint and returns zero exclusions without prompting.
- **Component**: the existing `multiselect` from `src/core/cli/tui/index.js`
  (already keyboard-driven, checkbox-toggling, injectable stdin/stdout for
  tests) — LLP 0072 assumed this was net-new; it is not, which removes its
  main cost. The prompt renders on `ctx.stderr` so stdout stays clean for
  scripts. Each option's label is the path; its `summary` carries
  `repo_root`, exchange count, and last-seen.
- **Defaults and dismissal** ([LLP 0072 §default](./0072-enrollment-dir-picker.decision.md#default)):
  fresh candidates are unchecked; Enter with nothing selected, Ctrl-C, and EOF
  (`PromptCancelledError` from the tui runtime, via `isPromptCancelledError`)
  all resolve to **zero exclusions and proceed** — the picker can narrow an
  enrollment, never abort one. An empty/`null` candidate list skips with the
  hint.
- **Editor semantics on re-login**: candidates already on the list are shown
  pre-checked — they are the user's own prior affirmative choices, so
  pre-checking them does not violate "the tool does not infer"
  ([LLP 0072 §default](./0072-enrollment-dir-picker.decision.md#default), which
  forbids the *tool* pre-excluding). The confirmed checked set replaces list
  entries that appeared as candidates; list entries **not** offered (vanished
  or not-yet-captured directories) are preserved untouched.
- **Persist, then never-silent**: selections are written via
  `writeLocalOnlyDirs` and the flow prints
  `withholding N director(ies) from forwarding — recorded locally, never sent`
  ([LLP 0072 §never-silent](./0072-enrollment-dir-picker.decision.md#never-silent)).

### Wiring into `hyp remote login` {#login}

In `runBrowserLogin` (`src/core/cli/remote_commands.js`), the picker runs
after `seed(...)` succeeds and **before** the `seeded.length === 0` fork —
i.e. after the gateway credential is confirmed and past the `--no-forward`
early-return (both skips fall out of the placement for free), and strictly
before `enrollCentralSink` (`remote_commands.js:428`), so the list is on disk
before the daemon's first export pass and a dismissed picker leaves no
half-enrolled machine (R6, [LLP 0069 §trigger](./0069-local-only-dir-selection.spec.md#trigger)).
Running before the fork also covers the already-enrolled re-login (R1: "or
already targets a central sink"), where it acts as a convenient list editor.

```js
// @ref LLP 0069#trigger [implements] — picker after credential, before enrollCentralSink
// @ref LLP 0072 [implements] — skippable post-enrollment refinement, never a consent gate
await runLocalOnlyPicker({ ctx, stateDir })
```

A picker *failure* (thrown error other than cancellation) is caught, warned,
and treated as zero exclusions: the privacy refinement must never break the
enrollment it refines.

> **Superseded placement, [issue #281].** The "strictly before
> `enrollCentralSink`" wiring above enumerated the local cache *before* the daemon
> it installs had backfilled anything, so the picker showed no candidates and
> silently skipped on every first-time enroll (see
> [LLP 0069 §trigger, Revisited-by #281](./0069-local-only-dir-selection.spec.md#trigger)).
> The fix moves the picker on the auto-daemon fresh-enroll path to *after* the
> `waitForClientAttach` step, gated on a bounded, best-effort
> `waitForCapturedDirectories` poll (`src/core/cli/remote_commands.js`) so it runs
> against the populated cache. The `--no-daemon` fresh-enroll fork likewise now
> runs the picker after `enrollCentralSink` writes the sink config rather than
> strictly before it, but installs no forwarding daemon this run, so the list
> still lands before any export (R6 holds); the already-enrolled re-login fork
> runs against the already-populated cache. Everything else in this design
> (store, resolver, export seam, CLI, status) is unchanged.

> **Revisited-by [issue #281] follow-up (fresh-enroll registry staleness).** The
> reordered wiring above still enumerated through the login process's boot-time
> query-registry snapshot, which on a genuinely fresh box predates the org
> config pull that enables `@hypaware/ai-gateway` — so `ai_gateway_messages` was
> unregistered, the enumeration failed to null, and the picker still silently
> skipped. The fix adds `freshenCaptureEnumeration`
> (`src/core/cli/remote_commands.js`): after a client attaches (which
> guarantees the pulled central layer is on disk), the login re-boots one fresh
> kernel and hands its registry's enumeration to the
> `waitForCapturedDirectories` poll. Best-effort and one-shot; every other part
> of this design is unchanged. See
> [LLP 0069 §trigger, the follow-up note](./0069-local-only-dir-selection.spec.md#trigger).

> **Extended-by [LLP 0093](./0093-pick-pending-export-hold.decision.md)
> (export hold during the pick).** The one-time backfill forwarding window
> both notes above describe is now closed: a bounded pick-pending marker
> (`usage-policy/pick-pending.json`, written by the enrolling login before
> `enrollCentralSink`, cleared on every exit from that fork) holds sink
> driver ticks while fresh, restoring R6's "not forwarded, even once" on the
> auto-daemon fresh-enroll path.

## CLI: the durable authoring path {#cli}

`hyp ignore` / `hyp unignore` / `hyp ignore --check`
(`src/core/commands/clients.js`) gain a `--local-only` flag
(`parseIgnoreArgs`), per [LLP 0072 §cli](./0072-enrollment-dir-picker.decision.md#cli)
— same verbs, second store:

- `hyp ignore --local-only [path]` — resolve the target like `runIgnore`
  (repo root when in a repo, else the path/cwd; explicit path wins), then
  read/modify/write the machine-local list. Never writes into a repo; the
  path need not exist or be a repo (R4). Idempotent: already governed (exact
  entry or ancestor entry) ⇒ no-op success naming the governor.
- `hyp unignore --local-only [path]` — remove every list entry that governs
  the target (equal or ancestor), printing what was removed — the same
  "remove the governing thing" semantics as dotfile `unignore`. Idempotent.
- `hyp ignore --check [path]` — the extended resolver now reports
  `local-only` membership via the same `resolve()` call: resolved class, the
  governing source (dotfile path or the list file), and the existing residual
  cached-row count, which for a `local-only` scope reads as "recorded locally,
  withheld from forwarding" ([LLP 0049 §prospective-only](./0049-hypignore-usage-policy.spec.md#prospective-only)).
- Verb registration summaries/usage strings in `src/core/cli/core_commands.js`
  are updated to name the flag.

Both the picker and the verbs are thin front-ends over the one store + one
resolver — one place privacy-critical logic lives, one place to test
([LLP 0072 consequences](./0072-enrollment-dir-picker.decision.md#consequences)).

## `hyp status`: never-silent withholding {#status}

`collectHypAwareStatus` (`src/core/daemon/status.js`) gains a best-effort
`usagePolicy: { localOnlyDirCount }` read via `readLocalOnlyDirs` (a corrupt
file surfaces as a diagnostic, consistent with [fail-safe](#fail-safe));
`runStatus` (`src/core/commands/status.js`) renders
`local-only: withholding N directories from forwarding (recorded locally)` in
text and the count in `--json` when N > 0 — "enrolled but withholding" is a
visible state (R9).

## Composition with the neighbouring mechanisms {#composition}

Per the spec's [neighbours table](./0069-local-only-dir-selection.spec.md#neighbours),
the three mechanisms stay independent and compose by construction:

- `.hypignore` `ignore` and the session opt-out drop at the **capture seam**
  — those rows never reach the cache, so the export filter never sees them;
- the `local-only` list acts only at the **export seam** — rows are cached and
  locally queryable; the resolver returns the most restrictive class when both
  sources govern one directory, and the export filter's `class !== 'full'`
  test makes any non-`full` verdict withhold;
- no ordering or configuration dependency exists between them; removing one
  never widens another.

## Telemetry {#telemetry}

Log-driven (CLAUDE.md): per-partition aggregate on the export read —
`usage_policy.export_drop` with `component: 'cache'`, `hyp_dataset`,
`dropped_row_count`, `distinct_cwd_count` (cwds hashed/redacted, never raw
paths in dev telemetry). Picker events: `local_only.picker_result` with
`candidate_count`, `selected_count`, `outcome`
(`selected|none|cancelled|non_tty|no_candidates|enumeration_failed`). Store
writes: `usage_policy.local_only_write` with `dir_count`. Fail-safe errors
carry `error_kind: 'local_only_list_unreadable'` and the file path.

## Test plan {#tests}

Traditional tests (the bulk, deterministic):

- **store**: round-trip; missing ⇒ `[]`; corrupt ⇒ throws with `error_kind`;
  normalization/dedupe; atomic replace.
- **resolver**: equal/descendant/sibling-prefix (`/a/bc` vs `/a/b`) matching;
  most-restrictive vs `.hypignore`; TTL re-read of an edited list; dotfile
  `local-only` token now resolves (not clamped); no-list-path resolver
  behaves exactly as today.
- **`readRowsSince`**: local-only cwd ⇒ drop-only entry with advancing
  `after`; `full` rows unchanged; cwd-less rows pass; mixed partition
  interleaving; corrupt list ⇒ the scan throws.
- **central sink**: drop-only tick advances the watermark; mixed tick ships
  only `full` rows to the high-water `after`; a directory un-excluded after a
  checkpoint is not re-sent; failed chunk still never checkpoints.
- **`openIncrementalRows` + blob sinks**: leading/trailing drops; all-drop ⇒
  `empty` with advanced `lastAfter` and `droppedRowCount`; s3/local-fs write
  the watermark on a drop-only tick and PUT nothing.
- **iceberg**: rerouted `openRows` excludes local-only rows from the snapshot.
- **CLI**: `--local-only` add/remove idempotency; `--check` reports class +
  governor for both sources.
- **picker**: injected tui io; cancel/EOF/enter-nothing ⇒ zero exclusions and
  proceed; non-TTY skip with hint; empty candidates skip; pre-checked
  existing entries; non-candidate entries preserved.

Hermetic smoke `local_only_export_withhold`: cache rows from two cwds, mark
one `local-only`, run the forward/export path; assert the clean cwd's rows
export, the excluded cwd's rows stay cache-queryable and reach no sink, the
watermark advances past them, the `usage_policy.export_drop` event fires, and
`hyp status` shows the count (stable `smoke_name`/`smoke_step`).

## Out of scope

Carried from [LLP 0069 §non-goals](./0069-local-only-dir-selection.spec.md#non-goals):
no retroactive purge or server-side deletion; directory-scoped only;
raw-proxy/OTEL stays directory-blind; never central config; no live-call
effect. The org-forces-forwarding policy stays deferred to
[LLP 0072 §org-policy](./0072-enrollment-dir-picker.decision.md#org-policy).

## Annotation map (for the implementing change set)

| Site | Annotation |
|------|-----------|
| `src/core/usage-policy/local_only.js` (store) | `@ref LLP 0071 [implements]` |
| `src/core/usage-policy/matcher.js` (second source, most-restrictive) | `@ref LLP 0070#resolver [implements]`, `@ref LLP 0071 [implements]` (alongside the existing `@ref LLP 0050`) |
| `src/core/cache/storage.js` `readRowsSince` row filter | `@ref LLP 0070#enforce [implements]`, `@ref LLP 0069#enforce [implements]` |
| `central/src/sink.js` cursor-across-drops + watermark gate | `@ref LLP 0070#incremental [constrained-by]` |
| `src/core/sinks/incremental.js` drop-skip/advance | `@ref LLP 0070#incremental [constrained-by]` |
| `format-iceberg/src/table-format.js` `openRows` reroute | `@ref LLP 0070#why-export [implements]` |
| `src/core/commands/local_only.js` enumeration | `@ref LLP 0069#enumerate [implements]` |
| picker call in `remote_commands.js` `runBrowserLogin` | `@ref LLP 0069#trigger [implements]`, `@ref LLP 0072 [implements]` |
| `hyp ignore`/`unignore` `--local-only` branches | `@ref LLP 0072#cli [implements]` |
| `hyp status` local-only line | `@ref LLP 0069#requirements [implements]` (R9) |
