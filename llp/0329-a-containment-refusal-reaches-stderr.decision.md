# LLP 0329: A containment refusal reaches stderr, because the log substrate is dark by default

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Observability, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-30
**Extends:** [LLP 0326](./0326-generation-name-is-the-directory.decision.md)
(#consequences: the loudness those bullets rely on now has a channel that
exists on a default install), and
[LLP 0328](./0328-a-spool-path-is-checked-where-it-is-walked.decision.md)
(#loud-refusal: the same qualification, for the capture-spool guard)
**Extended-by:** [LLP 0332](./0332-cursor-refusal-warns-on-transition-then-rewarns.decision.md)
(#consequences: the cursor guard's per-read line rate is rebased to
warn-on-transition plus a rewarn interval; the refusal itself still reaches
stderr), and
[LLP 0335](./0335-a-telemetry-failure-is-said-once-never-thrown.decision.md)
(#stderr-mirror: the mirror's "beside the emit" is made structural by a guard
whose own one-line diagnostic is a fifth unconditional stderr write, beyond
the four opt-in refusal lines settled here), and
[LLP 0362](./0362-an-absence-only-degradation-opts-into-the-stderr-mirror.decision.md)
(#stderr-mirror: the opt-in set is restated by the property it always turned
on, so a report whose subject is observable only as an absence takes the
mirror whether or not the site reporting it refused)
**Related:** LLP 0021, LLP 0189, LLP 0323, LLP 0326

> Every containment guard in the symlink series says its refusal out loud at
> WARN, and on a default install nobody hears it: with neither
> `HYP_DEV_TELEMETRY` nor `OTEL_EXPORTER_OTLP_ENDPOINT` set, no logger
> provider is installed and `Logger.emit` drops the record before any
> exporter sees it. A refused spool is then byte-identical to an empty one,
> which for `hyp purge`, a delete-my-data verb, is a privacy defect and not
> only a disk one. The refusal reports now opt into the stderr mirror that
> already existed in `getLogger`, at the emitting site: the WARN still flows
> to the structured substrate when one is installed, and the same line
> reaches the process's stderr always. An ordinary run stays silent, because
> the mirror is on the refusal reports, not on a level.

## The substrate the loud-refusal claims assumed {#dark-substrate}

LLP 0323 #say-it introduced the pattern: a guard that refuses instead of
repairing must name its refusal, because refusing is otherwise
indistinguishable from having nothing to do. LLP 0326 applied it to the three
cache guards (`cursor_table_dir_escapes_partition`, `sweep_path_is_symlink`,
`spool_dir_is_symlink`) and its `#consequences` calls the resulting states
loud. LLP 0328 #loud-refusal makes the identical claim for
`capture_spool_path_is_symlink` and promises that `ls -l` at a logged path
answers in one line.

All four claims route through `getLogger(...).warn(...)`, and the chain under
that call was verified on master at issue hyparam/hypaware#1108:

- `installLoggerProvider` pushes an exporter only when `env.devTelemetry` is
  set, or when `otlpEndpoint` is set and dev telemetry is not. With neither
  env var present, `exporters` is empty and the provider is `null`.
- `Logger.emit` begins `if (!provider) return`. The record is constructed and
  dropped.
- `getLogger`'s `mirrorStderr` option, the one path that writes without a
  provider, was passed by nothing anywhere in the tree.

Measured through the real CLI: with a planted symlink standing where a
generation name resolves, `hyp purge --all --yes --json` printed
`{"rowsDeleted":0,...}`, wrote nothing to stderr, and exited 0, which is
byte-identical to purging an already-empty install. The partition's rows were
retained, and the verb that exists to delete data reported success. The same
silence covers a symlinked `_hypaware_spool` (a table that quietly stops
committing) and a symlinked sweep component (a generation that quietly stops
reclaiming), and it covers the one legitimate case the series knowingly
refuses: a user who symlinks a spool onto a larger volume loses reclamation
with disk growth as the only symptom.

So the corpus claimed visibility the substrate does not deliver. The docs are
Accepted and stay as written; this decision is the qualification, recorded
the way CLAUDE.md routes changes to frozen docs.

## The refusal reports opt into the stderr mirror {#stderr-mirror}

Each containment refusal report passes `{ mirrorStderr: true }` to
`getLogger`. That seam already existed for the dev harness: it writes the
same severity, message, and attributes to `process.stderr`, and it does so
whether or not a provider is installed, because it sits beside the OTel emit
rather than behind it.

What this buys, per property:

- **It exists on a default install.** stderr is the one channel every process
  has without configuration. In a terminal it reaches the operator directly.
  Under launchd or systemd the service manager captures it into the daemon's
  log file, which matters because two of the guards fire mostly on daemon
  maintenance ticks, not under any verb.
- **It is scoped to the refusals.** The mirror is per-call-site, so nothing
  else any verb prints changes. An empty spool, an absent spool, and an
  ordinary reclaim stay exactly as quiet as they were: the mirror only ever
  writes when a guard actually refused, and a refused spool and an empty
  spool are now distinguishable, which is the whole point.
- **It keeps the structured record.** When a provider is installed (dev
  telemetry, or a configured OTLP endpoint), the WARN still flows there
  unchanged, with the same `error_kind` attributes. The mirror is an
  addition, not a rerouting.

The mirrored line carries the attributes JSON, `error_kind` and the refused
path included, so the `ls -l` promise in LLP 0326 and LLP 0328 is now kept
verbatim: the path to ask about is on the line the operator can actually see.
The paths named are directories the cache or the spool layout owns, never
spooled body names, so LLP 0253's counts-not-names rule is not disturbed.

The rule this settles for future guards: **a refusal that leaves every
counter at zero must opt into the stderr mirror.** A guard whose refusal is
already surfaced in its verb's output (a nonzero `failed`, an error line) does
not need it; a guard whose refusal is observable only as an absence does.

## Not through the verbs' return shapes {#not-the-verb}

The first alternative was to thread the refusal through each invoking verb:
a `refused` count on `sweepCaptureSpool`'s return, a line in `runPurge`, a
warning in detach's existing warnings channel. For the detach half that
channel has precedent two lines above the call, and PR #1107's review
recorded that a `refused` field would not re-open what LLP 0328
#positive-evidence settled, which governs `lstat` semantics and merely
observes the zero counts.

Rejected as the general mechanism because three of the four guards do not
belong to a verb. The flush guard and both sweep guards fire wherever the
cache is driven, most often on daemon maintenance ticks with no command
attached, and the cursor gate fires in every reader of every destructive
pass. Threading a refusal signal up through those return shapes means
re-plumbing `tryReadCursorSync`, the flush, and two sweep passes, and every
current and future caller of each, to deliver a signal the emitting site
already possesses in full. The verb route also fixes only the verbs it
touches: the daemon-tick refusals, which are most of them, would stay dark.
Nothing here forbids a verb from also surfacing a refusal it can see
(detach's warnings channel remains the natural home for the capture-spool
half once that guard lands); this decision just refuses to make per-verb
plumbing the mechanism the guarantee depends on.

## Not every WARN in every CLI process {#not-every-warn}

The second alternative was blanket mirroring: turn warn-and-above stderr
mirroring on at the CLI entrypoint, fixing all four guards and every future
one in a single switch. Rejected, twice over:

- The tree has about eighty `warn` call sites, and their noise profile on
  healthy paths is unaudited. Turning them all into user-visible output at
  once changes the printed contract of every verb on the strength of an
  audit nobody has done. The containment refusals are the records with a
  measured cost to dropping; they should not have to wait for, or be
  hostage to, a global logging policy.
- The CLI binds `ctx.stderr` per dispatch (LLP 0189 #choke-point colours it
  there), while the observability substrate is process-global and writes to
  `process.stderr`. A process-wide mirror quietly widens that mismatch to
  every warn in the tree; the per-site mirror keeps the bypass confined to
  the four lines that need a channel of last resort.

A later decision may still adopt CLI-wide mirroring after auditing the warn
corpus; it would subsume this one's mechanism without contradicting its
guarantee.

## A refusal is something a test can see {#testable}

Decided explicitly, because until now it could not be: **a containment
refusal must be observable by a test, and the observation channel is the
process's stderr.** No prior test could assert any of the four refusals
(nothing in `test/` installs a logger provider), so no regression guard could
exist for the loud half of any guard in the series.

The pinned shape: build a cache with a planted symlink where a generation
name resolves, run the packaged CLI (`bin/hypaware.js purge --all --yes
--json`) as a real subprocess, and assert three things together: the exit
code is still 0, the JSON on stdout is unchanged in shape, and stderr names
`cursor_table_dir_escapes_partition`. Its control runs the same verb over a
healthy cache and asserts stderr carries no WARN at all, which pins the
other direction: the mirror must not fire on the ordinary no-op path. The
flush and sweep guards are pinned in-process by capturing `process.stderr`
writes around a planted `_hypaware_spool` and a planted sweep component.

## Consequences {#consequences}

- The `#consequences` bullets of LLP 0326 that call a refused state loud
  (`spool_dir_is_symlink` on every flush, the `ls -l` answer for a rejected
  cursor) are true on a default install for the first time, and LLP 0328
  #loud-refusal with them: its guard adopts the same opt-in here, so all
  four refusals in the series reach a channel that exists with no telemetry
  configured. None is left loud only into the substrate, which is the
  pre-existing state this decision was minted to end.
- `hyp purge` over a partition whose containment was refused still exits 0
  and still prints zero counts; what changes is one WARN line on stderr
  naming the refused path. The refusal is a standing condition an operator
  fixes at the filesystem, not a failure of the purge that ran.
- A daemon's refusals land in the daemon's log file via the service
  manager's stderr capture, at one line per refusing flush or sweep pass.
  The lines repeat because the condition persists; that is the standing
  signal working, and it costs one stderr write per refusal that was already
  paying for a dropped log record.
- Dev-telemetry runs see each refusal twice, once in the JSONL export and
  once on stderr. Duplication in the mode built for watching the harness is
  accepted rather than special-cased.
- The mirror writes to `process.stderr`, not the dispatch-bound
  `ctx.stderr`, so an in-process caller capturing `ctx.stderr` does not see
  it and it is never coloured by LLP 0189's choke point. Accepted: the
  mirror is the channel of last resort for processes with no other one, and
  the tests that pin it spawn the real CLI.

## References {#references}

- [LLP 0326](./0326-generation-name-is-the-directory.decision.md): the three
  cache guards whose loudness this qualifies and delivers.
- [LLP 0328](./0328-a-spool-path-is-checked-where-it-is-walked.decision.md):
  the capture-spool guard; its `#loud-refusal` section is the fourth claim
  this decision gives a channel. Its guard landed on master as
  hyparam/hypaware#1107 while this decision was in review, so the one-line
  opt-in and the reciprocal `Extended-by:` forward-ref ride here rather than
  as the deferred follow-up an earlier draft of this section described.
- [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md):
  `#say-it`, where the say-it-out-loud pattern started.
- [LLP 0021](./0021-observability.spec.md): the OTel substrate and
  its exporter strategy, which this decision leaves unchanged.
- [LLP 0189](./0189-cli-severity-colour.decision.md): the dispatch-bound
  stderr choke point the mirror deliberately bypasses.
- hyparam/hypaware#1108: the issue, with the verified drop chain and the
  measured byte-identical purge.
