# WP5: Cross-check, interface assessment, and synthesis

Status: complete.

## Answer

The thirteen-command proposal is structurally sound after four corrections:

1. Keep `join` and `leave` top-level, with no two-leaf enrollment namespace.
2. Describe `client status` as new work that projects overall status.
3. Do not promise remote vector search until vector search becomes a typed
   verb.
4. Do not teach Gas City attach/detach as durable administration until they
   write config rather than only process memory.

Everything else can be introduced as a canonical registration or alias over an
existing implementation, provided boot profiles, plugin ownership, help
visibility, and machine stdout contracts are preserved.

## Proposed canonical tree

```text
hyp
├── setup [preset] [flags]
├── status [--json]
├── ask ["question"] [--list]
├── query
│   ├── overview [--days N] [--json] [--sql] [--include-local-only]
│   ├── sql <select...> [query controls]
│   ├── schema <dataset>
│   ├── graph neighbors <node> [traversal/query controls]
│   └── vector search <query> [vector controls]
├── report
│   ├── render [dir] [--no-refresh-assets]
│   ├── publish <file-or-dir> --kind K --period P [remote controls]
│   ├── list [filters] [--json] [remote controls]
│   ├── get <kind> <period> <id> [path] [--output file] [remote controls]
│   └── delete <kind> <period> <id> [--yes] [remote controls]
├── sync [sink-instance] [--yes] [--dry-run]
├── session
│   ├── status [session-id] [--json]
│   ├── ignore [session-id] [--json]
│   └── unignore [session-id] [--json]
├── client
│   ├── status [client] [--json]                         new projection
│   ├── attach [client] [--dry-run] [--json]
│   ├── detach [client] [--dry-run] [--purge] [--json]
│   ├── history
│   │   ├── import [provider...] [history flags]
│   │   ├── plan [provider...] [--retention-days N] [--json]
│   │   └── providers [--json]
│   ├── skills install [--client name|all]
│   ├── claude-account login|logout|status
│   └── claude-desktop install|status|verify
├── privacy
│   ├── show [path] [--json]
│   ├── set <path> sync|local-only|ignore
│   ├── unset <path> [sync|local-only|ignore]
│   ├── list [--json]
│   ├── ignore [path]
│   ├── unignore [path]
│   ├── client [name] [sync|local-only] [--json]
│   ├── folders [ask|sync] [--json]
│   └── purge <path>|--session id|--ignored|--all [--yes] [--json]
├── join <url> [token] [--token-file file] [--bin path] [--no-daemon]
├── leave
├── admin
│   ├── daemon install|uninstall|run|start|status|stop|restart
│   ├── config validate [--path file]
│   ├── cache status|refresh|maintain
│   ├── sink maintain
│   ├── plugin install|list|info|outdated|update|remove
│   ├── remote add|login|list|remove
│   ├── mcp serve [--remote target]
│   ├── graph project|compact
│   ├── vector status
│   ├── enrichment propose|curate|backfill|status
│   ├── source gascity attach|detach|list                 persistence gap
│   ├── client claude-desktop profile|install-helper
│   └── version
└── dev
    ├── plugin new|doctor
    └── smoke <flow-name>

hidden machine contracts:
  claude-account credential
  claude-hook session-context
  claude-hook classify-cwd
```

## Complete current-to-canonical coverage

Core registers 65 primary names including executable group-help registrations
and the intrinsic `query sql` verb. The only current core alias is `unattach`.
The following matrix covers every behavioral leaf; group-help registrations
collapse into their corresponding new group metadata.

| Current spelling | Canonical spelling | Classification |
|---|---|---|
| `init` | `setup` | Alias, preserve all-available boot |
| `status` | `status` | Unchanged |
| `ask` | `ask` | Unchanged |
| `query overview|sql|schema` | same | Unchanged leaves |
| `query status|refresh|maintain` | `admin cache status|refresh|maintain` | Operator move |
| `backfill` | `client history import` | Alias |
| `backfill plan` | `client history plan` | Alias |
| `backfill list` | `client history providers` | Alias |
| `attach` | `client attach` | Alias |
| `detach`, `unattach` | `client detach` | Aliases |
| none | `client status` | New projection |
| `skills install` | `client skills install` | Alias |
| `ignore`, `unignore` | `privacy ignore`, `privacy unignore` | Aliases, bare dotfile behavior |
| `policy set|show|unset|list|client|folders` | `privacy set|show|unset|list|client|folders` | Aliases |
| `purge` | `privacy purge` | Alias, destructive |
| `join`, `leave` | unchanged | Top-level, unchanged |
| `sync` | unchanged | Top-level, unchanged |
| `report render|publish|list|get|delete` | unchanged | Unchanged group |
| `daemon *` | `admin daemon *` | Alias, preserve no-activation boot |
| `config validate` | `admin config validate` | Alias |
| `sink maintain` | `admin sink maintain` | Alias |
| `plugin install|list|info|outdated|update|remove` | `admin plugin *` | Alias |
| `plugin new|doctor` | `dev plugin new|doctor` | Alias |
| `remote add|login|list|remove` | `admin remote *` | Alias |
| `mcp` | `admin mcp serve` | Alias |
| `version` | `admin version` | Alias, preserve no-activation boot |
| `smoke` | `dev smoke` | Alias, preserve no-activation boot |
| `graph neighbors` | `query graph neighbors` | Typed-verb alias; tool name unchanged |
| `graph project|compact` | `admin graph project|compact` | Plugin-owned alias |
| `vector search` | `query vector search` | Plugin-owned alias; not remote yet |
| `vector status` | `admin vector status` | Plugin-owned alias |
| `enrich propose|curate|backfill|status` | `admin enrichment *` | Plugin-owned aliases |
| `gascity attach|detach|list` | `admin source gascity *` | Plugin-owned aliases after persistence fix |
| `claude-account login|logout|status` | `client claude-account *` | Plugin-owned aliases |
| `claude-desktop install|status|verify` | `client claude-desktop *` | Plugin-owned aliases |
| `claude-desktop profile|install-helper` | `admin client claude-desktop *` | Plugin-owned aliases |
| `claude-account credential` | same, hidden | Secret-bearing machine contract |
| `claude-hook session-context|classify-cwd` | same, hidden | Generated hook contracts |

