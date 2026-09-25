# LLP 0435: The wizard screen is a log plus a live region drawn from state

**Type:** RFC
**Status:** Draft
**Systems:** Onboarding, CLI
**Author:** Kenny / Claude
**Date:** 2026-09-24
**Related:** LLP 0188 (#never-silent: the wizard is a consent surface),
LLP 0341 (#context: stdout is that surface; the guarded streams),
LLP 0387 (#adjacency: compact lines that must sit next to each other),
LLP 0191 (back-navigation), LLP 0135 (the wizard's lane machine)

> What the wizard leaves on screen is an accident of which primitive each
> step used. Prompts erase themselves (`clearOnResolve`), the spinner erases
> its own row, and every other line stays forever. This RFC proposes one
> model: the screen is an append-only log above a live region, and the live
> region is a pure function of the current step's state. A line is durable
> because the step committed it to the log, never because it happened to be
> printed.

## Motivation {#motivation}

The prompt menu is already state-driven: `tui/runtime.js` reduces key
presses into a `State`, `render(state)` turns it into a frame, and the
runtime redraws the frame in place. Nothing between the prompts works that
way. Lanes print directly, sometimes to stdout and sometimes to stderr, and
nothing tracks those lines.

The symptom that started this: after a successful sign-in in the join
lane, the fallback sign-in URL stayed on screen above the next step, reading
as a step still waiting on the user. The interim fix (`clearFallback` in
`src/core/remote/oidc_login.js`) counts the rows it printed and erases them.
It works, but it is a one-off, and it first shipped erasing through stdout
lines the login lane had printed on stderr. Each further case would be
another one-off.

## Design {#design}

### Two regions {#regions}

- **Log.** Append-only lines above the live region. Once written, a log line
  is never redrawn or erased. Results and consent statements live here:
  "Signed in", "Recording Claude", the privacy block, the finale.
- **Live region.** The bottom of the screen, redrawn from state on every
  change. Prompts, spinners, fallback URLs, hints, and progress live here.
  When a step ends, the live region is cleared, and anything the step wants
  kept it commits to the log first.

This is the split Ink draws between `<Static>` and the dynamic tree, without
React: a render function per step, a reducer per step, and one runtime that
owns the terminal.

### Consent lines go to the log {#consent-in-log}

A statement that is part of the consent surface (LLP 0188, LLP 0341) is
committed to the log before the act it covers, never drawn in the live
region. Clearing a live region must never erase something the user agreed
on the basis of. Lines that LLP 0387 requires to be adjacent are committed
together, in order, so nothing can land between them.

### One writer {#one-writer}

Only the runtime writes to the terminal. Lanes that print today (the login
lane, the attach wait, sync) report events instead: `url_ready`,
`waiting`, `signed_in`, `failed`. The step's reducer turns events into
state, and the runtime decides what that means on screen. A lane's
standalone command (`hyp remote login` run directly) keeps its own plain
printer over the same events.

### The live region is stdout only {#streams}

The live region is drawn on stdout and nowhere else, because it is the only
thing ever erased, and an erase is safe only when every row it moves over
was written to the same stream. Log lines are never erased, so they may go
to either stream, and the LLP 0341 split stands unchanged: stdout carries
the consent surface and its death cancels the run (#dead-surface); stderr
carries warnings and its death never does (#warnings).

To show a warning, the runtime clears the live region, writes the warning
to stderr, and redraws the live region below it. With stderr redirected,
the warning goes to the file, the screen simply lacks it, and no row count
is wrong. The interim `clearFallback` follows this: the compact login lane
draws its fallback URL on stdout, the stream it later erases through.

### Off an interactive terminal {#non-tty}

Off a TTY, under `HYP_NO_TUI=1`, or with no reported width, nothing is
redrawn or erased. Log lines print as they are committed. A live element
prints once, as plain text, when it first appears, and later state changes
to it print nothing. Prompts fall back to the existing readline paths. The
goal is that today's scripted transcripts stay byte-stable through the
migration, so every step can be moved over without rewriting the smoke
expectations.

### Back-navigation leaves the log alone {#back}

The log stays append-only, including across a back (LLP 0191). This needs
no rollback because every screen a back can reach is a question screen
before the commit point (LLP 0191 #back-edges), and a question screen
commits nothing to the log: its answer lives in state, and the
re-presented screen re-states it (#re-entry-seeding). The one lane that
commits before the commit point is the join, and its line stays because
the join itself cannot be undone (LLP 0191 #join-not-undone).

### The commit point writes a recap {#recap}

Because answered questions leave nothing in the log, a finished run would
otherwise show no record of what the user chose. When the wizard commits
the config (LLP 0190 #commit-point), it commits one short recap line of
the answers, for example "Collecting Claude and Codex, syncing to your
team." It is written there and not per answer so that a back never leaves
a stale line behind (#back). It states what was saved, so it sits with
LLP 0391's rule that the wizard states results, not plans.

### Row accounting {#rows}

The runtime tracks the physical rows of the live region with
`countPhysicalRows`, re-read per frame against the current width, as the
prompt runtime does today. Because the live region is always the last thing
on screen and the runtime is its only writer, erasing it is always "move up
N rows, clear to end".

## Migration {#migration}

1. Extract the prompt runtime's frame bookkeeping into a screen runtime with
   `commit(lines)` and `render(frame)`, and have the prompts use it. No
   behavior change.
2. Move the join lane first: the login lane emits events, the join step
   renders the URL and spinner in the live region, and commits "Signed in".
   Delete `clearFallback`.
3. Move the remaining steps one at a time, largest print surface first.

## Known limits {#limits}

**A resize can smear the live region.** Narrowing the terminal re-wraps
rows already drawn, so the row count taken at the old width can be wrong
and one erase can leave a partial copy of the frame behind. The prompt
runtime has the same exposure today. Accepted rather than engineered
around: a setup run is short, and the smear is cosmetic. It stays above
the live region and never changes what the log says.

## References {#references}

- `src/core/cli/tui/runtime.js` (the existing reducer/render/redraw loop)
- `src/core/cli/spinner.js` (a single-row live element)
- `src/core/remote/oidc_login.js` (`clearFallback`, the interim fix)
- Ink's `<Static>` component, for the log/live split
