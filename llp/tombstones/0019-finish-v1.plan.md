# LLP 0019: Finish V1 Plan (historical)

**Type:** Plan
**Status:** Tombstoned
**Systems:** Process
**Author:** HypAware team
**Date:** 2026-05-20
**Related:** LLP 0002

> **Tombstoned.** The executed V1 finishing plan. v1.0.0 has shipped. Its live
> `## Decisions` were lifted into [LLP 0002](../0002-v1-scope.decision.md); this
> file is kept for historical phasing only. Original body follows verbatim.

---

This replaces the old phase 10-13 path in
[`hypaware-implementation-plan.md`](hypaware-implementation-plan.md).
V1 no longer depends on extracting first-party plugins into separate
repos, moving server code out, making gascity external, or doing donor
cleanup as a release gate.

The V1 target is:

> A fresh user can run `npx hypaware`, choose what to capture, install a
> persistent daemon, attach Claude Code and/or Codex when selected, and
> query locally captured logs/traces/metrics/conversations without
> manually installing plugins or editing config.

## Decisions

- Publish and run as `hypaware`.
- Keep `hyp` as a CLI alias.
- Keep the first-run picker flow.
- When daemon install is requested from `npx hypaware`, install a
  persistent global package first, then point launchd/systemd at the
  stable global binary.
- First-party plugins remain bundled in this repo under
  `hypaware-core/plugins-workspace`.
- `@hypaware/central` and `@hypaware/gascity` are not V1 scope.
- No Collectivus config or recording migration is required for V1.

## Current Gaps

- `package.json` exposes only `hyp`, marks the package private, and does
  not provide the `hypaware` binary required by `npx hypaware`.
- The normal CLI path loads workspace plugin manifests, but does not
  activate the plugins before command dispatch. Plugin commands,
  capabilities, clients, sources, sinks, skills, and init presets are
  therefore not reliably available outside smoke-specific paths.
- The source registry can start and stop sources, and the sink driver can
  export ready partitions, but there is no primary daemon that boots the
  kernel, starts configured sources, runs sink ticks, watches config, and
  reports health.
- There is no launchd/systemd installer for HypAware yet.
- The walkthrough writes config, but the V1 `npx hypaware` path needs to
  finish the whole first-run experience: compose selected bundled
  plugins, install daemon, attach selected clients, install skills, and
  print a working first query.
- Central and gascity are present in the plugin workspace, but should be
  excluded from the V1 default path and V1 acceptance gates.

## V1 Acceptance Criteria

1. `npx hypaware` works from a fresh install and starts the picker on a
   TTY.
2. The picker can select Claude Code, Codex, raw Anthropic/OpenAI API
   capture, OTEL, local cache, and local Parquet export.
3. The generated config is explicit and reproducible at
   `~/.hyp/hypaware-config.json`.
4. The daemon is installed as a persistent user service:
   - macOS: launchd user LaunchAgent.
   - Linux: systemd user service.
5. The daemon starts all configured sources and runs the sink export loop.
6. Claude Code attach and Codex attach are idempotent and reversible.
7. Local query works against newly captured data.
8. All V1 smokes emit a `DEV_RUN_ID` and can be verified through
   `hyp query` or `ctvs query` over logs, spans, metrics, and captured
   datasets.
9. V1 docs do not claim central, gascity, repo extraction, or migration
   are part of the release.

## Non-Goals

- No external first-party plugin repos.
- No standalone server repo.
- No central/enterprise sink as a V1 gate.
- No gascity V1 gate.
- No Collectivus config migration.
- No manual plugin install step in the default V1 path.

## Phase 1 - Package And CLI Identity

Goal: make the package runnable as `npx hypaware` while preserving the
existing `hyp` command.

Files:

- [`package.json`](package.json)
- [`bin/hyp.js`](bin/hyp.js)
- New `bin/hypaware.js`, if the shared entrypoint needs a clearer name.
- README install sections.

Work:

1. Remove `"private": true` when the package is ready for pack/publish
   testing.
2. Expose both binaries:

   ```json
   {
     "bin": {
       "hypaware": "./bin/hypaware.js",
       "hyp": "./bin/hypaware.js"
     }
   }
   ```

3. Keep `bin/hyp.js` only as a compatibility shim if needed.
4. Make no-arg behavior intentional:
   - TTY: start the V1 picker walkthrough.
   - non-TTY: print concise help and exit 0.
