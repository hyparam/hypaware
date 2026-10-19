# Codex

**Status:** Supported. **Setup id:** `codex`. **Backfill:** Yes.

HypAware records Codex CLI and the Codex desktop app from the session files
they share in `~/.codex/sessions`, imported every minute. Codex connects to its
provider directly; HypAware does not sit in its model traffic unless you turn on
gateway capture.

For hosted Codex tasks, see [Codex Cloud](codex-cloud.md), a separate
integration.

## What is recorded

Prompts, responses, tool calls, and token counts from Codex's session files, with
the working directory of each session. Codex does not report cost.

## Set it up

`hyp setup` offers Codex when it finds `~/.codex/config.toml`. To add it later:

```sh
hyp attach codex --dry-run
hyp attach codex
hyp client status codex
```

Attach covers both the CLI and the desktop app, installs HypAware's skills in
`~/.codex/skills`, and adds a hook that records each session's working
directory.

## Import existing history

```sh
hyp backfill codex --since 2026-09-01T00:00:00Z --dry-run
hyp backfill codex --since 2026-09-01T00:00:00Z
```

The one-minute import is Codex's only capture lane by default, so
`backfill.on_join: false` does not stop it. Use `hyp detach codex` to stop
recording.

## Gateway capture

To record Codex's model traffic as it happens instead of from session files,
set `capture_mode` to `gateway` in the Codex plugin's configuration, then attach
again:

```json
{ "name": "@hypaware/codex", "config": { "capture_mode": "gateway" } }
```

Gateway capture routes Codex through HypAware's local gateway. The default,
`transcript`, removes any gateway route.
