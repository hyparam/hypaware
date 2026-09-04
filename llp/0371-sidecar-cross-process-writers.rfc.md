# LLP 0371: Plugin state sidecars have no cross-process writer coordination

**Type:** RFC
**Status:** Draft
**Systems:** Plugins, Sources, Core, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-04
**Related:** [LLP 0360](./0360-github-source-is-bundled.decision.md)
(#cursoring the sidecar design this coordinates, #resource-bounds sequential
repos inside one tick), [LLP 0361](./0361-github-capture-is-work-budgeted.decision.md)
(the whole-tick request budget that sets how long a lock would be held),
[LLP 0367](./0367-observed-repos-revalidate-against-withholding.decision.md)
(the revalidation sidecar that shares the shape and self-heals via the policy
fingerprint), [LLP 0301](./0301-bounded-compaction-resettle.issue.md)
(#requirements the in-process precedent, `withPartitionMutationLock`),
[LLP 0028](./0028-context-graph-enrichment.decision.md) (#per-session-watermark
the watermark sidecar pattern the github plugin copied),
hyparam/hypaware#1286, PR #1235

> Several bundled plugins persist mutable control state as a whole-file JSON
> sidecar under their kernel-assigned `stateDir`: read the whole file, mutate
> in memory over a tick, write the whole file back through an atomic
> tmp+rename. The write is atomic but the read-modify-write cycle is not, and
> the daemon and the CLI run the same tick code in different processes over
> the same `stateDir`. Concurrent ticks are last-writer-wins and the losing
> process's advances are erased. The kernel's only mutation lock is
> in-process, the plugin contract exposes no lock seam, and the sidecar shape
> is shared, so a github-only patch would fork the pattern instead of fixing
> it. This document states the race, the settled constraints, and the option
> space. It decides nothing.

## Summary

Issue #1286 (deferred from PR #1235 triage) records that the github plugin's
cursor sidecar races across processes: the daemon poll source and
`hyp github sync` / `hyp github backfill` each run `runCaptureTick`, which
reads `github-cursors.json` at tick start and writes the whole state back in
a `finally`. Two concurrent ticks interleave as read, read, write, write, and
the first writer's cursor advances vanish. The same shape, and the same
two-process exposure, exists in the github observed-repos sidecar and in the
context-graph-enrich watermark sidecar. Fixing it needs either a
cross-process lock plugins can use, which the kernel does not offer today, or
an enforced single-writer rule at the entrypoints, which needs the CLI-side
command to know the daemon holds a tick, a seam that also does not exist.
Both arms are design decisions with kernel-surface and product-behavior
consequences, so this RFC asks for that decision instead of smuggling a
mechanism in as a bug fix.

## The race, precisely {#race}

Affected code at `origin/master` (`aea83613`):

- `hypaware-core/plugins-workspace/github/src/tick.js`: `runCaptureTick`
  calls `readCursors(runtime.stateDir)` once at entry and
  `writeCursors(runtime.stateDir, cursors)` in a `finally`. The tick between
  those two points is budgeted at up to 400 API requests (LLP 0361), so the
  window is minutes, not microseconds.
- `hypaware-core/plugins-workspace/github/src/cursors.js`: whole-state
  sidecar `github-cursors.json`, atomic tmp+rename, no lock.
- `hypaware-core/plugins-workspace/github/src/observed-repos.js`: whole-state
  sidecar `github-observed-repos.json`, same write shape. A lost write here
  converges on a later tick because the policy fingerprint re-triggers
  revalidation (LLP 0367), so it is exposure, not damage.
- `hypaware-core/plugins-workspace/context-graph-enrich/src/state.js`:
  whole-state sidecar `enrich-state.json` via the shared
  `atomicWriteJsonSync` helper. The daemon registers propose and curate
  sources and the CLI registers `hyp enrichment propose|curate|backfill`,
  the same two-process pairing over one `stateDir`.

The processes: the daemon runs the poll source on its own schedule, and
`hyp github sync` / `backfill` is a separate CLI process dispatching the same
`runCaptureTick` over the same `stateDir`. Nothing coordinates them.

The blast radius is bounded, which is why the issue was deferred rather than
hotfixed: the rename is atomic, so the surviving file is always one process's
self-consistent view, and since-watermarks publish only at phase boundaries
after their rows append (LLP 0360#cursoring), so an erased `work` descriptor
degrades to re-fetching an uncommitted phase. That is duplicated rows and
lost progress, not a silently skipped range, and `hyp github backfill` is
full recovery.

## What the corpus and kernel already settle {#constraints}

- **The sidecar is the design, not the bug.** LLP 0360#cursoring decided
  cursors are mutable control state beside the table, not `github_events`
  columns. Any fix coordinates writers of the sidecar. Moving the state into
  the cache would reopen a settled decision.
- **The kernel's lock precedent is in-process only.**
  `withPartitionMutationLock` (`src/core/cache/partition.js`) is a promise
  chain keyed by partition dir in a module-level `Map`. It serializes flush
  against compaction inside one daemon process (LLP 0301#requirements). It
  cannot see a second process. There is no cross-process file-lock primitive
  anywhere in `src/core` to "expose": a state-dir lock is new infrastructure,
  with a lock-file protocol, staleness detection, and a contention policy to
  design.
- **The plugin contract has no seam to hang it on.** Plugins receive a bare
  `stateDir: string` (`hypaware-plugin-kernel-types.d.ts`). The only "lock"
  in the contract is the plugin-install lockfile, an unrelated concept.
  Plugins also cannot ask whether the daemon is running or mid-tick: daemon
  liveness lives in `src/core/daemon/status.js` behind CLI commands, not the
  plugin contract.
- **Tick duration is a decided property.** LLP 0361 deliberately lets one
  tick spend a large request budget and resume across ticks. Any lock held
  for a whole tick is held for minutes, and any lock scoped smaller than the
  tick does not stop the last-writer-wins erasure, because the in-memory
  state written at the end was read at the start.

## Options {#options}

### A. Kernel-exposed cross-process state lock, adopted by the github plugin {#option-lock}

The kernel grows a cross-process mutual exclusion primitive over a plugin's
state dir, for example `withStateLock(fn)` on the runtime context or a
`hypaware/core/util` export beside `atomicWriteJsonSync`, implemented as an
`O_EXCL` lock file carrying pid and timestamp. `runCaptureTick` wraps its
read-tick-write cycle in it. Two concurrent ticks over one `stateDir`
serialize, and neither tick's advance is lost.

Costs and open sub-decisions:

- New public surface on the plugin kernel contract, which is versioned and
  conservative by design.
- Contention semantics: does the second arrival wait (unbounded, behind a
  minutes-long backfill), wait with a timeout, or fail fast with a
  retryable error? Each is observable behavior for both the daemon schedule
  and the CLI user.
- Staleness: a crashed holder must not wedge the daemon forever, but a
  too-short staleness horizon steals the lock from a live budgeted backfill,
  recreating the race it exists to prevent. A pid-liveness check helps on
  one host and is still racy on pid reuse.
- Adoption scope: github cursors only, or also observed-repos,
  context-graph-enrich, and the pattern as documented guidance for future
  sidecars.

### B. Single-writer rule enforced at the entrypoints {#option-single-writer}

Document that the daemon is the only steady-state writer, and make
`hyp github sync` / `backfill` refuse or queue while the daemon holds a
tick. This is the issue's second acceptance arm.

Costs and open sub-decisions:

- "While the daemon holds the tick" is not observable today. Daemon
  liveness alone is too coarse: refusing `sync` whenever the daemon is
  running makes the command useless in its main scenario, forcing an
  immediate capture on a machine where the daemon is healthy. A tick-held
  marker file with staleness handling is option A's lock file with
  refuse-instead-of-wait semantics, so this arm converges on the same
  mechanism and mostly changes the contention policy.
- Alternatively the daemon could expose "pause the source, run my tick,
  resume" as a control-plane verb, which is a larger seam than a lock.
- Refusal is a product-behavior change to two shipped commands and needs
  its own UX decision (error text, exit code, retry guidance).

### C. Shrink the damage without serializing {#option-merge}

Re-read the sidecar immediately before `writeCursors` and merge per-repo
entries, taking the further-advanced cursor per repo, or split the sidecar
into one file per repo so concurrent ticks over disjoint repos cannot
clobber each other.

This narrows the window and the blast radius but does not close the race:
two ticks over the same repo still race the merge itself, and "further
advanced" is not well defined across a poll and a backfill whose `work`
descriptors differ in kind. It also fails the issue's acceptance condition
as written, which demands serialization or an enforced single-writer rule.
Recorded here so its rejection, if it is rejected, is on the record.

### D. Accept and document the race {#option-document}

The damage is re-work plus duplicate rows, recovery is `hyp github
backfill`, and the trigger needs a human running a manual capture against a
live daemon. Document the hazard on the commands and close. This fails the
issue's acceptance condition and leaves every future sidecar plugin to
rediscover the problem, but it is the honest null option and costs nothing.

## Decision requested {#decision}

1. Which arm: a cross-process lock (A), an entrypoint single-writer rule
   (B), or explicit acceptance (D). C is available as a complement, not a
   substitute.
2. If A or B: where the seam lives (plugin runtime context, a
   `hypaware/core/util` export, or daemon control plane), the contention
   semantics (wait, bounded wait, or refuse), and the staleness policy.
3. Adoption scope: github only, or every bundled whole-state sidecar, and
   whether the pattern becomes documented guidance for plugin authors.

The proof obligation from issue #1286 carries over unchanged: two concurrent
ticks over one `stateDir` serialize, shown by a test that interleaves them
and asserts neither tick's cursor advance is lost, or the CLI entrypoint
demonstrably refuses or queues while the daemon holds the tick.

## References

- hyparam/hypaware#1286 (deferred finding, PR #1235 triage)
- `hypaware-core/plugins-workspace/github/src/tick.js`, `cursors.js`,
  `observed-repos.js`
- `hypaware-core/plugins-workspace/context-graph-enrich/src/state.js`
- `src/core/cache/partition.js` (`withPartitionMutationLock`)
- `hypaware-plugin-kernel-types.d.ts` (plugin contract, `stateDir`)
