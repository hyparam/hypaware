# LLP 0211: The fork explains the product and leads with shared collection

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Author:** Kenny / Claude
**Date:** 2026-08-10
**Related:** LLP 0129 (#fork: the copy this rewords), LLP 0182 (every machine reaches the fork), LLP 0134 (#login-lane: the lane behind the shared row), LLP 0000 (the product this screen must explain)

> Extends [LLP 0129 §fork](./0129-init-wizard-fork.decision.md#fork).
> The fork's *mechanics* are untouched: it is still the wizard's first
> question, still `team` / `local` / `quit` with quit the safe default on
> a bare enter, and every back edge and pathway consequence stands. What
> changes is the words on the screen and which row leads.

## Context

The fork was the first thing a new user ever saw, and it read
"Join a team, or set up HypAware locally?" over the rows "Join a team" /
"Local install and configuration". Nothing on the screen said what
HypAware *does*, "Join a team" hid its sign-in cost, and the framing
inherited from the picker walkthrough's welcome line ("the local
logs+telemetry collector") sold HypAware as a local tool. That framing
is out of date: local collection is one option, but the pathway the
product wants users on is shared collection, which pays off for
individuals too - one history across harnesses and across machines -
not only for teams. "Join a team" made the shared pathway sound like an
enterprise feature and the menu gave a new user no reason to prefer it.

## Decision

<a id="explain-first"></a>**The wizard explains the product before its
first question.** One intro line prints above the fork, every time the
fork renders:

> HypAware records the sessions, logs, and telemetry from your AI
> agents (Claude, Codex) into one queryable history.

"One queryable history" is the load-bearing phrase: it is what the
shared row then locates ("follows you across machines"). The line
renders on every presentation (first run, reconfigure, a failed join's
return to the fork) rather than only the first: the fork is one screen,
and threading a shown-already flag through the orchestrator bought less
than it cost. The pick lane's "Welcome to HypAware - the local
logs+telemetry collector." banner is retired with it, both as redundant
mid-wizard and as the exact framing this decision drops; the npm
package description sheds the same "captures ... locally" framing.

<a id="collect-labels"></a>**The rows lead with what gets collected;
shared leads.** The title is "How do you want to collect agent logs?"
and the rows are:

1. `team`: **Collect shared agent logs**
   with summary "One history that follows you across machines and
   harnesses, and can be shared with your team. You will be asked to
   sign in."
2. `local`: **Collect agent logs locally**
   with summary "Everything stays on this machine. You can switch to
   shared later by re-running hyp init."
3. `quit`: **Quit** (no summary)

Shared keeps the lead position "Join a team" held: listed second, it
would read as the advanced option.
An explicit "(recommended)" tag on the shared row is deferred while
shared collection is in beta; the ordering and the summaries carry the
steer until the tag is earned.
LLP 0129's bare-labels rationale is reversed for this menu: a label
alone cannot both guide the choice and disclose its cost, so the two
real rows carry one-line summaries - the shared row's stating the value
and the sign-in it will ask for (consent in the summary, not a warning
in the label), the local row's stating the boundary and that the choice
is revisitable. Both the TUI and the numbered readline fallback render
the summaries. Row *values*, the quit default on a bare enter, and
LLP 0129's pathway consequences are unchanged: recommending shared
means leading with it and saying why, never preselecting it.

## Consequences

- The returning gate's menu keeps its bare labels; the reversal is
  argued from this menu's guide-and-disclose need, which the gate's
  three self-describing verbs do not have.
- Docs that quote the old copy (LLP 0129, 0134, 0136, 0182, 0190) stay
  as written; they are records of the design, not of the strings. Code
  glosses that quoted "Join a team" are updated where touched.
- `narrateAcceptedGate`'s `lead: false` escape loses its only caller
  (the pick lane block that followed the retired welcome banner).
