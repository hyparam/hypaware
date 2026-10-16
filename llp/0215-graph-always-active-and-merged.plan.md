# LLP 0215: Graph always active and skill merged, implementation plan

**Type:** Plan
**Status:** Active
**Systems:** Graph, Plugins, Onboarding, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-12
**Related:** LLP 0213 (the decisions this executes), LLP 0214 (the help capability T6 needs), LLP 0197 (the sequencing principle borrowed wholesale), LLP 0005 (the manifest T1 extends), LLP 0130 (why T1 is a manifest field and not a composer branch)

> Turns [LLP 0213](./0213-graph-plugin-always-active.decision.md) and
> [LLP 0214](./0214-verbs-and-plugin-groups-carry-long-help.decision.md) into
> eight tasks. Both are Accepted. **All eight landed 2026-08-12.**

## Sequencing principle {#sequencing}

**The merge comes last, for the reason LLP 0197 already found.** Its own
principle reads: "Merging four 25 KB skills before removing their mechanical
content produces one 60 KB skill, which is the same problem with fewer files."

The identical trap is live here, one document later. `hypaware-query` is 106
lines and `hypaware-graph` is 171. Merging before the mechanics have somewhere
to go produces a 277-line skill, which is the outcome the merge exists to
prevent, and it will look like progress while it happens. So the order is:

1. **Make help able to hold the mechanics** (T2, T3, from LLP 0214).
2. **Move the mechanics into it** (T6).
3. **Then merge what is left** (T8).

The composition half (T1, T4) is independent of that chain and can run beside
it. Only T8 depends on both halves.

## What was verified against the tree {#verified}

Checked 2026-08-12, and each of these is load-bearing for a task below:

