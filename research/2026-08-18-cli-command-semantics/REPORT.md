# HypAware CLI reorganization: researched command semantics

## Decision

Adopt thirteen top-level commands:

```text
setup  status  ask  query  report  sync  session
client  privacy  join  leave  admin  dev
```

Keep `join` and `leave` top-level. The rejected `fleet` group had only two
high-salience leaves, added depth without clarifying behavior, and duplicated
health already reported by `status`.

The task-oriented structure accurately describes the current implementation
with four conditions:

1. `client status` is new and must project the existing overall status model.
2. Vector search does not support remote execution until it becomes a typed
   verb.
3. Gas City attach/detach must become durable before being taught as source
   administration.
4. Boot profiles, plugin ownership, hidden machine contracts, and old aliases
   must be preserved explicitly during the rename.

## Proposed interface

```text
hyp
├── setup [preset] [flags]
├── status [--json]
├── ask ["question"] [--list]
├── query
│   ├── overview [--days N] [--json] [--sql] [--include-local-only]
│   ├── sql <select...> [--remote [target]] [render/privacy controls]
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
│   ├── status [client] [--json]
│   ├── attach [client] [--dry-run] [--json]
│   ├── detach [client] [--dry-run] [--purge] [--json]
│   ├── history
│   │   ├── import [provider...] [--since ISO] [--until ISO]
│   │   │   [--retention-days N] [--dry-run] [--json]
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
│   ├── config validate
│   ├── cache status|refresh|maintain
│   ├── sink maintain
│   ├── plugin install|list|info|outdated|update|remove
│   ├── remote add|login|list|remove
│   ├── mcp serve
│   ├── graph project|compact
│   ├── vector status
│   ├── enrichment propose|curate|backfill|status
│   ├── source gascity attach|detach|list
│   ├── client claude-desktop profile|install-helper
│   └── version
└── dev
    ├── plugin new|doctor
    └── smoke <flow-name>
```

Hidden machine contracts retain their current spellings:

- `claude-account credential`
- `claude-hook session-context`
- `claude-hook classify-cwd`

## Command reference

### Everyday entry points

| Command | What it does | Effects, requirements, and failure meaning |
|---|---|---|
| `setup` | Runs a preset, a noninteractive config path, or the full first/returning-user walkthrough | Can write/replace config, install daemon, attach clients/assets, and import history. Dry-run is safe. Must keep `all-available` plugin discovery. |
| `status` | Builds one repair-oriented snapshot of config, daemon, plugins, sources, sinks, clients, cache, errors, first-sync, gateway, and trust state | Read-only and no plugin activation. JSON is the stable machine form. |
| `ask` | Lists suggested questions or launches the first attached executable CLI client on one | Does not query itself. No launchable client or spawn failure exits 1; list/decline/empty-cache paths succeed. |

Full inputs, writes, and failure paths: [WP1](work/WP1-onboarding-clients-privacy.md).

### Query and report

| Command | What it does | Effects, requirements, and failure meaning |
|---|---|---|
| `query overview` | Local summary of AI tokens/models, daily use, repos, and tools | Read-only, auto-budgets the date window, exposes withheld-row counts, and fails when no AI dataset is registered. |
| `query sql` | Runs one read-only SELECT locally or through remote `query_sql` | Auto-refreshes local cache by default; filters local-only content by caller cwd; supports bounded table/JSON/JSONL/Markdown/file output. |
| `query schema` | Prints one registered dataset schema | Unknown dataset currently prints a placeholder and exits 0. |
| `query graph neighbors` | Resolves a node and breadth-first walks published graph edges | Read-only typed verb, supports remote MCP and privacy filtering; unresolved/ambiguous seed exits 1. It never builds the graph. |
| `query vector search` | Embeds a query and searches configured local vector shards | Auto-refresh may write indexes and call an embedder. No remote/output/privacy parity yet because current command is not a typed verb. |
| `report render` | Rebuilds a local static HTML report site from Markdown | Replaces derived `html/`, preserves source Markdown/theme, and refuses an empty source tree. |
| `report publish` | Uploads one HTML/Markdown file or gzip report bundle | Server-only, write credential required, idempotent by content hash. |
| `report list` | Lists newest org reports with filters | Server-only read; empty list succeeds. |
| `report get` | Streams an entry document/artifact to stdout or a file | Server-only read; preserves binary bytes. |
| `report delete` | Deletes one org report and its artifacts | Unrecoverable, org-wide, TTY-confirmed or `--yes`; non-TTY without confirmation exits 2. |

