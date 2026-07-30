# LLP 0163: Claude attach backs up a malformed block instead of discarding or refusing it

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Config
**Author:** Phil / Claude
**Date:** 2026-07-30
**Related:** LLP 0044, LLP 0045, LLP 0109, LLP 0143

> `hyp attach` has to write into Claude Code's `env` and `hooks` blocks. When
> one of them is present on disk with the wrong JSON type (a hand-edit
> mistake), the writer used to replace it with an empty container, report
> success, and leave nothing on disk to recover the displaced value from. The
> OpenClaw adapter answers the same question by refusing (`MALFORMED_CONFIG`).
> Neither is right for Claude: attach **backs the displaced value up into the
> `_hypaware` marker, repairs the block, and warns**. The marker is already the
> backup for everything else attach displaces; a malformed block is not a
> special case, it is one more thing to record.

## Context

`attach()` in
[`hypaware-core/plugins-workspace/claude/src/settings.js`](../hypaware-core/plugins-workspace/claude/src/settings.js)
must end with `settings.json` holding an object at `env` and an object at
`hooks`, whose per-event members are arrays. Three states can be on disk at
each of those paths:

- **absent** - attach creates it. Ordinary first attach.
- **present and well-formed** - attach merges into it. Ordinary re-attach.
- **present and malformed** - present, but the wrong JSON type.

The third is the case this document is about. `ensureObject` handled it by
assigning a fresh `{}` over whatever was there, and `installManagedHooks`
handled a non-array `hooks.<event>` by starting from an empty group list. Both
were silent: no backup, no `prev_*` record on the marker, no warning, and a
success exit. Whatever the user had written was gone and nothing said so.

