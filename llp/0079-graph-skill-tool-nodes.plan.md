# LLP 0079: graph Skill & Program nodes — implementation plan

**Type:** plan
**Status:** Active
**Systems:** Plugins, Sources
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0073, LLP 0074, LLP 0075, LLP 0076, LLP 0077, LLP 0078

> Executable breakdown of
> [LLP 0073](./0073-graph-skill-tool-nodes.design.md), which implements
> [issue #229](https://github.com/hyparam/hypaware/issues/229) (Skill nodes)
> and [issue #230](https://github.com/hyparam/hypaware/issues/230) (Program
> nodes) under decisions LLP 0074–0078. Five tasks: the tiny kit widening
> first (inert until consumed), the tractable Program half and the
> judgment-heavy Claude skill half in parallel, the Codex skill rule on top of
> the shared skill helpers, then the cross-cutting end-to-end/query proof.

Task shape:

- **T1 — kit edge props** (`@hypaware/context-graph`). `EdgeSpec.props?` in
  `context-graph/src/types.d.ts` + the structural twin in
  `ai-gateway-graph/src/types.d.ts`; `buildEdge` mirrors `buildNode`'s props
  handling (`contract-kit.js`); unit tests for passthrough, empty → null, and
  edge-id stability with/without props
  ([LLP 0078](./0078-dispatch-source-edge-props.decision.md)). Merges green
  with zero behavior change: nothing passes props yet. Rated 2: mechanical,
  but it touches the central kit and the capability shape, so the id-stability
  assertions must be airtight.
- **T2 — Program nodes + `invoked` edges, #230** (`@hypaware/ai-gateway-graph`).
  New `tool_facets.js` with `commandStringFrom` (Bash `command` /
  exec_command `cmd`) and the fail-closed `programFrom` pipeline
  (first-connector cut, env-skip, wrapper + `shell -c` unwrap, basename,
  lowercase, `PROGRAM_RE` gate —
  [LLP 0073 §program-derivation](./0073-graph-skill-tool-nodes.design.md#program-derivation),
  [LLP 0077](./0077-program-facet-extraction.decision.md)); the
  `Program` node + `invoked` edge rules in `graph_contract.js`; the
  `PROJECTOR_VERSION` 1 → 2 bump (provenance-only; T3 must not bump again);
  table-driven extraction tests + contract-rule tests incl. aux-filter
  passthrough. No dependency on T1 (`invoked` carries no props). Rated 4:
  the shell-parsing judgment calls (wrappers, `bash -lc` recursion, quoting)
  are the risk; the graph wiring is pattern-following.
- **T3 — Claude Skill nodes + `ran` edges** (`@hypaware/ai-gateway-graph`).
  The three Claude surfaces as node+edge rule pairs in `graph_contract.js`
  (Skill tool call / offset-0 marker / offset-0 `<command-name>` with the
  static `CLAUDE_BUILTIN_COMMANDS` exclusion —
  [LLP 0074](./0074-claude-skill-activation-signal.decision.md)); skill-name
  helpers + `SKILL_NAME_RE` gate in `tool_facets.js`; per-surface dispatch
  props via the T1 kit
  ([LLP 0078](./0078-dispatch-source-edge-props.decision.md)); strict-filter
  false-positive tests (assistant-role marker, mid-text marker, built-in
  slash, grep-of-SKILL.md mint nothing). Rated 5: this is the
  judgment-heaviest derivation — three signal shapes, an exclusion list, and
  the false-positive matrix are all inference over prose conventions.
- **T4 — Codex Skill derivation** (`@hypaware/ai-gateway-graph`). The
  exec-read path-pattern rule pair
  ([LLP 0075](./0075-codex-skill-activation-signal.decision.md)):
  `.codex/skills/<name>/SKILL.md` regex over `tool_args.cmd`,
  `dispatch_shell_read` flag, tests for match/reject variants (quoting,
  non-`.codex` paths, `~` prefix). Depends on T3's shared skill helpers and
  Skill-rule structure. Rated 3: one surface and a regex, but the
  reject-variants matter and the fixture shape must stay pinned to the Codex
  projector's `{"cmd": ...}`.
- **T5 — end-to-end + query proof** (tests only). Extend
  `context-graph-project-e2e.test.js`: all skill surfaces + programs through
  `projectGraph`, the `mergeRow` dispatch-flag union (marker + slash → one
  `ran` edge, both flags), re-projection idempotence, and the issue #229/#230
  headline queries (sessions-per-skill SQL, which-sessions-ran-git,
  `traverse` with `--edge-type ran --type Skill` / `--edge-type invoked
  --type Program`) over the fixtures. Rated 2: assertion-writing over
  existing harnesses; no new surface (the CLI is already type-agnostic,
  [LLP 0073 §query-surface](./0073-graph-skill-tool-nodes.design.md#query-surface)).

Sequencing notes: T2 and T3 are branch-disjoint in intent but both append to
`graph_contract.js` and `tool_facets.js`; the textual conflict is
append-order-only and trivially rebased. The `PROJECTOR_VERSION` bump lands
exactly once, in T2.

## Tasks
- id: T1  branch: task/graph-skill-tool-nodes/T1  deps: []          complexity: 2  -- kit edge props: EdgeSpec.props + buildEdge passthrough (both types.d.ts twins), id-stability tests
- id: T2  branch: task/graph-skill-tool-nodes/T2  deps: []          complexity: 4  -- Program nodes + invoked edges (#230): tool_facets.js programFrom/commandStringFrom (fail-closed), contract rules, PROJECTOR_VERSION 1->2, extraction + contract tests
- id: T3  branch: task/graph-skill-tool-nodes/T3  deps: [T1]        complexity: 5  -- Claude Skill nodes + ran edges (#229): marker/tool/slash union w/ strict offset-0 filters + builtin exclusion, dispatch props, false-positive test matrix
- id: T4  branch: task/graph-skill-tool-nodes/T4  deps: [T3]        complexity: 3  -- Codex Skill derivation: .codex/skills/<name>/SKILL.md path pattern over exec_command cmd, dispatch_shell_read, match/reject tests
- id: T5  branch: task/graph-skill-tool-nodes/T5  deps: [T2,T3,T4]  complexity: 2  -- e2e + query proof: projectGraph fixtures for all surfaces, dispatch-flag merge union, idempotence, issue #229/#230 headline SQL + neighbors traversal tests