Shared typed query controls include format, output, cell/byte budgets, refresh,
and bare/named remote selection. Explicit refresh cannot be combined with
remote execution. Full detail: [WP2](work/WP2-query-report-sync.md).

### Capture and movement

| Command | What it does | Effects, requirements, and failure meaning |
|---|---|---|
| `sync` | Prints destination/exclusion plan, confirms, then forces configured sink ticks | Sends data. Dry-run sends nothing. During first-sync hold, only an interactive all-destination run can release early. Any sink failure exits 1. |
| `session status` | Checks exact session membership in gateway in-memory drop set | Exit 0 ignored, 1 recorded, 3 unknown/fail-closed. |
| `session ignore` | Adds exact session ID to the live gateway drop set | Stops future capture only until gateway restart; no row deletion. |
| `session unignore` | Removes exact session ID from the drop set | Resumes capture if folder policy permits. |

Session ID can be explicit or derived from Claude/Codex context. The drop set is
not durable and forks mint new IDs. Full detail: [WP1](work/WP1-onboarding-clients-privacy.md).

### Clients

| Command | What it does | Effects, requirements, and failure meaning |
|---|---|---|
| `client status` | Projects client attach/config/provenance facts from overall status | New read-only view. Must not duplicate state calculation. |
| `client attach` | Writes adapter-managed settings to point a client at the gateway and installs its skills/subagents | Requires a live gateway adapter. Can interactively enable adapter/proxy mode and offer history import. Dry-run writes nothing. |
| `client detach` | Reverses managed client settings from the on-disk undo marker | Works without live gateway, keeps recordings. `--purge` also removes proxy CA/trust residue. |
| `client history import` | Scans providers, materializes records into live datasets, appends and flushes | Writes cache; provider failures do not stop siblings. Dry-run scans only. |
| `client history plan` | Calls provider planning hooks without importing | Read-only, but current plan-hook failures can still end at exit 0. |
| `client history providers` | Lists every registered provider | Read-only, not limited to active-config defaults. |
| `client skills install` | Replaces registered skill and subagent copies for selected clients | Requires HOME; idempotent repair path. |
| `client claude-account login` | Browser/loopback or pasted-code Claude subscription OAuth | Interactive, writes refreshable credential. Refuses org-key mode. |
| `client claude-account logout` | Removes stored subscription credential | Local only; does not revoke server-side or remove org-key config. |
| `client claude-account status` | Reports mode and usable credential presence/expiry | Read-only; unhealthy/missing credential exits 1. |
| `client claude-desktop install` | Attended macOS chain: login, helper, residue backup/clear, sudo managed plist, restart | Idempotent/resumable; `--print-commands` changes nothing. Unsupported platform or incomplete step exits 1. |
| `client claude-desktop status` | Reports resolved endpoint/mode/helper/models/bundle | Helper missing exits 1; does not verify plist. |
| `client claude-desktop verify` | Checks plist freshness and cleared residue, then prints manual in-app capture check | macOS read-only; automatic checks drive exit code. |

Full detail: [WP1](work/WP1-onboarding-clients-privacy.md) and
[WP4](work/WP4-plugin-commands.md).

### Privacy

