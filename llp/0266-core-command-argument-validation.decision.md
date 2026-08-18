# LLP 0266: Core commands share one argument-validation contract

**Type:** Decision
**Status:** Accepted
**Systems:** CLI
**Author:** neutral
**Date:** 2026-08-18
**Related:** LLP 0009 (#core-owns-dispatch, #central-help-interception: the registration and help system this constrains), LLP 0034 (#verbs: the argv/schema codec this reuses, and the boundary it does not cross), LLP 0153 (#decision: exit 2 as the usage-error code), LLP 0067 (#exit-codes: the same code, per command)

> Extends [LLP 0009](./0009-cli-registry.spec.md). A registration carries a
> `usage` line but nothing that makes the command honour it, so half the core
> set rejected a misspelled flag with exit 2 and half read the tokens it
> recognised and dropped the rest. This settles that every visible core command
> refuses input it does not know, and that its usage line and its parser are one
> declaration rather than two.

## Context {#context}

[LLP 0034 #verbs](./0034-mcp-host-intrinsic.decision.md#verbs) minted the
argv/schema codec and bounded it deliberately: verbs are "a typed superset for
the query family, not a retrofit of every command". That boundary is about
*registration* (what projects an MCP tool), and it still holds. What grew out of
the codec since is a plain function, `parseCommandArgv()` in
`src/core/cli/verb_codec.js`, which any command can call to get strict argv
parsing without becoming a verb. Roughly half the core set already did:
`query overview`, `query maintain`, `sync`, `sink maintain`, `config validate`,
`init`, `plugin install`, `daemon install`, `daemon run`, and the newer plugin
commands.

The other half did not, and read argv by hand. Measured on `master` at
a14246d9, sixteen visible core commands accepted a token they had no meaning
for:

- `version`, `query status`, `daemon stop`, `daemon restart` ignored every
  argument.
- `status`, `daemon status`, `backfill list`, `plugin list`,
  `plugin outdated`, `remote list` read only `--json`.
- `plugin info`, `plugin remove`, `query schema`, `query refresh` took the
  first token as a name, flag-shaped or not, so `hyp plugin info --jsn` failed
  with "'--jsn' is not installed" (exit 1).
- `ask` filtered out anything starting with `-` before joining the question.
- `remote add`, `remote remove`, `remote login`, and the `report` subcommands
  derived positionals through `positionals()`/`valueFlag()`, which skip flags
  they do not recognise rather than refusing them. Those exited 2 only when the
  dropped token left a required positional missing, and never named the token.

So `hyp daemon status --jsn` printed the human table and exited 0, while
`hyp sink maintain --jsn` exited 2. A script cannot tell those apart, and the
quiet reading is the dangerous one exactly where it matters most: around
`daemon stop`, `daemon restart`, and `report delete` a dropped flag is a
different operation, silently.

There is no repo-wide statement of this anywhere in the corpus. Exit 2 for a
usage error exists as independent precedents
([LLP 0153](./0153-inactive-not-unknown-dispatch-miss.decision.md) for the
dispatch miss, [LLP 0067 #exit-codes](./0067-session-opt-out.design.md#exit-codes)
for one command's table, [LLP 0111 #tokens](./0111-hyp-policy-verb.design.md#tokens)
for a bad enum value), which is why each command was free to answer differently.

## D1: unknown input is a usage error, on every visible core command {#one-contract}

A token a visible core command does not accept, an unrecognised flag or a
positional beyond what its schema binds, is a usage error: exit 2, with the
offending token named on stderr and nothing on stdout. Not exit 0 with a
different output mode, not exit 1 through a downstream lookup that happened to
fail on a flag-shaped name.

The mechanism is `parseCommandArgv()`, wrapped by `parseCoreCommandArgv()` in
`src/core/cli/command_args.js` so the refusal itself is written in one place
rather than reworded per command. This is reuse of the codec, not the verb
registration LLP 0034 bounded: an imperative command that parses strictly is
still `ctx.commands.register`, contributes no MCP tool, and gains no `render`.

Two things stay as they were. Kernel render/transport controls (`--format`,
`--output`, `--max-cell`, `--max-bytes`, `--remote`, `--refresh`) remain outside
the per-command schema, stripped by `parseControlFlags` for the verb family
([LLP 0033](./0033-remote-query-attach.spec.md)); and a leading `--help` never
reaches a command body, because dispatch renders registry help for it
([LLP 0009 #central-help-interception](./0009-cli-registry.spec.md#central-help-interception)).
A `--help` further along argv prints the usage line on stdout and exits 0.

Where a command already had wording better than the codec's for a specific flag,
that wording is kept and the strict gate runs behind it. `hyp remote login`
checks `--token-file`, `--org`, and `--host` for a missing value first, because
"--org expects an org name" tells the reader more than "--org expects a value";
what the gate adds there is the refusal for everything no reader names at all.

## D2: usage line and parser schema are one declaration {#usage-agreement}

The failure mode a strict parser invites is a usage line that advertises a flag
the parser rejects, or a parser that accepts one the usage line never mentions.
Two hand-maintained strings drift; LLP 0009's registration gave `usage` no
relationship to anything that reads argv.

So for every command this decision covers, the schema and the usage line are
authored together, as one `CORE_COMMAND_ARGS` entry in
`src/core/cli/command_args.js`. `core_commands.js` reads `usage` from there
(`coreUsage(name)`) instead of holding its own copy, so there is one string, not
two that agree. `test/core/cli-arg-validation.test.js` proves the entry is
internally honest: every `--flag` in the usage line is a non-positional schema
property and every non-positional property appears in the usage line.

Generating the usage line from the schema outright was the alternative, and was
rejected: `usageForVerb()` already shows what that produces, and it cannot
express `hyp purge <path> | --session <id> | --ignored | --all`, or the
`[--dry-run [--json]]` nesting `daemon install` documents. The agreement check
buys the same guarantee without flattening the lines a reader actually reads.

The table covers the commands migrated here, not the whole core set. A command
that already parses strictly through its own schema (`init`, `sync`, `purge`,
`policy *`, `attach`/`detach`, `plugin install`) keeps its schema next to the
code that consumes it; folding those in would mean copying schemas away from
their bodies, which is the drift this decision is against. They are held to D1
by the parameterized test, not by the table.

## Consequences {#consequences}

- A misspelled flag now fails the same way everywhere, so a script can rely on
  exit 2. This is a behaviour change for the sixteen commands listed above: an
  invocation that used to be silently accepted now exits 2.
- `hyp remote login`'s usage line becomes `[name]` rather than `<name>`, which
  is what the command has actually done since
  [LLP 0062 #bare-remote](./0062-builtin-default-remote.decision.md#bare-remote)
  made a bare login resolve the default target.
- New core commands have somewhere to declare their surface, and a test that
  fails when a usage line and a parser disagree.
- Nothing changes for plugin commands. `CommandRegistration` gains no field, so
  a plugin's parser stays its own business; what plugins get is a core set that
  behaves consistently around theirs.

## Open questions {#open-questions}

1. **Should the table absorb the already-strict commands?** It would make
   "every visible core command has a declared surface" checkable statically
   rather than behaviourally, at the cost of moving schemas away from the code
   that reads their params. Worth revisiting if a usage line drifts anyway.
2. **Does the plugin surface want the same guarantee?** The parameterized test
   is scoped to core commands. Holding plugin commands to it would mean either a
   registration-level schema (a plugin-facing contract change) or a smoke that
   dispatches every registered command, and neither is obviously worth it yet.
