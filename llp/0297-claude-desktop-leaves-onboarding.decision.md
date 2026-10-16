# LLP 0297: Claude Desktop leaves onboarding; `claude-desktop install` is the only way in

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Plugins
**Author:** Brendan / Claude
**Date:** 2026-08-19
**Related:** LLP 0202 (#hidden-rows: the display filter this reuses, #carry-through: the rule this narrows), LLP 0133 (#solo-sudo, #dialog-residue: what the row's setup actually does), LLP 0131 (the configure phase the row drove), LLP 0139 (#repair-must-be-runnable: the standalone command this makes the only entry), LLP 0130 (#picker-block, #configure-command), LLP 0011 (#autodetect-vs-default), LLP 0224 (#ask-once-per-pick)
**Superseded-by:** LLP 0358 (Desktop returns as a transcript-only picker row with no setup command)

> Extends [LLP 0202 §hidden-rows](./0202-hidden-picker-rows.decision.md#hidden-rows):
> `claude-desktop` sets `hidden: true`, so "`raw-anthropic` and `raw-openai`
> set it. No other row does." no longer holds. Narrows
> [§carry-through](./0202-hidden-picker-rows.decision.md#carry-through): the
> "nothing visible seeded" test is a proxy for a derivative read-back, and a
> hidden row whose read-back is *not* derivative carries without it.

## The problem {#problem}

`claude-desktop` was the picker's only `needs_setup` row. Ticking it did not
configure anything by itself: the wizard's configure phase (LLP 0131) then
ran `hyp client claude-desktop install`, which is the heaviest thing
onboarding can do to a machine. In one accepted checkbox it launches a
browser OAuth sign-in, writes an executable credential wrapper, backs up and
deletes `~/Library/Application Support/Claude/Claude-3p` (LLP 0133
#dialog-residue), and takes a `sudo` prompt to place a root-owned plist under
`/Library/Managed Preferences` (LLP 0133 #solo-sudo).

Three things follow, and they all point the same way:

1. **The checkbox and the consent are not the same act.** Every other picker
   row composes config: tick it, the wizard writes `plugins[]`, done. This
   one composes config *and* opens an interactive sub-flow with its own
   disclosure screen and its own yes/no question, mid-wizard. The row's
   `· needs extra setup` suffix and the reassurance in its summary were both
   added to paper over that mismatch. They label the seam; they do not close
   it.

2. **It is the only row that can leave a machine changed outside HypAware.**
   The plist is not in `~/.hyp` and is not removed by `hyp client detach`
   (the client descriptor carries no `attach_probe`, LLP 0135 #no-probe):
   its undo is `sudo rm` of a system path. A first-run wizard is the wrong
   place to acquire state the product cannot take back.

3. **macOS-only, and small.** The row renders on Linux, where the plist path
   does not exist, and the flow it starts is only reachable by a user who
   already runs Claude Desktop *and* is willing to sudo. It costs every
   first-run user a row to serve a minority of Mac users, which is the same
   arithmetic LLP 0202 ran on the raw rows.

## Decision {#claude-desktop}

`@hypaware/claude-desktop`'s `contributes.picker` row sets `hidden: true`.
Claude Desktop is not offered by `hyp init` on any screen - not the menu, not
the defaults gate, not the express gate, not the sync gate (LLP 0276) - and
the wizard's configure phase never runs its `configure_command`.

**`hyp client claude-desktop install` becomes the only way in.** It is
unchanged, and it was already the flow that does the real work: LLP 0139
#repair-must-be-runnable already made it the repair `hyp status` names, and
LLP 0224 #ask-once-per-pick already made a reconfigure skip it. What changes
is that nothing else now runs it.

The plugin stays in `V1_EXCLUDED_FROM_DEFAULT`, so the command registers only
on a config that names the plugin. On a config that does not, the dispatch
miss reports the LLP 0153/0154 unavailable-plus-repair line
(`add {"name": "@hypaware/claude-desktop"} to plugins[]`), the same answer
every other excluded opt-in gives (`@hypaware/gascity`,
`@hypaware/embedder-openai`, the completion providers). Making the install
command self-enabling - a config write from a dispatch miss - was considered
and deliberately not taken here: it is a general change to what an inactive
plugin command may do, not a Claude Desktop decision, and it belongs to a
request of its own.

## Hiding, not deleting {#not-deleting}

For the reasons LLP 0202 #hidden-rows already gives, and one more this row
adds:

- `hyp init --source claude-desktop` still composes it, so a scripted or
  fleet install keeps a non-interactive route.
- `configuredPickerSources` still reads it back, which is what the carry rule
  below rests on.
- `datasetOwnedSourceIdsFromCatalog` still sees it, so the LLP 0192
  fail-closed owner map for `ai_gateway_messages` keeps its entry.
- **New here:** the descriptor is where `configure_command` lives, and
  `hyp status`'s `client_attach_missing` repair reads it
  (`daemon/status.js`, LLP 0139 #repair-must-be-runnable). Delete the row and
  a half-finished Desktop install loses the line telling the user how to
  finish it.

## The carry rule needs a real test, not a proxy {#carry-through}

LLP 0202 #carry-through carries a config-seeded hidden row only when the
config "collects nothing the menu can show". That test is a *proxy*. The
property it stands for is stated one paragraph later: read-back for the raw
rows is **derivative** - `raw-openai` reads as configured whenever codex's
`openai` upstream is present, so its seeded state is evidence about the
config, never about the user, and carrying on it would resurrect an upstream
the user just unchecked.

`claude-desktop`'s read-back is not derivative. It requires
`@hypaware/claude-account` and `@hypaware/claude-desktop` to be named in
`plugins[]`, and nothing else composes either. A config holding them recorded
a decision someone made at a sudo prompt.

Under the bare proxy the row would be dropped by any reconfigure that also
seeded a visible row - which is every install that captures anything at all.
The failure is silent and unrecoverable from inside the product: the rewrite
removes `@hypaware/claude-desktop` from `plugins[]`, so the very command that
would repair the setup stops registering. The plist stays on disk pointing at
a gateway whose config no longer knows why.

So: <a id="own-plugins"></a>a config-seeded hidden row carries when the
config collects nothing visible **or** when its `compose` contributes plugins
of its own (`compose.plugin` / `compose.plugins`; `requires_gateway` does not
count, since every gateway-backed row asks for it and it therefore separates
nothing). `readsBackFromOwnPlugins` in `walkthrough.js` is that predicate.
`selection`-origin and `detected`-origin seeds are unchanged.

## Consequences {#consequences}

- The picker's `needs_setup` machinery keeps its contract but has no bundled
  row exercising it end to end: `NEEDS_SETUP_LABEL_SUFFIX` and the configure
  phase stay, tested against synthetic descriptors. That is deliberate -
  `needs_setup` is a kernel contract for any plugin, not a Claude Desktop
  feature.
- The row keeps its `detect` probe. It can no longer seed anything (hidden
  rows do not render, and `detectedSeed` already dropped every `needs_setup`
  row), so the LLP 0202 comment that no bundled hidden row declares a
  `detect` probe is retired.
- Onboarding loses a row on every platform; nothing else about first run
  changes.

## References

- LLP 0202, LLP 0276, LLP 0133, LLP 0135, LLP 0131, LLP 0139, LLP 0130,
  LLP 0224, LLP 0192, LLP 0153, LLP 0154
- `hypaware-core/plugins-workspace/claude-desktop/hypaware.plugin.json`
  (`contributes.picker[0].hidden`),
  `hypaware-core/plugins-workspace/claude-desktop/src/install.js`,
  `src/core/cli/walkthrough.js` (`visiblePickerDescriptors`,
  `readsBackFromOwnPlugins`), `src/core/cli/wizard/pick.js`
  (`resolvePickSeeding`), `src/core/runtime/bundled.js`
  (`V1_EXCLUDED_FROM_DEFAULT`)
