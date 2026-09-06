# LLP 0381: An overflowing watermark second re-appends its overflow every tick

**Type:** RFC
**Status:** Draft
**Systems:** Plugins, Sources
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-05
**Related:** [LLP 0373](./0373-boundary-identity-is-the-id-not-the-snapshot.rfc.md)
(#guard the boundary sets and the cap this document is about, #constraints
where 0373 explicitly sets this question aside: "the cap's own documented
failure mode (overflow re-appends every tick until the watermark moves) is
unchanged by all of them and is not what this asks about"),
[LLP 0360](./0360-github-source-is-bundled.decision.md) (#resource-bounds
"identity carried across ticks stays capped, never a repository's history",
the rule the cap realizes and exit B forks against, #cursoring the sidecar and
phase-boundary publication any new state must ride),
[LLP 0361](./0361-github-capture-is-work-budgeted.decision.md) (#budget the
400-request tick budget and round-robin fairness the loop starves, #page-work
"equal-timestamp unseen pulls are still captured", the anti-loss rule exit A
forks against),
hyparam/hypaware#1332 (the deferred finding this document is minted from),
hyparam/hypaware#1284 (the unguarded per-tick re-append the boundary sets
replaced), PR #1330 (where the guard and its cap landed, and whose review
round 2 measured the probe below)

> The GitHub boundary gate carries the event ids sitting exactly on a pass's
> published watermark so an inclusive `since` cannot re-append them. The
> carried set is capped at `MAX_BOUNDARY_IDS` (1000), symmetrically on write
> and read. When more than 1000 items share one watermark second, the overflow
> sits outside the guard: it is re-appended, and re-spends its sub-resource
> requests, on every tick until unrelated activity moves the watermark off
> that second, and under the production budget it can starve every other
> repository in rotation. The cap keeps the sidecar bounded and cannot also
> keep the guard complete, so every exit gives something up that a settled
> document currently protects. This document states the loop, measures it, and
> lists the exits. It decides nothing.

## The loop, precisely {#loop}

Affected code at `origin/master` (`509c0620`), all in
`hypaware-core/plugins-workspace/github/src/`:

- `cursors.js`, `MAX_BOUNDARY_IDS = 1000`: the cap.
- `cursors.js`, `readBoundaryIds`: the read-side cap,
  `slice(0, MAX_BOUNDARY_IDS)` after dedup, applied to `cursor.boundary[pass]`
  on every sidecar read. Its own docstring records this document's problem:
  "The cap is a bound, not a cure ... Trading it for a bounded loss (advancing
  the watermark past a second that will not fit) is a design decision, not
  something a cap decides."
- `capture.js`, `openGate`'s `ids` getter: the write-side cap, the same
  `slice(0, MAX_BOUNDARY_IDS)` over the running maximum's set before
  `setBoundary` publishes it.

Why the overflow is never absorbed: `openGate` seeds the next tick's set from
the published boundary ids first (`staged === undefined` reads
`publishedIds`), the re-listed boundary items re-claim their places in
insertion order, and `slice(0, 1000)` keeps insertion order. So the same first
1000 ids are retained every tick, the floor refuses exactly those 1000, and
the items beyond them are outside the floor on every tick. Each tick appends
the overflow again as new `github_events` rows, re-queues its sub-resources
(for the commits pass, one `listCommitFiles` request and a repeat
`commit_file` fan-out per overflow commit), and publishes the same 1000 ids.
Nothing converges until something newer moves the watermark past the second.

The trigger needs more than 1000 items stamped on one wall-clock second, which
normal repository activity does not produce. The producers are bulk
operations: a label or milestone sweep touching thousands of issues in one
scripted second, or a history rewrite restamping thousands of commit dates.
Rare, but a single occurrence loops every tick indefinitely on a repository
that then goes quiet.

## Measured evidence {#evidence}

Reviewer probe at PR #1330's head (`ffb4e260`), review round 2, recorded in
issue #1332, with the request budget raised to isolate the effect:

```
N=1500:  tick1 1500 commit rows, 1500 listCommitFiles   boundary=1000
         tick2  500 commit rows,  500 listCommitFiles   boundary=1000
         tick3  500 ...           tick4  500 ...        no convergence
N=900:   tick1  900 rows          tick2/3/4  0 rows     boundary=900
```

