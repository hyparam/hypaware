# Claude Code

**Status:** Supported. **Setup id:** `claude`. **Backfill:** Yes.

HypAware records Claude Code sessions live through Claude Code's own
OpenTelemetry export, and recovers anything live capture missed from Claude
Code's transcripts. Subagents and agent teams are recorded as part of the
sessions that start them, and transcripts from Claude Agent SDK runs that use
the Claude Code CLI are imported too.

For Anthropic-managed cloud sessions, use the
[Claude Code Cloud recipe](claude-code-cloud.md), tested with HypAware 1.42.0.
It installs capture before Claude launches and adds cloud lifecycle hooks.

## What is recorded

- Prompts, responses, tool calls and their decisions, tokens, and cost, from
  Claude Code's OpenTelemetry events.
- Raw API request and response bodies, held briefly in a local spool while they
  are recorded.
- The working directory and repository of each session, from Claude Code hooks.
- Transcript recovery from `~/.claude/projects` every five minutes.

## Requirements

Claude Code 2.1.193 or newer. Version 2.1.214 adds full tool-decision detail.
When you pick Claude Code, `hyp setup` reads `claude --version`. Below 2.1.193 it
skips only Claude Code and tells you to run `claude update`, then
`hyp attach claude`. Between the two versions it notes the missing detail and
attaches. A version it cannot read proceeds. Both floors are
`CLAUDE_OTEL_MIN_VERSION` and `CLAUDE_TOOL_SOURCE_MIN_VERSION` in the Claude
plugin's `claude_version.js` (LLP 0258, LLP 0532).

## Set it up

`hyp setup` offers Claude Code when it finds `~/.claude/settings.json`. To add it
later:

```sh
hyp attach claude --dry-run
hyp attach claude
hyp client status claude
```

Attach writes HypAware's managed OpenTelemetry settings into
`~/.claude/settings.json`, keeps your other settings, and installs HypAware's
skills in `~/.claude/skills` and its `hypaware-analyst` subagent in
`~/.claude/agents`. Start a new Claude Code session so it reads the settings.

## Import existing history

```sh
hyp backfill claude --dry-run
hyp backfill claude
```

## Stop recording

```sh
hyp detach claude
```

Detach removes the managed OpenTelemetry settings and clears the raw-body spool.
Recorded history is kept. See [clients and history](../CLIENTS.md#stop-capture-or-keep-it-local).
