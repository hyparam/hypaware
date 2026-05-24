# Repository Guidance

HypAware is the active codebase. Prefer files under `src/`, `hypaware-core/`,
`bin/`, and root `test/`. The old `collectivus/` donor tree is not part of this
repo; do not assume its tests, package scripts, or agent notes are available
unless a task explicitly provides that context.

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