Current executable group-help names `query`, `plugin`, `config`, `policy`,
`skills`, `daemon`, `sink`, `remote`, `report`, `vector`, and `enrich` map to
the corresponding canonical group-help registration. Context graph already
uses metadata-only group help. The new design should converge all groups on
that model.

## Side-effect and risk index

### Destructive

- `privacy purge`: deletes local cache rows only, confirmed.
- `report delete`: deletes an org report and artifacts, confirmed and
  unrecoverable.
- `admin daemon uninstall`: removes the service and detaches clients, but keeps
  recordings/config/logs.
- `client detach --purge`: removes managed settings plus local proxy CA/trust
  residue, but not recordings.
- `admin plugin remove`: removes installed code and lock entry, not config.

### Sends data or invokes remote services

- `sync`: sends through configured sinks after plan and confirmation.
- `report publish`: uploads report files/bundles.
- `query ... --remote`, report list/get/delete, and `admin mcp serve --remote`:
  authenticated server calls.
- `admin remote login`: browser/OIDC or static credential write and, by default,
  can enroll/forward/install the daemon.
- vector search/refresh and enrichment commands can call configured embedder or
  completion providers.

### Local persistent writes

- `setup`, `join`, `leave`, client attach/detach, privacy setters, daemon,
  cache/sink maintenance, plugin lifecycle, remote add/remove/login, Desktop
  install/profile/helper, graph projection/compaction, and history import.

### Read-only or process-only

- `status`, `ask --list`, query reads, report list/get to stdout, session
  status, client status, privacy show/list, daemon/config/cache/vector/enrichment
  status, plugin list/info/outdated, remote list, version.
- Session ignore/unignore and current Gas City attach/detach are process-memory
  controls, though session control changes live capture until restart.

## Requirements and availability index

- Core commands are always registered. Plugin leaves appear only when their
  owner is effective-config active.
- `setup` requires all-available discovery; `status`, daemon lifecycle,
  version, and smokes intentionally activate no plugins.
- `session` and attach require the AI gateway. Detach does not.
- Graph commands require context graph; neighbor/project usefulness also needs
  projection contracts and data.
- Vector commands require vector search plus an embedder capability.
- Enrichment requires graph and lazily resolved vector/completion capabilities.
- Claude Desktop wet install/verify require macOS; install uses sudo.
- Remote/report commands require a target and suitable credential.
- Confirmation/TTY requirements apply to sync, purge, report delete, remote
  browser login, remote-code plugin install/update, and Desktop install.

## Contract mismatches to resolve during implementation

1. **Boot classification:** first-token dispatch logic would activate plugins
   for `admin daemon`, `admin version`, and `dev smoke`, and would fail to give
   `setup` all-available discovery.
2. **Client status:** proposed but absent. Reuse the overall status collector.
3. **Vector remote:** proposed nesting must not imply remote parity. Convert to
   a typed verb before documenting it.
4. **Gas City persistence:** current attach/detach do not persist.
5. **Credential hiding:** current manifest and runtime make
   `claude-account credential` visible.
6. **Enrichment dry-run:** current `--dry-run` can still write T1 prospects.
7. **Argument validation:** graph compact, vector status, enrichment leaf
   commands, and Gas City list/detach ignore some extra argv.
8. **Plugin list source label:** human output calls every active plugin bundled.
9. **Backfill plan exit:** per-provider plan failures can still end with 0.
10. **Schema unknown exit:** `query schema` reports unregistered dataset but
    exits 0.

These are implementation/docs mismatches, not reasons to abandon the command
tree. They should become explicit acceptance tests for the reorganization.

## Deletion test

`join` and `leave` do not justify a namespace by themselves. Both are
high-salience lifecycle verbs, already shallow, and easy to distinguish. Their
health facts already belong in overall `status`. Removing `fleet` improves the
proposal without losing a useful abstraction.

By contrast, `admin`, `client`, `privacy`, and `dev` each own several related
operations with coherent side-effect/audience boundaries, so deleting those
groups would recreate the current flat inventory.
