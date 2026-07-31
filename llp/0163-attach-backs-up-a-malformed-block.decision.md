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
`constructor` or `prototype`. Those last three matter because every dotted path
this undo replays is named by a *settings file* the user can hand-edit, and the
path writers walk with plain `parent[segment]`: the restore helper creates the
parents it walks, so `__proto__.x` would assign onto `Object.prototype`, and the
nested-marker branch's `managed.added` replay *deletes* what its paths name, so
`__proto__.toString` removed an `Object.prototype` member outright. No attach
records such a path, so all three writers refuse them.

**The two refusals are reported apart.** "Could not be restored" carries a
reason, and the reason has to be the true one: a segment this undo may not write
is a policy refusal the user can do nothing about, while a parent that is no
longer a JSON object is the ordinary nested-backup collision below and tells
them exactly which value is sitting in the way. Folding both into one sentence
made the common case unactionable.

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

**Order between nested paths is an arbitrary tiebreak, and cannot be more.**
`hooks` and `hooks.<event>` can both be recorded (one run repaired the event, a
hand-edit then broke the whole root, or the other way round). They are mutually
exclusive on the way back - a string root has no room for an event key - so
whichever the replay reaches first wins and the other is reported as discarded.
The replay sorts **shallowest first**. That is not forced by the restore helper,
which recreates missing parents in either direction.

It is tempting to read the sort as choosing between an old value and a new one,
the way `prev_malformed`'s prior-wins rule does one level up. It does not, and
it cannot: **depth is orthogonal to age.** Break the event first and the shallow
entry is the newer one; break the root first and the shallow entry is the older
one. Both sequences are pinned by tests, and the same sort keeps the later value
in the first and the earlier value in the second. Neither direction implements
"the earliest backup is the one holding the user's content", so flipping the
sort would move the loss, not remove it.

Implementing prior-wins here would need the record to carry age. It very nearly
does by accident - `{ ...displaced, ...priorMalformed }` leaves the newest key
first, and both tests observe that order - but JSON key order is not a thing to
hang a user's data on: a reformat or a hand-edit reorders it silently. An
explicit per-entry order (or timestamp) would be a schema change, and it is left
as an open question rather than smuggled in. The current order is pinned by
tests so that changing it is a visible decision.

### A restore that happened is reported, by path and never by value

The failure half of the replay has always been reported (`warning`). The
*success* half was silent: a detach that rewrote the user's `env` block back set
none of `removed` / `restoredValue` / `warning`, so `hyp detach` printed
`✓ Detached claude` and stopped. A restore that says nothing is the same defect
as a destruction that says nothing, one direction over - the user cannot tell
that the file they are looking at was rewritten (issue #500, finding 3).

The undo reports it as `DetachFromDiskResult.restoredPaths`, a **list of dotted
paths**, and the command prints one line each.

**Paths, never values.** The attach-side notices already refuse to echo the
displaced value, because a malformed `env` block is exactly where an API key
ends up and these strings are printed and logged. The same rule governs the way
back, so this cannot ride on `restoredValue`, which both consumers render as a
bare value.

**A list, not a joined string**, for the reason LLP 0045 Part 3 already gives
for `warnings: string[]`: `warning` is unsplittable prose because each notice
carries its own punctuation, whereas a successful restore has nothing to say
*but* the path. Handing callers a string they would have to split would be
inventing a parsing problem.

This also makes the one behaviour this document deliberately leaves alone
audible. Delete the repaired block by hand and `hyp detach` puts the original
malformed value back, where the sibling `prev_base_url` leaves a hand-deleted
leaf deleted. The divergence is defensible - at the moment of deletion the block
held only hypaware's own repaired keys, so restoring the pre-attach value
completes a partial manual detach and nothing is lost, which is the opposite of
the destruction direction #454 was about - and reversing it would *discard* a
value rather than keep one. It stays. What it no longer does is happen without a
word.

### The legacy branch replays every backup the marker carries

Legacy pre-record markers never wrote `prev_malformed` or `prev_base_url`, so
for a genuine pre-upgrade marker the legacy branch has nothing to replay and is
unchanged.

A marker can nevertheless *reach* that branch carrying both, because the branch
is selected by `managed` not being a plain object, and hand-editing (or
otherwise corrupting) the record out of a current marker leaves the backups
behind. No attach writes that shape - `managed` goes on in the same write that
ever sets `prev_malformed` - so it is only reachable through a damaged file.
This was previously accepted as corrupt-input behaviour and the backups were
dropped without a word. That is wrong on this document's own terms: the marker
is deleted in the same write and holds the only copy, so "no record to replay"
was destroying the user's value while reporting a successful detach, which is
the exact failure this document exists to end (issue #500, finding 1). The
branch now replays `prev_malformed` through the same helper and with the same
words as the record-driven one, and restores a recorded `prev_base_url` instead
of deleting the key.

What it still cannot do is name the managed keys the unreadable record listed
(`ENABLE_TOOL_SEARCH`, `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, and any
later addition). Nothing on disk distinguishes a value hypaware wrote from one
the user did, and never-clobber-a-user-edit outranks tidiness, so they are left
in place and the reversal reports itself as partial. Hooks are different and are
now stripped: every managed handler is matched by its `hyp claude-hook …`
command, which is proof of ownership rather than a guess, so widening the legacy
pattern to `classify-cwd` clears entries the retired convention predates without
any risk to a user's own hook.

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
  as a deferral, and each names its own cause.
- The three dotted-path writers in the core undo now refuse `__proto__`,
  `constructor` and `prototype` segments. That closes a reachable hole in the
  nested-marker branch as well (`managed.added` deleted `Object.prototype`
  members), which predates this change but shares the helper family and the
  guard.
- OpenClaw is unchanged and still refuses (LLP 0143, LLP 0109). The
  divergence is now documented rather than accidental.
- `DetachFromDiskResult` grows `restoredPaths?: string[]`, and `hyp detach`
  gains a `Restored <path> from the marker's malformed-block backup` line plus a
  `restored_paths` key in `--json`. Nothing parses it; both output modes render
  it.
- The reconciler's `reverse()` (`action_attach.js`) reports it too, as a
  `client_action.attach_reverse_restored` log record. It is the same field and
  the same paths-never-values rule, but it is the *more* important half: an
  org-driven fleet drop rewrites a block of the user's settings file with nobody
  at a terminal to read a printed line, and the failure half of the replay was
  already logged there while the success half was not.
- The legacy `json` branch is no longer a silent hole for a damaged marker. It
  replays `prev_malformed` and `prev_base_url`, strips `classify-cwd` hooks, and
  reports itself as a partial reversal. A genuine pre-record marker carries none
  of the triggering fields, so its reversal and its (silent) output are
  bit-identical to before.

## Open questions

- **Should an unrestorable backup have somewhere else to go?** Today it is
  discarded with the marker and reported. A sidecar file
  (`settings.json.hypaware-backup-<timestamp>`) would make the promise
  unconditional at the cost of new on-disk surface nobody cleans up. Out of
  scope for #454; worth deciding before anyone leans harder on the promise.
- **Should `prev_malformed` record the order its entries were taken in?** Not
  shallowest-versus-deepest: see above, depth is orthogonal to age and flipping
  the sort only moves which sequence loses. The real question is whether the
  record should carry enough (an explicit order, or a per-entry timestamp) to
  apply the same prior-wins rule between nested paths that it already applies at
  a single path. That is a marker schema change and out of scope for #454.
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