- **The skill can never outrun the plugin.** `hypaware-query` is contributed by
  `@hypaware/claude` and `@hypaware/codex` only. Both declare
  `requires.capabilities: { "hypaware.ai-gateway": "^2.0.0" }`, and
  `@hypaware/ai-gateway` is the sole provider in the bundled surface. So after
  T4, wherever the skill installs, the graph is composed
  ([LLP 0213 #skill-implies-graph](./0213-graph-plugin-always-active.decision.md#skill-implies-graph)).
- **Activation is registration only.** No listeners, no timers, no daemon work,
  no disk writes, and `createDataSource` returns `emptySource(...)` when nothing
  has been projected.
- **`composerManagedPlugins` builds its set from descriptor `compose` blocks**
  (`src/core/cli/walkthrough.js:1060`), so a `compose_with` plugin joins the
  managed set rather than needing a parallel mechanism.
- **No optional-dependency concept exists.** `requires.plugins` is a hard
  dependency and points the wrong way, which is why T1 is a new field rather
  than a reinterpretation of an existing one.
- **`VerbRegistration` has no `help`.** Dispatch's central interception renders
  `summary` + `usage` + optional `help` from the command registration, and
  `commandForVerb` has no `help` to pass it.
- **`test/core/dispatch-inactive-plugin.test.js` uses `@hypaware/context-graph`
  as its exemplar** of an inactive plugin, in all of the unknown-command,
  disabled-entry, and fleet-disabled paths.

Not verified, and therefore not assumed: whether any hermetic smoke depends on
the graph being absent from a default config, and what the manifest validator
change costs in `src/core/config/`.

## The task graph {#tasks}

### Wave 1 (deps `[]`), three-wide

- **T1, `compose_with` in the manifest. LANDED 2026-08-12.** Top-level field
  (beside `requires`/`provides`, not under `contributes`: it is a relationship
  the plugin declares, not a surface it contributes), validated in
  `src/core/manifest.js`, surfaced as `PluginCatalog.composeWith`, declared by
  both graph manifests, and specified at
  [LLP 0005 #compose-with](./0005-plugin-manifest.spec.md#compose-with).

  **`composeWith` on the catalog is optional, deliberately.** Making it required
  broke every hand-built catalog literal in tests and two call sites for no
  benefit; absent simply means "no riders". Complexity 2 as estimated.
- **T2, `help` on `VerbRegistration`. LANDED 2026-08-12.** One optional field,
  spread into the registration by `verbToCommand` so an absent `help`
  contributes no key at all rather than an explicit `undefined`. Complexity 1.
- **T3, long help for plugin-owned groups. LANDED 2026-08-12.** A registerable
  group description, not the exposed factory: `registerGroup`/`getGroup` on the
  registry, read by `resolveGroupHelp`. Reasoning recorded at
  [LLP 0214 #d2](./0214-verbs-and-plugin-groups-carry-long-help.decision.md#d2),
  along with the `hyp graph - undefined` header bug the summary-less case
  exposed. Complexity 2.

### Wave 2 (deps `[T1]`), two-wide

- **T4, compose the pair. LANDED 2026-08-12.** `ridersFor` folds riders after
  the picked rows, run to a fixpoint so a rider may ride a rider without the
  manifests needing an ordering convention between themselves. Riders join
  `composerManagedPlugins`, which is what makes the stranding rule hold.
  Six cases in `test/core/compose-picker-config.test.js`, including the two
  negatives that matter: a hand-added non-rider still survives a reconfigure,
  and with no `composeWith` map nothing rides anything (which is why every
  pre-existing test in that file kept passing untouched). Complexity 2.
- **T5, move the inactive-plugin exemplar. LANDED 2026-08-12.** Moved to
  `@hypaware/gascity`, with a header comment saying why it must not move back.
  These tests stage synthetic plugins, so they never failed; the change is that
  the example stops teaching the reader that the graph is the thing you probably
  do not have. Complexity 1.

### Wave 3 (deps `[T2, T3]`)

- **T6, author the graph help text. LANDED 2026-08-12.** All four surfaces, not
  the two the plan named: the `graph` group, `graph project`, `graph compact`,
  and `graph neighbors`. Verified by rendering each against a real temp install.

  **The constraint / mechanic line held without argument**, which was the risk
  this task was rated 3 for. Everything that moved is a property of the command
  (flag meanings, seed resolution order, where truncation is written, `--json`
  versus `--format json`); nothing with nameable harm moved, so
  `skill-constraints-survive` never had an opinion. The judgment call the plan
  feared did not materialise, because the boundary turns out to be legible from
  the fixture's own admission rule rather than needing a case-by-case ruling.

### Wave 4 (deps `[T4]`)

- **T7, an empty graph says so. LANDED 2026-08-12.** `queryNeighbors` sets
  `graphEmpty` when the node table folds to nothing, so it rides the shared
  result to both surfaces
  ([LLP 0213 #empty-is-shared](./0213-graph-plugin-always-active.decision.md#empty-is-shared)).

  **The load-bearing test is the negative one.** `graphEmpty` must mean "nothing
  projected", never "this seed missed": a populated graph with a bad seed still
  renders its own error and candidates, or the message would send people to
  re-project a graph that is already fine. Complexity 2.

### Wave 5 (deps `[T6, T7]`)

- **T8, the merge. LANDED 2026-08-12.** 277 lines across two skills became
  **148** in `hypaware-query` plus a **42-line `github.md`** loaded only for
  questions that span AI activity and code review. The sequencing worked: the
  naive concatenation this plan was written to avoid would have been 277.

  Four graph constraints joined `test/fixtures/skill-constraints.json`
  (`graph-derived-facets`, `graph-project-first`, `graph-keys-converge`,
  `graph-is-derived-not-truth`), each with the measured harm. All 21 now pass
  against both hosts.

  **`skill-host-divergence.json` needed no re-record**, which is the useful
  surprise. The merge added ~40 lines of shared prose and *zero* new
  divergence: `hypaware-query` is still 2/2, because the codex sync preserved
  its two host-specific MCP lines byte-for-byte and `github.md` is identical
  across trees. The plan assumed a re-record would be needed; it is only needed
  when divergence itself changes.

  **Three dangling references the plan did not name**, all found by grep rather
  than by test: both `hypaware-reference` descriptions routed graph questions to
  the deleted skill, and `README.md` advertised it. A retirement is not done
  when the source is deleted; it is done when nothing points at it.

  Complexity 3 as estimated.

  <a id="t8-blocked"></a>**Held back 2026-08-12, on a collision rather than a
  difficulty. Collision since cleared.** When T1 to T7 landed, the working tree
  carried unrelated in-flight work in the same skill tree: the LLP 0212 session
  opt-out retiring `hypaware-ignore` / `hypaware-unignore` in favour of
  `hyp session ignore|unignore|status`, with matching edits to
  `hypaware-privacy` and `hypaware-reference`, and a re-recorded
  `test/fixtures/skill-host-divergence.json`. T8 edits that tree and re-records
  that fixture, so landing on top would have entangled two independent changes
  and made the re-record ambiguous about which one it belonged to.

  That work settled and its deletions were staged, so T8 went ahead the same
  day. Its own prerequisites (T6, T7) were always met; this was merge ordering,
  never a blocked task.

## The hard parts, by name {#hard-parts}

**T6: 3, and it is judgment, not typing.** Every line moved has to be
classified: a **mechanic** goes to help, a **constraint** stays in the skill.
Getting it wrong toward help is the worse direction, because
[LLP 0214 #d3](./0214-verbs-and-plugin-groups-carry-long-help.decision.md#d3)
deliberately did **not** widen the constraint guard's corpus. A constraint moved
into a help string therefore fails `skill-constraints-survive`, and that failure
is correct. **The fix is to move the text back into the skill.** Do not loosen
the pattern and do not widen the corpus to make it pass; LLP 0197 named that
move as converting the guard into a rubber stamp exactly when it is working.

**T1: 2, but it sets a precedent.** `compose_with` is the first declaration that
lets a plugin be written into a config without a pick of its own. The validator
should make a nonsense value legible rather than mysterious, because the next
user of this field will be a plugin author who is not in this conversation.

Everything else is mechanical: a field passthrough (T2), a rendering path that
already exists for core groups (T3), composition cases beside existing ones
(T4), a test fixture swap (T5), and a result-shape addition with two assertions
(T7).

## Not in scope {#not-in-scope}

- **Existing configs are not migrated** ([LLP 0213 #rq-upgrade](./0213-graph-plugin-always-active.decision.md#rq-upgrade)).
  No task here writes to a user's config file.
- **Retiring the installed `hypaware-graph` copy.** T8 deletes the source; the
  copy already installed under `~/.claude/skills` and `~/.codex/skills` is
  [#660](https://github.com/hyparam/hypaware/issues/660) (LLP 0197 T13), which
  this makes one case worse and does not fix.
- **A warning when composition strands a non-empty dataset.** Worth doing,
  general rather than graph-specific, and not this plan's.
