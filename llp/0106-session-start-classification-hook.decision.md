# LLP 0106: new folders are classified at session start, not defaulted silently

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Usage-Policy, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0044, LLP 0049, LLP 0100, LLP 0103, LLP 0105, LLP 0107

> On an **enrolled** machine, opening a Claude/Codex session in a directory
> with no recorded usage class triggers a client hook that asks the user to
> classify it: sync, `local-only`, or `ignore`. The answer lands as an
> explicit machine-local entry ([LLP 0103](./0103-machine-local-policy-classes.decision.md)),
> so the question is asked once per directory. Chosen over silently applying
> a default polarity at the query seam: coverage, not fallback, is the
> primary answer to "unknown context".
>
> @ref LLP 0103 [constrained-by] - the explicit `full` entry is what makes "asked and answered" representable at all.

## Context

The query-seam rule ([LLP 0105](./0105-query-seam-local-only-visibility.decision.md))
needs to know the querying context's class, and the export seam needs every
`cwd`'s class to be what the user actually wants. Both degrade when a
directory has never been classified: the machine falls back to the implicit
`full` default the user never affirmed. The privacy review skill
([LLP 0100](./0100-enrollment-privacy-review.spec.md)) classifies the
**backlog** at enrollment; nothing covered directories the user starts
working in afterwards. This hook is the incremental half: together they keep
classification coverage total over the machine's life.

## Decision

**A session-start hook, installed at attach alongside the existing
session-context hook ([LLP 0107](./0107-skills-ride-attach.decision.md)),
checks the session's `cwd` against the resolver and, when no explicit class
governs, has the user classify the folder before work proceeds.**

- **Enrolled machines only** {#enrolled-only}: on a never-enrolled box
  nothing forwards, so sync-vs-`local-only` is a distinction without a
  difference; forcing a prompt there is pure friction. The hook activates
  when a central sink exists and is inert otherwise.
- **Interactive sessions only, degrade gracefully** {#interactive}: a
  headless/CI session in an unclassified folder proceeds under today's
  implicit default (`full`) and leaves the folder unclassified for the next
  interactive session to catch. The hook must never hang or fail a
  non-interactive run.
- **The answer is written via the same CLI verbs** the skill and the human
  use (`hyp ignore --private`, `--local-only`, the explicit-sync marking),
  landing as an [LLP 0103](./0103-machine-local-policy-classes.decision.md)
  entry. One store, three writers: skill, hook, hand-run CLI. Choosing sync
  writes the explicit `full` entry, which is precisely what suppresses the
  next prompt.
- **"Force" is per-client mechanics**, resolved in the design doc: Claude's
  hook protocol supports blocking a session start with a prompt; Codex's
  hook surface is thinner and may degrade to a firm nag on first prompt.
  The decision here is the *model*: unclassified plus interactive means the
  user is asked, once, at the moment the answer is cheapest to give.
- **Mechanical unknowns keep the [LLP 0105 #unknown](./0105-query-seam-local-only-visibility.decision.md#unknown)
  backstop**: the hook makes unclassified interactive contexts rare; it does
  not repeal the exclude-on-unknown polarity for contexts that still slip
  through.

## Alternatives rejected

- **Fail-closed defaults as the primary mechanism** (silently exclude
  `local-only` from queries in unknown contexts, silently sync unclassified
  dirs): safe but silent, and the silence is the product failure; users
  discover the policy only after it surprised them.
- **Run the hook on unenrolled machines too** (pre-answering for a future
  enrollment): rejected as friction without stakes; enrollment already has a
  dedicated review moment for the backlog ([LLP 0100](./0100-enrollment-privacy-review.spec.md)).
- **Classify at capture time in the daemon** (no client hook): the daemon has
  no interactive surface; a prompt belongs where the human is.

## Consequences

- After the enrollment review plus steady-state hook, every directory a
  session runs in has an affirmed class; the implicit `full` default remains
  only for headless work and pre-enrollment history.
- One more attach-installed artifact rides the [LLP 0044](./0044-client-attach-on-join.decision.md)
  consent-and-reversal perimeter; `hyp leave` disables it with the rest.
- The prompt copy is load-bearing (it is many users' first contact with the
  class vocabulary) and should be pinned by tests like the other consent
  surfaces.