5. Preserve `hyp smoke <flow>` as an internal developer path.
6. Add `npm pack --dry-run` coverage to ensure bundled plugin manifests,
   plugin source files, skills, and smoke harness files are included.

Smoke:

- `hyp smoke package_bin_boot`

Assertions:

- `node ./bin/hypaware.js --help` exits 0.
- `node ./bin/hypaware.js smoke core_boot_noop` still works.
- A packed tarball contains:
  - `bin/hypaware.js`
  - `src/core/**`
  - `hypaware-core/plugins-workspace/**/hypaware.plugin.json`
  - plugin entrypoints and skill assets.

Telemetry:

- Emit `command.run` for `help`, `smoke`, and no-arg dispatch.
- Attributes: `dev_run_id`, `hyp_component=cmd-dispatch`,
  `hyp_command`, `status`, `error_kind`.

## Phase 2 - One Kernel Boot Path

Goal: CLI, daemon, walkthrough, and smokes all boot the same bundled
plugin runtime.

Files:

- `src/core/cli/dispatch.js`
- `src/core/runtime/loader.js`
- `src/core/runtime/workspace.js`
- `src/core/registry/*`
- `src/core/config/schema.js`
- `src/core/config/validate.js`
- `hypaware-core/smoke/**`

Work:

1. Introduce a single `bootKernel({ configPath, hypHome, mode, runId })`
   helper.
2. Load the config, load bundled plugin manifests, resolve dependencies,
   and activate selected plugins before command dispatch.
3. Treat bundled plugins as available, not implicitly active. Active
   plugins come from config or from a command's explicit boot profile.
4. Add a V1 bundled allowlist:
   - `@hypaware/ai-gateway`
   - `@hypaware/otel`
   - `@hypaware/claude`
   - `@hypaware/codex`
   - `@hypaware/local-fs`
   - `@hypaware/format-parquet`
   - `@hypaware/format-jsonl`
5. Keep `@hypaware/central` and `@hypaware/gascity` loadable for
   developers, but exclude them from default picker options, default
   configs, V1 docs, and V1 smokes.
6. Ensure plugin-contributed commands, source registrations, sinks,
   clients, skills, and init presets are available after boot.
7. Ensure `hyp attach`, `hyp detach`, `hyp skills install`, `hyp status`,
   `hyp query`, and `hyp plugin list` use the same boot path.

Smoke:

- `hyp smoke cli_bundled_plugins_activated`

Assertions:

- `hyp plugin list` shows active bundled plugins from the generated
  config.
- `hyp attach --client claude --dry-run` reaches the Claude client
  adapter.
- `hyp attach --client codex --dry-run` reaches the Codex client adapter.
- `hyp status --json` reports configured sources and daemon state without
  requiring central or gascity.

Telemetry:

- One `kernel.boot` root span per process.
- One `plugin.activate` child span per active plugin.
- Logs for skipped bundled plugins with `status=skipped` and
  `hyp_reason=not_configured`.

## Phase 3 - Primary Daemon Runtime

Goal: implement the long-running HypAware daemon independent of
launchd/systemd installation.

Files:

- New `src/core/daemon/runtime.js`
- New `src/core/daemon/status.js`
- New `src/core/daemon/pid.js`
- New `src/core/daemon/logs.js`
- `src/core/registry/sources.js`
- `src/core/sinks/driver.js`
- `src/core/cli/core_commands.js`

Work:

1. Add daemon commands:
   - `hyp daemon run --foreground`
   - `hyp daemon status --json`
   - `hyp daemon stop`
   - `hyp daemon restart`
2. `daemon run` should:
   - boot the kernel from the selected config
   - start every configured source through `kernel.sources.start`
   - run sink ticks on an interval
   - write PID and health state under `~/.hyp/hypaware/run`
   - write daemon logs under `~/.hyp/hypaware/logs`
   - handle `SIGTERM` and `SIGINT` by stopping sources and flushing
     telemetry
3. Define the daemon health model:
   - `starting`
   - `healthy`
   - `degraded`
   - `stopping`
   - `stopped`
4. Surface per-source status using the existing source registry
   `status()` contract.
5. Surface per-sink status from the sink driver:
   - last tick time
   - last successful export
   - failed outbox count
   - next scheduled tick
6. Add a lightweight config reload path:
   - `SIGHUP` reloads config.
   - Sources with changed config call `reload`.
   - Removed sources call `stop`.
   - New sources call `start`.
   - Sink schedule changes take effect on the next tick.
