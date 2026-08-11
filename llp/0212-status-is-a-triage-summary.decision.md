# LLP 0212: `hyp status` is a triage summary; the inventory moves behind `--full`

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Observability
**Author:** Brendan / Claude
**Date:** 2026-08-11
**Related:** LLP 0031 (#status-provenance: the per-entry tags and drop section this relocates), LLP 0164 (#status-reads-it-from-the-status-file: the recent-clients line this promotes to the headline), LLP 0186 (#hyp-status-attention-needed-surface: the attention signal this generalizes), LLP 0188 (#never-silent: the sync/local-only split this compresses), LLP 0069 (R9: withheld-directory count), LLP 0100 (R9: the first-sync hold), LLP 0200 (the standing new-folder ask), LLP 0135 (#disclosure: what the block omits, it says), LLP 0189 (#palette: the colours the summary paints with)

> Narrows what [LLP 0031 §Status provenance](./0031-layered-config.decision.md#status-provenance),
> [LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md),
> [LLP 0186 §`hyp status` attention-needed surface](./0186-reconciler-refused-marker.design.md),
> and [LLP 0188](./0188-enrolled-default-sync-with-client-optout.decision.md)
> each required of `hyp status` *prose*: every fact they mandate survives, but
> the default screen carries only the ones that are true and actionable right
> now, and the exhaustive inventory each of them assumed moves to
> `hyp status --full`.

## Context {#context}

`hyp --help` states this command's job in one line: *"Start with `hyp status`
for whether this install is working."* On a joined machine with the bundled
plugin set it printed 50 lines, and that line was not what most of them
answered.

Every subsystem that landed a never-silent requirement landed it here, each
one correctly, and each one unaware of the others. The result was an
inventory: ten `active plugins` lines, a sink roster, a source roster, a
client roster, a nine-line client-action ledger of which six read `[done]`,
a 64-character config etag, two absolute paths, a raw byte count, and a
`datasets: 1`. All of it addressable elsewhere - `hyp plugin list`,
`hyp config show`, `hyp daemon status`, `hyp query status`, `hyp policy
list`, `hyp remote list` - and all of it printed unconditionally, whether or
not it was true of anything the reader needed to do.

The cost is not length, it is *dilution*. On the observed machine one real
problem (Claude Desktop enabled but not attached) appeared four times: as a
`clients` line, as an `attach` client action, as a `backfill` client action,
and as a diagnostic with its repair. Four mentions of one problem, inside
fifty lines of mostly-constant inventory, is a screen a human scans past.

## Decision {#decision}

`hyp status` renders a fixed-shape summary that answers, in order: **is it
healthy, is it recording, where does the data go, and what needs me.**

Everything else is reachable, unchanged, at `hyp status --full` (the exact
text surface that shipped before this document) and `hyp status --json`
(unchanged to the byte: no consumer's key moves).

### The summary's four rows {#rows}

One boxed block, one fixed label column, facts joined with `·`:

```
╭──────────────────────────────────────────────────────────────────────────╮
│ HypAware  healthy                                                        │
│ daemon    running (foreground, pid 32521)                                │
│ capture   Claude, Codex, OpenClaw, Claude Desktop (not attached), Hermes │
│ activity  claude/cli just now · 2,194 rows                               │
│ data      820 MB · 120-day retention · syncing to org                    │
╰──────────────────────────────────────────────────────────────────────────╯

  warning  '@hypaware/claude-desktop' is enabled but claude-desktop settings
           show no HypAware marker
           → hyp claude-desktop install
  note     plugins.@hypaware/ai-gateway in your local config is not applied
           (collides with central)

hyp status --full for the full inventory, --json for everything
```

A client carries its own exceptions inline, so one client is one mention.
The screen above replaces fifty lines in which that same Claude Desktop
problem appeared four times.

`activity` is the row the others are proxies for. Attach state predicts
capture; rows landing *is* capture, and
[LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md)
already put that answer in the status file at no query cost. It is promoted
out of a trailing section into the summary, and a machine that has recorded
nothing says so there rather than by the absence of a section.

The block is framed with the shared `boxed()` (LLP 0135 §disclosure): the
frame is a shape, not a colour, so it survives `NO_COLOR`.

### The summary wraps itself {#width}

A framed block must wrap its own content, and the label gutter must hang.
Both follow from the same fact: the terminal's wrap happens *after* the
renderer has placed the right-hand edge, so a row one column too long does
not produce a taller box, it produces a staircase - and a soft-wrapped
continuation restarts at column zero, under the label instead of under the
text it continues.

So the renderer takes a width (`stdout.columns`, else `COLUMNS`, else 80),
subtracts the frame and the gutter, and wraps every row and every attention
message to what is left, hanging continuations in the value column. A token
longer than the column (a path, an etag) is broken rather than allowed to
push the frame open. Below 34 columns the frame is dropped and the gutter
layout stands on its own.

**80, not "unbounded", is the answer when the stream will not say.** A
status screen is pasted into chat, piped into a pager, and captured in CI
logs at least as often as it is read on a wide terminal, and a block laid
out for infinity breaks in all three.

### What needs me {#attention}

Below the block, and only when non-empty:

- diagnostics, with their repair lines (unchanged from before);
- client actions in `failed` or `refused` state, with the re-arm hint
  [LLP 0186](./0186-reconciler-refused-marker.design.md) settled;
- local config entries dropped at merge, with their reason
  ([LLP 0031](./0031-layered-config.decision.md#status-provenance));
- a live first-sync hold and its deadline ([LLP 0100](./0100-enrollment-privacy-review.spec.md) R9).

`pending` client actions are **not** attention. A pending action is the
reconciler working as designed; when one is genuinely stuck it has a
diagnostic, a `failed`, or a `refused` marker, and those are the states
LLP 0186 gave a rendering to. Six `[done]` lines and a `[pending]` line are a
ledger, and a ledger belongs in `--full`.

### The never-silent facts, under a summary {#never-silent}

A fact mandated as never-silent is rendered **when it is true**, not
unconditionally. The distinction the earlier documents did not need to draw,
because nothing was conditional then, is between a *state with data
consequences* and the *default that state departs from*:

| Fact | In the summary |
| --- | --- |
| Local-only clients (LLP 0188) | Marked `(local only)` inline on the `capture` row, beside the client it applies to |
| Unattached configured clients | Marked `(not attached)` inline on the same row; the repair is stated once, in attention |
| Withheld directories (LLP 0069 R9) | `data` row, whenever the count is non-zero |
| Where rows go (LLP 0188) | `data` row, always, in both directions: `syncing to org` or `stays on this machine` |
| Centrally managed (LLP 0031) | Implied by that same phrase: the one thing the per-entry tags exist to tell a reader |
| Per-entry `[central · locked]` / `[local]` tags (LLP 0031) | `--full` and `--json` |
| Dropped local entries (LLP 0031) | Attention section, whenever any exist |
| Convergence / probation / running etag (LLP 0031, LLP 0025) | `--full` and `--json`; a rollback (its own diagnostic) or a rejected etag is attention |
| Refused / failed client action (LLP 0186) | Attention section, with the re-arm command |
| First-sync hold (LLP 0100 R9) | Attention section while live |
| New-folder ask (LLP 0200) | `data` row, only when set to `ask`; `sync` is the default and departs from nothing |
| Diagnostic `kind` strings | `--full` and `--json`; the summary prints the sentence, not the identifier |

The rule generalizes: **the summary states a fact when a reader could act on
it, and the default it departs from is stated by the absence.** `hyp status
--full` remains the surface where every fact is stated unconditionally, and
`--json` remains the surface where every fact is stated in a fixed shape - so
"never silent" continues to hold across the command, which is the level the
requirement was ever about.

## Consequences {#consequences}

- `renderStatusText` becomes the summary; the previous body is preserved
  verbatim as `renderStatusFull` and reached with `hyp status --full`. Tests
  asserting inventory lines assert them against `renderStatusFull`.
- `renderStatusJson` is untouched. No key moves, nothing is dropped, and
  `--json` stays the contract for machine consumers and for anything the
  summary elides.
- A reader who wants an inventory is one flag away, and the command's own
  help says so on the summary's last line.
- Three collector diagnostics stop embedding their own repair command in
  their `message` (`client_attach_missing`, `client_attach_stale`,
  `client_attached_not_configured`). The `repair` field carries it, and both
  text surfaces render that field, so the embedded copy only ever printed the
  same command twice on one screen.
- The four-mentions-of-one-problem shape is gone by construction: a client
  that is enabled and not attached is named inline on `capture`, and its
  repair is named once, in the attention section.
- Future never-silent requirements land in the table above. A new one that
  cannot state a condition under which it is *not* interesting belongs in
  `--full`, not in the summary.