| Command | What it does | Effects, requirements, and failure meaning |
|---|---|---|
| `privacy show` | Resolves path class/governor and best-effort residual cache count | Read-only; defaults cwd. |
| `privacy set` | Upserts exact machine-local path as sync/local-only/ignore | No dotfile and no row deletion. |
| `privacy unset` | Removes machine-local governing entries, optionally by class | No dotfile and no row deletion; idempotent. |
| `privacy list` | Lists machine-local path/client policy and folder ask preference | Cannot globally enumerate `.hypignore`; use show by path. |
| `privacy ignore` | Writes a self-documenting `.hypignore` at explicit path or default repo root | Future live/backfill capture is dropped; existing rows remain. |
| `privacy unignore` | Removes nearest governing `.hypignore` | Does not remove machine-local entries or cached rows. |
| `privacy client` | Lists or edits per-client local-only export opt-outs | Central-configured clients cannot opt out; switching to sync is future-only. |
| `privacy folders` | Reports/sets whether new unclassified folders ask or sync without asking | Changes prompt preference only, never existing classifications. |
| `privacy purge` | Deletes matching local cache rows by path/session/ignored/all | Confirmed destructive local-only operation; never retracts exported copies. |

The three similarly named operations remain deliberately different:
`privacy set ... ignore` is machine-local prospective policy,
`privacy ignore` is a shareable dotfile, and `privacy purge` removes existing
local data. Full detail: [WP1](work/WP1-onboarding-clients-privacy.md).

### Enrollment

| Command | What it does | Effects, requirements, and failure meaning |
|---|---|---|
| `join` | Validates URL/token, writes only the central seed layer, then installs/restarts daemon | Full org config is pulled later. Local config/history remain. `--no-daemon` leaves an explicit finish step. |
| `leave` | Removes central layer/identity, restarts daemon, and reverses org-driven attaches | Keeps local config, daemon service, and history. Best-effort/idempotent; partial failure exits 1 with repair commands. |

### Administration

| Command family | What it does | Important boundary |
|---|---|---|
| `admin daemon install|uninstall|run|start|status|stop|restart` | Manages foreground or persistent launchd/systemd daemon lifecycle | Install dry-run renders exact unit. Uninstall detaches clients but keeps recordings/config/logs. Preserve no-plugin boot. |
| `admin config validate` | Loads active/explicit config and cross-validates plugin/dataset/sink contracts | Read-only, detailed pointers/error kinds. |
| `admin cache status|refresh|maintain` | Inspects cache, force-refreshes dataset partitions, or migrates/expires/compacts/re-settles | Refresh/maintain write local cache. Maintain continues past partitions and exits 1 if any failed. |
| `admin sink maintain` | Expires Iceberg export snapshots and optionally rewrites data files | Only explicit `--compact` rewrites; dry-run safe. |
| `admin plugin install|list|info|outdated|update|remove` | Manages installed plugin code/lock and cached update state | Remote install/update has a trust confirmation. Bare update only refreshes metadata. Remove does not edit config. |
| `admin remote add|login|list|remove` | Manages named target URLs and permission-restricted credentials | Browser login can enroll/forward/install daemon unless `--no-forward`; remove does not leave enrollment. |
| `admin mcp serve` | Serves active typed verbs over local stdio or proxies a named remote | Stdout is protocol-only. HTTP is refused in V1. |
| `admin graph project|compact` | Builds node/edge tables from contracts or deduplicates/sorts them | Both write derived local graph unless dry-run. |
| `admin vector status` | Reports local vector index/shard coverage and staleness | Read-only, requires active vector/embedder capabilities. |
| `admin enrichment propose|curate|backfill|status` | Extracts prospects, curates committed knowledge, cold-backfills, or reports counts | Can call completion/Batch APIs and write datasets. Current backfill dry-run can still write proposal rows. |
| `admin source gascity attach|detach|list` | Starts/reloads/lists Gas City subscriptions | Current attach/detach are process-memory only and not durable. Fix before teaching canonical names. |
| `admin client claude-desktop profile|install-helper` | Renders secret-free MDM profile or writes executable credential wrapper | Profile output may write a file; helper is 0755 and invokes hidden credential command. |
| `admin version` | Prints HypAware, Node, platform/arch, and HYP_HOME | Read-only and no plugin activation. |