7. Make foreground mode suitable for smoke tests with temp `HYP_HOME` and
   deterministic ports.

Smoke:

- `hyp smoke daemon_foreground_start_stop`

Assertions:

- Daemon reaches `healthy`.
- Configured `ai-gateway` and `otel` sources report started.
- `SIGTERM` stops both sources.
- A status file records `stopped` after shutdown.
- Traces contain `source.start`, `source.stop`, and `daemon.shutdown`.

Telemetry:

- Root span: `daemon.run`.
- Child spans: `kernel.boot`, `source.start`, `sink.tick`,
  `source.stop`, `daemon.shutdown`.
- Metrics:
  - `hyp_daemon_uptime_ms`
  - `hyp_sources_started`
  - `hyp_sink_ticks_total`
  - `hyp_sink_exports_total`

## Phase 4 - Daemon Installers

Goal: install the primary daemon as a persistent user service on macOS
and Linux.

Reference donor code:

- `collectivus/src/daemon/index.js`
- `collectivus/src/daemon/macos.js`
- `collectivus/src/daemon/linux.js`
- `collectivus/src/cli/install.js`
- `collectivus/src/cli/uninstall.js`
- `collectivus/src/cli/status.js`

Files:

- New `src/core/daemon/install.js`
- New `src/core/daemon/platform.js`
- New `src/core/daemon/macos.js`
- New `src/core/daemon/linux.js`
- `src/core/cli/core_commands.js`

Work:

1. Add user-facing commands:
   - `hyp daemon install`
   - `hyp daemon uninstall`
   - `hyp daemon start`
   - `hyp daemon stop`
   - `hyp daemon restart`
   - `hyp daemon status`
2. macOS:
   - Write `~/Library/LaunchAgents/com.hyperparam.hypaware.plist`.
   - Use `ProgramArguments` pointing at the stable global `hypaware`
     binary.
   - Pass `daemon run --foreground --config <path>`.
   - Use `RunAtLoad` and `KeepAlive`.
   - Send stdout/stderr to `~/.hyp/hypaware/logs/daemon.out.log` and
     `daemon.err.log`.
   - Manage with `launchctl bootstrap`, `bootout`, `kickstart`, and
     `print`.
3. Linux:
   - Write `~/.config/systemd/user/hypaware.service`.
   - Use `ExecStart=<global hypaware> daemon run --foreground --config
     <path>`.
   - Use `Restart=always`.
   - Manage with `systemctl --user daemon-reload`, `enable`, `restart`,
     `stop`, and `status`.
4. Add dry-run rendering for tests:
   - `hyp daemon install --dry-run --json`
   - returns the planned plist/unit content and target paths.
5. Add clear failure messages for unsupported platforms.
6. Ensure uninstall stops the service but does not remove config,
   recordings, exports, or user client settings unless explicitly asked.

Smoke:

- `hyp smoke daemon_install_render`

Assertions:

- macOS plist render includes the configured binary path, config path,
  log paths, label, and foreground daemon command.
- Linux unit render includes the configured binary path, config path,
  restart policy, and foreground daemon command.
- Rendered service files do not reference `collectivus`.

Manual V1 gate:

- macOS install/restart/status/uninstall on a real user account.
- Linux install/restart/status/uninstall on a real user account with
  systemd user services.

Telemetry:

- Spans: `daemon.install`, `daemon.uninstall`, `daemon.start`,
  `daemon.stop`, `daemon.status`.
- Logs include platform, target path, service label/name, and exit
  status from the platform manager.

## Phase 5 - Npx First-Run Flow

Goal: `npx hypaware` guides a fresh user to a working daemon-backed local
capture setup.

Files:

- `src/core/cli/walkthrough.js`
- `src/core/cli/core_commands.js`
- `src/core/config/schema.js`
- plugin client adapters under `hypaware-core/plugins-workspace/*/src`
- README quickstart

Work:

1. No args on a TTY starts the picker.
2. Picker inputs:
   - capture Claude Code conversations
   - capture Codex conversations
   - capture raw Anthropic API traffic
   - capture raw OpenAI API traffic
   - receive OTEL logs/traces/metrics
3. Export inputs:
   - keep local query cache only
   - export local Parquet files
   - configure later
