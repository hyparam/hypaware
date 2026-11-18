# LLP 0613: `hyp plugin new` and `hyp plugin doctor` drop the `dev` prefix

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins
**Author:** Brendan / Claude
**Date:** 2026-11-17
**Extends:** LLP 0248 (#tree: `plugin new|doctor` return to the `plugin` group; #aliases: `dev plugin new|doctor` and `dev smoke` become the aliases; #decision: `dev` leaves the Additional commands list)
**Related:** LLP 0393 (#contract: `plugin new` and `plugin doctor` replace `dev`, `dev plugin new` and `dev plugin doctor` in the finite command vocabulary), LLP 0609, LLP 0610, LLP 0611 (the same shortening elsewhere)

> LLP 0248 moved the two plugin authoring commands under a `dev` group. They
> are plugin commands and read naturally beside `plugin install|list|info`,
> so they go back there.

## Decision {#decision}

```text
plugin install|list|info|outdated|update|remove|new|doctor
```

- `plugin new` and `plugin doctor` are canonical. `dev plugin new` and
  `dev plugin doctor` are compatibility aliases under the LLP 0248 #aliases
  rules.
- The `dev` group is no longer a command. Its only other member was
  `dev smoke`, which is hidden from help, so a listed `dev` group would
  render an empty subcommand table. The hidden runner is canonically
  `smoke`, with `dev smoke` as its alias, so both spellings still run; bare
  `hyp dev` is an unknown command.

### Telemetry {#telemetry}

`plugin new`, `plugin doctor` and `smoke` join the finite command vocabulary
of LLP 0393 #contract; `dev`, `dev plugin new`, `dev plugin doctor` and
`dev smoke` leave this client's copy. A receiver should keep the retired names for older
clients.
