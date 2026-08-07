# LLP 0200: Picker rows can be hidden from the menu without ceasing to be sources

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Plugins
**Author:** Brendan / Claude
**Date:** 2026-08-07
**Related:** LLP 0130 (#picker-block: the manifest-sourced row contract this extends), LLP 0012 (#source-kinds: the raw proxy source class), LLP 0183 (#seed-from-config: the read-back this has to stay compatible with), LLP 0192 (#fail-closed: what the ids are load-bearing for), LLP 0190 (#pick-gate: the two screens a hidden row must stay out of)

> Extends [LLP 0130 §picker-block](./0130-declarative-picker-descriptors.decision.md#picker-block)
> with a `hidden` field, and narrows what
> [LLP 0012 §Source kinds](./0012-sources.spec.md#source-kinds) said the
> wizard offers: the raw proxy sources remain sources, but stop being
> first-run questions.

## The problem {#problem}

`raw-anthropic` and `raw-openai` are picker rows contributed by
`@hypaware/ai-gateway`. Their whole `compose` contribution is one gateway
upstream and `requires_gateway: true`. Two things follow, and both are bad
for a first-run checkbox:

1. **Beside a client row they compose nothing.** `claude` contributes the
   same `anthropic` upstream; `codex` contributes `openai` and `chatgpt`.
   The picker fold dedupes upstreams by name, so on any machine where a
   client is picked the raw row composes byte-identical config, and
   `configuredPickerSources` reads it back as checked whatever the user
   did. LLP 0183 already named this: the row's checked state is cosmetic.

2. **Alone they capture nothing.** Projection into `ai_gateway_messages` is
   adapter-owned: `registerExchangeProjector` is called only by
   `@hypaware/claude`, `@hypaware/codex`, and `@hypaware/openclaw`. With no
   adapter activated, `dispatchProjector` has an empty projector list and
   `projectExchange` returns no rows - the gateway proxies the traffic,
   emits `aigw.exchange_bytes`, warns `aigw.message_projection_skipped`
   with `reason: no_projector_match`, and writes nothing. A user who picks
   only a raw row gets a working reverse proxy that records nothing.

So the rows are redundant in the common case and non-functional in the case
they exist for. Either way they cost every first-run user a question.

## Decision {#hidden-rows}

A `contributes.picker` row may set `hidden: true`. A hidden row is **absent
from the interactive menu and from the defaults gate**, and is otherwise a
picker source in every respect:

- `hyp init --source <id>` still composes it (that path sets `opts.picks`
  and never prompts).
- `configuredPickerSources` still reads it back off a config that collects
  it, so a reconfigure does not re-decide it.
- Its id keeps its identity in the opt-out/sync store, and its descriptor
  keeps feeding `datasetOwnedSourceIdsFromCatalog`.

`raw-anthropic` and `raw-openai` set it. No other row does.

**Hiding is a display filter, never a catalog deletion.** Deleting the two
`contributes.picker` blocks would look like the same change and is not:
the owner map that arms LLP 0192's fail-closed withholding is folded from
picker descriptors, so `ai_gateway_messages` would get an empty owner list,
and both withhold rules read an empty owner list as "never withhold". A
privacy guard would switch off under cover of a UI cleanup. The descriptors
stay; only `visiblePickerDescriptors` filters.

## Carry-through, and why seeding is not consent {#carry-through}

A hidden row never renders, so neither screen can return one. It rides
through the selection in one case: **the config on disk collects nothing the
menu can show.** Then every row it collects is hidden, and an interactive
pass would silently strip a setup the picker cannot represent - a
`--source raw-anthropic` install being reconfigured.

Once carried, it stays carried. The pick lane can be re-entered by stepping
back from a later lane, and LLP 0191 #re-entry-seeding seeds that pass with
the selection the previous one confirmed. That seed holds the carried hidden
row *and* whatever visible rows the user added, so re-testing "the seed
collects nothing the menu can show" against it fails and the row would be
dropped: `back` then `enter` would delete the upstream the carry exists to
preserve. So the test above is asked of a **config** seed only. A
**selection** seed carries every hidden row in it unconditionally, which is
safe for the reason the next paragraph is about: read-back cannot reach that
tier, so a hidden id is in a previous answer only because this rule put it
there.

Carrying on seed membership alone was tried and is wrong. Seeding is
*derivative* for these rows: `raw-openai` reads as configured whenever
codex's `openai` upstream is present, because the two compose the same
bytes (LLP 0183 #seed-from-config). Seeding therefore is not evidence the
user chose the row, and carrying on it resurrects the `openai` upstream the
moment someone unchecks codex - breaking the guarantee that unchecking a
row removes its upstream. The existing test
`runWizardPick: unchecking a row still removes its plugin and its gateway
upstream` pins that guarantee and is what caught the mistake.

## What this does not fix {#residual}

Hiding the rows removes the wizard question. It does not touch capture or
attribution, and two residuals stay open, both belonging to the
attribution work LLP 0192 defers:

- Raw traffic still needs an adapter plugin's projector to be recorded at
  all. Hiding the row means fewer users reach that dead end; it does not
  remove it.
- Generic Anthropic-dialect traffic is still stamped `client_name:
  'claude'` by the claude projector's fallback (LLP 0115), so it still
  pollutes Claude-attributed queries and reports. That is projector
  behaviour, independent of any picker row.

Tracked as [issue #673](https://github.com/hyparam/hypaware/issues/673),
against LLP 0192's deferred decision.

## Consequences {#consequences}

- `PluginPickerContribution` and `PickerDescriptor` gain `hidden?: boolean`;
  `validatePickerContributions` rejects a non-boolean.
- `visiblePickerDescriptors` (walkthrough.js) is the single display filter,
  used by `runWalkthrough`'s prompt and by `runWizardPick`'s gate and menu.
- The pick lane's seed grows a companion `SeedOrigin`
  (`selection` / `config` / `detected`), because carry-through has to ask
  which tier produced the seed and the set does not say.
- `PICKER_DISPLAY_ORDER` keeps both raw ids: order is still defined for
  them, they simply do not render.
- The sync/opt-out menu is unchanged. It governs data classes already on
  disk, which exist whether or not a row was ever offered.

## References

- LLP 0130, LLP 0012, LLP 0183, LLP 0192, LLP 0190, LLP 0115, LLP 0151
- `src/core/cli/walkthrough.js` (`visiblePickerDescriptors`,
  `PICKER_DISPLAY_ORDER`), `src/core/cli/wizard/pick.js`
  (`promptPickSelection`), `src/core/plugin_catalog.js`,
  `src/core/manifest.js`, `src/core/runtime/source_withhold.js`
  (`datasetOwnedSourceIdsFromCatalog`),
  `hypaware-core/plugins-workspace/ai-gateway/hypaware.plugin.json`