4. Prompt for retention days with default `30`.
5. Compose an explicit config:
   - include only selected bundled plugins plus required dependencies
   - include `@hypaware/ai-gateway` when Claude, Codex, raw Anthropic, or
     raw OpenAI is selected
   - include Anthropic upstream when Claude or raw Anthropic is selected
   - include OpenAI upstream when Codex or raw OpenAI is selected
   - include `@hypaware/otel` when OTEL is selected
   - include `@hypaware/local-fs` and `@hypaware/format-parquet` when
     local Parquet export is selected
6. Write config to `~/.hyp/hypaware-config.json`.
7. If invoked through `npx` and the user chooses daemon install:
   - install the stable global package first
   - resolve the global `hypaware` binary
   - install launchd/systemd service pointing at that binary
8. Attach selected clients:
   - Claude Code via the Claude plugin adapter
   - Codex via the Codex plugin adapter
9. Offer skill installation for selected clients:
   - Claude skills to `~/.claude/skills`
   - Codex skills to `~/.codex/skills`
10. Start or restart the daemon.
11. Print:
   - config path
   - daemon status
   - client attach results
   - first query command

Non-interactive flags:

- `hypaware init --yes`
- `hypaware init --no-daemon`
- `hypaware init --client claude`
- `hypaware init --client codex`
- `hypaware init --source otel`
- `hypaware init --export local-parquet`
- `hypaware init --retention-days 30`
- `hypaware init --from-file <config.json>`

Smoke:

- `hyp smoke walkthrough_picker_to_first_query`

Assertions:

- A temp HOME and temp HYP_HOME are used.
- Non-interactive picker selections generate a config containing the
  expected plugin list and upstreams.
- Dry-run daemon install chooses the stable binary path.
- Claude and Codex attach dry-runs produce expected file edits without
  touching the real HOME.
- The daemon foreground smoke captures at least one synthetic AI gateway
  exchange and one OTEL log.
- `hyp query` can read the captured rows by `DEV_RUN_ID`.

Telemetry:

- Spans: `walkthrough.start`, `walkthrough.pick`,
  `walkthrough.write_config`, `daemon.install`, `client.attach`,
  `skills.install`, `walkthrough.finish`.
- Logs include selected source ids, selected export ids, retention days,
  and attach outcomes.

## Phase 6 - Claude And Codex Attach Hardening

Goal: selected clients are wired correctly, idempotently, and reversibly.

Files:

- `hypaware-core/plugins-workspace/claude/src/**`
- `hypaware-core/plugins-workspace/codex/src/**`
- `src/core/cli/core_commands.js`
- `hypaware-core/smoke/**`

Work:

1. Add `--dry-run` and JSON output to attach/detach commands where
   missing.
2. Ensure Claude attach writes only the needed settings keys and preserves
   unrelated user settings.
3. Ensure Codex attach writes a `hypaware` provider using:
   - `base_url = "http://127.0.0.1:<gateway-port>/v1"`
   - Responses API support.
   - OpenAI auth behavior compatible with Codex.
4. Ensure detach only removes HypAware-managed settings.
5. Add idempotency tests:
   - attach twice has no duplicate settings
   - detach twice succeeds
   - attach after detach restores the expected state
6. Ensure attach fails clearly if the generated config did not include
   `@hypaware/ai-gateway`.

Smoke:

- `hyp smoke client_attach_idempotent`

Assertions:

- Temp Claude settings and temp Codex config are modified as expected.
- Attach/detach operations leave unrelated keys intact.
- Attach emits `client.attach` telemetry with `status=ok`.
- Missing gateway emits `status=failed` and
  `error_kind=cap_missing`.

## Phase 7 - Local Capture, Query, And Export Gate

Goal: prove the daemon captures real local data and makes it queryable.

Files:

- `hypaware-core/plugins-workspace/ai-gateway/src/**`
- `hypaware-core/plugins-workspace/otel/src/**`
- `hypaware-core/plugins-workspace/local-fs/src/**`
- `hypaware-core/plugins-workspace/format-parquet/src/**`
- `src/core/sinks/driver.js`
- `src/core/query/**`
- `hypaware-core/smoke/**`

Work:

1. AI gateway:
   - verify Anthropic upstream passthrough
   - verify OpenAI `/v1` passthrough
   - verify `/v1/responses` capture for Codex
   - verify failed upstream responses are recorded with status and error
     fields
2. OTEL:
   - verify logs, traces, and metrics are accepted through OTLP HTTP
   - verify daemon self-telemetry loops back into local storage