The sibling adapter answers the identical question the other way.
`ensureObjectAt` in
[`hypaware-core/plugins-workspace/openclaw/src/settings.js`](../hypaware-core/plugins-workspace/openclaw/src/settings.js)
throws `MALFORMED_CONFIG` naming the offending path, on the ground that a
non-object there is a config OpenClaw itself would reject, so hypaware refuses
too rather than clobbering it. Two client plugins in one tree, opposite
answers, and the destructive one carried no comment explaining itself
(issue #454).

## The question

Should attach repair a settings file it does not understand, or refuse it?

Three answers were costed:

1. **Refuse**, matching OpenClaw: throw naming the key.
2. **Back up, then repair**: record the displaced value on the marker so
   `hyp detach` restores it, warn, keep succeeding.
3. **Warn and repair**: cheapest; the value is still lost, but the user is
   told.

## Back up then repair, not refuse

**Option 2.** Attach records the displaced value into the marker under
`prev_malformed`, rebuilds the block, returns `warnings`, and succeeds.

The reasons, in order of weight:

**The marker is already the backup.** LLP 0044 fixes the conflict rule as
*back up, override, restore on leave*, and LLP 0045 Part 3 makes the marker a
self-describing undo record so a plugin-agnostic core routine can reverse the
attach from disk alone. `env.ANTHROPIC_BASE_URL` is already displaced by every
attach and already backed up (`prev_base_url`). A malformed `env` block is the
same kind of event - attach needs the path and something else is on it - so it
gets the same treatment. Refusing would mean the one displacement with no
backup mechanism is the one that gets a hard error, and the one with a backup
mechanism proceeds. That is backwards.

**Refusing punishes the wrong person at the wrong moment.** Attach runs during
enrollment and on every reconcile pass that finds the gateway endpoint stale
(LLP 0086). A user with a stray `"hooks": "SessionStart"` in `settings.json`
would get a failed enrollment and a message telling them to hand-edit JSON
before hypaware will work at all. The failure is recoverable but the cost lands
on someone whose only mistake is a typo in a file hypaware chose to co-own.

**Option 3 gives up the thing that matters.** Warning about a value you have
already destroyed is a strictly worse version of backing it up: the same words,
none of the recovery. The marker schema was going to have to grow either way
for the warning to name a path.

**Why not converge OpenClaw on this too, in the same change?** Because the two
adapters are not in the same position. `MALFORMED_CONFIG` there covers
`models.providers.*` parents in a config OpenClaw's own loader rejects, so
proceeding produces a file the *client* will not read - repairing it silently
would be hypaware guessing at a fix for a file it does not own the schema of.
Claude Code tolerates and ignores junk keys. That asymmetry may not hold up on
inspection, and converging OpenClaw is worth its own look, but it is a separate
change against a separate adapter and is deliberately out of scope here.

## `prev_malformed` is path-keyed, not one field per block

The marker gains one field:

```json
"_hypaware": {
  "prev_malformed": {
    "env": "ANTHROPIC_API_KEY=sk-x",
    "hooks.SessionStart": "hyp claude-hook session-context"
  }
}
```

A map from dotted path to the exact JSON value that was displaced, rather than
a fixed `prev_env` / `prev_hooks` pair, because the hook case is a **family**,
not a key: any of `SessionStart`, `CwdChanged`, `UserPromptSubmit`,
`PostToolUse` can independently be the wrong type, and the `hooks` root can be
malformed as well. A path-keyed map also keeps the replay in core
format-generic: the undo restores "the value that was at this dotted path",
never "Claude's hooks block".

**Presence, not type, decides what is malformed.** JSON cannot encode
`undefined`, so `Object.hasOwn` is the entire absent-vs-present test, and a
hand-written `null` is a value the user put there rather than a missing key -
the same rule the `prev_base_url` backup and the managed-env ownership guard
already follow in this file. An absent block displaces nothing and records
nothing, which is what keeps the ordinary first attach silent.

**A prior backup survives re-attach.** Once attach has repaired the block, the
live value is hypaware's own, so the second attach finds nothing malformed. The
prior marker's `prev_malformed` is carried forward, and a prior entry wins over
anything found at the same path this run: the earliest backup is the one
holding the user's content. This is the identical rule `prev_base_url` follows
for the same reason.

**A displacement the prior backup outranks is reported as lost.** The rule above
has a second half. If the user breaks the same block again *between* two
attaches, the second attach displaces a real value that there is no room to
record - one path, one slot, and the earlier occupant is the one worth keeping.
That value is destroyed, so the warning for it says so
(`... already holds an earlier backup for that path, so this value was
discarded and hyp detach will not restore it`) rather than reusing the ordinary
"backed up, `hyp detach` restores it" line. A reassuring sentence over a
destroyed value is the failure this document exists to end, not a mitigation of
it. Neither notice ever echoes the displaced value: a malformed `env` is exactly
where an API key ends up, and these strings are printed to the terminal and
logged.

**`warnings` is a list, not a joined string.** The attach result reports only
what *this* run displaced (a re-attach that merely carries a backup forward has
nothing new to say). It is rendered by its callers - the human path prints a
line each, `--json` echoes the array - so there is no reason to hand them a
string they would have to split. Contrast `DetachFromDiskResult.warning`, which
stays a single display-only string for compatibility reasons argued in LLP 0045
Part 3; that section already names `warnings: string[]` as the honest shape for
a new field, and this is one.

## Detach restores the backup

The core undo (`detachJsonMarker` in
[`src/core/config/client_detach_disk.js`](../src/core/config/client_detach_disk.js))
replays `prev_malformed` after it has stripped the managed env keys and hook
entries.

Restoring obeys the **never-clobber-a-user-edit** rule of LLP 0045 Part 3,
expressed as a presence test: the backup goes back only into a path that is now
**empty**. That is exactly the state the strip leaves behind when everything
attach put there has been removed. Anything still sitting at the path arrived
after the attach, so the undo leaves it and reports it through `warning` - the
same treatment a managed env key that was re-pointed externally gets.

Restoring may have to **recreate** an object parent the strip just deleted (the
`hooks` root is deleted once its last managed event array is emptied), so the
restore helper creates missing parents. It refuses when a parent is present as a
non-object (something else owns that path, and forcing the write would repeat
the destruction the backup exists to undo), and when a segment is `__proto__`,
`constructor` or `prototype`. Those last three matter because `prev_malformed`
keys are the only dotted paths in the undo that a *settings file* names freely,
and a helper that creates the parents it walks would otherwise leave the
document and assign onto `Object.prototype`. Attach never records such a path.

**A backup that cannot go back is destroyed, and the notice says so.** The
marker is deleted in the same write, and it held the only copy, so "left in
place" and "could not be restored" are not deferrals: they are the moment the
value stops existing. Both notices end `... is discarded with the marker` so the
person reading the line knows they are the last one who can act on it. This is
not a rare path - `env is in use again` fires for anyone who added an ordinary
env key after attaching. Giving the value somewhere else to go (a sidecar backup
file next to `settings.json`, say) is a real option and deliberately **not**
taken here: it is new on-disk surface with its own lifecycle, and the decision
on #454 scoped this change to the marker. Recorded as an open question rather
than smuggled in.

**Order between nested paths is a choice, not a mechanism.** `hooks` and
`hooks.<event>` can both be recorded (an earlier run repaired the event, a later
hand-edit broke the whole root). They are mutually exclusive on the way back - a
string root has no room for an event key - so whichever the replay reaches first
wins and the other is reported as discarded. The replay sorts **shallowest
first**, which restores the later whole-root breakage and drops the earlier
event value. Note that this is *not* forced by the restore helper, which
recreates missing parents in either direction; a deepest-first replay would keep
the earlier value, which is arguably what "the earliest backup is the one
holding the user's content" argues for one level up. The current order is pinned
by a test so that flipping it is a visible decision.

Legacy pre-record markers never wrote `prev_malformed`, so the legacy branch is
untouched. A marker that reaches that branch *with* the field (only possible by
hand-editing `managed` out of an otherwise current marker) drops it silently;
that is accepted as corrupt-input behaviour, not designed for.

## Consequences

- Attach keeps its "always succeeds" property. No enrollment newly fails.
- `hyp attach` gains warning lines on the human path and an optional
  `warnings` array in `--json`. The plugin emits a
  `client.attach.malformed_block` log per displaced block and a
  `malformed_blocks_repaired` span attribute, so a reconciler-driven attach
  records it too and the repair is not invisible on the daemon path.
- The `_hypaware` marker schema grows `prev_malformed`. Markers written before
  this change simply lack it; the undo treats a missing field as an empty map.
- The backup is not an unconditional promise. It survives until the first
  detach, and that detach discards it if the path has been re-occupied, if a
  nested backup outranks it, or if a second displacement collided with it at
  attach time. Every one of those is reported in the words "discarded", never
  as a deferral.
- OpenClaw is unchanged and still refuses (LLP 0143, LLP 0109). The
  divergence is now documented rather than accidental.

## Open questions

- **Should an unrestorable backup have somewhere else to go?** Today it is
  discarded with the marker and reported. A sidecar file
  (`settings.json.hypaware-backup-<timestamp>`) would make the promise
  unconditional at the cost of new on-disk surface nobody cleans up. Out of
  scope for #454; worth deciding before anyone leans harder on the promise.
- **Shallowest-first or deepest-first between nested paths?** See above. The
  current order keeps the later, shallower breakage. Deepest-first would keep
  the earlier, deeper original.
- **Does OpenClaw converge?** Argued above that it does not, on the ground that
  its own loader rejects the malformed config. That asymmetry deserves its own
  look; OpenClaw is untouched here per the decision on #454.

## References

- Issue #454 - the report, and the maintainer's decision selecting option 2.
- [LLP 0044](./0044-client-attach-on-join.decision.md) - back up, override,
  restore on leave.
- [LLP 0045](./0045-client-attach.design.md) Part 3 - the marker as a
  self-describing undo record, and the never-clobber-a-user-edit rule.
- [LLP 0109](./0109-openclaw-client-adapter.decision.md),
  [LLP 0143](./0143-openclaw-registers-no-attach-probe.decision.md) - the
  OpenClaw adapter's refuse-over-half-reverse stance.
