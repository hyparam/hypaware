# Repository Guidance

HypAware is the active codebase. Prefer files under `src/`, `hypaware-core/`,
`bin/`, and root `test/`. The old `collectivus/` donor tree is not part of this
repo; do not assume its tests, package scripts, or agent notes are available
unless a task explicitly provides that context.

## Design docs (LLP)

Design rationale lives in numbered **LLP documents** under `llp/`, following
Linked Literate Programming. Start at [`llp/0000-hypaware.explainer.md`](llp/0000-hypaware.explainer.md)
for the subsystem map, and [LLP 0002](llp/0002-v1-scope.decision.md) for what
actually shipped in V1.

- **Read before you change.** Before modifying a subsystem, read the LLP tagged
  with its `Systems` value (e.g. `Sources`, `Sinks`, `Plugins`, `Config`).
- **Annotate non-obvious decisions.** When you implement or change code that
  realizes a documented, non-obvious design decision, add an annotation:
  `// @ref LLP NNNN#anchor — short gloss` (optional relation:
  `[implements]`, `[constrained-by]`, `[tests]`). Attach it directly above the
  construct — a blank line breaks attachment. Don't annotate mechanically; a
  ref must tell you something the code and filename don't.
- **Keep refs honest.** When you touch annotated code, check the referenced
  section still applies; update or remove the `@ref` if not.
- **Living docs.** Update the LLP when the design changes — land the doc edit in
  the same commit as the code. Mark retired docs `Superseded` or move them to
  `llp/tombstones/` with `Status: Tombstoned`; don't leave stale guidance.
- **Tooling lives in-repo** under `.claude/skills/` (so every clone has it):
  `/ref-check [path]` validates `@ref`s; `/ref-story <file>` shows a file's
  rationale-order view; `/llp-create <title>` scaffolds a new doc; `/llp-list`
  surveys the corpus; `/llp-grill` stress-tests a plan against the LLP corpus
  before you write code.

## Skills (`plugins-workspace`)

Agent skills live under
`hypaware-core/plugins-workspace/{claude,codex}/skills/<name>/SKILL.md`.

- **Mirror claude and codex.** A skill offered to both clients must be
  **byte-identical** across `claude/skills/` and `codex/skills/` — edit one,
  copy to the other, verify with `diff`. Client-specific skills (e.g.
  `hypaware-ignore` / `hypaware-unignore`, which are Claude-only) live only
  under the client that needs them.
- **One source of truth for the data format.** The **hypaware-query** skill
  owns *all* knowledge of the `ai_gateway_messages` schema — column names, JSON
  paths, the deduped token-spine SQL, Claude-vs-Codex column availability, and
  what transcript backfill does and doesn't populate. Every other skill that
  reads recorded data (the `hypaware-ai-*-report` skills) stays
  **schema-agnostic**: describe the analysis conceptually and defer to
  hypaware-query. Don't put column names, JSON paths, or SQL in a report skill —
  a schema change should touch only hypaware-query.
- **Reports are written for a human, not an LLM.** The `hypaware-ai-*-report`
  one-pagers follow a fixed house style:
  - open with `## Overview` (a bold, plain-English summary — never a bare
    opening line);
  - then a short **numbered list** — `## Recommended changes` (improvement) or
    `## What we found` (adoption / spend / security) — with each item's single
    most relevant **number inline**; no detached "key numbers" table;
  - lead each recommendation **problem-first, then the fix**;
  - **ban internal jargon** (no "package", "fan-out", "sidechain",
    "single-gateway" / "fleet-wide", raw "bypassPermissions" — say what you
    mean);
  - group items that share a section link under one `### subsection` (don't
    repeat the same link);
  - keep tables and depth in the per-section files — progressive disclosure: a
    short main file plus one file per section;
  - tokens are reported as **volume, never dollars**, and every figure is a
    floor.

## Code Style

- JavaScript, no semicolons.
- Types are defined in JSDoc comments, not TypeScript.
- Never use inline `import('...')` types. Declare type imports at the top of
  the file with `@import` JSDoc comments, then reference the bare names.
- Do not use `@typedef` in JSDoc. Define shared types as `interface`s in
  `.d.ts` files and import them via `@import`.

## Development Checks

- Run `npm test` for the active traditional test suite. It is intentionally
  scoped to root `test/**/*.test.js`.
- Add traditional tests for deterministic logic: config parsing and validation,
  manifest validation, daemon install rendering, path helpers, TOML transforms,
  OTLP flatteners, sink scheduling, and similar local contracts.
- Use `npm run smoke -- <flow>` for the existing hermetic smoke flows under
  `hypaware-core/smoke/flows`.
- Do not treat the hermetic smokes as the only release gate. They run with a
  temp `HYP_HOME` and `HYP_DEV_TELEMETRY=1`, which is useful for deterministic
  regression checks but does not prove installed-daemon behavior.

## Smoke Test Model

Keep three tiers distinct:

1. Traditional tests: fast, deterministic, and broad over edge cases.
2. Hermetic smokes: narrow complete workflows in a temp install, good for PR
   confidence and plugin/kernel wiring checks.
3. Acceptance smokes: heavier release or manual gates that use the packaged CLI,
   real daemon install/start/stop, real user-home style config, production-ish
   telemetry defaults, client attach behavior, and bounded disk-growth
   assertions.

Good acceptance smoke candidates:

- `installed_daemon_idle_soak`: install/start/status/stop the real daemon path,
  wait briefly while idle, and assert cache growth stays zero or bounded.
- `otel_self_loop_guard`: run without `HYP_DEV_TELEMETRY=1` and prove the daemon
  does not export into its own OTEL listener in a runaway loop.
- `codex_subscription_capture`: opt-in/manual, using real or path-faithful
  ChatGPT Codex traffic against `/backend-api/codex/responses`.
- `configured_sink_roundtrip`: use config-driven sink setup and prove rows land
  in the configured local destination.

## Log-Driven Development

When adding or changing workflows, make the app observable enough that failures
identify the broken step rather than only returning a nonzero exit code.

- Give every smoke a stable `DEV_RUN_ID`, `smoke_name`, and `smoke_step`.
- Emit structured logs/spans/metrics around entrypoints, lifecycle transitions,
  external calls, retries, validation decisions, source/sink starts, and error
  paths.
- Prefer structured attributes such as `component`, `operation`, `status`,
  `error_kind`, plugin names, dataset names, and sink/source ids.
- Verify both external behavior and emitted telemetry. A smoke should assert
  the user-visible result and the internal signal that proves the intended path
  ran.
- Keep dev telemetry local and secret-safe. Do not record credentials, raw
  prompts, private customer data, or hidden reasoning. Use hashes or short
  redacted excerpts when payload identity matters.
- After a smoke failure, inspect the run-specific logs/spans/metrics before
  changing code. Fix from evidence, then rerun the same smoke.

Useful commands:

```sh
npm test
npm run smoke -- core_boot_noop
npm run smoke -- gateway_codex_capture
npm run smoke -- daemon_foreground_start_stop
```
