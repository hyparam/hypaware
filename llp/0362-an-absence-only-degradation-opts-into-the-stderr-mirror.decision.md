# LLP 0362: A degradation observable only as an absence opts into the stderr mirror, refusal or not

**Type:** Decision
**Status:** Accepted
**Systems:** Observability, CLI, Plugins
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-02
**Extends:** [LLP 0329](./0329-a-containment-refusal-reaches-stderr.decision.md)
(#stderr-mirror: the per-call-site opt-in, stated there for containment
refusals, admits one report on a registration that succeeded, because the
property the rule turns on is the absence and not the refusal), and
[LLP 0335](./0335-a-telemetry-failure-is-said-once-never-thrown.decision.md)
(#not-a-fifth-mirror: its "four" is a head count and not a closed set, and
the line this admits is the first mirrored one with no refusal behind it)
**Related:** LLP 0323, LLP 0332, LLP 0334, LLP 0248, LLP 0268,
hyparam/hypaware#1226, hyparam/hypaware#1227, hyparam/hypaware#1232

> LLP 0329 settled a per-call-site `mirrorStderr` opt-in and wrote its rule
> for the four containment refusals it was minted over, where refusing and
> leaving no trace are the same event. `CommandRegistry.register` separates
> them: an optional member the registry's copy dropped fails no shape check,
> so registration succeeds by design and the command runs without it, and
> every symptom is still an absence that the dark substrate 0329 measured
> drops before any exporter. This decision admits that report to the opt-in
> set and states the rule by the property it always turned on: a report whose
> subject is observable only as an absence takes the mirror. A refusal is the
> common case among the sites that have opted in, not the qualification.

## The rule turns on the absence, not on the refusal {#absence-not-refusal}

LLP 0329 #stderr-mirror closes with the rule for future guards: *a refusal
that leaves every counter at zero must opt into the stderr mirror*, and
qualifies it in the next sentence, "a guard whose refusal is already surfaced
in its verb's output does not need it; a guard whose refusal is observable
only as an absence does." All four sites it governed refuse, so at that head
"refusal" and "absence" named the same set and the rule never had to separate
the two words.

`warnDroppedOptionals` (`src/core/registry/commands.js`) separates them. The
registry stores `{ ...command }` and shape-checks that copy, so a member that
is reachable on the registration but not own-enumerable does not survive. For
the four required members that is a refusal with an error that names the
cause. For an *optional* member there is nothing to refuse: registration
succeeds, which is the design, and the command runs without the member. What
is left is the absence, and it is the whole of the symptom:

