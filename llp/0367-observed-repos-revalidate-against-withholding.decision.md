# LLP 0367: The observed-repos inventory revalidates against current withholding

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Cache, Usage-Policy
**Author:** Phil / Codex
**Generated-by:** neutral
**Date:** 2026-09-03
**Related:** LLP 0069, LLP 0070, LLP 0071, LLP 0103, LLP 0188, LLP 0360,
LLP 0361; hyparam/hypaware#1235 (maintainer decision, option b)
**Extends:** LLP 0360

> The session-evidence repository inventory is no longer admission-time-only.
> The sidecar re-derives its repository set from the export-eligible evidence
> whenever the withholding policy changes, evidence rows disappear, or the last
> full derivation is old, so a repository with no remaining permitted evidence
> stops future GitHub capture. Revalidation streams the same narrow export-seam
> read the initial scan uses, under a fixed per-tick row budget, resumable
> across ticks; while it is incomplete, only repositories already re-confirmed
> are captured.

## Context {#context}

LLP 0360#inventory settles that withheld rows "do not expand" the GitHub
inventory, and is silent on contraction. The shipped sidecar was monotonic:
`repos` was only ever added to, and the `partition_versions` short-circuit
meant unchanged partitions were never re-examined. A repository admitted on
day one therefore kept being captured, and kept writing forwardable
`github_events` rows, after every session that evidenced it was marked
`local-only`, opted out at the client, or purged. That contradicts 0360's own
stated rationale: a repository evidenced only by withheld sessions must not
produce structural rows that a central sink could ship.

The maintainer decision on hyparam/hypaware#1235 selects contraction at the
inventory (option b): the sidecar re-validates against the current withholding
policy. It explicitly rejects paying for that with per-tick history re-scans,
and does not select row-level provenance columns on `github_events` (option c).

## Decision {#decision}

### Policy fingerprint {#policy-fingerprint}

A privacy-policy change is detected by comparing fingerprints, never by
re-reading history. The kernel storage service exposes
`exportPolicyFingerprint()`, a cheap stable digest of the mutable machine-local
inputs to the `readRowsSince` export seam:

- the machine-local class-per-entry list (LLP 0071/0103), fingerprinted as a
  hash of the list file's bytes so no directory path enters the digest, and
- the client sync opt-out set (LLP 0188), fingerprinted as the sorted withheld
  source ids (the TTL-cached live set the seam itself consults).

The sidecar persists the fingerprint its current `repos` set was derived
under. An ordinary tick recomputes the fingerprint (two small reads, no cache
I/O), and on a match keeps today's incremental behavior: unchanged partitions
are not reopened, and no history row is re-read.

The fingerprint deliberately does not cover committable `.hypignore` dotfiles:
they are unenumerable, so no cheap digest can. Dotfile-declared `local-only`
contraction is covered by the age trigger below instead.

### Revalidation triggers {#triggers}

A full re-derivation pass starts when any of these holds:

1. the current fingerprint differs from the persisted one (this also covers a
   pre-0367 sidecar with no persisted fingerprint), or
2. a tracked partition regressed: its `epoch:rowCount` version changed other
   than by row-count growth, or the partition disappeared. Purge recomputes
   `rowCount` from the live post-delete count, so purged evidence fires this
   trigger on the discover pass every tick already performs, or
3. the last completed derivation is older than seven days, the backstop for
   policy inputs the fingerprint cannot see (dotfile edits).

Triggers are re-derived from persisted state on every tick, never stored as
events, so a crash between detection and completion loses nothing. A
fingerprint change can retract and also re-admit: a directory moved back to
`full` restores its repositories on the same pass.

### Bounded, resumable, streaming revalidation {#bounded-revalidation}

Revalidation is the initial scan's read, restarted: per partition, the narrow
`columns: ['git_remote']` stream through `readRowsSince` from the beginning of
history, evaluated by the seam against the live policy. It differs only in
discipline, consistent with LLP 0361's whole-tick budget guarantees:

- **Budget.** One tick examines at most 50,000 rows across partitions. The
  budget is fixed implementation policy, not a user configuration surface
  (like LLP 0361's 400-request budget); tests inject smaller already-validated
  values.
- **Resumable.** Progress persists in the sidecar as a revalidation record:
  the fingerprint under revalidation, the repositories confirmed so far,
  per-partition continuations, and the set of completed partitions. A later
  tick, or a restarted daemon, resumes mid-partition rather than rescanning
  the completed prefix. A fingerprint change mid-pass restarts the pass
  against the new fingerprint.
- **Streaming.** Rows are consumed one at a time from the async stream and
  reduced immediately to `owner/repo` keys. Retained memory and persisted
  state are bounded by the distinct repository inventory plus per-partition
  cursor state, never by transcript-row count.
- **Atomic swap.** Only when every discovered partition completes does the
  pass replace `repos`, the partition continuations, and the versions, stamp
  the new fingerprint and derivation time, and clear the revalidation record.

While work remains, the sidecar reports pending and the capture tick surfaces
it, so the daemon resumes on LLP 0361's bounded backlog cadence instead of
waiting a full poll interval to finish contracting.

### Conservative while incomplete {#conservative}

While a revalidation record exists, the inventory the capture tick sees is the
set confirmed so far by the pass, not the pre-pass `repos`. A repository whose
permission is uncertain is therefore not captured and produces no new
forwardable rows during the window; it returns as soon as the pass re-confirms
it. The same rule applies to every trigger, including the age backstop, so
there is exactly one behavior to reason about and test.

Rows already written and forwarded are not retracted: `github_events` still
carries no row provenance (option c was explicitly not selected), and
LLP 0360#three-invariants' `ignore[]` remains the forward-only repository
control it settled.

### Telemetry {#telemetry}

Revalidation is observable in counts, never repository names
(LLP 0360#cadence): a started event carries the trigger and prior inventory
size; each budget-exhausted slice reports rows read, the row budget, partition
progress, and confirmed count; completion reports rows read, confirmed count,
and how many repositories were retired.

## Consequences {#consequences}

- Marking a directory `local-only`, opting a client out, or purging rows now
  stops future GitHub capture for a repository those sessions alone
  evidenced, within one revalidation pass of the next capture tick.
- An ordinary tick's cost is unchanged: fingerprint comparison plus the
  existing discover pass; zero history reads when nothing changed.
- A policy change temporarily pauses capture for not-yet-reconfirmed
  repositories; with the 50,000-row budget and 15-minute backlog cadence a
  large history converges over a handful of ticks.
- A `.hypignore` dotfile edit contracts the inventory only at the seven-day
  backstop, not immediately; the machine-local controls contract on the next
  tick.
- The sidecar state gains `policy_fingerprint`, `revalidated_at`, and a
  transient `revalidation` record; a pre-0367 sidecar (no fingerprint) simply
  revalidates once on upgrade.