Under the production 400-request budget (LLP 0361#budget), 500
`listCommitFiles` calls per tick means the repository never finishes its
commits phase, so the round-robin rotation that budget exists to keep fair is
starved by one repository forever, on top of the duplicate `github_events` and
`commit_file` rows.

Not a regression: `origin/master` before PR #1330 re-appended all 1500 items
every tick with no cap at all (#1284). The guard strictly improved the case
and fully closed #1284 for every boundary second that fits the cap. The
severity as reviewed is LOW-MEDIUM, and deferring was judged safe on exactly
those grounds.

## What the corpus already settles {#constraints}

Every exit forks against at least one settled position, which is why this is a
request and not a fix:

- **The guard must not lose the watermark second.** The gate exists because
  advancing the watermark past its second would lose an item stamped in that
  second but published after the request. `pullChangedSince` refuses that
  trade for the pulls pass, LLP 0361#page-work states the rule ("equal-
  timestamp unseen pulls are still captured"), and the tests "an item tied at
  the watermark but not yet captured is still captured next tick" and "new
  activity does not drag the already-captured boundary rows back in"
  (`test/plugins/github-capture.test.js`) pin it. Exit A breaks this rule for
  overflowing seconds and must say so out loud.
- **Identity carried across ticks stays capped.** LLP 0360#resource-bounds,
  realized by `MAX_BOUNDARY_IDS` and annotated `[constrained-by]` on
  `openGate`: never a repository's history. Exit B forks against this. One
  nuance cuts the other way: LLP 0373#constraints already records that
  `cursor.pulls_high_numbers` and `work.pulls_emitted` sit outside this
  constant's reach, bounded by the population of a boundary second rather than
  by a constant, so the corpus tolerates a population-bounded durable set in
  one lane today. The trigger population differs by orders of magnitude,
  though: a second's worth of tied pulls is small, a restamped history is not.
- **The tick budget is fixed and fairness is deliberate.** LLP 0361#budget:
  400 requests per tick, round-robin continuation so a large repository yields
  to its neighbor. The loop's worst cost is here, and any chosen exit owes a
  convergence proof against it (#decision).
- **Cursors are sidecar control state, published at phase boundaries.**
  LLP 0360#cursoring. Any new marker an exit needs (a completion flag, a
  rotated window, a widened set) is written and read at the same points the
  boundary sets are, and never becomes a `github_events` column.

## Relation to LLP 0373 {#relation}

LLP 0373 asks what the guard's identity KEY is: the event id or a content
fingerprint of the row. This document asks what happens when the carried SET
overflows its capacity. The questions are distinct and their exits are
orthogonal: every arm of 0373 (fingerprint on four passes, fingerprint where a
field can change, explicit acceptance) carries a boundary set of the same
cardinality, so each still overflows at the same population and loops the same
way. 0373#constraints says so itself and sets the question aside by name.
The one coupling worth deciding together: a fingerprint entry is larger than
an event id, so a 0373 arm that re-keys the boundary sets raises the byte cost
of whatever capacity this document's exit settles on, and exit B's sidecar
growth should be priced against the entry size 0373 chooses. Neither document
constrains the other's choice beyond that.

## Candidate exits {#exits}

### A. Bounded, declared loss {#exit-loss}

When a second's population exceeds the cap, advance the published watermark
past that second (treat it exclusively) once the pass has traversed it, and
thereafter refuse the whole second by timestamp with no id set at all. The
sidecar stays bounded by the existing constant, convergence is immediate
(tick 2 appends zero overflow rows), and normal seconds keep the guard
unchanged.

Costs and open sub-decisions:

- It accepts a silent loss: an item published into that second after the
  pass's read is never listed by a later inclusive `since` and never captured.
  For a history rewrite (restamped past dates) the lost window is essentially
  empty. For a live bulk sweep it is real: items the sweep touches after the
  read, in the same second, are gone. The loss is bounded to overflowing
  seconds, but it is the exact loss the gate was built to refuse, so the
  anti-loss tests must be re-pinned to exempt overflow and LLP 0361#page-work
  needs a forward-ref recording the exemption.
- When to take the loss: immediately on overflow mid-traversal, or only after
  a complete traversal of the second (so everything listed at read time was
  absorbed and only later arrivals are lost). The second is strictly less
  lossy and costs one full traversal's requests once.
- Whether the pulls pass's uncapped `pulls_high_numbers` adopts the same rule
  for symmetry, or keeps its population bound because its trigger population
  is small. Asymmetry here is a standing exception that needs stating.

### B. Carry the whole second {#exit-carry}

Remove or raise the cap for the boundary sets so the entire second's ids are
carried, read and republished until the watermark moves. No loss, no
duplicates, convergence at tick 2, and mechanically the smallest change.

Costs and open sub-decisions:

- The sidecar becomes population-bounded instead of constant-bounded: a
  rewrite restamping 100k commits writes 100k ids into `github-cursors.json`,
  rewritten on every publish and re-read on every tick, for as long as the
  repository stays quiet. That forks against LLP 0360#resource-bounds as
  written, so the rule needs an extension recording the new bound ("one
  watermark second's population, never a repository's history") rather than a
  silent violation of the old one.
- A raised constant instead of no constant only moves the loop's threshold; it
  needs a stated reason why the new number is where bulk operations stop,
  which the probe suggests does not exist.
- Whether `work.gate_emitted`, capped by the same constant at the opposite end
  (`slice(-MAX_BOUNDARY_IDS)`, a sliding window that degrades to a duplicate
  rather than a loop), keeps its cap. Its overflow behavior is benign by
  construction, so uncapping it buys nothing, but a shared constant that no
  longer means one thing needs splitting.

### C. Absorb the overflow across ticks {#exit-absorb}

Keep the constant but make successive ticks make progress, so some tick K
appends the last overflow rows and every tick after K appends zero. The issue
names this as the explicit alternative. Known sub-shapes, each with its own
catch:

- **Rotation alone does not converge.** Retaining the newest admissions
  instead of the first 1000 (as `gate_emitted` already does) rotates which
  1000 the floor refuses, but a floor of 1000 can never cover a population
  above 1000, so roughly population-minus-cap items sit outside it on every
  tick. Membership rotates; the loop does not close.
- **Rotation plus a completion marker.** Walk the second across ticks,
  rotating the retained window so each tick absorbs a fresh slice, and once a
  traversal has observed the whole second, publish a per-second "complete"
  marker and thereafter refuse the second by timestamp. Converges in about
  population-over-cap ticks with duplicates only during convergence. The
  marker is exit A's timestamp refusal taken only after full absorption, so
  its loss window (items published into the second after the last observing
  read) is A's, narrowed but not zero, and the anti-loss rule still needs the
  same explicit exemption.
- **Admit the overflow and deduplicate downstream, scoped to overflow
  seconds.** LLP 0373#option-admit records the global form of this as already
  rejected (#1284's behavior). A variant confined to seconds the cap cannot
  hold would be a new, narrower question, but it still spends the sub-resource
  requests every tick, which the probe shows is the dominant cost, so it
  converges on rows and not on budget.

Whichever sub-shape, C is the most mechanism for the rarest trigger, and its
convergent forms reduce to a deferred A. That reduction is an argument, not a
verdict; pricing it is the decision below.

## Decision requested {#decision}

1. Which exit: bounded declared loss (A), a population-bounded carry (B), or
   an absorbing scheme (C), with C's sub-shape named if chosen.
2. If A or C: where the loss window is declared (the LLP 0361#page-work
   forward-ref, the re-pinned tests, and the `openGate` and `readBoundaryIds`
   docstrings that currently promise the opposite for all seconds).
3. If B: the new statement of LLP 0360#resource-bounds, and whether
   `gate_emitted` keeps the old cap under a split constant.
4. Whether the pulls pass's uncapped durable set (`pulls_high_numbers`)
   adopts the chosen exit or keeps its current population bound, and why.

This document chooses none of them. The choice trades a settled anti-loss
rule against a settled resource bound, which is the Designer's call and
ultimately a human's.

The proof obligation from issue #1332 carries over verbatim: with the chosen
design in place, the reviewer's probe scenario (1500 commits sharing one
committer second, budget not confounding) converges. Some tick K appends the
remaining rows once, every tick after K appends zero rows and spends zero
`listCommitFiles` requests, and no item published in that second after the
first read is silently lost unless the chosen exit explicitly accepts that
loss. The existing boundary tests in `test/plugins/github-capture.test.js`
stay green except where the chosen exit explicitly re-pins them.

## References

- hyparam/hypaware#1332 (the deferred finding, PR #1330 review round 2,
  finding 1: this document is its acceptance condition's "LLP records the
  chosen exit")
- hyparam/hypaware#1284 (the unguarded per-tick re-append, closed by PR #1330)
- PR #1330 (the boundary gate and `MAX_BOUNDARY_IDS`)
- [LLP 0373](./0373-boundary-identity-is-the-id-not-the-snapshot.rfc.md)
  (the identity-key question this document is disjoint from, #relation)
- `hypaware-core/plugins-workspace/github/src/cursors.js`
  (`MAX_BOUNDARY_IDS`, `readBoundaryIds` and the docstring recording the
  loop, `readNumbers`)
- `hypaware-core/plugins-workspace/github/src/capture.js`
  (`openGate` and its `ids` getter, `setBoundary`, `advancePullsHigh`)
- `test/plugins/github-capture.test.js` (the anti-loss tests exits A and C
  must explicitly re-pin)
