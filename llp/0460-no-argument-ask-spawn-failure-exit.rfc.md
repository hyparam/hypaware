# LLP 0460: The no-argument ask's exit code on a spawn failure needs one answer

**Type:** RFC
**Status:** Draft
**Systems:** CLI
**Author:** Neutral / Claude
**Date:** 2026-10-01
**Extends:** LLP 0198 (#real-launch: "the command owns its exit code" names the constraint; this RFC asks what the no-argument path's code says when the spawn itself fails)
**Related:** LLP 0414 (#same-seams: the report commands reuse the same launch seams and return 1 on the same failure), LLP 0456 and LLP 0459 (the sibling RFCs on the same pickers), issue #2388, PR #2385

> `hyp ask "<question>"` exits 1 when the chosen client fails to start.
> Bare `hyp ask` prints the same failure sentence and exits 0.
> `docs/CLI_REFERENCE.md` claims 1 for both forms. One side has to move,
> and either move is visible: the docs sentence is a published contract,
> and the exit code is one too. This RFC records the measured evidence,
> lays out both arms with their costs, and asks for a decision. It
> changes no behavior by itself.

## Context {#context}

`runAsk` (`src/core/commands/ask.js`) has two launch paths. With a
question, a failed `launchClient` prints
`hyp ask: could not start <bin>: ...` and returns 1 directly. With no
argument, the launch runs inside `runWizardFirstAsk`
(`src/core/cli/wizard/first_ask.js`), which reports a failed spawn as
`{ launched: false, reason: 'spawn-failed' }`, and `runAsk` maps the
outcome with:

```js
return outcome.launched === false && (outcome.reason === 'no-launcher' || outcome.reason === 'no-evidence') ? 1 : 0
```

so `spawn-failed` falls into the success bucket. The comment above that
line draws the boundary as "`no-launcher` and `no-evidence` are the
outcomes that are a failed invocation rather than a choice", a rationale
that describes a spawn failure exactly as well, yet the reason is not in
the set. No test pins the no-argument spawn-failure exit code, so
nothing says whether the omission was chosen.

The published contract disagrees with the code. The `hyp ask` section of
`docs/CLI_REFERENCE.md` covers both forms in one paragraph and ends: "No
launchable client, no gatherable evidence, or a process-start failure
returns `1`."

## Evidence {#evidence}

Measured on `origin/master` (`5ac84146`), four sites launch an attached
client through the same `launchClient` seam, and three of the four
return 1 when the spawn fails:

| Path | Spawn-failure exit | Site |
| --- | --- | --- |
| `hyp ask "<question>"` | 1 | `src/core/commands/ask.js` (direct return after `!result.ok`) |
| `hyp report generate` | 1 | `src/core/cli/report_commands.js` (the `could not start` write, then `return 1`) |
| `hyp report fix` | 1 | `src/core/cli/report_commands.js` (same shape) |
| bare `hyp ask` | 0 | `src/core/commands/ask.js` outcome mapping over `first_ask.js` `spawn-failed` |

The report commands' own reference sections make the same
"a process-start failure returns `1`" claim, and for them it is true.
The no-argument ask is the lone outlier, against its siblings, against
the docs, and against the stated rationale of its own mapping comment.

One scoping fact bounds the blast radius of either arm: `spawn-failed`
on the no-argument path is reachable only from a run that holds a
terminal. `runWizardFirstAsk` returns `not-interactive` before any
spawn when either stream is not a tty or `HYP_NO_TUI=1`, so a piped or
plain scripted run never reaches the spawn and keeps exit 0 under every
candidate below. A terminal is not a person, though: a tty-allocating
wrapper - `docker run -t`, a tty-allocating CI runner, expect - answers
`isTTY` exactly as a human's terminal does and does reach the spawn, as
the client picker's own deadline already records
(`PICK_DEADLINE_MS`, #2373). So what either arm excludes is every run
whose streams are not ttys, which is not the same as excluding CI.

## Problem {#problem}

A script cannot detect a failed launch from the no-argument form, the
documentation promises that it can, and the asymmetry between the two
forms of the same verb is undocumented everywhere. Issue #2388 records
the fork; PR #2385, being docs-only, deferred it rather than deciding a
behavior question in a re-wrapped paragraph.

## Candidate arms {#candidates}

Neither is decided here.

<a id="align-code"></a>**1. Map `spawn-failed` to 1.** Add the reason to
the failure set in `runAsk`'s mapping, with a test that pins bare
`hyp ask`'s exit code on a failed spawn. This makes the behavior match
the published docs, the with-question path, both report commands, and
the mapping comment's own boundary ("a failed invocation rather than a
choice"). Cost: a user-visible exit-code change on a shipped CLI.
Any caller that runs bare `hyp ask` on a terminal, suffers a spawn
failure, and branches on `$?` would see 1 where it saw 0; the scoping
fact above confines that to runs on a tty, but confined is not none.
One such caller is already in this repository. Setup's closing offer
spawns bare `hyp ask` as a child (`runAskChild`,
`cli/wizard/suggest_skill.js`) with all three stdio inherited, and
branches on the child's exit code, so a spawn failure there is reported
today as `suggest_skill: launched` with no verb line, and under this
arm becomes `child-failed` with the "Run `hyp ask` any time" line.
That is arguably the arm's point rather than its price, since setup
currently records a launch that did not happen - but it is a change
inside the product, not only in third-party scripts, and it sits in
exactly the attended setup the scoping fact does not exclude.

<a id="align-docs"></a>**2. Scope the docs sentence to the with-question
path.** State that the no-argument form exits 0 on a spawn failure,
reporting it on stderr only, and keep the code untouched. Cheapest and
inert. Cost: it ratifies the outlier as contract. The asymmetry between
two forms of one verb, and between `hyp ask` and the report commands on
the identical failure, becomes documented policy with no rationale
behind it, and a rejected exit-code fix later is a second, larger
contract change.

## Decision requested {#decision-requested}

Which arm lands. Whichever is chosen, issue #2388's acceptance
condition applies: a test pins bare `hyp ask`'s exit code on a spawn
failure, which nothing does today. Arm 1's test fails before the
change and passes after. Arm 2's cannot: it pins the code the command
already returns, so it passes from the moment it is written, and what
has to move there is the docs sentence the edit scopes.

## Open questions {#open-questions}

- Should `declined` and `not-interactive` stay 0 regardless of the arm
  chosen here? Both are choices, not failures, and nothing in #2388
  questions them; this RFC assumes they stand.
- The catch-all `error` reason in `runWizardFirstAsk` also maps to 0
  today. If arm 1 lands, does an internal error during the gather
  deserve the same 1, or is that a separate question?

## References

- [LLP 0198](./0198-setup-ends-on-a-question.decision.md) #real-launch
- [LLP 0414](./0414-a-recommendation-is-a-verb.decision.md) #same-seams
- Issue #2388; PR #2385 (the deferral); `docs/CLI_REFERENCE.md`, the
  `hyp ask`, `hyp report generate`, and `hyp report fix` sections
