# LLP 0611: `hyp skills install` is the canonical spelling again

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins
**Author:** Brendan / Claude
**Date:** 2026-11-17
**Extends:** LLP 0248 (#tree: `skills install` returns to the top level; #aliases: `client skills install` becomes the alias, reversing the direction)
**Related:** LLP 0138 (#one-command: still one install command for skills and subagents), LLP 0458 (#attached-only: `--attached` is unchanged), LLP 0393 (#contract: `skills` and `skills install` replace `client skills` and `client skills install` in the finite command vocabulary), LLP 0609, LLP 0610 (the same shortening elsewhere)

> LLP 0248 moved `hyp skills install` under `client` on 2026-08-19 and kept
> the old spelling as a hidden alias. The old spelling is the one status
> output, update messages and most of the code's own comments kept using.
> This decision makes it canonical again and lets the client be named
> without a flag.

## Decision {#decision}

```text
skills install [client] [--attached]
```

- `skills` is listed in primary help under "Control capture and movement",
  after `client`.
- The client may be given as a positional. `--client <name>` keeps working
  and means the same thing; with neither, every eligible client is installed
  for, as before.
- `client skills` and `client skills install` are compatibility aliases under
  the LLP 0248 #aliases rules.
- What is installed, where, and the `--attached` behaviour are unchanged.

### Consequences {#consequences}

- `hyp client --help` no longer lists `skills`.
- `install` stays a required word although it is the group's only
  subcommand: the command writes into client directories, and a bare noun
  that writes would be a surprise.

### Telemetry {#telemetry}

`skills` and `skills install` join the finite command vocabulary of
LLP 0393 #contract and `client skills` and `client skills install` leave this
client's copy. A receiver that validates against its own copy needs the two
new names added and should keep the retired ones for older clients.
