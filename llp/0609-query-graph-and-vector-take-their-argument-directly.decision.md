# LLP 0609: `hyp query graph` and `hyp query vector` take their argument directly

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Graph
**Author:** Brendan / Claude
**Date:** 2026-11-17
**Extends:** LLP 0248 (#tree: `query graph neighbors` and `query vector search` shorten to `query graph` and `query vector`; #aliases: the longer spellings join the compatibility aliases)
**Related:** LLP 0393 (#contract: `query graph` joins the finite command vocabulary; `query graph neighbors` and `query vector search` leave it), LLP 0214 (#d2: `query graph` stops being a described group because it is now a command), LLP 0034 (#verbs: the verb and its `graph_neighbors` tool are unchanged), LLP 0024 (#cli-surface)

> LLP 0248 nested the two plugin read commands one level deeper than they
> need: `hyp query graph neighbors <node>` and `hyp query vector search
> <query>`. Each group has one everyday action, so the subcommand is a word
> the user must type that selects nothing. This decision drops it.

## Context {#context}

`query graph` has exactly one subcommand, `neighbors`. `query vector` has
`search`, plus `status` as an alias of the operator command `vector status`,
whose canonical home is outside `query`. Every sibling under `query`
(`sql`, `grep`, `schema`, `overview`) is one token after `query`.

## Decision {#decision}

The canonical journey spellings in LLP 0248 #tree become:

```text
query graph <node>
query vector <query>
```

`graph project|compact` and `vector status` stay direct operations, unchanged.

`query graph neighbors`, `graph neighbors`, `query vector search` and
`vector search` remain compatibility aliases under the LLP 0248 #aliases
rules: one registration and runner, omitted from help, removed only by a
future major-version LLP. `query vector status` keeps reaching
`vector status`.

The MCP tool stays `graph_neighbors`; only the CLI spelling changes.

### Consequences {#consequences}

- Longest-prefix matching sends `hyp query vector status` to the status
  command and `hyp query graph neighbors <node>` to the alias, so a search
  for the single bare word `status`, or a seed node literally named
  `neighbors`, cannot be spelled without another token. A quoted multi-word
  query is one argv token and is unaffected.
- `query graph` is a command, so it no longer carries the group description
  LLP 0214 #d2 gave it. `hyp query graph --help` renders the verb's own help;
  the projection model stays stated in `hyp graph --help`.
- Bare `hyp query vector` and `hyp query graph` are usage errors (exit 2)
  instead of a subcommand listing.

### Telemetry {#telemetry}

`query graph` joins the finite command vocabulary of LLP 0393 #contract.
`query graph neighbors` and `query vector search` leave this client's copy:
the vocabulary is held to exactly the registered command names, and an alias
reports as its canonical command. `query vector` was already a member. A
receiver that validates against its own copy of the vocabulary needs
`query graph` added before records carrying it are accepted, and should keep
the two retired names, since clients released before this change still
report them.
