# Antigravity

**Status:** Beta. **Setup ids:** `antigravity` (CLI) and `antigravity-desktop`
(Desktop). **Backfill:** Yes.

HypAware records Google Antigravity conversations by reading the local stores
Antigravity writes: a read-only `conversation_summaries.db` SQLite index and
each conversation's JSONL transcript under `brain/<conversation-id>`. The
collector polls every 30 seconds and recovers missed activity every five
minutes. Model traffic continues to go directly to your provider.

These are undocumented local formats, so a future Antigravity release can
change them. Capture has not yet been validated against a live Antigravity
install.

## What is recorded

Prompts, responses, model thinking, tool calls and results, and each
conversation's working directory and repository. Token usage is recorded where
a planner step reports input, output, and cache-read tokens. Subagent
conversations keep their parent link. Rows land in `ai_gateway_messages` with
the client name `antigravity` and entrypoint `cli`, or `antigravity-desktop`
and entrypoint `desktop`.

Desktop skips the summary rows Antigravity syncs from the CLI, so a CLI
conversation is recorded only by the CLI collector. Attach the CLI to record
CLI conversations.

## Requirements

A Node.js runtime with the built-in `node:sqlite` module. Without it,
`hyp client status` reports the collector as degraded and nothing is recorded.
The CLI store is
`~/.gemini/antigravity-cli` and the Desktop store is `~/.gemini/antigravity`.
To read a different location, set `app_data_dir` in the plugin's config.

## Set it up

`hyp setup` offers **Antigravity CLI** when it finds
`~/.gemini/antigravity-cli/settings.json`, and **Antigravity Desktop** when it
finds `~/.gemini/antigravity/conversation_summaries.db`. To add one later:

```sh
hyp attach antigravity --dry-run
hyp attach antigravity
hyp client status antigravity
```

Use `antigravity-desktop` for the Desktop app. Attach writes the HypAware
plugin manifest at `~/.gemini/config/plugins/hypaware/plugin.json` and installs
HypAware's skills and analyst subagent beside it. Attach refuses to replace a
`plugin.json` at that path that HypAware did not write.

## Verify recording

Complete a short Antigravity turn containing a distinctive phrase, then search
for it:

```sh
hyp query grep 'your distinctive phrase'
```

Allow up to a poll interval for capture plus cache visibility. An attach marker
alone does not prove that a conversation was recorded.

## Import existing history

Apply your [privacy markings](../PRIVACY.md#marking-directories) before
importing sensitive history.

```sh
hyp backfill antigravity --dry-run
hyp backfill antigravity
```

A positive `backfill.window_days` limits both setup-time imports and scheduled
recovery. `backfill.sweep_cron` sets the recovery schedule, and
`backfill.on_join: false` turns off automatic imports and scheduled recovery.
See the
[recovery reference](../CLI_REFERENCE.md#scheduled-recovery-sweeps-and-backfillwindow_days).

## Privacy and stopping capture

Live capture and history imports honor directory exclusions, local-only
markings, and saved session exclusions. To exclude one conversation, pass its
Antigravity conversation ID:

```sh
hyp session ignore <conversation-id>
hyp session status <conversation-id>
hyp session unignore <conversation-id>
```

To stop recording:

```sh
hyp detach antigravity --dry-run
hyp detach antigravity
```

The CLI and Desktop share one plugin manifest, so detaching either one removes
the HypAware plugin from both. Run `hyp attach` for the one you still use to
restore it.

## Troubleshooting and limits

- If attach reports that the plugin manifest is not HypAware-owned, move your
  own `~/.gemini/config/plugins/hypaware/plugin.json` aside or rename that
  plugin, then attach again.
- If the summary database is locked, the collector retries briefly and tries
  again on the next poll.
- Each changed transcript is read whole; very large transcripts cost
  proportionally more memory while they are read.

For shared diagnostic steps and log locations, see
[troubleshooting](../TROUBLESHOOTING.md#no-new-recordings).
