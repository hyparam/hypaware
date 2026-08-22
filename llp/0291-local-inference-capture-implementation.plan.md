# LLP 0291: Projector precedence contract implementation plan

**Type:** Plan
**Status:** Draft
**Systems:** Gateway, Plugins
**Author:** Brendan / Claude
**Date:** 2026-08-18
**Related:** LLP 0290 (the decision this executes), LLP 0016 (the capability the band is published with), LLP 0194 (the mislabeling the band prevents)

> Turns the one first-party obligation of
> [LLP 0290](./0290-local-inference-capture-lane.decision.md) into three
> tasks. The local-inference plugin itself is explicitly **not** in this plan:
> [#ownership](./0290-local-inference-capture-lane.decision.md#ownership) puts
> it out of tree.

## Sequencing principle {#sequencing}

**Small, and shippable independently of anything using it.** The band is
useful the moment it is published and pinned, whether or not a local-inference
plugin ever exists, because it also protects any other third-party adapter on
`hypaware.ai-gateway@2.0.0`. Nothing here blocks on, or waits for, work
outside this repo.

## What was verified against the tree {#verified}

Checked 2026-08-18.

- **Dispatch is priority-ordered, and declining continues the walk.**
  `dispatchProjector` filters by `match`, sorts `byPriorityThenSeq`, and per
  projector: a usage-policy drop returns terminally, an invalid or `undefined`
  result `continue`s, an empty `messages` array `continue`s, the first valid
  projection wins (`ai-gateway/src/message_projector.js:791-830`).
- **The collision is real and silent.** Codex's projector matches
  `isOpenAiChatPath(path)` (`codex/src/exchange-projector.js:63`), which
  accepts `/v1/chat/completions`, `/chat/completions`, any path ending in
  `/chat/completions`, and both as prefixes (`:351-357`), at `priority: 100`
  (`:61`). Ollama's OpenAI-compatible surface is exactly that set.
- **Third-party adapters are an intended consumer.** The gateway registers
  `hypaware.ai-gateway@2.0.0` so adapter plugins, "`@hypaware/claude`,
  `@hypaware/codex`, future custom integrations", can contribute "upstream
  presets, client wiring, and exchange projectors"
  (`ai-gateway/src/index.js:20-25,46`).
- **The install path is complete.** `src/core/plugin_install/` carries
  resolver, fetch, git fetch, lock, install, and update check, and
  `buildPluginCatalog(bundledManifests, installedManifests)` merges installed
  manifests with bundled names taking precedence
  (`src/core/plugin_catalog.js:32,46`).
- **`upstream` is on the projector input**, so an out-of-tree projector has a
  collision-free match key available
  (`hypaware-plugin-kernel-types.d.ts:1959-1971`).
- **Only bundled projectors exist today**, so introducing a band reorders
  nothing at runtime on a current install.
- **The install path is a real product surface, and the scaffolder has a
  hole.** `resolveSource` fixes five precedence rungs and requires third-party
  names to be `hypaware-plugin-<name>` or `@scope/hypaware-plugin-<name>`
  (`src/core/plugin_install/resolver.js:11-16`), and `hyp plugin`
  carries install / list / info / outdated / update / remove / doctor / new
  (`src/core/cli/core_commands.js:169-219`). But `scaffoldPlugin` accepts only
  `source | sink | dataset` (`src/core/plugin_doctor/scaffold.js:31,91-96`):
  there is no gateway-adapter kind, so an out-of-tree adapter author starts
  from a source skeleton and reverse-engineers the capability wiring from
  bundled plugin source. T4 closes that.

Not verified: how many distinct priorities the bundled adapters actually use,
which T1 must enumerate before choosing boundaries.

## The task graph {#tasks}

### Wave 1 (deps `[]`)

- **T1, define and publish the band.** Enumerate every bundled projector's
  `priority`, then reserve a numeric range **above** them for third-party
  projectors and document it where the capability is documented, not in a
  sibling adapter: the `hypaware.ai-gateway@2.0.0` surface in
  `ai-gateway/src/api.js` and the `AiGatewayExchangeProjector` docs in
  `hypaware-plugin-kernel-types.d.ts`. State the two rules an out-of-tree
  projector depends on: it outranks every bundled projector, and a decline
  hands the exchange to the next match, so it must not decline for traffic it
  owns.

### Wave 2 (deps `[T1]`), three-wide

- **T2, pin it.** A traditional test asserting every bundled projector's
  priority sits inside the bundled range, so raising one into the third-party
  band fails here rather than silently restamping an installed plugin's rows.
  Assert the ordering property directly too (a higher-priority projector wins
  a path both match), so the guarantee is tested and not merely asserted by
  the constants.
- **T3, the author's guide.** A short `docs/` page for writing a gateway
  adapter out of tree: register on the capability, contribute an upstream,
  match on `upstream` rather than path and why
  ([LLP 0290 #core-owes](./0290-local-inference-capture-lane.decision.md#core-owes)),
  the band, the no-decline rule, and the `session_id` synthesis constraint
  from [#constraints](./0290-local-inference-capture-lane.decision.md#constraints).
  Use the local-inference lane as the worked example, including that an
  upstream declared with no plugin still yields rows in
  `ai_gateway_exchanges`.

- **T4, an `adapter` scaffold kind.** Add `adapter` to `SCAFFOLD_KINDS` and
  give it a template that registers on `hypaware.ai-gateway@2.0.0`,
  contributes one upstream, and registers a projector stub that matches on
  `upstream`, sits in the third-party band, and carries the no-decline rule as
  a comment. The scaffold is where an author meets these rules whether or not
  they find T3's guide, which makes it the durable half of the pair. Deps
  `[T1]` (it hardcodes a band value), parallel to T2 and T3.

## Annotations owed {#annotations}

- The band constants in T1: `@ref LLP 0290#core-owes [implements]`.
- The pin test in T2: `@ref LLP 0290#core-owes [tests]`, naming the LLP 0194
  mislabeling as the failure it guards.
- Codex's `priority: 100` literal gains
  `@ref LLP 0290#core-owes [constrained-by]`, since it is now a published
  boundary rather than a local choice.

## Out of scope {#out-of-scope}

- **The local-inference plugin itself** (upstream, projector, session
  identity). Out of tree per
  [LLP 0290 #ownership](./0290-local-inference-capture-lane.decision.md#ownership).
- **Shadow mode** and the reverse-proxy record anchor it would require.
  Deferred by [LLP 0290 #shadow](./0290-local-inference-capture-lane.decision.md#shadow);
  reviving it needs a new request.
- **NDJSON stream parsing** for Ollama's native `/api/*` surface. Core work,
  but only worth doing behind a decision that wants the native surface.
- **The Ollama desktop `db.sqlite` sweep.** Different mechanism entirely;
  flagged in [LLP 0290 #open](./0290-local-inference-capture-lane.decision.md#open).
