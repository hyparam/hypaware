# LLP 0213: The graph plugin is always active, and its skill merges into query

**Type:** Decision
**Status:** Accepted
**Systems:** Graph, Plugins, Onboarding, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-12
**Related:** LLP 0023 (#on-demand-projection: why activation costs nothing), LLP 0196 (#one-skill-per-question: the merge this finally executes), LLP 0197 (#t12-graph-was-already-owned: the objection this answers), LLP 0009 (#layered-help: the surface the merged skill leans on), LLP 0214 (the help-surface capability D4 defers to), LLP 0064 (the traversal command being documented), LLP 0032 (the GitHub bridge, which stays conditional)
**Planned-by:** LLP 0215

> Two decisions, and the second follows from the first. `@hypaware/context-graph`
> ships in every install but activates in almost none, for no recorded reason.
> Turning it on removes the packaging constraint that
> [LLP 0197 #t12-graph-was-already-owned](./0197-skills-state-constraints-not-procedures.plan.md#t12-graph-was-already-owned)
> correctly refused to work around, which lets
> [LLP 0196 #one-skill-per-question](./0196-skills-state-constraints-not-procedures.rfc.md#one-skill-per-question)
> finally execute as written.

## Context {#context}

`@hypaware/context-graph` and `@hypaware/ai-gateway-graph` are in
`V1_BUNDLED_PLUGIN_ALLOWLIST` (`src/core/runtime/bundled.js`), so they ship
inside the package on every install. They are nonetheless inactive on a normal
install, because shipping is not activation:

- Day-to-day CLI dispatch boots `bootProfile: 'config'`, which activates only
  what the user's `hypaware-config.json` names. The allowlist governs
  `all-bundled` / `all-available`, which is bare `hyp` and `hyp init`.
- The walkthrough composes that `plugins[]` array from **picker rows**, and
  picker rows are clients and export sinks. An engine plugin that is neither has
  no slot in the composition model, so it is never written.
- No init preset adds them either.

Measured on the author's machine, 2026-08-12: the config lists nine plugins and
neither graph plugin is among them, so `hyp graph --help` reports the plugin as
unavailable with a hand-edit repair (LLP 0153). That machine has been an active
HypAware install for months.

**Nothing decided this.** The LLP corpus contains no decision, note, or caveat
about default-activating the graph. It is a gap in how the walkthrough composes
configs, not a policy, and it has a cost: the `hypaware-graph` skill installs
only when the plugin is active, so a default install never learns the feature
exists. The documentation for the feature is gated behind having already found
and enabled the feature.

### The distinction that settles it {#mechanism-not-data}

The objection to always-on assumes that an install without a *projected graph*
should not carry the *graph query surface*. Those are separate things, and the
code already treats them separately.

**Activation costs nothing.** `activate()` is pure registration: a contract
registry, one capability, two dataset registrations, two commands, one verb, one
skill. No listeners, no timers, no daemon participation
([LLP 0023 #on-demand-projection](./0023-context-graph-projection.decision.md)
keeps projection command-only on purpose), and no disk writes.
`@hypaware/ai-gateway-graph` is a single `registerContract` call whose manifest
declares both dependencies, so activation order resolves itself. Disk usage
before `hyp graph project` is zero.

**An unbuilt graph already degrades correctly.** `createDataSource` in
`context-graph/src/datasets.js` ends with
`if (sources.length === 0) return emptySource(...)`. On an install that has never
projected, `select * from node` returns zero rows with the correct schema. Not an
error, not a missing-partition failure. The plugin was already written for the
case where the mechanism is present and the data is not.

So the conditionality that
[LLP 0197 #t12-graph-was-already-owned](./0197-skills-state-constraints-not-procedures.plan.md#t12-graph-was-already-owned)
protected is real but misplaced. It belongs on the projected data, which is
already conditional and self-reporting, not on whether the commands exist.

## Options considered {#options}

1. **Status quo: off by default, two skills.** Rejected. No activation cost
   justifies the gate, and the price is a bundled feature most users cannot
   discover.
2. **Turn it on, keep two skills.** Rejected. Once the conditionality is gone,
   the remaining boundary is between two ways of asking the same question ("get
   me facts out of the recordings"), which is the split LLP 0196 named as
   ours rather than the user's.
3. **Keep it off, merge anyway with an availability caveat.** Rejected, and this
   is what LLP 0197 refused. It ships graph guidance to installs with no graph,
   and it duplicates a conditional surface into two unconditional trees.
4. **Chosen: on by default, then merge.**

## Decision {#decision}

### D1: both graph plugins are composed by default {#d1}

The walkthrough composes `@hypaware/context-graph` and
`@hypaware/ai-gateway-graph` **as a pair, wherever the AI gateway is composed**.
The connector's manifest already requires `@hypaware/ai-gateway` `^2.0.0`; this
binds the engine to the same condition.

**The engine is not composed alone**, though it would be harmless to activate.
An install with no gateway has no contract to project, so a solo engine
registers a `node` and an `edge` table that can never hold a row. Empty tables
that will never fill read as breakage: the user sees the datasets in
`hyp query status`, runs `hyp graph project`, gets nothing, and has no way to
tell a working empty graph from a broken one. The graph appears exactly when
there is something for it to contain.

**The pairing is declared, not hardcoded.** The graph plugins name their
condition in their own manifests (a `compose_with` declaration), and core
composes any bundled plugin whose named plugins are all composed. A branch in
`composePickerConfig` would work today and would move against
[LLP 0130 #consequences](./0130-declarative-picker-descriptors.decision.md),
which has core keeping composition while the hardcoded rules "migrate onto the
plugins they describe". The next derived plugin then needs a manifest line
rather than a core patch. This extends
[LLP 0005](./0005-plugin-manifest.spec.md); normative field prose lands there
with the implementation.

Note the existing `requires.plugins` cannot carry this. It is a hard dependency
governing activation order and presence, and it points the wrong way:
`@hypaware/ai-gateway-graph` requires the gateway, but nothing lets the gateway
pull the connector in. A rule of "compose anything whose `requires` are
satisfied" is worse than useless here, since `@hypaware/context-graph` declares
no `requires` at all and would either never compose or drag in every
unconstrained plugin in the allowlist.

<a id="derived-data-plugins"></a>**What this widens.**
[LLP 0011 #interactive-walkthrough](./0011-setup-and-onboarding.decision.md)
defines composition as picks contributed by source, client, and sink plugins,
and [LLP 0000 #plugin-categories](./0000-hypaware.explainer.md) has four
categories with no room for a projection engine. Both are amended rather than
worked around, because the gap is real and the next derived plugin will hit it:
a **derived-data** plugin consumes what another plugin captured, contributes no
pick of its own, and rides the pick whose data it derives from.
[LLP 0005](./0005-plugin-manifest.spec.md) already holds that a plugin's
category is *emergent from the manifest, not a declared type*, so naming a fifth
emergent shape adds vocabulary, not machinery.
[LLP 0011 #no-architectural-names](./0011-setup-and-onboarding.decision.md#no-architectural-names)
is untouched, and is precisely why this is not a picker row: the user says what
to collect, and HypAware picks the plugin set.

### D2: `hypaware-graph` merges into `hypaware-query` {#d2}

LLP 0196 #one-skill-per-question as written, now that its blocker is gone. The
merged skill carries the routing rule (graph for entities and connections,
messages for per-message measures), the two-stage strategy, the derived-facet
rule, and the measured performance tiers. The availability-and-repair *section*
is deleted: it exists only to explain the gate D1 removes. One sentence of it
survives, because D1 governs what `hyp init` writes from now on and not what is
already on disk (see
[#availability-is-not-universal](#availability-is-not-universal)).

<a id="skill-implies-graph"></a>**Under D1 the objection is not merely reduced,
it is unreachable**, and the manifests prove it rather than the prose asserting
it. `hypaware-query` is contributed by exactly two plugins, `@hypaware/claude`
and `@hypaware/codex`. Both declare
`requires.capabilities: { "hypaware.ai-gateway": "^2.0.0" }`, and the sole
provider of that capability in the bundled surface is `@hypaware/ai-gateway`.
D1 composes the graph wherever that gateway is composed. So the skill is
installed only where a gateway exists, and a gateway exists only where the graph
does: there is no configuration in which the merged skill lands on an install
without the graph. That is the precise fear
[LLP 0197 #t12-graph-was-already-owned](./0197-skills-state-constraints-not-procedures.plan.md#t12-graph-was-already-owned)
declined to accept, and it is closed structurally rather than by caveat.

The one way to reopen it is to give `hypaware-query` a third contributor that
does not require the gateway. Any plugin doing so must either carry the graph
condition itself or accept that the skill overstates what its install can do.

**What does not merge:** the GitHub enrichment material
([LLP 0032](./0032-github-llm-graph-bridge.decision.md)) stays genuinely
conditional, because it needs `@hypaware/github` configured on a server. It
becomes a reference file the merged skill loads on entry, in the pattern
`hypaware-report` already uses for `reviewing.md` and its siblings.

Skill count returns to six on every install, rather than six without the graph
and seven with it.

### D3: an empty graph says so {#d3}

With the commands always present, "the graph has never been projected" becomes
the common first experience rather than an edge case. Today
`hyp graph neighbors <x>` on an unprojected graph reports a resolution failure,
which reads identically to "no such node". It must instead report that the graph
is empty and name `hyp graph project`.

This is the one behaviour change always-on genuinely requires, and it is the
honest replacement for the availability section D2 deletes: the check moves from
the skill's prose into the command's own output, where it is tested.

<a id="empty-is-shared"></a>**The signal belongs to the verb's `operation`, not
its `render`.** [LLP 0034 #verbs](./0034-mcp-host-intrinsic.decision.md#verbs)
splits a verb into a shared core ("identical for the CLI and the MCP tool") and
a CLI-only renderer, so a fact placed in `render` reaches half the callers. That
half matters more under D1 than it did before: composing the graph everywhere
also puts `graph_neighbors` on every install's MCP tool surface, which is
0034's designed behaviour ("add `@hypaware/context-graph` and `graph_neighbors`
appears") now reached by default rather than by hand-editing a config. So the
operation returns the emptiness as a structured fact, the CLI renders it as the
prose above, and an MCP caller gets the same distinction between "no such node"
and "nothing has been projected" instead of a bare empty result.

### D4: mechanics move into command help, not into the merged skill {#d4}

The merge must not simply concatenate 106 lines onto 171. Following
[LLP 0196 #mechanics-as-code](./0196-skills-state-constraints-not-procedures.rfc.md#mechanics-as-code),
the deterministic half of the graph skill (flag semantics, `--direction`, node
resolution order, `--json` full ids versus display-truncated ones, where
truncation is written) belongs in `hyp graph --help` and
`hyp graph neighbors --help`. The skill keeps routing and correctness: what to
ask the graph rather than the messages, and what goes silently wrong if you ask
the wrong one.

**The capability this needs does not exist, and is decided elsewhere.** Verbs
cannot carry long help, and plugin-owned groups cannot either, so there is
currently nowhere in `hyp graph --help` for this text to go. That is a change to
the help system serving every plugin, not a graph concern, and it is owned by
[LLP 0214](./0214-verbs-and-plugin-groups-carry-long-help.decision.md). D4 is
the intent; 0214 is the mechanism, and D2 cannot fully land before it.

## Consequences {#consequences}

- **Existing configs are not migrated.** New configs get the graph; already
  written ones keep whatever they name until their owner re-runs `hyp init`. No
  reconcile pass and no config migration is built for this
  ([resolved question 1](#rq-upgrade)).
  "New configs" means every path that writes one, not just the picker fold.
  `compose_with` is read in `composePickerConfig` alone, so a preset that
  writes its plugin list literally has to name the pair itself:
  `hyp init claude-and-otel-local` does, and any future preset must.
- <a id="availability-is-not-universal"></a>**`hyp query status` lists `node`
  and `edge` on every install `hyp init` has written since this landed**, which
  is not the same as every install. Configs predating this decision are
  deliberately not migrated (above), and a fleet-joined host takes its plugin
  set from the central layer, which may omit the pair. So the merged skill
  keeps one diagnostic sentence rather than deleting the check outright: the
  failure it guards against is the model being told to run `hyp graph project`
  and read `node` / `edge` on a host that has neither, and reporting the
  resulting nothing as an empty graph rather than an absent one. What is
  deleted is the old skill's full availability *gate*; what survives is a
  sentence naming the symptom and the repair (`re-run hyp init`).
- <a id="stranding"></a>**Unpicking the gateway strands an existing graph, and
  that is the existing rule, not a new hazard.** Composer-managed plugins "live
  and die by the picks"
  ([LLP 0183 #carry-forward](./0183-reconfigure-starts-from-the-config-on-disk.decision.md)), so
  a reconfigure that drops the gateway drops these two with it. The projected
  `node` / `edge` parquet stays on disk, unregistered and unqueryable, and
  returns if the pick returns. This is exactly what unpicking `@hypaware/otel`
  already does to `logs`, `traces`, and `metrics`. Recorded here so the next
  reader files it as consistent behaviour rather than as a bug; a composer that
  warns before stranding a non-empty dataset would be a general improvement and
  is not this document's to make.
- **Every pointer to `hypaware-graph` moves, not just the skill.** Both host
  trees' `hypaware-query` described the gate, both `hypaware-reference`
  descriptions routed graph questions to the retired skill, and `README.md`
  advertised it. A retirement is finished when nothing points at it, not when
  the source is deleted.
- **`test/core/compose-picker-config.test.js` gains the `compose_with` cases**,
  which is where D1's mechanism earns its coverage: composed with the gateway,
  absent without it, and dropped on a reconfigure that unpicks the gateway
  ([#stranding](#stranding)).
- **The graph stops being a usable example of an inactive plugin.**
  `test/core/dispatch-inactive-plugin.test.js` uses `@hypaware/context-graph` as
  its exemplar throughout, for the unknown-command, disabled-entry, and
  fleet-disabled repair paths (LLP 0153). Those tests stage their own configs so
  they keep passing, but the example stops being representative: it teaches the
  reader that the graph is the thing you probably do not have. Move them onto a
  plugin that really is opt-in (`@hypaware/gascity` or `@hypaware/vector-search`
  are both in the excluded-from-default set).
- **`cli_bundled_plugins_activated` is unaffected.** It stages its own config
  and counts both graph plugins among six skipped, which stays true of that
  config.
- **LLP 0197 #t12-graph-was-already-owned is superseded in part.** On acceptance,
  append `Superseded-by: LLP 0213` there. Its reasoning stays correct for the
  packaging world it was written in; D1 changes that world. LLP 0196
  #one-skill-per-question needs no change: this executes it.
- **Retiring `hypaware-graph` adds a sixth stale installed skill**, joining
  `hypaware-sensitive-scan` and the four merged report skills under
  [#660](https://github.com/hyparam/hypaware/issues/660) (LLP 0197 T13). The
  merge is cheaper to ship after that lands than before, and should not ship
  without at least noting it.
- **Graph constraints enter the constraint guard's corpus.**
  `skill-constraints-survive` reads the claude and codex skill trees, which
  `hypaware-graph` is outside of today. On merge its load-bearing rules (the
  derived-facet rule above all) become guarded, which is the point. What does
  **not** move into help is any of them: see
  [LLP 0214 #d3](./0214-verbs-and-plugin-groups-carry-long-help.decision.md#d3)
  for the constraint / mechanic boundary D4 has to respect
  ([resolved question 4](#rq-corpus)).

## Resolved questions {#resolved-questions}

All four were resolved by the maintainer on 2026-08-12, before this left Draft.

1. <a id="rq-upgrade"></a>**How do existing configs get the graph? They do not.**
   The candidates were a boot-time reconcile, a one-time migration, or nothing.
   **Nothing**, on the grounds that the installed population is small enough that
   the machinery costs more than it returns. Re-running `hyp init` picks it up.
   Revisit if the population grows: the argument is about scale, not principle,
   and it expires quietly rather than loudly.
2. **Engine alone, or the pair? The pair.** Folded into [D1](#d1) with its
   reasoning: a solo engine offers tables that can never fill, which is worse
   than offering nothing.
3. **Does D4 need its own LLP? Yes**, split into
   [LLP 0214](./0214-verbs-and-plugin-groups-carry-long-help.decision.md). The
   help-surface change serves every plugin that registers a verb, and burying it
   in a graph document hides it from the next author who needs it. [D4](#d4) now
   states the intent and defers the mechanism.
4. <a id="rq-corpus"></a>**Does the constraint guard follow prose into command
   help? No, and the first answer here was wrong.** Resolved yes, reversed
   during the grill: the fixture holds no constraint that D4 relocates, so the
   corpus does not widen. Constraints stay in skills, mechanics move to help,
   and the guard already enforces that split by failing when a guarded
   constraint leaves the skill trees. Owned by
   [LLP 0214 #d3](./0214-verbs-and-plugin-groups-carry-long-help.decision.md#d3).

## References {#references}

- [LLP 0023: Context graph projection](./0023-context-graph-projection.decision.md)
- [LLP 0196: Skills state constraints, not procedures](./0196-skills-state-constraints-not-procedures.rfc.md)
- [LLP 0197: Skills state constraints, implementation plan](./0197-skills-state-constraints-not-procedures.plan.md)
- [LLP 0009: CLI registry](./0009-cli-registry.spec.md)
- [LLP 0214: Verbs and plugin groups carry long help](./0214-verbs-and-plugin-groups-carry-long-help.decision.md)
- [LLP 0011: Setup and onboarding](./0011-setup-and-onboarding.decision.md) (amended: composition admits derived-data plugins)
- [LLP 0005: Plugin manifest](./0005-plugin-manifest.spec.md) (extended: `compose_with`)
- [LLP 0130: Picker entries are declarative manifest contributions](./0130-declarative-picker-descriptors.decision.md)
- [LLP 0000: HypAware](./0000-hypaware.explainer.md) (amended: derived-data plugin category)
- [LLP 0064: Context graph query](./0064-context-graph-query.decision.md)
- [LLP 0032: GitHub LLM graph bridge](./0032-github-llm-graph-bridge.decision.md)
- `src/core/runtime/bundled.js`, `src/core/runtime/boot.js` (`computeSelectedPlugins`), `src/core/cli/walkthrough.js` (config composition)
- `hypaware-core/plugins-workspace/context-graph/src/{index,datasets}.js`
