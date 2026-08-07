# LLP 0198: Setup ends by handing the user a question, and can start it for them

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI, Plugins
**Author:** Brendan / Claude
**Date:** 2026-08-06
**Related:** LLP 0135 (#first-look, #privacy, #finale: the closing sequence this appends to), LLP 0130 (#picker-block: manifest-contributed picker rows, the pattern the launch spec follows), LLP 0180 (client derivation from `contributes.client`), LLP 0107 (#gating: the skills that make these questions answerable ride attach), LLP 0011 (#no-architectural-names: the user asks in their own words)

> Extends the closing sequence of [LLP 0135](./0135-install-experience-overhaul.design.md).
> What setup writes, attaches, and narrates is untouched. What changes is
> the last screen: setup now offers a short list of questions worth
> asking of the data it just captured, and can start the user's client on
> the chosen one rather than printing a command to copy.

## Context {#context}

[LLP 0135 #first-look](./0135-install-experience-overhaul.design.md#first-look)
replaced setup's closing hint (`next: hyp query sql 'select count(*) from
logs'`, a command that failed on most installs) with the shared overview:
setup ends on the user's own rows instead of on homework. That fixed the
proof-of-life problem and left a second one standing.

The overview proves HypAware recorded something. It does not teach what
HypAware is *for*. A user finishing setup has just had ten helper skills
installed into `~/.claude/skills` ([LLP 0107](./0107-skills-ride-attach.decision.md))
and has no idea any of them exist: the finale reports `skills: 10 copied`,
which names a file operation, not a capability. The product's whole
proposition - ask your own AI client about your own AI history - is
reachable only by a user who already knows to try it.

The gap is not information. It is activation. Printing example
prompts would leave the user to open a second terminal, start a client,
and retype one; the drop-off across those three steps is the entire
distance between "installed" and "used".

Both first-party CLI clients accept the opening prompt as argv and start
interactively on it (`claude [options] [prompt]`, `codex [OPTIONS]
[PROMPT]`), so the distance is closable: setup can *be* the launcher.

## Decision {#decision}

<a id="first-ask"></a>**Setup closes on a question list, and the list is
live.** After the first look and the privacy narration, an attended run
renders a select of the suggested questions plus "Not now". Choosing one
starts the user's own client on that question. This step is named the
**first ask**, paired with the first look: the look proves there are rows,
the ask spends them.

Ordering is deliberate and the privacy narration keeps its position
([LLP 0135 #privacy](./0135-install-experience-overhaul.design.md#privacy):
it "stays the last thing on screen"). The first ask is not a sixth
paragraph of output competing with it; it is the exit door. The narration
remains the last thing HypAware *says*, and the ask is what the user does
next. An enrolled run therefore reads: rows, then what leaves this machine
and when, then a question.

<a id="frame"></a>**The ask is drawn as its own screen.** The prompt is
framed in a border (`box`, `cli/tui/types.d.ts`), which no other wizard
prompt is. The step's position is what makes it necessary: every other
prompt arrives on a screen of its own with nothing above it, while this one
lands at the bottom of a long scroll, under the first look's tables, rules
and dim footers. An unframed list of plain sentences there reads as more
output to skim past rather than as the one thing still waiting for a
keypress, and the step's whole purpose is that the user presses a key.

The border is dim and the content inside keeps the emphasis it already had:
the frame's job is separation, not competition with the bold title or the
cyan cursor row. It is a shape rather than a colour, so it survives
`NO_COLOR` and a colour-blind reader
([LLP 0135 #disclosure](./0135-install-experience-overhaul.design.md#disclosure)),
and it is suppressed rather than soft-wrapped when it would be wider than
the terminal - a broken rectangle is worse than no rectangle. The shape
lives in `cli/style.js` beside the palette, on the same one-place grounds
([LLP 0189 #palette](./0189-cli-severity-colour.decision.md#palette)), so a
second framed block cannot invent a second frame.

<a id="real-launch"></a>**The launch is a real launch, not a hint.** The
chosen client is spawned with the prompt as argv and `stdio: 'inherit'`,
so it takes the terminal and draws its own UI. Copy-paste is the failure
mode being removed; a "here is a command you could run" screen would be
the old `next:` hint with more words.

Three constraints follow from inheriting a live terminal, and each one is
load-bearing:

- **The prompt chrome must be fully unwound before the spawn.** The TUI
  runtime (`cli/tui/runtime.js`) sets raw mode and hides the cursor, and
  restores both in `cleanup()` on every exit path. The first ask spawns
  only after `select()` has resolved, never from inside a reducer, so the
  child inherits a terminal in its original mode. A child that inherits
  raw mode renders as a client that "opens broken".
- **The wizard keeps its own exit code.** `hyp init` exits on whether
  *setup* succeeded. The child's exit code is not propagated: a user who
  quits the client with ctrl+c has not failed an install, and reporting
  that as a non-zero `hyp init` would be a false claim about durable
  state that was written minutes earlier.
- **The step can never fail a finished install.** Same rule as the first
  look, for the same reason: every durable action already succeeded. A
  missing binary, a spawn error, a cancelled prompt, an unforeseen throw -
  each degrades to the printed list, never to a stack trace over a
  successful setup. The step is attended-only on the same terms as the
  first look, so a `--yes` or `--dry-run` install prints nothing new; the
  non-TTY path exists for `hyp ask` (#re-runnable), where a piped run
  prints the list rather than prompting.

<a id="path-probe"></a>**Launchability is a PATH probe, and it is a
different question from detection.** `detectPickerSources`
(`cli/detect.js`) answers "is this client installed here" from settings
files and app bundles ([LLP 0135 #detection](./0135-install-experience-overhaul.design.md#detection)).
That is the right probe for the picker and the wrong one here: a settings
file at `~/.claude/settings.json` does not imply a `claude` on `$PATH`,
and Claude Desktop is detectable, pickable, attachable, and cannot be
started on a question at all - it is a GUI app with no prompt argument.

The first ask therefore probes `$PATH` directly for the launch binary of
each *picked* client, and offers only what both was picked and resolves.
The two conditions are both required: an unpicked client is one HypAware
is not recording, so opening it would produce a session the user did not
consent to capture, and a picked client with no binary cannot be started.

<a id="split"></a>**Core owns the questions; the manifest owns the
launch.** The prompts are questions about HypAware's own datasets -
what was recorded, what it cost, what was sensitive - and they are
identical whichever client answers them, so they live in core beside the
datasets they interrogate. What differs per client is only *how to start
it on a question*, which is a fact about that client, and belongs where
every other client fact already lives: `contributes.client`, as a
`launch` block ([LLP 0130 #picker-block](./0130-declarative-picker-descriptors.decision.md#picker-block)
applied to a new field). A future adapter becomes launchable by declaring
`launch`, with no edit to core - the same rule [LLP 0180](./0180-finale-attaches-openclaw.decision.md)
established for the finale's client list.

The launch block is `{ bin, args }`, where exactly one `args` element
must contain the `{prompt}` placeholder. The validation is not ceremony:
a launch spec that drops the placeholder starts the client with no
question, which looks like the feature working and silently isn't. A
malformed block makes the client unlaunchable rather than launchable and
mute.

<a id="wizard-sections"></a>**Setup runs two of the first look's four
sections; `hyp query overview` still runs all four.** This takes up
[LLP 0135 #first-look](./0135-install-experience-overhaul.design.md#first-look)'s
own offer - "the seam for a shorter variant remains if setup output ever
needs trimming" - and reverses its judgment that showing all four was
right. Both halves of the cost turned out to be real on a working cache:

- **Space.** Four sections run ~60 lines. The block is now followed by
  the privacy narration *and* the first ask, so setup's tail is a wall to
  scroll past at exactly the moment the user is finally being handed
  something to do. 0135 argued the narration survives because it comes
  after; that was right about the narration and wrong about the reader.
- **Time.** The sections run sequentially. On a 91k-row cache the four
  took ~5s against a planner that budgeted ~2s for them, so setup
  routinely printed *"Stopped here to keep setup moving - the repos and
  tools sections did not finish"*. A block that regularly announces its
  own truncation is worse than a shorter block that finishes.

**Models and daily are the pair that survives**, because they are the two
that answer *did it work*: which models this machine talks to, and that
the traffic landed on real days. Repos and tools are the more
interesting half, and interesting is what the on-demand command is for.

Two consequences the trim must not get wrong:

- **A section nobody requested is never called unfinished.**
  `collectOverview` stamps the requested set on the result before its
  first await, and `missingSections` reads that stamp, so an expired
  deadline names only sections that were actually started. Stamping
  rather than passing the set at the call site is what makes an
  *abandoned* run answer correctly: when the deadline fires the caller
  holds only the partial result, and the plan has to have travelled on
  it. Without this the trim would make setup claim repos and tools "did
  not finish" on every single run.
- **The pointer line states an upgrade, not a repeat.** "See more
  anytime: `hyp query overview` (adds repos and tools)" - because a
  trimmed block under a line that says "see this again" teaches the user
  that what they just saw is all there is.

The trim only pays off because the planner charges for the sections it
will actually run: `rowsAffordable` divides the budget by the requested
count, not by all four
([LLP 0135 #window](./0135-install-experience-overhaul.design.md#window)).
Were it still charging four, asking for two would buy a window half the
size the budget allows and truncate more, not less.

The deadline is untouched. It stays a backstop for a mis-measured plan,
not the mechanism, and the planner's `SECTION_COST_VS_PROBE` is still
calibrated against an older, narrower measurement - a separate defect
this decision does not fix, only stops routinely tripping over.

<a id="empty-cache"></a>**An empty cache suppresses the launch, and says
why.** Every suggested question is about recorded history. On a fresh
install with nothing to backfill - the ordinary case for someone new to
Claude or Codex - launching one spends the user's single first impression
on an empty answer, and teaches them the tool does not work at the exact
moment they were about to find out that it does. So a cache with no rows
gets the list as text, prefaced by the fact that makes the emptiness
legible: **capture starts now, not retroactively.**

The signal is free in the wizard: the first look ran immediately before,
and its result already distinguishes the cases. `hyp ask` establishes it
with the overview's own probe, which is the cheapest statement that
answers the question and is already what the block opens with.

Three outcomes, and collapsing any two of them would be the bug:

- **A definite no** (no gateway dataset, or a rendered block with zero
  rows in both counted sections) suppresses the launch.
- **A definite yes** includes the first look's `slow` outcome, which
  means the opposite of empty: the block was abandoned precisely because
  summarizing this much history would have held up setup.
- **Unknown** (the query failed, no runner is available) never withholds
  the offer. A launch against a cache that turns out to be full costs
  nothing; suppressing one against a cache that was merely unreadable
  silently removes the feature.

`hyp ask "<question>"` is exempt. A named question is not one of the
suggested set and may be about anything, so the row check does not gate it - the
user asked for a specific thing, and answering "you have no history" to
a question that never assumed any would be the tool talking past them.

<a id="no-preauth"></a>**The launched session is not pre-authorized.**
The client will ask its own permission the first time the skill runs
`hyp query`, and that prompt stands. HypAware does not pass
`--allowedTools`, `--dangerously-skip-permissions`, or any equivalent.
A tool whose pitch is "see what your AI clients are doing" must not open
its first session by quietly widening what one of them may do.

<a id="re-runnable"></a>**The list is re-runnable as `hyp ask`.** Every
other closing surface names a durable entry point - the first look prints
"See this again anytime: hyp query overview" - and a menu reachable only
by re-running `hyp init` would be the exception. `hyp ask` renders the
same list against the same probe, and `hyp ask "<question>"` skips the
menu and launches directly.

## Consequences {#consequences}

The prompts are a curriculum, and a short one. They are chosen to
each land on a different installed skill and a different dataset, so a
user who runs two of them has seen most of the surface: session history,
token cost, tool usage, error patterns, and the privacy audit. They are
phrased as a user would phrase them, not as skill invocations
([LLP 0011 #no-architectural-names](./0011-setup-and-onboarding.decision.md#no-architectural-names)) -
the skills' own descriptions do the routing.

A launched session is itself recorded through the gateway the finale just
restarted, so the user's first question becomes their second data point.
This is a pleasant accident rather than a design goal, and it is not
narrated: setup claiming credit for capturing the session it just started
would read as a boast at the moment the user is finally doing something.

`hyp ask` is a new top-level verb in an already-broad surface. It earns
the slot by being the only one that is about *starting* rather than
inspecting or configuring; it is the verb a user runs when they have
HypAware installed and have forgotten what to do with it.

## Telemetry

`wizard.first_ask` span: `launcher_count`, `client`, `prompt_id`,
`launched`, and `status` (`ok` / `skipped` / `error`) with `skip_reason`
distinguishing `no-rows`, `no-launcher`, `not-interactive`, and
`declined`. `no-rows` is the one worth watching on its own: a high rate
says installs are finishing with nothing captured, which is a backfill
problem wearing a first-ask costume. The
distribution across those reasons is the measurement that says whether
the step is reaching anyone; `prompt_id` says which question people
actually pick, which is what would justify changing the set.
