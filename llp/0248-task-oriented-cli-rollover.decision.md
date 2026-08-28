# LLP 0248: Focused CLI help and journey groups

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Onboarding
**Author:** Phil / Codex
**Date:** 2026-08-18
**Related:** LLP 0005, LLP 0009, LLP 0011, LLP 0034, LLP 0117, LLP 0135

## Context {#context}

The shipped CLI grew by subsystem. Everyday tasks, operational nouns, plugin
names, and hidden machine hooks all compete in one alphabetical help table.
The command semantics are mostly sound, but the presentation gives no path
through them and asks a new user to understand architecture before intent.

The researched inventory and side-effect review live in
`research/2026-08-18-cli-command-semantics/REPORT.md`. Reorganization must not
weaken confirmation, privacy, credential, plugin-activation, or stdout
contracts.

## Options considered {#options}

1. Keep one alphabetical list and improve summaries. This keeps direct
   operator spellings but still gives every command equal prominence.
2. Put all operational commands below `admin`. This creates a tidy tree, but
   adds a junk-drawer namespace and discards useful operator muscle memory.
3. Focus primary help on journeys, keep natural operational groups direct,
   and render those operations in one compact Additional commands list.

## Decision {#decision}

Choose option 3. Help is organized by task rather than alphabet:

```text
Getting started:
  setup      Install, reconfigure, or maintain HypAware
  status     Check capture, clients, storage, and health

Explore and share:
  ask        Ask an AI client about recorded activity
  query      Explore recorded datasets
  report     Render and manage reports

Control capture and movement:
  client     Manage AI clients and history
  privacy    Control recording, synchronization, deletion
  session    Pause or resume this live session
  join       Connect this machine to a central server
  leave      Disconnect central management, keep local history
  sync       Send captured data to destinations now

Additional commands:
  daemon, config, cache, sink, plugin, remote, mcp, graph, vector,
  enrichment, source, version, dev
```

There is no `admin` or `fleet` group. `join`, `leave`, and `session` stay
top-level. Operational nouns stay direct, but lose descriptions in primary
help so they do not compete visually with everyday journeys.

### Canonical tree {#tree}

Journey groups are:

```text
setup [preset] [flags]
status [--json]
ask [question] [--list]
query overview|sql|schema
query graph neighbors
query vector search
report render|publish|list|get|delete
sync
session status|ignore|unignore
client status|attach|detach
client history import|plan|providers
client skills install
client claude-account login|logout|status
client claude-desktop install|status|verify|profile|install-helper
privacy show|set|unset|list|ignore|unignore|client|folders|purge
join
leave
dev plugin new|doctor
dev smoke
```

Direct operations are:

```text
daemon install|uninstall|run|start|status|stop|restart
config validate
cache status|refresh|maintain
sink maintain
plugin install|list|info|outdated|update|remove
remote add|login|list|remove
mcp serve
graph project|compact
vector status
enrichment propose|curate|backfill|status
source gascity attach|detach|list
version
```

Gas City's canonical `source gascity` mutations are withheld until attach and
detach persist configuration. Vector search stays local until it becomes a
typed verb; its `query` nesting does not imply remote support.

### Compatibility aliases {#aliases}

Only changed journeys gain aliases. Direct operations that keep their spelling
are not aliases:

- `init` to `setup`
- `attach`, `detach`, `unattach` to `client attach|detach`
- `backfill`, `backfill plan`, `backfill list` to `client history *`
- `skills install` to `client skills install`
- human Claude account and Desktop commands to `client ...`
- `policy *`, `ignore`, `unignore`, `purge` to `privacy *`
- `query status|refresh|maintain` to `cache *`
- `graph neighbors` and `vector search` to `query ...`
- `plugin new|doctor` and `smoke` to `dev ...`
- `mcp` to `mcp serve`
- `enrich *` to `enrichment *`

The canonical and old spellings resolve to one registration and runner.
Aliases are omitted from help and require a future major-version LLP to
remove.

Plugin-owned canonical commands and aliases exist only when their plugin is
config-active. Inactive paths still identify the owning plugin and repair.

The exact hidden machine contracts remain callable and absent from help:

- `claude-account credential`
- `claude-hook session-context`
- `claude-hook classify-cwd`
- `codex-hook classify-cwd`

`claude-account credential` continues to write exactly one secret JSON line to
stdout.

### Help and boot metadata {#semantic-boot}

Canonical registry and manifest entries can declare a help category, audience,
semantic boot profile, and aliases. The help renderer uses metadata to form the
three journey sections and the compact Additional commands list. Plugin help
still comes from config-active manifests without activation.

Dispatch resolves the full semantic command before boot selection. Required
profiles are:

- bare `hyp` and `setup`: `all-available`
- `status`, every `daemon` command, `version`, and `dev smoke`: `none`
- all other commands: `config`

Aliases inherit the canonical profile.

### Client status {#client-status}

`client status` is a projection of the overall status collector, not a second
calculation. It carries configured, attached, attachable, provenance, error,
recent-entrypoint, and recorder health facts from the same snapshot.

## Consequences {#consequences}

- Primary help emphasizes eleven journey commands and one compact operations
  list rather than a single alphabetical inventory.
- Natural operational spellings remain stable.
- Existing changed spellings keep working without a second code path.
- Analytics use canonical names and may separately record invoked aliases.
- Diagnostics, walkthroughs, docs, and skills teach canonical journeys.
- Alias removal and transactional setup lifecycle are deferred.

## Deferred setup lifecycle {#deferred-setup-lifecycle}

These commands remain future-only:

```text
setup update [--check] [--to VERSION] [--dry-run] [--yes]
             [--accept-breaking]
setup repair [--dry-run] [--resume] [--version VERSION]
setup rollback [snapshot-id] [--dry-run]
```

They require a durable journal, control-state snapshots, daemon coordination,
migrations, managed-client reconciliation, health verification, and rollback.
Generic `--yes` must not imply major-version acceptance.

## References

- [LLP 0009](./0009-cli-registry.spec.md)
- [LLP 0011](./0011-setup-and-onboarding.decision.md)
- [LLP 0034](./0034-mcp-host-intrinsic.decision.md)
- [LLP 0117](./0117-claude-account-credential-plugin.decision.md)
- `research/2026-08-18-cli-command-semantics/REPORT.md`
