# OpenCode

**Status:** Supported. **Setup id:** `opencode`. **Backfill:** Yes.

HypAware records OpenCode CLI and the OpenCode desktop app live through a small
HypAware-owned OpenCode plugin, which sends each session's messages to the
local daemon as they change. Model traffic goes to your provider directly.

## What is recorded

Prompts, responses, tool calls, tokens, and cost as OpenCode reports them, with
each session's directory.

## Set it up

`hyp setup` offers OpenCode when it finds `~/.config/opencode/opencode.json`. To
add it later:

```sh
hyp attach opencode --dry-run
hyp attach opencode
hyp client status opencode
```

Attach installs the plugin at `~/.config/opencode/plugins/hypaware.js`, shared by
the CLI and the desktop app, and HypAware's skills in
`~/.config/opencode/skills`. Start a new OpenCode process so it loads the plugin.

## Import existing history

```sh
hyp backfill opencode --dry-run
hyp backfill opencode
```

OpenCode 1.x and 2.x are supported. Backfill selects up to 1,000 recently
updated sessions across projects, including subagents, applies the requested
time window, and exports each selected session. It uses `opencode export` on
1.x and `opencode session export` on 2.x.

OpenCode 2.x runs plugins in its shared server. Its live snapshots use the
active context; history import recovers messages from before compaction. The
frontend is recorded as `unknown` because the shared server does not identify
which frontend caused an event.
