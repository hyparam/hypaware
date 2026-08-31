# LLP 0334: The escape report tracks the partition it names, and says when it lets go

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0332](./0332-cursor-refusal-warns-on-transition-then-rewarns.decision.md)
(#transition-plus-rewarn: the per-partition window that decision introduced
now ends where the partition ends, and announces itself when it ends)
**Extended-by:** [LLP 0336](./0336-retention-rides-the-maintenance-tick.decision.md)
(#eviction-clears, #consequences: the retention eviction sites those
sections lean on had no non-test caller until that wire, so the
`escapeReportedAt` bound in #consequences holds for a running daemon only
from there on)
**Related:** LLP 0323, LLP 0326, LLP 0329, hyparam/hypaware#1123

> LLP 0332 rebased the cursor containment refusal from one line per read to
> one line per standing condition, and recorded two residuals it did not
> need to settle in order to do that: the window's map entry strands when
> retention removes a poisoned partition, and a heal is silent, so silence
> after a refusal reads as either "healed" or "not due yet". Both are about
> the same object, the entry, and both are answered by making the entry
> track the thing it is keyed on: it is dropped where the partition is
> deleted, and the read that drops it says so once. Neither adds a syscall
> to the synchronous reader, which is the cost 0332 weighed and refused.

## The entry is dropped where the partition is {#eviction-clears}

`escapeReportedAt` in `src/core/cache/partition.js` is keyed by resolved
partition directory and cleared by any read of that partition that does not
refuse for escape. LLP 0332#transition-plus-rewarn names the hole in that
rule and accepts it: retention deletes whole date partitions, and a
partition removed while poisoned never gets the non-refusing read, so its
entry outlives it. The bound it accepted is roughly one entry per evicted
poisoned partition, around 200 bytes, and it cannot compound because a
partition recreated at the same path reuses the key.

That acceptance rested on a cost, not on the leak being desirable: "probing
the filesystem to prune it would put a syscall in a hot synchronous reader".
That cost belongs to one fix shape, pruning from the reader. It is not the
cost of the other one. `src/core/cache/retention.js` already holds the
partition path and is already deleting the directory at both of its
whole-partition eviction sites (`evictSourceTableByMtime`,
`evictLegacyPartition`); clearing the entry beside the `rm` is a `Map.delete`
on a path the code has in hand, on the slow asynchronous eviction path, and
adds nothing at all to `tryReadCursorSync`. So the entry is cleared there,
and `clearEscapeReport` is exported for those callers.

Retention is not the only one. `retirePartition` in
`src/core/cache/migrate.js` renames a whole legacy partition into
`.retired/`, and the scan above it read that partition's cursor, so a
poisoned one is armed and then stranded exactly as retention's was. The rule
is the site, not the subsystem: wherever a whole partition directory stops
existing at its path, the entry keyed on that path goes with it.

Silently, deliberately. The eviction is not the condition ending; it is the
subject of the report ceasing to exist, and retention's own
`retention.evict` / `retention.evict_source_table` spans already record the
removal. What the clear buys is that a partition recreated at that path
after an eviction warns as the transition it is, instead of being throttled
against a window armed for a directory that no longer exists.

In practice only the legacy site can hold a poisoned partition: a poisoned
cursor reads back as the epoch-0 default, which has no `layout`, so
`tick` routes it to `evictLegacyPartition`. The source-table site is
clearing state that a readable cursor already cleared on the read above it.
It is written at both sites anyway, because the property being kept is "no
entry outlives its directory", and a rule with an exception nobody can see
is a rule the next eviction site will not follow.

## The read that clears an armed refusal announces it {#recovery-is-announced}

LLP 0332#consequences records the ambiguity and declines to settle it:
before the throttle, silence after a refusal meant healed; under it, silence
means healed or not-due-yet, and separating them means knowing
`ESCAPE_REWARN_MS` and the maintenance interval. The reason given for
leaving it is that a recovery line is "its own decision about a channel
every healthy cursor read would sit on". This is that decision, and it
narrows the channel to nothing like every healthy read: the line is emitted
only when the clear actually removed an entry, which this process can only
have if it warned about that partition itself. A cache that never refused
pays exactly what it paid before, one `Map.delete` that misses.

The shape is `src/core/daemon/control.js`'s, the same precedent LLP 0332
took its window from: `noteConsumable` emits `daemon.control_scan_recovered`
only when a warn was armed, and resets. So:

- **One line per armed refusal that clears.** `noteEscapeCleared` deletes
  the entry, and if there was one, emits. A partition that refuses, heals,
  refuses and heals again pays two refusals and two clearings, which is
  four lines describing four transitions.
