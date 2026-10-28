# NanoClaw

**Status:** Supported. **Client id:** `nanoclaw` (explicit configuration). **Backfill:** Yes.

HypAware reads NanoClaw v2's local group catalog and native Claude transcripts,
read-only. It recovers retained sessions every five minutes, including rotated
transcripts and subagents. Model requests continue directly to the provider;
HypAware does not change NanoClaw's settings or credentials.

## What is recorded

Prompts, assistant responses, tool calls/results, and token usage present in
the native Claude records. Native session and message IDs are preserved, and
usage is counted once per response. Rows use `ai_gateway_messages` with
`client_name = 'nanoclaw'` and the host `groups/<folder>` workspace as `cwd`.
Container paths are not treated as host repository paths.

Finalized responses can be captured before the whole turn finishes, including
the last response from a subagent. Incomplete JSON lines and older records
without final response metadata wait for a later completion boundary. Content
and usage that NanoClaw never saved cannot be recovered.

## Set it up

Install a HypAware version containing the bundled `@hypaware/nanoclaw` plugin
on the same macOS or Linux host as NanoClaw. Use Node.js 22.13 or newer for
both the CLI and daemon, with the unflagged `node:sqlite` builtin available.

NanoClaw is opt-in and is not selected by `hyp setup`. To find a supported local
root, run `hyp client discover nanoclaw` from the installation or a group
workspace, or pass a candidate explicitly:

```sh
hyp client discover nanoclaw /absolute/path/to/nanoclaw --json
```

Discovery checks catalog and directory metadata only and changes no settings.
Without an explicit path it checks the configured root and current-directory
ancestors, at most eight locations. It does not search your home or other
projects. At least one group's Claude projects directory must exist.

Choose the root you want to record, then add this entry to the
existing `plugins` list in your HypAware configuration, preserving the other
entries:

```json
{
  "name": "@hypaware/nanoclaw",
  "config": {
    "root": "/absolute/path/to/nanoclaw",
    "backfill": { "window_days": 30 }
  }
}
```

Use the installation root containing `data/v2.db` and `groups/`, not an
individual group or session directory. The Claude files must be locally
accessible under `data/v2-sessions/<group>/.claude-shared/projects/`.
See [configuration](../CONFIGURATION.md#locate-and-validate-configuration)
for the config location, then apply and check the change:

```sh
hyp config validate
hyp daemon restart
hyp client status nanoclaw
```

This integration installs no skills into NanoClaw. After configuration,
`hyp client attach nanoclaw` can resume a previously detached client; attach
does not discover or set the installation root.

## Verify capture

Complete a Claude turn in NanoClaw and allow the next five-minute sweep to run:

```sh
hyp status
hyp query sql "select session_id, model, role, content_text from ai_gateway_messages where client_name = 'nanoclaw' limit 20" --refresh always
```

Source diagnostics report the last scan, groups, files read or unchanged,
failures, privacy drops, and deferred work. A degraded source can mean an
unfinished transcript or a scan limit, as well as an unavailable catalog.

## Import existing history

Preview and import retained history immediately:

```sh
hyp backfill nanoclaw --dry-run
hyp backfill nanoclaw
```

Use `--since 2026-10-01` to choose a start date. Replay does not duplicate
previously captured parts or token usage.

A positive `backfill.window_days` bounds both the initial import and scheduled
recovery. `backfill.sweep_cron` changes the schedule. Setting
`backfill.on_join: false` stops automatic recovery, which is NanoClaw's only
capture route; explicit manual imports still work. See the
[recovery reference](../CLI_REFERENCE.md#scheduled-recovery-sweeps-and-backfillwindow_days)
for default history windows.

## Privacy and stopping recording

Apply [folder privacy controls](../PRIVACY.md) to the host
`<root>/groups/<folder>` workspace before importing history. `.hypignore`
exclusions prevent capture; local-only markings withhold captured rows from
export. Persistent exclusions use the native Claude session ID shown above:

```sh
hyp session ignore <session-id>
hyp session status <session-id>
hyp session unignore <session-id>
```

To stop and later resume recording:

```sh
hyp client detach nanoclaw
hyp client attach nanoclaw
```

Detach stops scheduled capture without deleting native history or existing
HypAware recordings. Removing the plugin entry and restarting the daemon also
stops capture.

## Limits and troubleshooting

The qualified layout is NanoClaw v2 with a local SQLite group catalog and
Claude provider transcripts. Other providers, older layouts, remote catalogs,
mailboxes, and Markdown conversation archives are not imported. Checks used
NanoClaw commit `a62a8d2f53caf7afc77af5adb07dd8c0112cb434`, Claude Agent SDK
0.3.296, and Claude CLI 2.1.296, including real Read and Agent tools with a
local model stub. Authenticated messaging-channel delivery was not exercised.

| Symptom | Check |
| --- | --- |
| `nanoclaw` is unavailable | Check `hyp plugin list`, the installed HypAware version, and the explicit plugin entry. It is not a setup-picker choice. |
| Catalog unavailable or no groups | Check `config.root`, local `data/v2.db`, permissions, and that the installation uses the v2 layout. |
| Some sessions are absent | Check the history window, group/session privacy exclusions, and that the Claude provider wrote native transcripts. |
| Files failed or work deferred | Check permissions and unfinished writes. Files over 16 MiB, lines over 4 MiB, or files over 20,000 lines or chat blocks are not imported. Scheduled reads are capped at 64 MiB per run and resume on later sweeps. |
| Linked or relocated data is missing | Symlinked paths and paths escaping the installation root are refused. Use a local installation with its catalog, group workspaces, and transcripts contained under that root. |