- the alias index gets nothing, so the alias is dead
- a command that asked to be `hidden` lists in `hyp --help`
- a lost `plugin` re-derives `category` from the first word of the command's
  own name instead of `additional`, and `audience` becomes `everyday` instead
  of `operator` (LLP 0248 #semantic-boot is what derives them)

On the substrate 0329 measured (neither `HYP_DEV_TELEMETRY` nor
`OTEL_EXPORTER_OTLP_ENDPOINT` set, so `Logger.emit` drops the record before
any exporter), a WARN without the mirror is byte-identical to a registration
that never declared the member: the same silence the drop already has, in a
process the author is not watching, since registration happens during plugin
activation. So the decision: **a report whose subject is observable only as
an absence is inside the opt-in set, whether the reporting site refused or
carried on.** Nothing else about 0329 moves. The mirror stays
per-call-site, stays an addition to the structured record rather than a
rerouting, and stays off every report a verb's own output already carries.

## The opt-in set is open, and no refusal stands behind this entry {#not-a-refusal}

LLP 0335 #not-a-fifth-mirror reads the corpus as "four named containment
refusals" and distinguishes its own unconditional line as *not* a mirror,
because no call site asked for `mirrorStderr`. That distinction is untouched.
The count is not, and it had already moved before this decision:
`mirrorStderr: true` stands at eight call sites at this head, because
`reportUnreadableCursor` in `src/core/cache/partition.js` became a fifth
containment refusal on 0329's own terms (LLP 0323 #say-it, added in
hyparam/hypaware#1162), and LLP 0334 #recovery-is-announced added two INFO
lines in the same file, `noteEscapeCleared` and `noteUnreadableCleared`,
which retract a refusal rather than make one.

So this report is not the fifth of anything, and "not a refusal" does not
single it out either. What singles it out is that no refusal stands behind
it at all: every other mirrored line either makes a containment refusal or
retracts one it made earlier, while this site refuses nothing and has nothing
to retract. Registration succeeds, which is the design, and the report is
about what the successful registration did not carry.

A reader auditing what writes to `process.stderr` without a provider counts
the `mirrorStderr: true` call sites rather than a number any document states.
Every count in this section and in 0335's is a census at its own head.

## The audit LLP 0329 asked for is not re-opened {#still-not-every-warn}

LLP 0329 #not-every-warn rejects blanket mirroring on two arguments, and
neither is widened by one more call site:

- **The unaudited noise profile.** That argument is about turning roughly
  eighty `warn` sites into user-visible output on an audit nobody has done.
  This site is audited, in the direction that matters: it fires only on a
  registration that lost something, no registration in the tree trips it, and
  `hyp --help` and `hyp dev --help` on a temp `HYP_HOME` emit zero
  `command-registry` lines. Both directions are pinned by test, which is what
  0329 #testable requires of a mirrored line: `a registration with no optional
  members warns about nothing` for the healthy path, and `a refused
  registration is not warned about as a degraded one` so the say cannot
  describe a command that was refused.
- **The `ctx.stderr` mismatch.** LLP 0189 #choke-point binds `ctx.stderr` per
  dispatch, and this report has no dispatch to bind to: it fires while a
  plugin is activating, before any command runs, and on a daemon tick under no
  verb at all. It is the case 0329 #consequences accepted the bypass for, not
  a new instance of the mismatch.

## A prototype-resident default warns too {#prototype-default}

Accepted, with the cost named. A command class whose *base* supplies defaults
as prototype getters (`get hidden() { return false }`, `get aliases() { return
[] }`) is reported at every process start as `registered without the declared
'aliases', 'hidden'`, with `status: degraded`, although the stored record
behaves identically to one that declared neither.

Not fixed, because every fix costs more than the line does:

- Telling a default from a declared value means reading the member, and the
  probe is presence-only by design: it reads `in`, which walks the prototype
  chain and invokes no accessor, and the test pins `reads === 0` on a class
  whose optional members are getters. A registration must not be able to run
  caller code by being described.
- Shrinking `OPTIONAL_MEMBERS` to the members whose loss is loudest drops the
  quietest losses, which are the ones the diagnostic exists for.

The line is also true as written: the members did not reach the record, and
"the declared" is what it says, because `category`, `audience` and
`bootProfile` are defaulted and do carry a value, just not the declared one.
The remedy is one sentence in `docs/PLUGIN_AUTHORING.md` (assign the optional
members onto the instance, or register a plain object) and it is the same
remedy for a default as for a declared value.

## Consequences {#consequences}

- The `@ref` above `warnDroppedOptionals` points here, not at LLP 0329
  #stderr-mirror alone: the site is inside the opt-in set because of this
  extension, and a reader of 0329 by itself would find a rule about refusals
  over a function that refuses nothing.
- LLP 0335 #not-a-fifth-mirror's "four" is a census at its own head. Its
  argument (the substrate reporting on itself is not a mirror) stands
  unchanged.
- The mirrored line's noise budget is one line per degraded registration per
  process start, and it repeats for as long as the registration does, the
  same standing-condition shape LLP 0329 #consequences accepted for the
  daemon's refusals. It is not rate-limited the way LLP 0332 rebased the
  cursor guard: registration is once per command per process, not once per
  read.
- `OPTIONAL_MEMBERS` is the diagnostic's coverage, and a test now pins it to
  cover every optional member `CommandRegistration` declares rather than
  trusting the hand-written list, so a member added to the published interface
  cannot escape the report unnoticed. The pin runs that direction only: a key
  left in the list after its member leaves the interface is named by nothing
  and costs nothing. The pin reads the declaration file, so it holds for every
  spelling the file uses for an optional member, the optional method
  `foo?(...)` included, which is the shape that always lives on a prototype
  and so the one the copy drops.

## References {#references}

- [LLP 0329](./0329-a-containment-refusal-reaches-stderr.decision.md):
  #stderr-mirror, the opt-in this extends; #not-every-warn, the audit it does
  not re-open; #testable, the requirement both negative controls answer.
- [LLP 0335](./0335-a-telemetry-failure-is-said-once-never-thrown.decision.md):
  #not-a-fifth-mirror, the census this extends, and #never-throws, the
  contract that keeps a broken exporter from taking the mirror down with it.
- [LLP 0248](./0248-task-oriented-cli-rollover.decision.md): #semantic-boot, the
  defaulting a lost `plugin` silently re-derives.
- [LLP 0189](./0189-cli-severity-colour.decision.md): the dispatch-bound
  stderr this report has no dispatch to reach.
- hyparam/hypaware#1227: the PR that added the report, with the measured
  healthy-path silence; hyparam/hypaware#1232, the review finding that this
  site was a fifth opt-in the corpus did not predict.
