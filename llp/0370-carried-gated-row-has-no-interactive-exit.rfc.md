# LLP 0370: A platform-gated row the config already collects has no interactive exit

**Type:** RFC
**Status:** Draft
**Systems:** Onboarding, CLI, Plugins
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-03
**Related:** [LLP 0368](./0368-picker-rows-declare-their-platforms.decision.md)
(#platform-gate the gate this extends, #display-only the sentence that makes
the carry unconditional), [LLP 0202](./0202-hidden-picker-rows.decision.md)
(#hidden-rows the single display filter, #carry-through the rule the gate was
keyed onto), [LLP 0276](./0276-hidden-rows-stay-off-the-sync-gate.decision.md)
(#no-candidates the precedent for telling the truth about a row without naming
it), [LLP 0289](./0289-sync-lane-asks-the-store-about-hidden-picks.decision.md)
(#ask-the-store "the lane prints no hidden row", stated of the sync-scope lane
but the sharpest wording of the naming rule every narration option below has to
price),
[LLP 0297](./0297-claude-desktop-leaves-onboarding.decision.md)
(#own-plugins the non-derivative read-back that makes the carry unconditional),
[LLP 0011](./0011-setup-and-onboarding.decision.md) (#autodetect-vs-default a probe never
forces), hyparam/hypaware#1296, PR #1290, PR #1303

> LLP 0368 gave a picker row a `platforms` gate and routed it through the one
> display filter `hidden` already used, so a config that collects a gated row
> survives a reconfigure on the platform that withholds it. That carry is
> unconditional and silent. On Linux a config that reads the Desktop row back
> (every plugin of its `compose` block present, so `@hypaware/claude` as well
> as `@hypaware/claude-desktop`) therefore rides through every interactive
> `hyp init`: the row never renders, no screen says it was kept, and no answer
> the user can give at the menu removes it. Unchecking every row still writes
> it, and still writes `@hypaware/claude` with it, because that plugin is a
> rider on the Desktop row's `compose` block. The gap is real and reproduces on
> `origin/master`, but its fix is foreclosed in both directions by settled
> text: narration is foreclosed by LLP 0289's "the lane prints no hidden row",
> and removal by LLP 0368 #display-only's carry, which an `@ref`ed test pins.
> This document states the gap, carries the reproduction, and lays out the
> option space. It decides nothing.

## Context {#context}

[LLP 0368](./0368-picker-rows-declare-their-platforms.decision.md#platform-gate)
lets a `contributes.picker` row name the platforms it is offered on, and
`@hypaware/claude-desktop` declares `"platforms": ["darwin"]`. #display-only
settles what the gate is: "exactly what `hidden` gates and nothing further:
the single display filter `visiblePickerDescriptors`". It then names the one
place where withholding an offer and refusing a choice come apart, the pick
lane's carry-through, and keys the carry on what the display filter withheld
rather than on `hidden` itself, so that "walking the menu again on Linux"
cannot "silently un-compose a `--source claude-desktop` install".

That carry is [LLP 0202 #carry-through](./0202-hidden-picker-rows.decision.md#carry-through)
as widened by [LLP 0297 #own-plugins](./0297-claude-desktop-leaves-onboarding.decision.md):
a config-seeded withheld row carries whatever else is checked when it reads
back off plugins only it composes. `claude-desktop` is exactly that row, so on
Linux the config branch is unconditional: `readsBackFromOwnPlugins` is true, so
the `!seededVisible` half never gets a say
(`src/core/cli/wizard/pick.js`, `resolvePickSeeding`). `promptPickSelection`
then returns `[...new Set([...picked, ...carried])]`, and nothing between the
menu and the write mentions the carried half.

The three surrounding decisions all point the same way about naming such a row.
LLP 0202 #hidden-rows makes it "absent from the interactive menu and from the
defaults gate"; [LLP 0276](./0276-hidden-rows-stay-off-the-sync-gate.decision.md)
widens that to "absent from every wizard screen" and passes the sync lane
*counts* so it "can tell the truth about them without being able to name them";
[LLP 0289 #ask-the-store](./0289-sync-lane-asks-the-store-about-hidden-picks.decision.md)
turns those counts into ids for a store lookup and restates the boundary
exactly: "naming them is what stays forbidden: the lane prints no hidden row".

## The problem {#problem}

Reproduced against `origin/master` at `57438f44`, driving the real
`runWizardPick` over the real bundled catalog with `platform: 'linux'`, a
seeded config collecting `@hypaware/ai-gateway`, `@hypaware/claude` and
`@hypaware/claude-desktop`, and detection returning nothing:

```
--- user checked: ["claude"]
menu rows        : ["claude","codex","opencode","otel","hermes","openclaw"]
sourcesPicked    : ["claude","claude-desktop"]
plugins written  : ["@hypaware/ai-gateway","@hypaware/claude","@hypaware/claude-desktop",
                    "@hypaware/ai-gateway-graph","@hypaware/context-graph"]
stdout mentions Desktop: false
stderr mentions Desktop: false
stdout:
  | Backed up existing config to .../hypaware-config.json.bak-...
--- user checked: []
menu rows        : ["claude","codex","opencode","otel","hermes","openclaw"]
sourcesPicked    : ["claude-desktop"]
plugins written  : ["@hypaware/ai-gateway","@hypaware/claude","@hypaware/claude-desktop",
                    "@hypaware/ai-gateway-graph","@hypaware/context-graph"]
stdout mentions Desktop: false
stderr mentions Desktop: false
```

Three separate facts sit in that transcript.

1. **The row is unremovable from the menu.** There is no answer to the one
   question the lane asks that drops `claude-desktop`, because the row is not
   among the options. The empty selection is the strongest statement the menu
   can make and it composes the row anyway.
2. **Nothing says so.** The only line the lane prints is the config backup.
   A user who has just unchecked everything is shown a run that reports
   nothing and writes two capture plugins.
3. **The carry drags a rider.** `@hypaware/claude` is not residue from the old
   config: it is the first entry of the Desktop row's `compose.plugins`
   (`hypaware-core/plugins-workspace/claude-desktop/hypaware.plugin.json`), so
   the fold composes it fresh from the carried id. That plugin's `activate`
   registers the Claude Code OTLP listener source and the five-minute
   transcript backfill, neither of which is macOS-shaped. So on Linux the
   carried row keeps live Claude Code capture composed across an explicit
   uncheck of the Claude Code row.

Point 3 is the one that moves this above the severity #1296 recorded. That
issue verified the *Desktop half* is inert on Linux, which holds: the Desktop
commands refuse off darwin (LLP 0139 #macos-only) and the Desktop transcript
roots cannot exist. What is not inert is the rider. LLP 0202 #carry-through
names the guarantee at stake in its own words, "unchecking a row removes its
upstream", and offers that guarantee as the reason the carry may not rest on
seeding alone. Here the carry does not rest on seeding alone (the read-back is
non-derivative, exactly as LLP 0297 requires) and the guarantee breaks anyway,
through a compose rider rather than through a shared gateway upstream.

**The escape that exists.** A non-interactive recompose does drop the row,
because `opts.picks` bypasses the seeding lane entirely. It needs `--force`:

```
hyp init --source claude                 -> exit 1, config untouched
hyp init --force --source claude         -> exit 0, @hypaware/claude-desktop gone
```

That is a real exit and it is undocumented as one. `--force` also backs up and
overwrites the whole config rather than editing one entry, so the user has to
restate every other answer the config holds on the same command line.

## Why it is not a patch {#not-a-patch}

Both branches of #1296's acceptance condition land on settled text.

**Narrating the carried row** contradicts LLP 0289 #ask-the-store's "the lane
prints no hidden row" and LLP 0276's widening of LLP 0202 #hidden-rows to
"absent from every wizard screen". Narrating only the *gated* subset costs
something further and more specific: LLP 0368 #display-only says the gate gates
"exactly what `hidden` gates and nothing further", and argues that routing
through one filter rather than adding a second "carries two things for free".
A narration that fires for a gated row and not a hidden one is precisely the
second classification that section declined, and `carried` is currently a flat
`string[]` with no memory of why each id was withheld.

**Offering a way to drop it** contradicts the carry itself. LLP 0368
#display-only's whole argument for keying the carry on the display filter is
that dropping the row on a menu walk refuses a choice rather than withholding
an offer: "The gate withholds an offer, it does not refuse a choice", and the
drop on a menu walk is "the choice refused that this section says the gate does
not do". The behavior is pinned by a test that cites the section:

```
test('runWizardPick: a Linux reconfigure carries the configured claude-desktop it cannot offer', ...)
// @ref LLP 0368#display-only [tests]: the gate withholds the offer, so the
// choice already recorded must outlive a menu walk on Linux
```

Any drop path has to say how the user's *removal* is distinguished from the
menu's *inability to offer*, which is a question LLP 0368 answered by making
them indistinguishable. That is the design question this document exists to
put, and it is not answerable inside a review fix.

## Option space {#options}

The two halves are separable and can be decided independently: a narration
answers point 2 above, a drop path answers point 1, and either one answers
point 3 partially.

### Narration {#narration-options}

**N1. Name the carried row.** One line before or after the menu: "Kept from
your existing config: Claude Desktop (not available on this platform)". Costs:
supersedes LLP 0289 #ask-the-store's naming rule and LLP 0276's widening, for
every withheld row or for a gated subset that LLP 0368 declined to create.
Buys: the only option that tells the user which row, which is what makes the
`--force` escape usable without reading the config file. Note the naming rule
was argued for rows the user *never chose* (the raw gateway rows: over
disclosure of a menu decision). A row the user's own config records is the case
that argument does not cover, which is the strongest reason to think the rule
should split.

**N2. Count, not name.** "One capture source in your config is not available
on this platform and was kept." Costs: a user who does not know which row it is
still cannot act on the line, so it converts a silent surprise into a visible
one without buying an exit. Buys: it is exactly the LLP 0276 #no-candidates
shape, already precedented, and needs no supersession of the naming rule.

**N3. Narrate only what changed.** Say nothing when the carry preserves the
config unchanged, and print only when the carry contradicts the answer just
given (the empty selection that still writes two plugins). Costs: needs a
comparison the lane does not compute today, and it is silent in exactly the
common case where the user might want to know. Buys: the line fires only where
the run is otherwise actively misleading.

**N4. Nothing.** Costs: point 2 stands. Buys: no settled text is reopened.

### A drop path {#removal-options}

**R1. Render the carried row, checked, with a gate suffix.** A gated row
renders when and only when the config already collects it, checked, labelled
"unavailable on this platform", so unchecking removes it. Costs: LLP 0368
#display-only becomes "display-only, except that a configured gated row is
shown", so the gate is no longer exactly what `hidden` gates; the pinned test
above inverts; and the row is then a live checkbox whose *checked* state
composes a plugin that cannot work here, which is close to the dead-end offer
the gate exists to remove. Buys: it reuses the menu the user is already
looking at, needs no new screen or step counter change (LLP 0191 #back-edges),
and the "unchecking a row removes its upstream" guarantee comes back for the
rider in point 3.

**R2. A separate confirm.** A `noQuestion`-style one-line confirm, shown only
when a gated row is carried: "Your config records Claude Desktop, which this
platform cannot capture. Keep it?". Costs: a new wizard screen, so a step in
the counter and a back edge (LLP 0191); and it asks a question whose default
must be Keep, or a stray enter deletes a macOS user's Desktop setup on a Linux
box they were only trying out. Buys: keep and drop are then distinct answers,
so nothing has to be inferred from an absent checkbox.

**R3. Put the exit outside the wizard.** Leave the pick lane exactly as it is
and give the removal its own addressed command, the way
`hyp policy client <id> local-only` already addresses a hidden row by id
(LLP 0289 #ask-the-store: a withheld row "is not off every surface"). Costs:
the user has to learn a command, so it wants N1 or N2 to point at it; and it
adds a surface that can edit a composed config outside `hyp init`, which no
command does today. Buys: it touches no wizard invariant at all, and it is the
only option that scales to a withheld row of any kind rather than to the gated
subset.

**R4. Document `hyp init --force --source ...` as the exit.** Costs: the user
must restate every other pick on one command line, so it is an exit from the
row and a re-decision of everything else; and it is only discoverable through a
narration option, so it is R3's cost without R3's precision. Buys: zero code.

**R5. Nothing.** Costs: point 1 and point 3 stand. The population is narrow (a
Linux config that collected Desktop through `--source` or a pre-gate version),
and #1290's triage judged the residue acceptable on the strength of the Desktop
half being inert, which point 3 above qualifies rather than refutes: the rider
is live capture the user asked to remove.

## What this does not cover {#not-covered}

**The gate itself.** LLP 0368 #platform-gate is not in question here. Whether
`claude-desktop` should be offered on Linux is settled (it should not), and
every option above leaves the menu on a clean install exactly as it is.

**Hidden rows in general.** The raw gateway rows reach this same carry, and
their read-back is derivative, so the `!seededVisible` half of the rule still
governs them and none of the reproductions above apply. An option that widens
narration or a drop path past the gated subset has to say what it does to
them; N1, N2 and R3 are the three that can, and R3 is the only one that needs
no new wizard invariant to do it.

**The compose rider.** Point 3 is a property of the Desktop row's `compose`
block listing `@hypaware/claude`, and it would be a live question even without
the platform gate: a macOS user who unchecks Claude Code and keeps Desktop also
gets `@hypaware/claude` back. What the gate adds is that on Linux there is no
way to reach the other side of it.
