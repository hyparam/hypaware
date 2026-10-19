# Pi

**Status:** Supported. **Setup id:** `pi`. **Backfill:** Yes.

HypAware records [Pi](https://pi.dev) live through a managed Pi extension that
sends each completed entry to the local daemon, and recovers native Pi sessions
every five minutes, including recent history.

## What is recorded

Prompts, responses, tool calls, tokens, and cost as Pi reports them, with each
session's working directory.

## Set it up

`hyp setup` offers Pi when it finds `~/.pi/agent/settings.json`. To add it later:

```sh
hyp attach pi --dry-run
hyp attach pi
hyp client status pi
```

Attach installs the extension at `~/.pi/agent/extensions/hypaware.js` and
HypAware's skills in `~/.pi/agent/skills`. Start a new Pi session so it loads the
extension.

## Import existing history

```sh
hyp backfill pi --dry-run
hyp backfill pi
```
