# Grok Build

**Status:** Supported. **Setup id:** `grok`. **Backfill:** Yes.

HypAware records xAI Grok Build's local sessions. A native hook tells the local
daemon when a session changes; HypAware reads that session's `updates.jsonl` and
recovers missed activity every five minutes. Model traffic continues to go
directly to your provider.

## What is recorded

Prompts, responses, reasoning summaries, tool calls and results, model where
available, and each session's working directory. Tool results can include file
contents and command output. Rows land in `ai_gateway_messages` with the client
name `grok`. Subagents are separate sessions linked to their parent, and a fork
is its own conversation.

Rewound turns stay in the recording, because they did happen. Token usage and
cost are not recorded. Images keep a placeholder rather than their bytes.
HypAware does not read Grok credentials.

## Set it up

`hyp setup` offers Grok Build when it finds `~/.grok/config.toml`. To add it later:

```sh
hyp attach grok --dry-run
hyp attach grok
hyp client status grok
```

Restart Grok Build to load the hook. Attach writes only
`~/.grok/hooks/hypaware.json`, and `hyp detach grok` removes its entries from it.
If you set `GROK_HOME`, use the same value for Grok Build, HypAware commands, and
the daemon.

The hook never blocks: it does not register on `PreToolUse`, prints nothing, and
exits zero. Grok Build also runs hooks from `~/.claude/settings.json` by default.
HypAware's Claude hooks recognize that and do nothing, so a Grok session is not
recorded as Claude activity.

## Import history

```sh
hyp backfill grok --dry-run
hyp backfill grok --since 2026-01-01T00:00:00Z
```

Imports are safe to repeat, and the provider's `backfill.window_days` bounds them.

## Troubleshooting and limits

- The last message of a turn appears once the turn completes, or within about
  five minutes of a crash, because streamed text is folded into whole messages.
- A session file over 256 MiB, or a single line over 16 MiB, is skipped and
  reported as `file_failed` in the backfill output.
- Sessions that exist only on a remote or cloud host are not captured.
- Set `hyp session ignore <session-id>` or a `.hypignore` to stop recording.
