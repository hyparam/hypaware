# LLP 0410: The fork has two rows and defaults to sync

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Author:** Kenny / Claude
**Date:** 2026-09-15
**Related:** LLP 0129 (#fork: the quit default this withdraws), LLP 0211 (#collect-labels: the rows this relabels), LLP 0299 (#eof-declines: why EOF still quits), LLP 0190 (#eof-everywhere: the fork's `default 3` paragraph no longer describes the menu), LLP 0407 (plain-language copy)

> Extends [LLP 0129 §fork](./0129-init-wizard-fork.decision.md#fork) and
> [LLP 0211 §collect-labels](./0211-fork-copy-collect-first.decision.md#collect-labels).
> The fork's position, its `team` / `local` values, and every back edge
> and pathway consequence stand. What changes is that the menu is two
> rows, not three, and a bare enter takes sync.

## Context

The first screen offered three rows and landed the cursor on Quit. A new
user who ran `hyp init` and pressed enter left with nothing set up, and
the Quit row spent a third of the menu on the one thing every prompt
already offers through escape and ctrl+c. LLP 0211 said the ordering and
summaries should steer toward shared collection but that it must never
be preselected. That hedge is withdrawn: sync is what the product wants
a new user on, and the default should say so.

## Decision

<a id="two-rows"></a>**Two rows, sync first, sync the default.** The
title stays "How do you want to collect agent logs?" and the rows are:

1. `team`: **Sync to the cloud**, with the sign-in summary LLP 0211 gave
   the shared row.
2. `local`: **Local only**, with LLP 0211's boundary summary.

There is no Quit row. The TUI cursor starts on sync; the readline
fallback prints `default 1` and takes sync on a bare enter. Quitting is
escape or ctrl+c in the TUI, and any out-of-range answer in the
fallback, as before. The returning gate is untouched: it still lists
Quit and still defaults to it, because a bare enter there would re-open
a working install's wizard.

<a id="eof-quits"></a>**A stdin that cannot answer still quits.** The
fork's default now acts: it opens a sign-in. Under [LLP 0299
§eof-declines](./0299-confirm-prompts-default-to-yes.decision.md#eof-declines)
a spent stdin declines whatever default was printed, so the fallback
reads the asker's EOF `null` as quit instead of coalescing it into the
empty line. `hyp init` on a fresh machine with nobody at the terminal
still exits 0 having written nothing. LLP 0190 §eof-everywhere's
paragraph on the fork's `default 3` is superseded by this section; its
rule stands for every other prompt.

## Consequences

- LLP 0211's "never preselecting it" clause no longer holds.
- `docs/TEAM_SETUP.md` tells the reader to select Sync to the cloud; its
  screenshot still shows the old three-row menu until retaken.
