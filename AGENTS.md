# Repository Guidance

HypAware is the active codebase. Prefer files under `src/`, `hypaware-core/`,
`bin/`, and root `test/`. The old `collectivus/` donor tree is not part of this
repo; do not assume its tests, package scripts, or agent notes are available
unless a task explicitly provides that context.

## Adding things

Make the smallest change that fixes the problem. When a bigger change looks
right, land the small one and file the bigger one as a GitHub issue instead of
building it.

- **No new runtime dependencies.** Use the standard library and the code already
  here. If nothing here can do the job, keep the fix small and file an issue.
- **Do not invent columns, config keys, or schema fields.** Reuse or derive.
  Add one only when the task calls for it, and a rejected one stays rejected.
- **Reuse before you add** a file, helper, wrapper, or abstraction, unless the
  existing one is the wrong home for it.
- **Stop when tests pass.** Note unasked-for docs, cleanups, or adjacent fixes
  in the PR description; do not land them.

## Design docs (LLP)

Design rationale lives in numbered **LLP documents** under `llp/`, following
Linked Literate Programming. Start at [`llp/0000-hypaware.explainer.md`](llp/0000-hypaware.explainer.md)
for the subsystem map, and [LLP 0002](llp/0002-v1-scope.decision.md) for what
actually shipped in V1.

- **Most changes need no LLP.** Bug fixes, null handling, tests, renames,
  behavior-preserving refactors, and version bumps get none. Write one when a
  real design decision is made or changed, not as a record of a fix.
- **Read before you change.** Before modifying a subsystem, read the LLP tagged
  with its `Systems` value (e.g. `Sources`, `Sinks`, `Plugins`, `Config`).
- **Annotate non-obvious decisions.** When you implement or change code that
  realizes a documented, non-obvious design decision, add an annotation:
  `// @ref LLP NNNN#anchor: short gloss` (with an optional relation before the
  colon: `[implements]`, `[constrained-by]`, `[tests]`, e.g.
  `// @ref LLP NNNN#anchor [implements]: short gloss`). Attach it directly above
  the construct; a blank line breaks attachment. Don't annotate mechanically; a
  ref must tell you something the code and filename don't.
- **Keep refs honest.** When you touch annotated code, check the referenced
  section still applies; update or remove the `@ref` if not.
- **Living docs.** Update the LLP when the design changes: land the doc edit in
  the same commit as the code. Mark retired docs `Superseded` or move them to
  `llp/tombstones/` with `Status: Tombstoned`; don't leave stale guidance.
