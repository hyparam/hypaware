# Cursor

**Status:** Supported. **Setup id:** `cursor`. **Backfill:** Yes.

HypAware records the Cursor editor and the Cursor CLI. Cursor hooks tell
HypAware when a session changes, and HypAware then reads the session from
Cursor's own local store, read-only. A recovery sweep every five minutes picks
up anything the hooks missed.

## What is recorded

Prompts, responses, tool calls, and the file contents and command output
Cursor's tools see, with each session's working directory. Token usage and cost
are not available from Cursor's store.

## Set it up

`hyp setup` offers Cursor when it finds `~/.cursor/hooks.json`. To add it later:

```sh
hyp attach cursor --dry-run
hyp attach cursor
hyp client status cursor
```

Attach adds HypAware's hooks to `~/.cursor/hooks.json`, keeps your other hooks,
and installs HypAware's skills in `~/.cursor/skills`.

## Import existing history

```sh
hyp backfill cursor --dry-run
hyp backfill cursor
```
