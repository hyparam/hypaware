# LLP 0001: Adopting Linked Literate Programming in HypAware

**Type:** Plan
**Status:** Active
**Systems:** Docs, Process
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0000, ~/workspace/llp/llp/0000-linked-literate-programming.explainer.md

> This document is itself written in the LLP house style so it doubles as the
> first worked example. Waves 0–2 of the rollout below have been executed.
>
> **Numbering note:** the proposed map in this doc was authored before
> scaffolding. During execution an `0002 V1 scope` Decision was inserted (lifting
> live decisions out of the tombstoned `finish-v1` plan), shifting subsystem
> numbers up by one — e.g. Sources is **0012**, not 0011. The authoritative
> final numbering is the subsystem map in [LLP 0000](./0000-hypaware.explainer.md#subsystem-map).

## Summary

HypAware already has rich design rationale, but it lives in three large
monolithic markdown files plus a glossary. None of it is addressable at section
granularity, so code cannot point at it and agents must read whole files to
recover intent. This plan adopts LLP **closely to spec** and **decomposes** the
monolithic docs into a numbered, `Systems`-tagged LLP corpus that code can
`@ref` into.

Decisions already taken (this session):

1. **Deliverable:** adoption plan first (this doc), scaffolding only after review.
2. **Legacy docs:** decompose `hypaware-design.md` into per-subsystem LLPs.
3. **Fidelity:** follow the LLP spec as written (metadata headers,
   `NNNN-slug.type.md`, `tombstones/`, relation types, heading-slug anchors).

## Current state

| Artifact | Size | LLP fate |
|---|---|---|
| `hypaware-design.md` | 52k | **Decompose.** `## Design Decisions` (L244–963) → one LLP per subsystem. `## Mission` + `## Design Summary` → root LLP 0000. `## Open Questions` → `Issue` LLPs or fold into owning subsystem LLP. |
| `hypaware-implementation-plan.md` | 46k | **Tombstone.** Phased build plan, v1.0.0 shipped → `Type: Plan`, `Status: Tombstoned`. Historical, still useful for migration context. |
| `finish-v1.md` | 21k | **Tombstone.** Same: executed v1 plan. The `## Decisions` block (L16) is worth lifting into live Decision LLPs before tombstoning. |
| `CONTEXT.md` | 2.4k | **Keep + promote.** Already a `[[wiki-link]]` glossary. Becomes the canonical terms feeding the `Systems` vocabulary and several Spec LLPs (esp. Sources). Stays as the glossary; LLPs link into it. |
| `.feature-flow/*.md` | — | **Leave.** Process/integration artifacts on a different axis from design rationale. Out of LLP scope. |
| `AGENTS.md` | 3.7k | **Extend.** Add the LLP section (read-before-change, `@ref` policy, living-doc rule). |

Note: the `grill-with-docs` / `improve-codebase-architecture` skills assume a
`docs/adr/` tree that does not exist here. LLP's `Decision` type subsumes ADRs.
**Decision (this session): ignore those skills** — they are not repointed and
`docs/adr/` stays absent. LLP `Decision` LLPs are the home for that content.

## Conventions adopted (spec-faithful)

- **Location & filename:** `llp/NNNN-slug.type.md`, zero-padded to 4 digits.
  Flat to start; subdirectory buckets only once a subsystem spawns multiple LLPs.
- **Metadata header:** plain markdown block (not YAML) — `Type`, `Status`,
  `Systems`, `Author`, `Date` required; `Role`, `Revised`, `Related` optional.
- **Anchors:** heading slugs (`#token-strategy`) as default — they survive
  restructuring, which matters because these are living docs. Numbered anchors
  only for settled Spec docs.
- **`@ref` syntax:** `// @ref LLP NNNN#anchor — gloss` (≤80-char gloss).
  Relation types (`[implements]`, `[constrained-by]`, `[tests]`, `[explains]`)
  used where they sharpen agent retrieval, not mechanically.
- **Living-doc rule:** update in place; `Superseded` or `tombstones/` +
  `Tombstoned` when retired; delete when worthless (git holds history).
- **Co-evolution:** `@ref` annotations land in the same commit as the code they
  describe; LLP edits land with the code change that motivates them.

## Proposed Systems vocabulary

Drawn from the design-doc subsystems and `src/` layout. **Needs your sign-off —
this becomes the controlled vocabulary every LLP tags against.**

`Core`, `Plugins`, `CLI`, `Config`, `Onboarding`, `Sources`, `Cache`, `Sinks`,
`Query`, `Gateway`, `Daemon`, `Server`, `Docs`, `Process`

## Proposed decomposition map

One row ≈ one LLP. Source column is the section of `hypaware-design.md` (by
heading) it's lifted from. Numbers are a **proposal** — easy to renumber before
anything references them.

| LLP | Title | Type | Systems | Source section |
|---|---|---|---|---|
| 0000 | HypAware (root overview) | Explainer · Root | Core | Mission, Design Summary |
| 0002 | Core vs plugin surface | Spec | Core | Core vs Plugin Surface; What the core/server package does |
| 0003 | Activation, paths, state dirs | Spec | Core | Activation |
| 0004 | Plugin manifest | Spec | Plugins | Plugin Manifest, Manifest |
| 0005 | Dependencies & capabilities | Spec | Plugins | Dependencies and Capabilities |
| 0006 | Plugin install & lock file | Decision | Plugins | Plugin Install and Locking |
| 0007 | Plugin runtime dependencies | Decision | Plugins | Plugin Runtime Dependencies |
| 0008 | CLI registry & bridge | Spec | CLI | CLI Registry, Command Registry |
| 0009 | Config model v2 & migrator | Spec | Config | Config Model |
| 0010 | Setup & first-run wizard | Decision | Onboarding | Setup and Onboarding, Init Presets |
| 0011 | Sources model | Spec | Sources | Sources (+ CONTEXT.md glossary) |
| 0012 | Local query cache & lifecycle | Decision | Cache | Local Query Cache |
| 0013 | Sinks driver & scheduling | Spec | Sinks | Sinks |
| 0014 | Query, datasets & collect | Spec | Query | Query and Datasets, Collect Command |
| 0015 | AI gateway as a plugin | Decision | Gateway | AI Gateway as a Plugin |
| 0016 | Daemon runtime & installers | Decision | Daemon | (finish-v1 Phases 3–4) |
| — | Implementation plan (v1) | Plan · Tombstoned | Process | whole file |
| — | Finish-v1 plan | Plan · Tombstoned | Process | whole file |

**Judgement calls applied:** merged Query + Collect into 0014 (`collect` is a
query verb). Kept Core-vs-plugin (0002) separate from activation/paths (0003),
and install/lock (0006) separate from runtime deps (0007) — each pair is two
genuinely distinct concerns, and over-merging just rebuilds the monolith we're
breaking up. Net: 17 active LLPs (0000–0016) + 2 tombstones.

Sinks sub-topics that shipped recently (s3 / parquet / iceberg — cf. the
`.feature-flow/` docs and the `feat/s3-query-sources` branch) likely become
child LLPs under a `llp/sinks/` bucket once 0013 exists, rather than crowding
the flat tree now.

## Rollout (staged, not one-shot)

You chose full decomposition; LLP 0002 (retrofit) warns against converting
everything in a single pass. Reconciliation: **plan the whole map now, execute
in waves, validate the pattern on one exemplar before the bulk.**

- **Wave 0 — scaffold (1 PR).** `llp/`, `tombstones/`, LLP 0000 root from
  Mission+Summary, AGENTS.md LLP section. Move the two plan docs into
  `llp/tombstones/` with `Tombstoned` status. No code `@ref`s yet.
- **Wave 1 — exemplar (1 PR).** **Decided: Sources (0011)** — it already has
  glossary scaffolding in CONTEXT.md and active S3/iceberg work. Write the LLP,
  add `@ref`s to the real source files, confirm the loop feels right. This is
  the dogfood test before scale.
- **Wave 2 — bulk decomposition (batched PRs).** Remaining rows, grouped by
  Systems, reviewed in small batches. Module-level `@ref`s at each subsystem
  entry point; function-level only where non-obvious.
- **Wave 3 — boy-scout maintenance.** No more bulk passes. References added/
  updated when code is touched, per the spec's agent policy.

## Tooling

`ref-check` (extract/resolve/index/annotate) is **specified but unbuilt** in the
LLP repo — the `ref-check` skill is a prompt, not a validator binary.

**State:** only `llp-init` is currently vendored into `~/.claude/skills/`. The
other five (`llp-create`, `llp-list`, `llp-review`, `ref-check`, `ref-story`)
still need copying from `~/workspace/llp/skills/`. Do that first — it's the
zero-build path to the agent-facing workflow.

Then: build a **minimal extractor + resolver** (~a few hundred lines JS,
no-semicolon house style) — grep `@ref`, validate the LLP number and `#anchor`
exist — wired into `npm test` as a cheap correctness gate, once the corpus
passes ~10 LLPs and broken-ref risk becomes real. The `ref-check` skill drives
the agent workflow until then.

## AGENTS.md insertion (preview)

A new `## Design docs (LLP)` section telling agents: LLPs live in `llp/`; read
the ones tagged with the `Systems` you're touching before changing code; add
`@ref LLP NNNN#anchor — gloss` when implementing a non-obvious documented
decision; update the LLP (not just the code) when the design changes; never
leave a stale `@ref`.

## Resolved this session

- **Numbering:** no constraint — assigned at scaffolding time, freely renumbered.
- **Exemplar:** Sources.
- **ADR skills:** ignored, not repointed.
- **Tooling:** all seven LLP skills vendored into `~/.claude/skills/`; build the
  validator later.
- **Decomposition map:** finalized (my judgement) — 17 active + 2 tombstones,
  Query/Collect merged, the other two borderline pairs kept split.
- **Tombstone vs supersede:** **tombstone** both plan docs. v1.0.0 shipped, so
  they are executed history, not live guidance. Lift `finish-v1`'s `## Decisions`
  block into live Decision LLPs first, then move both to `llp/tombstones/`.

## Open questions for you

None blocking. The plan is ready to execute from Wave 0 on your go.
