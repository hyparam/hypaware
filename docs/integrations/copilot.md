# VS Code (GitHub Copilot)

**Status:** Beta. **Setup id:** `copilot`. **Backfill:** Within native retention.

HypAware records GitHub Copilot chats in VS Code from the native Local and
Agent Host SQLite stores, read-only. It imports completed model, chat and tool
spans every minute by default. Model requests go directly to the provider;
this integration requires no model proxy or extra listener.

The qualified scope is local single-folder workspaces. Installed-client checks
cover VS Code 1.139.1 with Copilot Chat 0.67.0, for both Local and Agent Host.
Other editor and SDK versions need qualification. This integration does not
cover GitHub Copilot CLI or inline code completions.

## What is recorded

Submitted prompts, assistant output, system context, offered tool definitions,
tool arguments/results, errors and visible reasoning when present in the native
spans. Provider-supplied token usage, including cache counters, is recorded once
per response. Rows use the normal `ai_gateway_messages` table with
`client_name = 'copilot'` and the session's verified local working directory.

Only completed spans with an unambiguous workspace binding are imported.
Hidden reasoning and exact binary attachments are not captured. Parent IDs are
preserved where available, but complete subagent trees are not guaranteed.

## Set it up

Install a HypAware version containing the bundled `@hypaware/copilot` plugin,
with Node.js 22.13 or newer on macOS or Linux, on the same host as VS Code.
This integration needs Node's unflagged `node:sqlite` builtin.
In `hyp setup`, choose **VS Code GitHub Copilot**. To add it later:

```sh
hyp client attach copilot --dry-run
hyp client attach copilot
hyp client status copilot
```

Accept the offer to enable recording if prompted. Then reload VS Code, open a
local single-folder workspace and complete a Copilot chat turn. Attach success
confirms settings were written; it does not prove the editor is emitting data.

Attach enables these application settings in `User/settings.json`, shared across
profiles, while preserving comments and unrelated settings:

```json
{
  "github.copilot.chat.otel.dbSpanExporter.enabled": true,
  "chat.agentHost.otel.dbSpanExporter.enabled": true,
  "chat.agentHost.otel.captureContent": true
}
```

The Local debug database can contain full content even when content capture for
an external exporter is disabled. HypAware applies its own recording and privacy
checks before importing; these do not prevent VS Code from storing debug content.
Attach preserves existing external destinations and refuses observable
incompatible protobuf/gRPC Agent Host exporter settings or environment overrides
that disable the required database/content pipeline. Editor-only environment and
enterprise policy can still affect capture.

Stable and Insiders installations are discovered at their standard platform
locations, including profile databases. Portable mode follows `VSCODE_PORTABLE`.
For a relocated installation, merge a `user_data_dirs` list of 1 to 8 absolute
VS Code user-data roots into the existing Copilot plugin's `config` block:

```json
{
  "name": "@hypaware/copilot",
  "config": { "user_data_dirs": ["/absolute/path/to/vscode-user-data"] }
}
```

Use the user-data root, not its `User` or profile subdirectory. Follow the
[configuration guide](../CONFIGURATION.md#locate-and-validate-configuration) to
validate and load the change, then rerun attach and reload VS Code.

## Verify capture

After completing a distinctive chat turn, allow the next minute's sweep to run:

```sh
hyp status
hyp query sql "select session_id, model, role, content_text from ai_gateway_messages where client_name = 'copilot' limit 20" --refresh always
```

Source status reports the last scan and counts of stores, selected, read,
unchanged, dropped and incomplete spans. A missing database, ambiguous workspace
or scan limit can leave capture incomplete. Status does not imply every native
span was recorded.

## Import retained history

```sh
hyp backfill copilot --dry-run
hyp backfill copilot
```

VS Code's native retention is seven days and the latest 100 conversations.
History already evicted, or generated before the native exporters were enabled,
cannot be recovered through this integration. Replaying captured spans does not
duplicate stored rows or token usage.

The default recovery schedule is every minute. A positive `backfill.window_days`
also bounds scheduled recovery; `backfill.sweep_cron` changes its schedule.
Declining join-time history (`backfill.on_join: false`) still captures new work,
with scheduled scans starting at adapter activation. Manual backfill can widen
the history window, subject to native retention. See
[clients and history](../CLIENTS.md#bring-in-existing-history).

## Privacy and stopping recording

[Folder privacy controls](../PRIVACY.md) and persistent session exclusions apply
before import and again before writes. Local-only rows retain their directory
so export rules withhold them. To exclude a session, supply its explicit native
session ID from the query above:

```sh
hyp session ignore <session-id>
hyp session status <session-id>
hyp session unignore <session-id>
```

To stop Copilot recording:

```sh
hyp client detach copilot
```

Detach disables HypAware recording and restores settings it managed, retaining
values you changed afterward with a warning. Reload VS Code to apply restored
settings. Detach does not delete native history or previously recorded rows.

## Limits and troubleshooting

Remote workspaces, multi-root workspaces and sessions that change working
directory are outside the qualified scope. Unowned or ambiguous spans are
withheld. Native retention, missing parents and scan size limits can leave
history incomplete; this is not an unlimited transcript archive.

| Symptom | Check |
| --- | --- |
| No stores or no new rows | Reload VS Code after attach, complete a turn in a local single-folder workspace, and wait for the next sweep. Check the selected user-data root and editor policy/environment. |
| Attach reports an exporter conflict | Preserve the existing destination; configure a compatible HTTP JSON Agent Host exporter explicitly before retrying. |
| `sqlite_unavailable` | Use Node.js 22.13 or newer for both the CLI and daemon; the native stores require its unflagged SQLite builtin. |
| Some sessions or tools are absent | Inspect incomplete/dropped counts, workspace ownership, folder/session exclusions and native retention. Known file-read tools outside the admitted folder or under stricter policy are withheld. |
| `copilot` is unavailable | Check `hyp plugin list`; install a HypAware version containing this integration and enable it in setup. |
