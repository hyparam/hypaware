# Manage clients and import history

[Documentation](README.md) / Clients and history

Use `hyp setup` to select capture integrations. An **attach** then changes the
selected client's settings so HypAware can observe new activity. **History
import** reads supported existing transcripts into the local cache.

## Choose and check a client

```sh
hyp setup
hyp client status
hyp client status codex
```

On an existing installation, choose **Reconfigure** to add a client. Team-managed
choices are locked; local additions remain yours to configure.

| Client | Capture behavior |
| --- | --- |
| Claude Code (`claude`) | OTEL events and transient raw bodies, plus transcript recovery. Requires Claude Code 2.1.193 or newer; 2.1.214 adds full tool-decision detail. |
| Codex (`codex`) | Gateway capture and local session-history import, covering CLI and Desktop. |
| OpenCode (`opencode`) | Managed global JavaScript plugin and bounded `opencode export` recovery for CLI and Desktop. |
| Claude Desktop (`claude-desktop`) | Scheduled transcript import by default. Also enables the shared Claude integration. |
| OpenClaw (`openclaw`) | Gateway routing plus a scheduled transcript recovery lane. |

Available integrations depend on active plugins and the installed version.
Check `hyp client attach --help` and `hyp client history providers` for your
installation. Raw proxy sources do not configure an AI client; use a client
integration for conversation capture.

## Attach and verify new activity

For a configured client, preview its changes and apply them:

```sh
hyp client attach codex --dry-run
hyp client attach codex
hyp client status codex
hyp status
```

Attach is safe to repeat and preserves unrelated client settings. Start a new
client process so it reads the updated configuration, complete a short turn,
then check `hyp query overview` or search for a distinctive phrase with
`hyp query grep`. Capture and cache visibility can take time to settle.

Claude Code attach writes managed environment settings in
`~/.claude/settings.json`; it uses telemetry and does not change the API base
URL. Codex attach manages a provider entry in `~/.codex/config.toml`.
OpenCode attach writes a managed global plugin file.

Claude Desktop's default transcript path does not require account sign-in or
managed inference preferences. Its shared Claude integration can also import
Claude Code history and attach Claude Code. The
[Desktop reference](CLI_REFERENCE.md#claude-desktop-commands) explains how to
control those shared behaviors and documents the optional experimental live route.

## Bring in existing history

Discover provider IDs and inspect the plan before importing:

```sh
hyp client history providers
hyp client history plan codex --json
hyp client history import codex --since 2026-09-01T00:00:00Z --dry-run
hyp client history import codex --since 2026-09-01T00:00:00Z
hyp cache status
```

Choose the provider and dates you actually want. `plan` uses provider planning
hooks; `import --dry-run` scans without writing. Inspect each provider's output
because one provider can fail while others succeed.

Import writes the local cache. If exports are configured, eligible imported
rows can subsequently leave through those sinks. Apply your
[privacy markings](PRIVACY.md) before importing sensitive history.

Some integrations run scheduled recovery automatically. A positive
`backfill.window_days` limits both join-time import and scheduled recovery;
widening it can make older history eligible on the next sweep. The adapters
differ in how `backfill.on_join` affects schedules, so consult the
[recovery reference](CLI_REFERENCE.md#scheduled-recovery-sweeps-and-backfillwindow_days)
before changing those settings.

## Stop capture or keep it local

```sh
hyp client detach codex --dry-run
hyp client detach codex
```

Detach reverses managed client settings and retains recorded history. To remove
an integration from ongoing automatic capture and history recovery, reconfigure
it with `hyp setup`; detaching settings alone does not remove configured
transcript schedules. Team policy can require an integration.

To retain capture but withhold a locally owned client's data from team sync:

```sh
hyp privacy client codex local-only
```

Returning that client to `sync` does not automatically upload previously
withheld history; `hyp sync --history codex` is a separate, confirmed replay.
For a single folder, live session, or permanent local deletion, see
[privacy controls](PRIVACY.md). For missing recordings, see
[troubleshooting](TROUBLESHOOTING.md).
