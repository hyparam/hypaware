# Hermes Agent

**Status:** Supported. **Setup id:** `hermes`. **Backfill:** Yes.

HypAware reads [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s
local state database, `~/.hermes/state.db`, read-only. It imports existing
sessions and then polls the database every 60 seconds for new messages. It does
not route Hermes's model traffic or change Hermes's settings.

## What is recorded

Sessions and messages with the tokens and cost Hermes records, and each
session's working directory.

## Set it up

`hyp setup` offers Hermes Agent when it finds `~/.hermes/state.db`. To add it
later:

```sh
hyp setup --source hermes
hyp client status hermes
```

Setup also installs HypAware's skills in `~/.hermes/skills`.

## Import existing history

```sh
hyp backfill hermes --dry-run
hyp backfill hermes
```

New sessions arrive on the next poll, up to a minute after they are written.
