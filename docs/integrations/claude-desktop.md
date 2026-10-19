# Claude Desktop

**Status:** Supported, macOS only. **Setup id:** `claude-desktop`. **Backfill:** Yes.

HypAware imports the Claude Code sessions you run in the Claude desktop app
from their local transcripts every five minutes. It needs no Claude account
credential and makes no changes to the desktop app. Cowork sessions are not
recorded.

## Set it up

`hyp setup` offers Claude Desktop on macOS when it finds
`/Applications/Claude.app`. Choosing it also turns on
[Claude Code](claude-code.md) capture, because both share the same transcript
reader: existing Claude Code CLI history is imported too, and Claude Code may be
attached. To add it later:

```sh
hyp setup --source claude-desktop
hyp client status claude-desktop
```

## Timing and history

Desktop sessions arrive on the five-minute import, not live. The schedule and
its history window belong to the Claude Code plugin's `backfill` settings; see
the [Claude Desktop reference](../CLI_REFERENCE.md#claude-desktop-commands) to
change the cadence or turn the import off.

The `hyp client claude-desktop` subcommands operate an older managed
third-party-inference route. They are optional experiments and are not needed
for transcript capture.
