# LLP 0443: Classifying a destination mention in CLI help

**Type:** RFC
**Status:** Draft
**Systems:** CLI, Tests, Reports
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-26
**Related:** LLP 0134 (self-hosted teams, whose target names are the
false-positive shape), LLP 0155 (Draft: the report CLI this guards),
LLP 0266 (Active: the CLI help structure the guard sweeps),
LLP 0436 (Accepted: the publish contract, which writes "the server" for the
same place); issues #2201, #2204, #2205, #2189, #2167, #2174;
PR #2195, PR #2191, PR #2188

> `test/core/cli-consistency-gate.test.js` renders every `hyp report` help
> surface and fails when one names its destination in two vocabularies
> (#2189, landed in PR #2195). To do that it has to decide, for each
> occurrence of a word like `remote` or `upstream`, whether the word names
> the **interface** (the `--remote` option, a `hyp remote ...` command, a
> target's name) or the **destination** (the place a report goes). It
> decides that **positionally**, with a regex, and it is wrong in both
> directions: it conceals real contradictions (#2205) and it fails truthful
> prose (#2204), and a third leak (#2201) is outside what either direction
> can reach.
>
> Two review rounds and a triage on PR #2195 each tried to settle this with
> another regex, and each traded one direction for the other. This document
> states the problem with its reproduced evidence, says why the regex
> approach has no fixed point here, and puts four options up with their
> costs and their CI cost. **It decides nothing**, and it changes no guard.
> The choice is a human's.

## Context {#context}

Issue #2189 asked for a guard, and named the shape it wanted: "assert the
concept rather than one verbatim sentence, since guards pinning single
sentences have already been defeated by rewording in this repo (#2167,
#2174)." PR #2195 built that: `DESTINATION_FAMILIES`
(`test/core/cli-consistency-gate.test.js:623`) is three word families, and
`destinationFamilies` (`:652`) blanks the interface spellings before matching
them:

```js
const prose = help.replace(/--remote/g, '--OPTION').replace(/hyp remote(?:\s+[a-z][a-z-]*)?/g, 'hyp COMMAND')
```

Ten probes defeated the guard across the two rounds. Three were fixed (the
greedy blanking, the surface enumeration, and a regression in the
enumeration fix). The residue became six issues, of which **three are one
design change described three times**: #2201, #2204 and #2205 all say, in
their own words, that closing them needs lexical classification of a
destination mention rather than another regex edit.

## The evidence, reproduced {#evidence}

Every row below was re-run first-hand at `origin/master` (`b1ca1d9b`, the
merge of PR #2195) against the shipped classifier, with each probe sentence
appended to the `report publish` help body. `GREEN` means the guard passes,
`RED` means it fails; the **Want** column is what the guard's own premise
says should happen.

| Probe | Text appended to the publish help body | Guard | Want | Issue |
| --- | --- | --- | --- | --- |
| B1 | `The service renders the report for the team.` | GREEN | RED | #2201 |
| B2 | `The host renders the report for the team.` | GREEN | RED | #2201 |
| B3 | `Hyperparam Collect renders the report for the team.` | GREEN | RED | #2201 |
| B7 | `run hyp remote list and the server renders the report` | RED | RED | fixed in PR #2195 |
| M1 | `Sign in first: hyp remote login onprem.` | RED | GREEN | #2204 |
| M2 | `Rendering happens on hyp remote upstream of your machine` | GREEN | RED | #2205 |
| M2 control | `hyp remote; server rendering follows` | RED | RED | correct today |
| A6 | `Run hyp remote list to see your targets.` | GREEN | GREEN | correct today |
| shipped | `stored via 'hyp remote login <target> --token-file <path>').` | GREEN | GREEN | correct today |

Three things follow from the table, and they are the whole problem.

**The two leaks run in opposite directions.** M1 fails truthful prose
because the blanking is positional: it erases exactly one token after
`hyp remote`, so it erases the subcommand `login` and leaves the target
name `onprem`, which matches `\bon-?prem\w*\b` in the `server` family. M2
passes a real contradiction for the same reason: `upstream` is a declared
`server`-family word sitting where a subcommand would be, so the blanking
erases it. Widening the blanking closes M2's direction and reopens B7's
(the round-1 greedy form concealed every word after the command); narrowing
it closes B7 and opens M1. PR #2195 walked that trade in both directions
and documented it in the JSDoc at `:644-649` rather than pretending it was
settled.

**`onprem` is not a hypothetical target name.** `docs/CLI_REFERENCE.md` and
`hypaware-core/smoke/flows/remote_oidc_login.js` already write concrete
lowercase target names after `hyp remote` subcommands, and
[LLP 0134](./0134-wizard-wraps-remote-login.decision.md)
records that self-hosted teams exist, for whom `onprem` is the obvious
name. The shipped tree is green, so M1 is latent; it is one truthful help
edit away from red.

**B1, B2 and B3 are not the same leak at all.** None of those three
sentences contains a family word. The blanking never runs, and no
classification of `remote`, `upstream` or `cloud` occurrences can reach
them. #2201's acceptance condition names "an interface-token allowlist or
quoted-command-span parse" as the devices that should turn them red, and
that is the one part of the three issues' shared framing that does not hold:
both devices decide whether a **known** family word is interface or
destination, and B1/B2/B3 contain none. Turning them red needs a rule about
**which sentence names the destination**, which is a different and stronger
claim than classifying a token. This matters for the options below: two of
them close #2204 and #2205 and leave #2201 open.

## Why a regex cannot settle it {#why-not-regex}

The guard is asked to decide a question about reference: does this word name
the place, or the way of reaching it? A regex can only decide that from
position and spelling, and in this vocabulary position and spelling do not
determine it. `upstream` after `hyp remote` is a destination word in M2 and
would be a subcommand token if one were ever registered under that name;
`onprem` after `hyp remote login` is a name and not a destination word,
while `onprem` anywhere else is exactly the contradiction the guard exists
to catch. Every repair proposed on PR #2195 moved the boundary and left a
falsifier on the other side of it, verified each time by whichever probe set
that round happened to write.

The repo has already paid for this pattern twice more, on two different
surfaces, and the two outcomes disagree:

- **PR #2188 is `neutral:stuck`** on the product-telemetry doc guard
  (`test/core/product-telemetry-doc-local-only.test.js`). Three independent
  reviewers each wrote their own mutation harness and **all three defeated
  the hardened guard**, including a one-word inversion (`includes` to
  `skips`) that leaves CI green on a doc asserting the opposite of the fact
  the guard exists to force. The question put to the human there is the same
  shape as the question here: verbatim pinning versus reducing the guard's
  claims. It is a different surface and a different decision, and it is
  **not** settled by this document.
- **PR #2191 round 2 converged on literal pinning** for the consent-prompt
  copy after eleven fresh defeats plus four of the reviewers' confirmed at
  the hardened head. The clause splitter, both destination extractors and
  the hedge scanner were deleted and replaced by a literal pin of the
  rendered block: all 33 mutations across both rounds went red, no false
  failure survived, and the file shrank by 78 lines. That is now on master
  (`test/core/usage-policy-classification.test.js`), and it followed a
  pre-existing idiom: `test/core/cli/wizard/sync_scope.test.js` pins nine
  sibling "the cloud" destination lines with plain `assert.equal`.

Against that, #2189's own reasoning, and the two issues it cites, point the
other way: #2167 and #2174 are both records of a **phrasing-literal pin
being defeated by rewording**. The distinction those three issues turn on is
worth stating, because it is the crux of the choice below and it is not
stated anywhere in the corpus: #2167 and #2174 pinned what a surface must
**not** say (`assert.doesNotMatch` on a literal), and an absence pin goes
green the moment the forbidden claim is reworded. PR #2191 pinned what the
surface must **say**, and a presence pin goes **red** the moment the copy
changes at all. The first fails silently, the second fails loudly and
demands a human re-bless. Which of those failure directions a destination
vocabulary deserves is a judgment about this surface, not a fact about
regexes.

## What governs this today {#governs}

Searched the corpus for an Accepted or Active LLP that settles either half
of this, and found none.

- **No LLP records the destination vocabulary.** The guard's premise, that
  `the remote` is the settled word, rests on `docs/CLI_REFERENCE.md:333-339`
  alone (landed in #2169 and cited by #2189). The corpus writes the other
  word for the same place:
  [LLP 0436 #sources](./0436-publish-markdown-report-sources.decision.md#sources)
  (Accepted) says publish "uploads Markdown for the server to render", and
  LLP 0155 (Draft) writes "the server" throughout. Those are design prose
  about a server component rather than user-facing help copy, so nothing is
  in conflict and nothing here asks to change them, but it does mean the
  vocabulary the guard enforces is a doc convention with no LLP behind it.
- **No LLP records a test-guard classification policy.** The nearest
  neighbour is LLP 0266 (Active, `CLI, Plugins, Onboarding, Tests`), whose
  `#milestones` M5 asks for snapshot and equivalence evidence over the help
  tree; it settles nothing about how a guard classifies prose.
  `test/core/team-setup-disclosure.test.js` states a house rule for pinning
  copy in its own header (match a distinctive fragment plus a structural
  check, rather than parsing meaning), but a test header is not a recorded
  decision and two live PRs are currently disagreeing with each other about
  it.

Consequently **no `Extended-by:` forward-ref was added to any existing
doc**: there is no settled section for this to extend. If the answer to the
open question is a policy rather than a one-guard repair, it will be a new
decision with its own `Systems: Tests` tag, and LLP 0266 is the doc it would
sit beside rather than amend.

## Options {#options}

Each option below is followed by its CI cost. The cost floor is the same for
all of them that keep the check: the guard renders help through `dispatch`
**once per registry entry in the `report` family**, which is 7 surfaces at
`b1ca1d9b` (`report`, `report delete`, `report fix`, `report get`,
`report list`, `report publish`, `report render`) and grows with every
report subcommand anyone registers. That dominates. Measured at
`b1ca1d9b`: the vocabulary case is **1.9 ms** of the file's 484 ms, and the
file is 28/28 green in 0.51 s wall. No option below changes the dominant
term, so the cost differences are real but small, and they are stated for
completeness rather than as a tiebreaker.

1. **An interface-token allowlist derived from the registry.** Blank
   `hyp remote` plus a following token only when that token is a registered
   `remote` subcommand, and blank the token after that only when the
   subcommand's own usage string declares a name operand. Both halves are
   already in the registry at `b1ca1d9b`: the family is
   `remote, remote add, remote list, remote login, remote mint,
   remote remove`, and the usage strings carry the arity
   (`hyp remote add <name> <url>`, `hyp remote login [name]`,
   `hyp remote mint [name]`, `hyp remote remove <name>`,
   `hyp remote list [--json]`). **Closes #2205**, because `upstream` is not
   a registered subcommand and so survives the blanking. **Closes #2204**,
   because `login` is blanked as a subcommand and `onprem` is blanked as its
   declared name operand. **Leaves #2201 open**, per
   [#evidence](#evidence). Costs: the `report` guard now fails when the
   `remote` family's registrations change, which is a coupling between two
   command families that a reader of a `report` failure will not expect; it
   needs the usage strings parsed, so a usage reword can silently change
   what the guard blanks; and a subcommand ever registered under a family
   word (`hyp remote upstream`) reopens M2 by construction. CI cost: the
   same 7 dispatches, plus one registry walk over the `remote` family (6
   entries) and one alternation built per run instead of a static literal.
   Sub-millisecond, no new allocation in any loop.
2. **A quoted-command-span parse.** Treat a command spelling as an
   interface mention only inside a quoted span, and count every family word
   outside one. The shipped help already writes it that way: across all 7
   report-family surfaces there is **exactly one** `hyp remote ...`
   occurrence, `stored via 'hyp remote login <target> --token-file <path>')`
   at `src/core/cli/core_commands.js:789`, and it is single-quoted with a
   `<target>` placeholder rather than a bare name; every other interface
   mention in the family is `--remote`. **Closes #2205** (an unquoted
   `upstream` is counted). **Leaves #2201 open.** Its effect on **#2204 is
   the interesting one**: M1's truthful sentence is unquoted, so it stays
   red unless help authors are required to quote commands, at which point
   M1 written as `Sign in first: 'hyp remote login onprem'.` is green. So
   this option closes #2204 by **imposing a writing convention** on help
   copy rather than by classifying it. Costs: that convention is real and
   unrecorded, and nothing but this test would enforce it; a help author who
   writes a command bare gets a failure about vocabulary for a punctuation
   mistake. CI cost: the same 7 dispatches, plus one additional linear pass
   per help string. Help bodies are around 1 KB; PR #2191 measured a
   comparable regex battery at 1.3 ms over 200 KB and linear in input, so
   this stays well under a millisecond at real sizes.
3. **Literal pinning of the help surfaces, as PR #2191 did for the consent
   prompt.** Replace the family matching with `assert.equal` against the
   rendered destination lines of the two surfaces whose subject is where a
   report goes (`report` and `report publish`), following
   `test/core/cli/wizard/sync_scope.test.js`. **Closes all three issues at
   once**, and it is the only option here that reaches #2201: a pinned
   sentence rejects `The service renders the report` without needing to know
   that "service" is a destination noun. Costs: every copy edit to those
   surfaces fails CI until a human re-blesses it, which PR #2191 accepted
   deliberately on a load-bearing consent surface and which #2189 argued
   against for this one; and a pin holds only the surfaces it names, so a
   new report subcommand is no longer swept by the rule unless someone adds
   it (the current guard sweeps the family automatically, which is the
   property #2189's acceptance condition asked for). CI cost: **the
   cheapest of the four that keep a check.** The 7 dispatches remain,
   because the rendered text is what gets compared, but all regex work
   becomes string comparison. PR #2191 measured exactly this swap on its own
   file: around 28 `RegExp` compilations plus two 1.3 KB text splits per run
   became one string comparison, and the file shrank by 78 lines.
4. **Reduce the guard's claimed scope and move the obligation to a human
   gate.** Keep the parts that hold absolutely (every report surface
   renders with exit 0, and the `report` and `report publish` surfaces still
   name a destination at all, which is the existing anti-vacuity half),
   drop the second-vocabulary claim and the classification with it, and put
   the one-vocabulary obligation in a review checklist line instead. This is
   PR #2188's option 2 applied to this surface, and PR #2188's reviewer
   recommended it there. **Closes none of the three in CI**, and closes all
   three as guard defects by retracting the claim that produced them. Costs:
   a real self-contradiction in shipped help lands silently until a human
   reads it, which is exactly what #2189 recorded happening once already;
   and the acceptance-procedure variant is not available, because
   `docs/ACCEPTANCE.md` was deleted and the acceptance tier retired by
   [LLP 0430 #decision](./0430-manual-acceptance-procedures-are-retired.decision.md#decision),
   so the checklist variant is the only live form of this option. CI cost:
   lowest. If the anti-vacuity half stays, the 7 dispatches stay and the
   three family regexes go; if the whole case goes, so do the dispatches.

## What a decision needs to say {#decision-needs}

1. **Which of the four**, or which combination. Options 1 and 2 are
   compatible with each other and with 3; option 4 is an alternative to all
   of them. PR #2188's reviewer offered "option 2 with option 1 applied to
   one sentence" for the sibling surface, and the analogous hybrid here is
   option 3 on the two destination-bearing surfaces plus option 4 on the
   rest of the family.
2. **Whether #2201 is in scope.** If the answer is one of options 1 or 2,
   #2201 stays open and should say so rather than waiting on a change that
   by construction does not reach it.
3. **Which failure direction this surface deserves**, per
   [#why-not-regex](#why-not-regex): loud on every reword (a presence pin)
   or silent on an inversion (a reduced guard). #2189 chose the second for
   this surface before the evidence existed; PR #2191 chose the first for
   the consent surface after it did.
4. **Whether the answer is a policy.** If it is, it is a new decision with
   `Systems: Tests` that binds the next prose guard as well as this one, and
   PR #2188 is waiting on the same question for a different surface.
5. **Whether the destination vocabulary itself should be recorded**, given
   [#governs](#governs): the guard enforces `the remote` on the authority of
   one docs line, while an Accepted LLP writes `the server` for the same
   place in design prose.

Whatever is chosen, the acceptance evidence is the full PR #2195 probe
matrix re-run, with the [#evidence](#evidence) table above as the baseline
to diff against, and with B7, the M2 control and the red baseline staying
red.

## Recommendation, offered and not decided {#recommendation}

**Option 3 for the two destination-bearing surfaces, plus option 4 for the
rest of the family.** The reasoning, from in-repo evidence rather than first
principles: it is the only combination in which every check either holds
absolutely or is not claimed at all, which is the property PR #2188's
reviewer named and PR #2191's round 2 actually shipped and measured (33/33
mutations red, no false failure, 78 lines smaller, strictly less CPU). It is
also the only option that reaches #2201, and it retires the classification
question rather than relocating it, which is what stops the trade. The case
against it is #2189's, and it is not weak: a pin does not sweep a new report
subcommand, and it summons a human on every copy edit. That is a judgment
about how load-bearing this help copy is, and the corpus records no
decision that answers it.

## Open question {#open-question}

**Which of the four options above should the guard become, and is the answer
a one-guard repair or a policy that binds the next prose guard too?**

This is the human's to answer, not neutral's: options 3 and 4 each retract a
design choice PR #2195 made deliberately and documented at the site
(`test/core/cli-consistency-gate.test.js:644-649`), and CLAUDE.md puts that
out of reach of a drive-by change. Nothing in this document is implemented,
no guard is changed, and #2201, #2204 and #2205 stay open.

## What this document does not open {#not-opened}

- **PR #2188's guard.** The product-telemetry doc guard is a different
  surface with its own `neutral:stuck` question and its own three-option
  menu. It is named here as context so a human can see one pattern behind
  both, and it is not settled, narrowed or pre-empted by this document.
- **The destination vocabulary.** Whether user-facing help should say `the
  remote` or `the server` was settled for the CLI by
  `docs/CLI_REFERENCE.md` and is not reopened;
  [#governs](#governs) only records that no LLP carries it.
- **The other three PR #2195 deferrals.** #2202, #2203 and #2206 are about
  anti-vacuity satisfiability and runtime output wording, not about
  classifying a mention, and they are not folded in here.

## References {#references}

- Issues: [#2201](https://github.com/hyparam/hypaware/issues/2201) (denylist
  hole, B1/B2/B3), [#2204](https://github.com/hyparam/hypaware/issues/2204)
  (false positive on a target name, M1),
  [#2205](https://github.com/hyparam/hypaware/issues/2205) (family word
  erased after the command, M2),
  [#2189](https://github.com/hyparam/hypaware/issues/2189) (the guard's
  request and its concept-over-verbatim reasoning),
  [#2167](https://github.com/hyparam/hypaware/issues/2167) and
  [#2174](https://github.com/hyparam/hypaware/issues/2174) (phrasing-literal
  absence pins defeated by rewording)
- PRs: [#2195](https://github.com/hyparam/hypaware/pull/2195) (the guard,
  its two review rounds and its triage disposition),
  [#2191](https://github.com/hyparam/hypaware/pull/2191) (literal pinning
  after eleven defeats, now on master),
  [#2188](https://github.com/hyparam/hypaware/pull/2188) (`neutral:stuck`,
  the sibling open question)
- Code: `test/core/cli-consistency-gate.test.js:623` (the families), `:644`
  (the documented two-way leak), `:652` (the classifier), `:673` (the
  sweep); `src/core/cli/core_commands.js:784` and `:789` (the report group
  help and its one quoted command span); `docs/CLI_REFERENCE.md:333-339`
  (the settled wording); `test/core/usage-policy-classification.test.js`
  and `test/core/cli/wizard/sync_scope.test.js` (the pinning idiom);
  `test/core/team-setup-disclosure.test.js` (the fragment-plus-structure
  idiom)
