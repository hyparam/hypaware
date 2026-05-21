# Claude Code Notes

HypAware is the active project in this repository. The old `collectivus/` donor
tree is not part of the repo; prefer files under `src/`, `hypaware-core/`,
`bin/`, and root `test/`.

## Testing Discipline

Use the right test tier for the job:

- `npm test` runs the active traditional Node test suite. Add to this suite for
  pure or deterministic behavior: parsers, validators, manifest handling,
  daemon renderers, TOML edits, OTLP normalizers, scheduling, and path logic.
- `npm run smoke -- <flow>` runs a hermetic workflow smoke. These smokes use a
  temp `HYP_HOME` plus `HYP_DEV_TELEMETRY=1`, so they are good regression tests
  for kernel/plugin wiring but not proof that a real installed daemon works.
- Acceptance smokes should be few and heavier. Use them for release confidence:
  packaged CLI, real daemon lifecycle, real config/home interactions,
  production-ish OTEL defaults, client attach behavior, and disk-growth bounds.

Use `npm test` for the active root suite.

## Log-Driven Development

When implementing a workflow or smoke, instrument the path so the next failure
is diagnosable:

- Stamp each run with `DEV_RUN_ID`; include `smoke_name` and `smoke_step` in
  smoke telemetry.
- Emit structured logs/spans/metrics around entrypoints, lifecycle transitions,
  external calls, retries, validation decisions, source/sink starts, and error
  paths.
- Assertions should cover the external result and the telemetry evidence that
  the intended internal route was exercised.
- Keep telemetry local and redacted. Never capture credentials, raw private
  prompts, customer data, or hidden reasoning.
- If a smoke fails, inspect run-specific telemetry before editing code. Then
  rerun the exact same smoke to close the loop.

Acceptance smoke examples to preserve as product-level gates:

- Installed daemon idle soak with bounded cache growth.
- OTEL self-loop guard without `HYP_DEV_TELEMETRY=1`.
- Codex subscription/path-faithful capture through
  `/backend-api/codex/responses`.
- Configured sink roundtrip using real config-driven sink instantiation.

Common commands:

```sh
npm test
npm run smoke -- core_boot_noop
npm run smoke -- daemon_foreground_start_stop
```
