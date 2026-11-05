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
name `grok`, along with repo, branch and commit when the session has them. A
subagent is its own session linked to its parent, and a fork is its own
conversation that starts with a copy of its parent's history.

Rewound turns stay in the recording, because they did happen. Each turn's token
usage and cost are on its last assistant message. Images and files in prompts and tool results keep a
placeholder rather than their bytes.
HypAware does not read Grok credentials.

## Set it up

`hyp setup` offers Grok Build when it finds `~/.grok/config.toml`. To add it later:

```sh
hyp attach grok --dry-run
hyp attach grok
hyp client status grok
```

Restart Grok Build to load the hook. Attach writes
`~/.grok/hooks/hypaware.json` and installs HypAware's skills under
`~/.grok/skills`. `hyp detach grok` removes its entries from the hook file and
leaves the skills in place.
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
- A session file over 256 MiB is skipped and reported as `file_failed` in the
  backfill output. A single line over 16 MiB is skipped and the rest of the
  session is still recorded.
- Sessions that exist only on a remote or cloud host are not captured.
- Run `hyp session ignore` from a tool inside Grok, or pass a session id, or use
  a `.hypignore`, to stop recording. An ignored session's forks and subagents are
  ignored with it. After `hyp session unignore`, recording resumes from new
  messages, and what was written while the session was ignored stays out. The
  daemon must have seen the session while it was ignored, which it does on the
  session's next hook or sweep.
