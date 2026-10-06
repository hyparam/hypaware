[← All documentation](README.md)

---

# Manage clients and import history

Use `hyp setup` to choose which AI clients to record. Setup configures those
clients and imports supported session history. You can also run
`hyp attach <client>` to configure a client and `hyp backfill <provider>` to
import history.

## Contents

- [Choose and check a client](#choose-and-check-a-client)
- [Attach and verify new activity](#attach-and-verify-new-activity)
- [Bring in existing history](#bring-in-existing-history)
- [Stop capture or keep it local](#stop-capture-or-keep-it-local)
- [Collect GitHub activity](#collect-github-activity)
- [Install client skills](#install-client-skills)

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
| Codex (`codex`) | Scheduled import of the shared local session rollouts, covering CLI and Desktop. Gateway capture is an explicit `capture_mode` opt-in. |
| OpenCode (`opencode`) | Managed global JavaScript plugin and bounded `opencode export` recovery for CLI and Desktop. |
| Claude Desktop (`claude-desktop`) | macOS-only transcript import every five minutes by default. Also enables the shared Claude integration. |
| OpenClaw (`openclaw`) | Gateway routing plus scheduled transcript recovery. |
| Cursor (`cursor`) | Native session recovery for the Cursor editor and CLI, including the file contents and command output its tools see. Token usage is not available. |
| Hermes Agent (`hermes`) | Reads Hermes's local state database read-only: a backfill plus ongoing polling. Makes no changes to Hermes. |
| Pi (`pi`) | A managed Pi extension plus bounded recovery of native sessions, including recent history. |

Available integrations depend on active plugins and the installed version.
Check `hyp plugin list` and `hyp backfill list` for your
installation. Raw proxy sources do not configure an AI client; use a client
integration for conversation capture.

## Attach and verify new activity

For a configured client, preview its changes and apply them:

```sh
hyp attach codex --dry-run
hyp attach codex
hyp client status codex
hyp status
```

Attach is safe to repeat and preserves unrelated client settings. Start a new
client process so it reads the updated configuration, complete a short turn,
then check `hyp query overview` or search for a distinctive phrase with
`hyp query grep`. Capture and cache visibility can take time to settle.

For missing recordings, see [troubleshooting](TROUBLESHOOTING.md#no-new-recordings).

## Bring in existing history

Discover provider IDs and preview the scan before importing:

```sh
hyp backfill list
hyp backfill codex --since 2026-09-01T00:00:00Z --dry-run
hyp backfill codex --since 2026-09-01T00:00:00Z
hyp cache status
```

Both `codex` and `--since` are optional. Omit the provider to import from all
enabled providers; use `--since` to choose a start date. Without it, the import
uses the configured history window.

`backfill --dry-run` scans and
projects without writing, so it previews the result but is not a cheap probe.
Inspect each provider's output because one provider can fail while others
succeed.

Import writes the local cache. If exports are configured, eligible imported
rows can subsequently leave through those sinks. Apply your
[privacy markings](PRIVACY.md) before importing sensitive history.

Some integrations run scheduled recovery automatically. A positive
`backfill.window_days` limits both join-time backfill and scheduled recovery;
widening it can make older history eligible on the next sweep. `hyp detach` stops a client's schedules. The adapters
differ in how `backfill.on_join` affects schedules, so consult the
[recovery reference](CLI_REFERENCE.md#scheduled-recovery-sweeps-and-backfillwindow_days)
before changing those settings.

## Stop capture or keep it local

```sh
hyp detach codex --dry-run
hyp detach codex
```

Detach stops recording this client: no new sessions from it reach the cache,
including the scheduled transcript imports, and the running daemon picks this
up without a restart. Detach also reverses the client's managed settings.
Recorded history is kept; [`hyp privacy purge`](PRIVACY.md) deletes it.
`hyp status` then shows the client as "Not recording". Run `hyp attach codex`
to record it again. If team policy requires the integration, detach refuses
and changes nothing.

To keep a client's recordings local, exclude a directory or session, or delete
recorded rows, use [privacy controls](PRIVACY.md). For missing recordings, see
[troubleshooting](TROUBLESHOOTING.md).

## Collect GitHub activity

The optional `@hypaware/github` integration records repository activity alongside
AI sessions. It captures structural metadata for issues, pull requests, commits,
files, reviews, and comments; their content remains on GitHub.

With the integration enabled, sign in and check access:

```sh
hyp github login
hyp github status
```

GitHub's `repo` authorization scope includes write access, although HypAware only
reads. Review the repositories selected in the plugin configuration. Use
`hyp github backfill owner/repo` to import existing activity or `hyp github sync`
to poll now. See the [GitHub reference](CLI_REFERENCE.md#collect-github-activity)
for authentication and import behavior.

## Install client skills

Setup and `hyp attach` automatically install HypAware's skills in supported
clients so your agent can look up recorded sessions. To reinstall the skills:

```sh
hyp client skills install
```

This installs skills for all eligible clients. For launching an agent on a
question, see [queries](QUERYING.md#explore-recordings-with-your-agent).