3. Local query:
   - verify `hyp query` can read AI gateway, logs, traces, and metrics
   - verify queries can filter by `DEV_RUN_ID`
4. Local export:
   - verify local-fs sink exports Parquet batches
   - verify failed exports land in the failed outbox
   - verify forced export works from CLI

Smokes:

- `hyp smoke gateway_claude_capture`
- `hyp smoke gateway_codex_capture`
- `hyp smoke otel_loopback_capture`
- `hyp smoke local_parquet_export`

Assertions:

- Every smoke writes at least one row to its target dataset.
- Every smoke can query those rows by `DEV_RUN_ID`.
- Exported Parquet files can be read back and contain the expected
  dataset rows.
- Daemon self-telemetry includes source start, request capture, sink
  tick, export success, and shutdown spans.

## Phase 8 - Status, Diagnostics, And Repair

Goal: users can tell whether HypAware is working and get actionable
repair commands.

Files:

- `src/core/cli/core_commands.js`
- `src/core/daemon/status.js`
- `src/core/config/validate.js`
- README troubleshooting section

Work:

1. `hyp status` should show:
   - config path
   - daemon installed/running state
   - active plugins
   - source status
   - sink/export status
   - Claude attach state
   - Codex attach state
   - recent error count
2. `hyp status --json` should return stable machine-readable output for
   smokes and support tools.
3. Add validation diagnostics for common broken states:
   - configured client without ai-gateway
   - Codex selected without OpenAI upstream
   - Claude selected without Anthropic upstream
   - local export selected without encoder
   - port conflict on source start
   - daemon installed with missing binary
4. Add repair suggestions:
   - `hyp daemon restart`
   - `hyp daemon install`
   - `hyp attach --client claude`
   - `hyp attach --client codex`
   - `hyp init --from-file <path>`

Smoke:

- `hyp smoke status_diagnostics`

Assertions:

- Healthy config reports healthy.
- Broken config reports degraded with specific diagnostics.
- JSON status includes no central or gascity requirements.

## Phase 9 - Docs And Release Gate

Goal: make V1 understandable, testable, and releasable.

Files:

- `README.md`
- `hypaware-design.md`, only if the design needs a V1 scope note
- `package.json`
- `finish-v1.md`

Work:

1. Update README quickstart:
   - `npx hypaware`
   - what the picker does
   - where config lives
   - where data lives
   - how to query
   - how to attach/detach Claude and Codex
   - how to install/uninstall/restart daemon
2. Document V1 scope:
   - bundled plugins
   - local capture
   - local query
   - local Parquet export
   - Claude Code and Codex attach
   - macOS/Linux user daemon
3. Document out-of-scope:
   - central
   - gascity
   - repo extraction
   - Collectivus migration
4. Add release checklist:
   - `npm test`, if present
   - `npm run lint`, if present
   - `npm run typecheck`, if present
   - `npm pack --dry-run`
   - all V1 smokes
   - manual daemon install on macOS
   - manual daemon install on Linux
5. Decide version bump:
   - for the first public V1 package, use `1.0.0`
   - remove pre-V1 wording from README and package description

Final V1 smoke command:

```sh
hyp smoke package_bin_boot
hyp smoke cli_bundled_plugins_activated
hyp smoke daemon_foreground_start_stop
hyp smoke daemon_install_render
hyp smoke walkthrough_picker_to_first_query
hyp smoke client_attach_idempotent
hyp smoke gateway_claude_capture
hyp smoke gateway_codex_capture
hyp smoke otel_loopback_capture
hyp smoke local_parquet_export
hyp smoke status_diagnostics
```

Final manual gate:

```sh
npm pack
npx ./hypaware-*.tgz
hypaware status
hypaware daemon restart
hypaware query "select count(*) from ai_gateway_messages"
hypaware query "select count(*) from traces"
hypaware query "select count(*) from logs"
hypaware daemon uninstall
```

## Implementation Order

1. Package/bin identity.
2. Shared kernel boot and bundled plugin activation.
3. Foreground daemon runtime.
4. Daemon install renderers and platform commands.
5. First-run picker completing config, attach, skills, daemon install,
   and daemon start.
6. Claude/Codex attach hardening.
7. Local capture/query/export smokes.
8. Status diagnostics.
9. README and release gate.

The key dependency is phase 2. Until normal CLI boot activates bundled
plugins, daemon work and `npx hypaware` work will keep hitting false
capability and command gaps.

