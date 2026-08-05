# LLP 0189: CLI severity is coloured at the stream, not at the write site

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Observability
**Author:** Brendan / Claude
**Date:** 2026-08-04
**Related:** LLP 0135 (install experience; the overview's colour rules and the never-colour-alone constraint), LLP 0153/0154 (the dispatch diagnostics this colours)

> The CLI encoded severity in a leading word (`error:`, `warning:`,
> `note:`) and nothing else: no diagnostic on any of ~250 write sites was
> ever coloured, while two components carried private `ANSI` maps of
> their own. This settles one palette for the whole CLI, one severity
> vocabulary, and one place the colour is applied - where `dispatch`
> binds stderr - so a run cannot be half-coloured and a new diagnostic
> cannot forget to opt in.

## Context {#context}

Three facts about the CLI before this document.

**Colour existed, but only inside two components.** The TUI frame builder
(`src/core/cli/tui/render.js`) and the query overview
(`src/core/query/overview.js`) each declared their own `ANSI` table and
their own `paint()`. The two tables disagreed - the TUI knew `red` and
`green`, the overview knew `magenta` - and neither knew `yellow`. The
only red in the product was a prompt's inline validation error.

**Everything else was plain.** Around 250 `stderr.write` calls across
`src/`, `bin/` and `hypaware-core/smoke/` (there are no `console.error`
calls) carried severity as a leading word and no colour at all. A failed
`hyp remote login` and a successful one printed in the same ink.

**The gate already existed and already had this bug written on it.**
`useColor()` in `src/core/cli/stdio.js` is the correct TTY + `NO_COLOR`
test, and its own comment records why it was extracted: commands that
reached for `isTty` directly did not honour `NO_COLOR`, "so the same run
could be half-coloured." It had two callers. The generalisation of that
complaint is the whole problem here - severity styling decided per write
site is severity styling that drifts.

## Decision {#decision}

Errors are red, warnings are yellow, informational asides are dim, and
the decision is made once.

### One palette {#palette}

`src/core/cli/style.js` owns the only `ANSI` table in the CLI, and
`render.js` and `overview.js` import it instead of declaring their own.
The table is a superset of what the two private tables held, so neither
component's output changes; adding `yellow` to a shared table is what
makes a warning colour expressible at all.

### Prefix-only, first-match rules {#rules}

A line's leading word selects a colour, and only that leading word is
painted:

| prefix | colour | reason |
| --- | --- | --- |
| `error:` (any case) | red | the failure vocabulary, including a thrown `Error:` message |
| `warning:` / `WARNING:` | yellow | includes the plugin-install broad-permission and unpinned-branch warnings |
| `note:`, `tip:`, `usage:` | dim | asides and syntax, subordinate to whatever prompted them |
| `hyp <cmd>:` | red | this CLI's spelling of the Unix `prog: msg` diagnostic |
| `… failed:` | red | the same shape without the `hyp` prefix (`daemon restart failed:`, `Joining failed:`) |
| leading whitespace | none | continuation lines belong to the diagnostic above |

Painting the prefix rather than the line is deliberate. Messages carry
paths, quoted config fragments and multi-line repair hints (LLP 0153,
LLP 0154); a fully red paragraph is harder to read than a plain one, and
prefix-only keeps the `NO_COLOR` output byte-identical to what shipped
before.

Two exclusions matter. A **cancellation is not an error**: `hyp init:
cancelled` exits non-zero because the user chose to stop, and red would
claim something broke, so the `hyp <cmd>:` rule refuses that one message.
And **colour is never the only encoding** - the leading word survives a
pipe, a monochrome terminal and a colour-blind reader, which is LLP 0135's
constraint on the overview bars applied to diagnostics.

### Applied where stderr is bound {#choke-point}

`dispatch()` resolves `opts.stderr ?? process.stderr` exactly once and
hands that binding to every command it runs, core and plugin alike. The
colouring wraps that one binding. Consequences:

- A new diagnostic anywhere in the CLI is coloured without its author
  doing anything, and a plugin's diagnostics are coloured without the
  plugin knowing this module exists.
- Output that is captured and replayed (the wizard tees stderr; `hyp
  plugin` buffers install warnings) is classified when it finally reaches
  the terminal, not at the site that buffered it.
- Tests and pipes inject non-TTY sinks, so they receive the stream
  untouched and every existing assertion on exact stderr text still holds.

The wrap is a `Proxy`, not a `{ write }` object, so `isTTY`, `columns`
and the rest of the stream surface survive it: `hyp plugin` gates its
confirmation prompt on `isTty(stderr)`, and a degraded stream would have
silently stopped it asking.

Two entrypoints bypass `dispatch` and wrap their own stderr the same way:
`bin/hypaware.js` (the `hyp: <message>` top-level catch, and the
`__smoke_internal` branch, which deliberately runs before the dispatcher
loads) and `hypaware-core/smoke/index.js`. Both also paint the smoke
verdict `FAIL` explicitly, since it is a verdict rather than a prefix any
rule recognises.

## Consequences {#consequences}

Two user-visible strings were reworded, because each wore a severity it
did not have and the rules would have mislabelled it:

- `hyp mcp: proxying stdio → …` is a successful startup banner wearing
  the diagnostic prefix. It is now `note: mcp proxying stdio → …`.
- `daemon: stop signal sent but daemon did not exit within 5s` is a
  failure (exit 1) wearing the `daemon:` status prefix its success lines
  use. It is now `hyp daemon stop: …`, matching every other daemon
  subcommand's errors.

The rules classify by leading word, so an unrecognised line is left
plain rather than guessed at. That is the intended failure mode: silence
over a wrong colour. The cost is that a diagnostic invented with a novel
prefix gets no colour until either it adopts the vocabulary or a rule is
added here.

The dev log mirror (`[hypaware:<component>] <LEVEL> …`, `logger.js`) is
deliberately not classified. It is structured dev telemetry with its own
severity field, not a user-facing diagnostic, and it matches no rule.

## Non-goals {#non-goals}

- No `FORCE_COLOR` or `HYP_COLOR` override. `useColor()` already settles
  the policy (TTY, and `NO_COLOR` vetoes), and a second knob would be a
  second place for the answer to drift.
- No colour on stdout. Stdout is the data channel - query rows, JSON,
  the MCP protocol stream - and belongs to whatever is reading it.
- No 256-colour or truecolour palette. The eight basic SGR codes render
  correctly against both light and dark terminal themes; specific RGB
  values do not.