Full administration semantics: [WP3](work/WP3-admin-dev.md). Plugin-owned
details: [WP4](work/WP4-plugin-commands.md).

### Development

| Command | What it does | Effects, requirements, and failure meaning |
|---|---|---|
| `dev plugin new` | Creates source/sink/dataset plugin scaffold designed to pass doctor | Writes target tree; existing/filesystem errors exit 1. |
| `dev plugin doctor` | Aggregates static manifest/entrypoint checks plus sandboxed dry-run activation | Read/execution diagnostic; warnings permit 0, errors return 1. |
| `dev smoke` | Spawns one hermetic flow in a fresh temporary HYP_HOME | Internal development evidence, not installed-daemon acceptance. Propagates child status. |

## Migration map

| Current | Canonical |
|---|---|
| `init` | `setup` |
| `attach`, `detach`, `unattach` | `client attach`, `client detach` |
| `backfill`, `backfill plan`, `backfill list` | `client history import`, `plan`, `providers` |
| `skills install` | `client skills install` |
| `claude-account login|logout|status` | `client claude-account *` |
| `claude-desktop install|status|verify` | `client claude-desktop *` |
| `policy *`, `ignore`, `unignore`, `purge` | `privacy *` |
| `join`, `leave` | unchanged top-level |
| `query status|refresh|maintain` | `admin cache *` |
| `graph neighbors`, `vector search` | `query graph neighbors`, `query vector search` |
| `daemon *`, `config validate`, `sink maintain` | corresponding `admin *` groups |
| plugin lifecycle | `admin plugin *` |
| `plugin new|doctor`, `smoke` | `dev plugin *`, `dev smoke` |
| `remote *`, `mcp`, `version` | corresponding `admin` commands |
| graph/vector/enrichment/Gas City operator commands | corresponding plugin-owned `admin` groups |
| Desktop profile/helper | `admin client claude-desktop *` |

Old spellings should dispatch through the same registration/runner and be
hidden from primary help only after repair output, wizard copy, skills, docs,
and generated hooks teach the canonical interface. Removal belongs to a future
major version and a new LLP.

## Implementation acceptance criteria

- Categorized help shows exactly thirteen top-level commands and no `fleet`.
- Bare `hyp` and `setup` retain all-available discovery.
- `status`, `admin daemon *`, `admin version`, and `dev smoke` activate no
  plugins.
- Every plugin-owned alias remains config-active-only and inactive-command
  repair names the owning plugin.
- Old and canonical spellings have the same runner and observable state change.
- `client status` uses the overall status collector.
- Vector help does not claim remote support before typed-verb conversion.
- Gas City persistence is fixed or canonical admin aliases are withheld.
- Hidden credential/hook commands stay callable but absent from help.
- Secret-bearing credential stdout remains exactly one JSON line.
- Destructive and movement confirmations stay unchanged.

## Confidence and limitations

Confidence is high for client-side command behavior: registrations, runners,
LLPs, manifests, and high-value tests were reconciled. No state-changing
commands were executed. Server-side report/enrollment enforcement was assessed
only through this repository's client contract. Platform daemon and Desktop
flows were statically traced but not exercised against live launchd, systemd,
sudo, a browser, or Claude Desktop.

## Methods and supporting artifacts

- [Research brief](BRIEF.md)
- [Approved plan](PLAN.md)
- [Status](STATUS.md)
- [Evidence ledger](SOURCES.md)
- [WP1: onboarding, clients, privacy, enrollment](work/WP1-onboarding-clients-privacy.md)
- [WP2: query, report, sync, remote execution](work/WP2-query-report-sync.md)
- [WP3: administration and development](work/WP3-admin-dev.md)
- [WP4: plugin commands](work/WP4-plugin-commands.md)
- [WP5: coverage and interface assessment](work/WP5-cross-check.md)
