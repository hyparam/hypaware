# LLP 0113: the classification ask is a menu, not an open prompt

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0103, LLP 0106

> The session-start classification question ([LLP 0106](./0106-session-start-classification-hook.decision.md))
> must reach the user as a **native selection menu** whenever the client
> environment provides one (in Claude Code, the `AskUserQuestion` tool);
> open-ended prose is a fallback for clients with no such tool, never a
> choice the assistant makes. The mandate lives in the shared consent copy,
> so the one-copy invariant of `classification.js` survives.
>
> @ref LLP 0106 [constrained-by] - pins the presentation half its "force is per-client mechanics" bullet left open.

## Context

LLP 0106 decided *when* the classification question is asked and *where the
answer lands*, and deliberately left presentation to per-client mechanics.
The Claude hook delivers the question as SessionStart `additionalContext`:
an instruction the assistant acts on. The copy said "ask the user", so
whether the user saw a real selectable menu (`AskUserQuestion`) or an
open-ended prose question depended on the model's judgment that turn.

On 2026-07-20 a fresh folder (`~/workspace/bingo`) got the prose form; the
user interrupted the turn before any options appeared and read the whole
exchange as "the menu never showed". A consent surface that renders
differently run to run is not predictable enough to be trusted, and prose
is strictly worse here: it is easier to interrupt, easier to answer
ambiguously, and it buries three fixed choices in free text.

## Decision

**The shared consent copy (`buildClassificationPrompt`) instructs the
assistant to present the three classes as a selection menu via the
environment's native question tool, naming `AskUserQuestion` for Claude
Code, and permits plain text only when no such tool exists.**

- The instruction lives in the one shared copy, phrased tool-neutrally with
  the Claude tool named as the example. Clients without a menu tool (Codex
  today) read the same copy and degrade to the plain-text ask, so the
  "hooks differ only in delivery, never in decision or copy" invariant of
  `classification.js` is untouched.
- The menu mandate is pinned by the consent-copy tests alongside the class
  vocabulary and the verb lines (LLP 0106 consequences: the copy is
  load-bearing).

## Alternatives rejected

- **Leave presentation to model judgment**: the status quo; nondeterministic
  rendering of a consent surface is the observed failure.
- **Fork the copy per client** (menu copy for Claude, prose copy for Codex):
  guarantees the wording per client but breaks the single pinned consent
  surface for a difference the tool-neutral phrasing already absorbs.
- **A client-side TUI menu outside the session** (picker redux): retired
  permanently by [LLP 0102](./0102-skill-replaces-enrollment-picker.decision.md);
  not reopened here.

## Consequences

- Interactive Claude sessions in unclassified folders get a real
  `AskUserQuestion` menu; an interrupted ask remains recoverable because the
  folder stays unclassified and the next session asks again (LLP 0106).
- Codex behavior is unchanged in form; it inherits the menu instruction
  only if its harness ever grows an equivalent tool.
