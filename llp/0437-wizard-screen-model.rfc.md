# LLP 0437: The wizard screen is a log plus a live region drawn from state

**Type:** RFC
**Status:** Draft
**Systems:** Onboarding, CLI
**Author:** Kenny / Claude
**Date:** 2026-09-24
**Supersedes:** LLP 0387, LLP 0412
**Extends:** LLP 0100 (#requirements R1a: the recap and `hyp sync` name the server as "HypAware Cloud" or its host, with no lookup pointer; see #server-name)
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

### Nothing writes while the live region is up {#one-writer}

A live region is scoped: a prompt or a wait (`withSpinner`) owns it for its
duration, draws everything that belongs to it (the menu, the spinner, the
sign-in URL above the spinner), and clears it on the way out, error or not.
Log lines are ordinary writes made between those scopes, when nothing is
live. The invariant is that nothing else writes while a scope is open, so
the rows the region counts are always the rows it drew.

This is lighter than routing every lane through events and a reducer, and it
is enough while each live element belongs to one wait or one prompt. Events
earn their place when a step needs live content that outlasts a single
wait, or two live elements at once.

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
is wrong.

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

Each question lane still states its answer, but as one checkmark line, and
it hands the line to the wizard instead of printing it. The wizard prints
the lines together, in lane order, just before it saves:

- what is recorded ("Recording Claude Code, Codex, and Claude Desktop"),
- where it goes ("Syncing all 3 to HypAware Cloud", naming the server as
  #server-name says and the rows the team sets, or "Everything stays on
  this machine" on a local run, printed only when every sink writes to
  local disk, since a reconfigure carries forward sinks the picker does
  not compose),
- the new-folder answer, with the command that flips it.

The sign-in step no longer prints its own "logs will sync to the server"
line, or the background service's partial "recording" line: the recap says
both. This supersedes LLP 0387 and LLP 0412, which governed that line. Re-running a lane replaces its
statement and drops the later lanes', so a back never leaves a stale one
on screen (#back).

The recap is the consent surface for what the save sets up, so it lands
before the checkpoint that guards the save (LLP 0341 #dead-surface): a
surface that dies while saying it cancels the run with nothing written.
For the same reason an express accept's new-folder answer is recorded after
the recap, not when the lane runs. An answer the user gave on screen is
still recorded at once (LLP 0341 #retained).

### Naming the server {#server-name}

The recap's sync line and `hyp sync`'s plan and result lines name the
destination the same way: "HypAware Cloud" for the built-in hosted server
(matched by origin, including its previous host), and any other server by
its host ("hyp.acme.dev"). Never a URL, for LLP 0100 R1a's reason: a
printed `https://` run autolinks to a service endpoint.

This extends LLP 0100 R1a for these surfaces. R1a names a server by its
configured target name and points at `hyp remote list` to map the name
back to a URL. A host needs no lookup, because it already says which server
it is, and the built-in's product name is what the user signed up to, where
its target name (`hyperparam`) is an internal key. So these lines carry no
lookup pointer. The wide `hyp remote login` lane is unchanged: it still
prints the target name and the lookup. When the wizard cannot tell which
server the machine enrolled with (no central sink, several, or an
unreadable layer), the line says "your team's server" rather than guess.

### Step counts live on menus {#headings}

"Step 2 of 4" helps while a menu is on screen and goes with it. A step that
leaves permanent lines (the sign-in, the finish) opens with a plain heading
instead ("Joining your team", "Finishing setup"), so the finished screen
never shows a count with gaps in it, and an express run, which shows no
menus, shows no counts at all.

### The finish step says each act once {#finish}

The finish step reports one line per act, by the names the user picked
from: the settings saved, each client attached with the one thing to do
next (restart its open sessions), the clients that got skills, and an
import only when it wrote rows or failed. Attended and scripted runs print
the same lines; the scan counts and file paths go to the spans. The one
difference is the closing summary, which only a scripted run prints: an
attended run has just watched each act happen.

### The close says only what is news {#first-look}

With nothing recorded yet, the first look prints nothing and there is no
upload offer: setup's closing line says nothing is recorded yet. The held
paragraph then speaks in the offer's place, since it is the only line on
that path naming `hyp sync` and the privacy review (LLP 0100 R1). With history,
the first look keeps its two tables, and the upload offer is `hyp sync`'s
own plan, which now reads as one line per destination ("Ready to upload
1,240 rows (the full history) to HypAware Cloud (automatic by
...)"), the exclude hint, the question, and one result line ("Uploaded
1,240 rows to ..."). `hyp sync` run by hand prints the same lines.

### Row accounting {#rows}

The runtime tracks the physical rows of the live region with
`countPhysicalRows`, re-read per frame against the current width, as the
prompt runtime does today. Because the live region is always the last thing
on screen and the runtime is its only writer, erasing it is always "move up
N rows, clear to end".

## Migration {#migration}

1. Extract the prompt runtime's frame bookkeeping into a live region
   (`src/core/cli/tui/live_region.js`: `draw(frame)` and `clear()`), and have
   the prompts use it. No behavior change. Committing lines to the log lands
   with its first user in step 2.
2. Build the spinner on the live region, with lines that live and die with
   it (`above`), and draw the sign-in URL above the login wait. This moves
   every live element of the join lane (the URL, and the sign-in, attach,
   and org-config waits) onto the one mechanism, and deletes the interim
   `clearFallback`.
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
- `src/core/remote/oidc_login.js` (the sign-in URL drawn above the wait)
- Ink's `<Static>` component, for the log/live split
