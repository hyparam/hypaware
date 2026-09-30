# LLP 0456: The non-interactive client pick needs a stated rule

**Type:** RFC
**Status:** Draft
**Systems:** CLI, Reports
**Author:** Neutral / Claude
**Date:** 2026-09-30
**Extends:** LLP 0414 (#same-seams: "piped, the first is taken" names a position, not a rule; this RFC asks what makes a client first), LLP 0198 (#path-probe: the recorded-and-resolvable predicate builds the list this pick indexes into)
**Related:** LLP 0398 (#run-directory: the launch mechanics around the pick), LLP 0429 (#status: the marker-less transcript mode that widened the list), issue #2368, issue #671 (item 5), PR #2339

> `hyp ask "<question>"`, `hyp report generate`, and `hyp report fix` each
> start one attached client. Interactive runs prompt since PR #2339. A run
> that cannot prompt (piped stdin, `HYP_NO_TUI=1`) takes `launchers[0]`,
> and no document says what earns a client index zero. This RFC records
> the evidence, lays out the candidate selection rules with their costs,
> and asks for a decision. It changes no behavior by itself.

## Context {#context}

Three non-interactive paths take the first entry of the same list:
`src/core/commands/ask.js` (the named-question launch),
`src/core/cli/report_commands.js` (`report generate`), and the same file
again (`report fix`, which hands the launched agent a repository edit).
The list is built by `askableClients` from the status report's client
order, filtered by `resolveLaunchers` (LLP 0198 #path-probe), which
preserves input order. The status order flows from plugin discovery:
`discoverBundledPlugins` in `src/core/runtime/bundled.js` maps
`fsp.readdir` over the bundled workspace with no explicit sort anywhere
downstream.

Issue #2368 first read that as cross-machine nondeterminism. The
ship-risk correction on the issue showed it is not: on the supported
platforms libuv's `uv_fs_scandir` sorts directory entries by `strcmp`,
so the pick is deterministic, alphabetical by workspace directory name.
That sharpens the problem rather than dissolving it. The order is a
byproduct of libuv internals and directory naming, not a decision anyone
made, and it is now load-bearing: PR #2339 widened the askable list so
that Codex in its default transcript mode (marker-less but recorded,
LLP 0429 #status) joins any attached client, making a two-element list
the ordinary case. On such an install, `codex` sorts before `opencode`
and every piped run silently switched agents when the list widened.
Issue #671 item 5 flagged the arbitrary `launchers[0]` pick before the
widening; PR #2339 fixed the interactive half with a picker and left
the piped half to the emergent order.

LLP 0414 #same-seams already states the piped behavior ("the first is
taken, as a named `hyp ask` does") but defines "first" only by list
position. The correction on #2368 is explicit that a sort commit fixes
nothing, because the order is already sorted: what is missing is the
rule, stated where a user can read it, or an explicit selection that
makes the ordering moot.

## Problem {#problem}

Which agent answers a piped `hyp ask`, and which agent receives a
repository edit from a piped `hyp report fix`, is currently a function
of ASCII ordering over plugin directory names. It is deterministic but
unchosen, undocumented, and it moves when a plugin is renamed or a new
askable client sorts earlier. Every run does name the agent on stdout
before starting it, so no run is silent about who acted, which is why
#2368 was safe to defer. The acceptance condition on that issue: a
deliberate selection rule lands, recorded per the LLP convention, with
a test that pins which client the non-interactive path starts and fails
when discovery order is shuffled adversarially.

## Candidate rules {#candidates}

None of these is decided here. Each changes something PR #2339 did not
otherwise touch, which is what makes this a decision and not a patch.

<a id="document-current"></a>**1. Adopt the current order as the rule.**
Declare the pick alphabetical by client name, add the explicit sort at
the pick site so the rule stops depending on libuv and directory layout,
and document it in `hyp ask --help` and the CLI reference. Cheapest, and
behavior-preserving on every existing install. Cost: it enshrines a
coincidence. Alphabetical says nothing about which agent a user would
want editing their repository, and `codex` beating `opencode` forever is
then policy rather than accident. A client renamed or newly added still
changes picks, now by documented rule.

<a id="client-flag"></a>**2. An explicit `--client <name>` flag.** On
`hyp ask`, `report generate`, and `report fix`. Unambiguous where used,
and the natural spelling for scripts, which are the main non-interactive
callers. Cost: new CLI surface on three commands, and it does not remove
the need for a default rule when the flag is absent, so it composes with
one of the other candidates rather than replacing them.

<a id="config-preference"></a>**3. A config preference.** A key naming
the preferred client, consulted wherever the list has more than one
entry, interactive runs preselecting it in the picker. Persistent and
per-install. Cost: a new config key, which the repo treats as something
a task must call for, plus schema, validation, and a story for a
preference naming a client that is no longer askable.

<a id="derived-precedence"></a>**4. A derived precedence.** Prefer the
client with the strongest evidence of use: an attach marker over a
marker-less transcript mode, or the client with the most recent recorded
activity. Derives from data the status report already carries, no new
surface. Cost: the pick changes as recordings accrue, so identical
configs on two machines can still start different agents, which is the
original complaint in different clothes, and the precedence itself is
another rule to choose and document.

<a id="refuse-ambiguity"></a>**5. Refuse when ambiguous.** A
non-interactive run with more than one launcher exits nonzero naming the
candidates and the way to choose (a flag or config from candidates 2 or
3). Fully deterministic by elimination and honest about the ambiguity.
Cost: it breaks piped runs that work today, and it is the harshest
option for `hyp ask`, where the user named a question, not a client, and
any recorded agent can answer it. It also sits directly on the tty gate
that issue #2373 is reworking.

## Decision requested {#decision-requested}

Which rule, or which combination (2 plus a default from 1 or 4 is the
common pairing), governs the non-interactive pick. Whatever is chosen,
the landing change should carry the test #2368's acceptance condition
names: pin the picked client and fail when discovery order is shuffled.

## Open questions {#open-questions}

- Is alphabetical-by-name an acceptable permanent default, or does the
  agent that edits a repository (`report fix`) deserve a stricter rule
  than the one that answers a question (`hyp ask`)?
- Should the interactive picker and the non-interactive default share
  one ordering, so the piped pick is always the picker's top row?
- Does the resolution here fold into the fix for #2373 (the unattended
  tty hang on the same gate), which its body suggests shares a cause?

## References

- [LLP 0414](./0414-a-recommendation-is-a-verb.decision.md) #same-seams
- [LLP 0198](./0198-setup-ends-on-a-question.decision.md) #path-probe
- [LLP 0429](./0429-codex-capture-leaves-inference.spec.md) #status
- Issue #2368 and its ship-risk correction comment; issue #671 item 5; PR #2339