- **INFO, mirrored to stderr.** Nothing is wrong, so it is not a WARN; but
  it is unreadable except beside the refusal it answers, and that refusal is
  on stderr because a default install has no provider at all (LLP
  0329#stderr-mirror). Splitting the pair across two channels would leave
  the operator who saw the refusal with the same silence to interpret.
- **It retracts the refusal, it does not certify the partition.** Two of
  the three clearing exits are an absent and an unparseable `cursor.json`,
  which still read as unreadable and still stop the partition compacting.
  The line therefore says the escape condition ended, which is exactly the
  fact the warn armed and the whole of what the entry holds. Announcing
  only the fully healthy exit would leave the other two silent and the
  ambiguity intact for them, for the sake of a stronger claim this report
  is not entitled to make. The wording carries the same limit. A read can
  stop refusing because it could not read at all, with the identical poison
  still on disk under it: an EACCES on `cursor.json`, or an `lstat` the
  symlink check fails open on by LLP 0326#positive-evidence. Clearing is
  still right there, because the escape condition is no longer proven and an
  unproven condition may not throttle. Saying the `tableDir` no longer
  escapes would not be: it is a claim about a file this read never saw. So
  the line says the refusal cleared and that this read did not refuse for
  escape, and stops.
- **The delete happens whether or not the line does.** The emit is guarded
  like the refusal's, and the entry is gone before it runs. An entry kept
  alive by a throwing log channel would throttle the next genuine refusal
  against a condition that had already ended, and that is silence: the one
  degradation LLP 0332#not-a-pass-object promises this throttle can never
  have. Losing a recovery line costs an operator a retraction; keeping a
  stale entry costs them a refusal.

## The window compares values, not renderings {#type-qualified-key}

LLP 0332#transition-plus-rewarn says an entry "whose rejected value differs
from this one" warns immediately, because a poison that changes shape is a
new fact. The code compared the rendered string: a non-string `tableDir` is
reported as `JSON.stringify(tableDir)`, so a value and a string that renders
identically produced the same comparison key and the second was absorbed
into the first's window. The pair that can be observed is one where both
spellings escape: the array `["a/b"]` and the string `'["a/b"]'`. (The
number `5` and the string `"5"` collide the same way, but `"5"` is a bare
segment and is contained, so it is never refused and never reaches the
window at all.) The window now compares a key qualified by
`typeof tableDir`, while the logged `table_dir` stays the rendered value it
always was. This is not a new rule; it is the rule 0332 stated, applied to
the value rather than to its rendering.

## A rate is something a test can count {#testable}

Both properties extend LLP 0332#testable's discipline, that a throttle is
tested in the direction of silence:

- Eviction: a poisoned partition that a real `createRetentionEnforcer` tick
  evicts, then reappears at the same path with the same poison inside the
  rewarn window, warns again. Against a stranded entry that read is mute.
  The same assertion runs against a real `migrateLegacyPartitions` retire,
  so the rule is tested at the site rather than in one subsystem.
- Recovery: a heal after a refusal writes exactly one `cursor_escape_recovered`
  line, a heal with no refusal before it writes none, and the refusal that
  follows a recovery still warns. The line is counted, not just detected,
  so a clear that fires on every read of a healthy partition fails.
- Type-qualified key: a `tableDir` of `["a/b"]` followed by the string
  `'["a/b"]'` inside the window costs two refusals, not one. That pair, not
  the `5`/`"5"` one the issue named: `"5"` is a bare segment and is never
  refused, so only one of those two spellings ever reaches the window.
- The retraction the channel dropped: a heal whose emit throws is still a
  clear, so the next refusal in the same window warns. Asserted through a
  `process.stderr.write` that throws, because with no provider installed the
  mirror is the whole emit.
- The retraction's claim: a refusal cleared by a `cursor.json` the process
  cannot read is retracted, the line does not say the escape ended, and the
  next readable read refuses the same bytes again at once.

## Consequences {#consequences}

- A daemon's `escapeReportedAt` is bounded by the poisoned partitions that
  currently exist, not by every poisoned partition it ever saw. The
  accepted-entry-a-day drift in LLP 0332#transition-plus-rewarn is gone.
- Silence after a refusal means the condition still stands. An operator
  reading a daemon log sees the refusal, then either a rewarn or a
  `cursor_escape_recovered` line, and does not need to know
  `ESCAPE_REWARN_MS` to tell those apart.
- A flapping partition is now two lines per cycle rather than one. That is
  the price of the transition being legible in both directions, and it is
  bounded by the refusal rate the throttle already bounds.
- A healthy cache is exactly as quiet as before, on both channels: no entry,
  no line. The quiet controls in `test/core/containment-refusal-stderr.test.js`
  are unchanged.
- The mirror-image delivery failure LLP 0332#consequences records, where the
  OTel emit succeeds and the stderr mirror then throws so no window is armed
  and the structured channel re-delivers per read, is untouched here. It is
  a property of `getLogger`'s two-channel emit rather than of this report,
  and it degrades toward extra lines on a working channel, which is the
  direction both decisions tolerate. It outlives the issue this doc closes,
  so it is carried as hyparam/hypaware#1129 rather than only as a bullet
  here.

## References {#references}

- [LLP 0332](./0332-cursor-refusal-warns-on-transition-then-rewarns.decision.md):
  the window this extends, and the two residuals it accepted without
  settling (#transition-plus-rewarn, #consequences).
- [LLP 0329](./0329-a-containment-refusal-reaches-stderr.decision.md):
  #stderr-mirror, why the pair belongs on one channel.
- [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md):
  #one-gate, the shared reader whose rate 0332 rebased.
- `src/core/daemon/control.js`: `daemon.control_scan_recovered`, the
  announce-on-clear precedent.
- hyparam/hypaware#1123: the triaged residuals of PR #1118.
