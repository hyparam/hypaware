# LLP 0104: `hyp purge` deletes cached rows, explicitly and only locally

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Usage-Policy, Sources
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0049, LLP 0030, LLP 0050, LLP 0069, LLP 0100, LLP 0103
**Extended-by:** LLP 0253 (#purge-and-detach-sweep: on acceptance of LLP 0262,
every form of the verb also empties the raw-body capture spool, which holds
un-projected bodies rather than cached rows; the target shapes, the
confirmation gate, and the cache-only stance here are unchanged)

> Retroactive deletion arrives as its own destructive verb. `hyp purge`
> removes already-cached rows by subtree, by session, by resolved-`ignore`
> sweep, or wholesale, and never touches sinks or the remote. This
> deliberately extends [LLP 0049 non-goal 2](./0049-hypignore-usage-policy.spec.md#non-goals)
> ("prospective-only; no purge"), which stands for the *marking* verbs:
> `hyp ignore` remains non-destructive.
>
> @ref LLP 0049#non-goals [implements] - ships the "separate, destructive capability" non-goal 2 explicitly deferred.

## Context

The privacy review ([LLP 0100](./0100-enrollment-privacy-review.spec.md))
makes 0049's residual-rows stance untenable for the `ignore` class: a user
who marks `~/journal` ignored during the review window means "this must not
sync at the deadline", and export-seam withholding is the `local-only`
contract, not the `ignore` one. "Never recorded" must not silently degrade
to "recorded, but withheld". The cache needs a way to actually forget.

## Decision

**A standalone `hyp purge`, keyed off targets, not off marking events:**

- `hyp purge <path>`: delete cached rows whose `cwd` equals or descends from
  the path (the [LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)
  ancestor rule), **regardless of the path's class**. Explicit purge may
  remove any data, `local-only` and synced included; the command is the
  user's, not the policy's.
- `hyp purge --session <id>`: delete one session's rows. This is the whole
  per-session retroactive story: session-scoped `local-only` was considered
  and deferred (a session-id withhold list at the export seam is a new
  mechanism for a rare want; the live case is already
  [LLP 0066](./0066-session-opt-out.spec.md)). `session_id` is the partition
  key ([LLP 0030](./0030-session-id-partition-key.decision.md)), making this
  the cheapest possible target.
- `hyp purge --ignored`: delete every cached row whose `cwd` currently
  resolves to `ignore`, from either source (dotfile or machine-local entry,
  [LLP 0103](./0103-machine-local-policy-classes.decision.md)). This is the
  review skill's bulk step, and it finally serves users who dropped a
  `.hypignore` after history was captured.
- `hyp purge --all`: empty the recorded datasets wholesale.
- Bare `hyp purge` with no target errors with usage; there is no implicit
  scope for a destructive verb.

**Boundaries:**

- **Cache-only.** Purge never contacts a sink or the remote and never deletes
  exported copies; server-side deletion stays out of scope
  ([LLP 0069 §non-goals](./0069-local-only-dir-selection.spec.md#non-goals)).
  During the review window ([LLP 0101](./0101-first-sync-review-window.decision.md))
  nothing has synced yet, so purge-before-deadline means genuinely
  never-forwarded.
- **Marking stays non-destructive.** `hyp ignore` in any form never deletes;
  a mistyped path must cost a config entry, not history. The skill composes:
  mark, confirm, then purge, each separately confirmed
  ([LLP 0100 R7](./0100-enrollment-privacy-review.spec.md#requirements)).
- **Resurrection warning.** Purging a subtree whose class still resolves to
  `full` is soft: the next backfill re-imports it from client logs. The verb
  warns and suggests marking `ignore` first; purge of an `ignore`d subtree is
  durable because the capture seam blocks re-import
  ([LLP 0049 R1](./0049-hypignore-usage-policy.spec.md#requirements)).

Mechanics (partition rewrite, `part_id` identity of rewritten parts,
watermark and settlement-buffer interaction) belong to the design doc that
follows, not this record.

## The subtree target matches a directory, and only one it can prove {#spellings}

`hyp purge <path>` names a **directory**, and a filesystem hands one directory
several spellings ([LLP 0050 §normalization](./0050-ignore-enforced-in-adapters.decision.md#normalization)).
Comparing the target against each row's `cwd` as a string therefore under-deletes:
rows recorded NFD survived a purge argument typed NFC (and the reverse, and case
variants), while the command printed `purged 0 rows` and exited 0 with empty
stderr. The user asked for data to be destroyed, was told it had been, and it
had not.

The obvious repair is the wrong one, and this section exists to say why. At the
gate the fold is free because the resolved class is `max(declared, folded)`, so
merging two genuinely distinct directories can only over-suppress. **Purge
deletes, so the same merge destroys rows for a directory the user never named**,
and the two failures are not symmetric: under-deleting leaves data the user
wanted gone, while over-deleting destroys data they never mentioned and cannot
get back. On every ext4 volume `caf` + U+00E9 and `cafe` + U+0301 really are two
directories with two inodes, as are `Proj` and `proj`, so a folding predicate on
Linux would delete a stranger's rows.

**Decision: the fold proposes, the filesystem disposes.** The one shared
predicate (`scopeGovernance` in `matcher.js`, the widened form of
`scopeGoverns`) gains an opt-in `proveAliases` mode that purge, and only purge,
passes:

1. Plain canonical matching runs first and is unchanged, so the common case
   costs exactly what it did.
2. Only when that says no does `foldPath` run, and only as a **candidate
   generator**: it names the prefix of the row's `cwd` that a spelling-folding
   volume would treat as the target.
3. That candidate is deleted only if `dev`/`ino` say the candidate and the
   target **are one directory** (`sameDirectoryOnDisk`, the identity test the
   case probe already uses, applied to the actual pair instead of a synthesized
   flip).

So the widening never rests on a rule about strings, and over-deletion is not
merely unlikely but unreachable: every extra row deleted sits under a directory
the filesystem itself identified with the one named. This is why no per-volume
normalization-insensitivity probe was added, and why the candidate generator
folds case with no probe at all. A volume verdict answers "does this volume fold
case?", from which a caller must still *infer* that two particular spellings are
one directory; comparing the pair directly needs no inference and no assumption
that the probed volume is the volume both spellings live on.

**A retention that cannot be proven is reported, never silent.** When the fold
proposes an alias and the filesystem does not confirm it, the rows stay, which is
correct, and `PurgeSummary` carries `retainedAliasRows` / `retainedAliasCwds` so
the CLI can name them on stderr. That closes the half of the defect the counts
alone do not: the original complaint was not only that rows survived but that
`purged 0 rows` with empty stderr is byte-identical to "that directory had
nothing cached". Note the inversion this repairs - a purge that *deletes* prints
the resurrection warning, so before this the failing case was the quieter of the
two.

**The report enumerates three causes, because there are three.** A note that
under-enumerates is making the same unearned claim it was written to avoid, so
this is a constraint on the wording and not a stylistic preference. Unproven
covers:

1. **Two directories.** This really is a case-sensitive (or normalization-
   sensitive) volume and the two spellings have two inodes. Only this one is the
   filesystem adjudicating "different".
2. **Not on disk.** The aliased spelling no longer exists, so the `stat` landed
   on nothing. The ordinary case: the user is purging a project directory they
   already deleted.
3. **Not checkable.** The `stat` could not be taken at all.
   `sameDirectoryOnDisk` answers `false` for **every** error, not only `ENOENT`,
   so an `EACCES` on an ancestor, an `ELOOP` on a self-referential symlink and
   an `ENOTDIR` all arrive here. The spelling may well be present and simply
   unreadable.

That collapse in `sameDirectoryOnDisk` is deliberate and stays: an unprovable
alias must not be widened onto whatever the errno was, or the `dev`/`ino` proof
above stops being a proof. It bounds only what the *message* may assert. So the
stderr note says "genuinely different, no longer on disk, or could not be
checked" and asserts none of the three; the concrete errno stays a diagnostic on
the `usage_policy.alias_probe_skipped` log line, since surfacing it per row would
mean threading a cause through the deletion predicate to improve a sentence.

**Deliberately unchanged.** Only the deletion predicate opts in. `policy unset`,
`policy show` and `hyp ignore --check` share `scopeGoverns` and keep their
unwidened answers: their disagreement with the gate fails *toward* privacy (an
opt-out the user spelled the other way stays on), so widening them is a separate
decision with its own disclosure argument, not a consequence of this one.
`--session`, `--ignored` and `--all` never compared spellings; `--ignored`
already classified each row through the folded gate.

> @ref LLP 0050#normalization [constrained-by] - the fold stops at the gate for free; here it is bought with a `dev`/`ino` proof.

## Consequences

- `hyp ignore --check`'s residual count stops being a dead end: it can now
  point at the verb that clears it.
- The forward-sink dedupe story must be checked in design: a purge-then-
  re-record of the same directory must not produce server-side duplicate
  identities the chunk-level dedupe cannot absorb.
- The `dev`/`ino` proof in [§spellings](#spellings) costs at most one `stat`
  pair per *distinct* row `cwd` that the fold proposes and plain matching had
  already rejected, so a cache whose rows are all inside or all far outside the
  target issues no extra syscall. `purgeCache` memoizes the verdict per `cwd`
  for the run.
- The residue is one-directional and safe: an aliased directory that has since
  been deleted, or that cannot be `stat`ed for any other reason, cannot be
  proven, so its rows are retained. They are reported, so the user can name that
  spelling directly.
- A row whose `cwd` is *lexically* inside the target while a symlink inside the
  target resolves it elsewhere is deleted. That is not this section's fold: it
  is the plain `canonicalSpellings` / `matchDepth` match, and it predates
  `proveAliases` (`scopeGoverns` returns `true` for the same fixture with the
  opt-in off). It is also what keeps the first consequence above true, since
  purge has to be able to clear exactly what the gate governs. Revisiting it is
  a change to
  [LLP 0050 §canonicalization](./0050-ignore-enforced-in-adapters.decision.md#canonicalization)'s
  set-of-spellings semantics, not to this decision.