- **Accepted docs are settled.** Once an LLP is `Accepted` or `Active`, do not
  edit what it settled. Change the design by extending it (a new LLP, noted on
  the old doc's `Extended-by:` line) or by replacing it with a new LLP and
  marking the old one `Superseded`. Mechanical edits are still fine: typos,
  broken links, status changes, and renumbering that does not change meaning
  (LLP 0156).
- **Tooling lives in-repo** under `.claude/skills/` (so every clone has it):
  `/ref-check [path]` validates `@ref`s; `/ref-story <file>` shows a file's
  rationale-order view; `/llp-create <title>` scaffolds a new doc; `/llp-list`
  surveys the corpus; `/llp-grill` stress-tests a plan against the LLP corpus
  before you write code.
- **A new number comes from `node scripts/llp-numbers.js next`**, after a
  `git fetch --prune`. Numbers are minted on every branch at once, so the tree
  you have checked out is not the corpus: three branches each read
  `max(llp/) + 1` and each got the same answer (issue #907). The same script
  gates it: `check` in the `cross-branch-numbers` CI job, which fetches every
  branch first, and in `npm test` wherever the clone carries them (a shallow or
  single-branch checkout skips it and says so). `survey` shows every collision
  across every ref.

## Code Style

- JavaScript, no semicolons.
- No em dashes (the U+2014 character) anywhere: code, comments, JSDoc, strings,
  or docs. In prose, use the punctuation the sentence wants (a comma, colon,
  parentheses, or a sentence split); in runtime strings, prefer `-`.
- Types are defined in JSDoc comments, not TypeScript.
- Never use inline `import('...')` types. Declare type imports at the top of
  the file with `@import` JSDoc comments, then reference the bare names.
- Do not use `@typedef` in JSDoc. Define shared types as `interface`s in
  `.d.ts` files and import them via `@import`.
- **Type-import specifiers are repo-root-anchored `.js` paths.** Inside `src/`,
  write `@import { Foo } from '../../src/core/types.js'` (route up to the repo
  root, then back down through `src/...`, with a `.js` extension), not
  `from './types.d.ts'`. The published declaration build (`npm run build:types`,
  `tsconfig.build.json`, `rootDir: src` to `outDir: types`) emits `.d.ts` into a
  parallel `types/` tree; a root-anchored specifier resolves identically from
  both `src/<P>/x.js` and the generated `types/<P>/x.d.ts`, so consumers of the
  published package get real types instead of `any`. A bare `./types.d.ts`
  resolves in `src` but dangles in `types/`. Imports of the root kernel contract
  (`hypaware-plugin-kernel-types.js`) and `hypaware-core/...` already reach
  the root, so they only need the `.js` extension. This is the icebird-style
  no-copy convention.

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
   assertions. Written procedures live in
   [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md); a human runs them before a
   release that touched the relevant adapter, and they are never simulated
   with fixtures.

Written acceptance procedures:

- `codex_desktop_capture`: opt-in/manual, needs Codex Desktop on a real Mac.
  Proves Desktop traffic reaches `ai_gateway_messages` by both the live
  gateway route and the `~/.codex/sessions` backfill route, and is
  attributable via `entrypoint`. See `docs/ACCEPTANCE.md`.
- `openclaw_capture`: opt-in/manual, needs OpenClaw with both `anthropic` and
  `openai` credentials. Proves both capture lanes (live gateway and the
  scheduled transcript sweep) and that a turn both lanes observe settles to
  one row. See `docs/ACCEPTANCE.md`.
- `claude_otel_shape_check`: opt-in/manual, needs a real Claude Code 2.1.214
  or newer. The release gate against upstream drift on the OTEL attach path:
  proves the installed Claude Code still honors the managed `env` block and
  still emits the event names, attributes, and raw body fields the telemetry
  listener reads, then checks the rows and the `hyp status` capture-health
  line agree. See `docs/ACCEPTANCE.md`.

Good acceptance smoke candidates (no written procedure yet):

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

## Session hygiene

- Close working sessions at the end of the day. Before closing a session you
  intend to continue, ask the agent for a continuation summary: open questions,
  key file paths, decisions made, and the next step. Start the next day's
  session from that summary instead of reopening the old session.
- A session reopened on a later day re-reads its entire history on every
  exchange. If a session has crossed a day boundary and its history no longer
  informs the current step, start fresh.
- Long autonomous runs (loops, overnight workflows) are exempt: they manage
  their own context.

## Edit rules

- Read a file (or the region you will change) before your first Edit to it in
  a session, and re-read it before retrying any failed Edit; the failure
  usually means the file changed underneath you (a formatter or another agent).
- If the same Edit fails twice, stop retrying: re-read, rebuild the edit from
  the current content, or fall back to Write.

## Repository layout

```
src/
  core/                 # the kernel
    observability/      # tracer, logger, meter, attrs, span helpers
    manifest.js
    dep_graph.js
    registry/           # capabilities, commands, datasets, sources, sinks
    runtime/            # paths, activation, loader, daemon runtime
    cache/              # intrinsic Iceberg-backed cache
    cli/                # dispatch, walkthrough, core_commands
    config/             # v2 schema, validator
    daemon/             # platform installers (launchd / systemd) + lifecycle
    otlp/               # shared OTLP http/json listener machinery
    plugin_install/     # resolver, fetch, lock, update_check
    sinks/              # cron driver + encoder utility
hypaware-core/
  smoke/                # `hyp smoke <name>` flows
  plugins-workspace/
    ai-gateway/         # @hypaware/ai-gateway
    otel/               # @hypaware/otel
    local-fs/           # @hypaware/local-fs
    format-parquet/     # @hypaware/format-parquet
    format-jsonl/       # @hypaware/format-jsonl
    claude/             # @hypaware/claude
    codex/              # @hypaware/codex
    central/            # @hypaware/central (bundled, opt-in via `hyp join`)
    gascity/            # @hypaware/gascity (bundled, opt-in)
bin/
  hypaware.js           # CLI entrypoint (bound to both `hypaware` and `hyp`)
```

## Release checklist

Run before tagging a new HypAware release:

```sh
npm test                  # if a test script is present
npm run typecheck         # if a typecheck script is present
npm pack --dry-run        # verify the published file set
```

Re-run the smoke battery and confirm every one is green:

```sh
hyp smoke package_bin_boot
hyp smoke cli_bundled_plugins_activated
hyp smoke daemon_foreground_start_stop
hyp smoke daemon_install_render
hyp smoke walkthrough_picker_to_first_query
hyp smoke client_attach_idempotent
hyp smoke gateway_claude_capture
hyp smoke gateway_codex_capture
hyp smoke claude_telemetry_capture
hyp smoke hypignore_capture_drop
hyp smoke local_only_export_withhold
hyp smoke source_optout_export_withhold
hyp smoke otel_loopback_capture
hyp smoke local_parquet_export
hyp smoke status_diagnostics
```

Finally, exercise the manual gate end-to-end on at least one macOS host
and one Linux host:

```sh
npm pack
npx ./hypaware-*.tgz
hypaware status
hypaware daemon restart
hypaware query sql "select count(*) from ai_gateway_messages"
hypaware query sql "select count(*) from traces"
hypaware query sql "select count(*) from logs"
hypaware daemon uninstall
```

If the release touched a client adapter, run the matching procedure in
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) and record the result in the
release notes.

If the release touched the **claude** adapter (`@hypaware/claude`, the
telemetry listener, the body spool, or the attach settings writer), the
matching procedure is
[`claude_otel_shape_check`](docs/ACCEPTANCE.md#claude_otel_shape_check). It is
not optional for those releases and it is not substitutable by the hermetic
smokes: `claude_telemetry_capture` POSTs a fixture we wrote, so it agrees with
itself no matter what upstream did. Only a real Claude Code can tell you it
renamed an event, dropped a flag, or changed the raw body format, and the
failure mode is silent (null columns, not an error). Record the observed
`claude --version` and the full event-name list in the release notes so the
next release has a baseline to diff against.

<!-- neutral:llp-conventions -->
## LLP conventions

Design rationale lives in numbered **LLP** documents under `llp/`, driven by neutral.

- **Immutable docs; change is a new request.** An Accepted/Active LLP is a
  *record*, not a worksheet: do not edit what it decided or required. To change
  intent, mint a **new request** (`rfc`/`spec`/`issue`) that `@ref`s what it
  supersedes, and append a `Superseded-by:`/`Extended-by: LLP NNNN` forward-ref to
  the applicable parts of the old doc. Trivial editorial fixes (typos, links,
  forward-refs) are fine; Drafts are still editable.
<!-- /neutral:llp-conventions -->
