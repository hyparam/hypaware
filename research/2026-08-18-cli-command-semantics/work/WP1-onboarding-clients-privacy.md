# WP1: Onboarding, clients, privacy, and enrollment

Status: complete.

## Findings that affect the proposal

- `setup` can be a direct rename of `init`, but dispatch must preserve the
  special `all-available` boot profile. A simple alias without changing
  `decideBootProfile()` would make the picker see only config-active plugins.
- `client status` does not exist. It should be a projection of the client
  section collected by overall `status`, not a second collector.
- `client attach` and `client detach` are good task names. Attach requires a
  live gateway adapter; detach intentionally works from disk without it.
- The proposed `client history` names are accurate aliases for `backfill`.
- `privacy set ... ignore` and `privacy ignore` must remain visibly distinct.
  The former writes a machine-local policy entry, while the latter writes a
  shareable `.hypignore` file.
- `session` must stay top-level. It is an in-memory, exact-session control with
  fail-closed status semantics, not a durable folder privacy policy.
- `join` and `leave` are already top-level and should remain there. Their
  behavior is machine enrollment, not generic remote-target administration.

## Canonical command semantics

### `hyp setup [preset] [flags]`

- **Current implementation:** `hyp init`.
- **Inputs:** optional registered preset; repeatable `--client` and `--source`;
  `--export`, `--retention-days`, `--from-file`, `--yes`/`-y`, `--no-daemon`,
  `--dry-run`, `--force`, and `--bin`.
- **Reads:** bundled and installed plugin manifests, layered config, client
  detection, preset registrations, and an optional JSON config file.
- **Writes and effects:** the interactive path can write or replace local
  config, install the daemon, attach selected clients, install client assets,
  and import history. `--from-file` validates before writing, refuses an
  existing config unless `--force`, and backs up before replacement.
  `--dry-run` writes nothing. `--no-daemon` skips service installation.
- **Selection rules:** a preset invokes that preset. Bare TTY use runs the
  returning-user gate or full wizard. Bare non-TTY use exits 2 with guidance.
  Any recognized flag selects the noninteractive path. `--yes` with no source
  selects Claude plus OTEL. Client selections also imply their source plugins.
  Export defaults to local Parquet.
- **Requirements and failures:** interactive flows need a TTY. Unknown presets,
  malformed flags, invalid configs, and unsafe overwrite attempts fail before
  mutation. Usage errors are 2 and execution failures are 1.
- **Boot contract:** bare `hyp` and `setup` must use `all-available`, not the
  normal config-active profile.
- **Evidence:** `src/core/commands/init.js`, `src/core/cli/walkthrough.js`,
  `src/core/cli/dispatch.js`, and `test/core/init-*.test.js`.

### `hyp status [--json]`

- **Reads only:** config path, daemon and service-manager state, active plugin
  selection, source and sink status, static and on-disk client attach state,
  cache size and retention, dataset registration, recent errors, first-sync
  hold, gateway entrypoints, proxy CA and trust, and launchd environment.
- **Output:** repair-oriented text or a stable JSON object. A missing or stopped
  component is normally diagnostic state, not itself a command failure.
- **Safety:** dispatch activates no plugins, so status cannot bind listeners
  while diagnosing them.
- **Evidence:** `src/core/commands/status.js`, `src/core/daemon/status.js`,
  `src/core/cli/dispatch.js`, and `test/core/status-*.test.js`.

### `hyp ask ["question"] [--list]`

- **Reads:** attached-client state, registered client launch metadata, PATH,
  and the suggested-question catalog. It does not query the cache itself.
- **Effect:** with an explicit question, replaces the terminal process with
  the first attached and executable CLI client that accepts a prompt. Without
  a question, a TTY picker selects one. Claude Desktop is excluded because it
  has no prompt argument.
- **Output and exits:** `--list` prints suggestions and availability without
  launching. An empty cache, a declined picker, and noninteractive list output
  are success. No launchable client or a spawn failure exits 1.
- **Evidence:** `src/core/commands/ask.js` and
  `test/core/commands/ask.test.js`.

### `hyp session status|ignore|unignore [session-id] [--json]`

- **Owner and availability:** contributed by active `@hypaware/ai-gateway`.
- **Resolution:** an explicit ID wins; otherwise the command tries the Claude
  or Codex session context. The control endpoint comes from config or live
  daemon status.
- **Effects:** `ignore` POSTs the exact ID into the gateway's in-memory drop
  set; `unignore` DELETEs it; `status` reads membership. No cached rows are
  deleted and folder policy is independent.
- **Important limits:** the set disappears on gateway restart, forks receive
  new IDs, and a receipt proves set membership only. It does not prove that a
  client is labeling live traffic with that ID. The local control responder is
  bounded and validated but unauthenticated.
- **Exit contract:** 0 means a successful mutation or confirmed ignored; 1
  means confirmed not ignored; 2 is usage error; 3 means unknown or
  unconfirmable and must be treated as recorded.
- **Evidence:** `hypaware-core/plugins-workspace/ai-gateway/src/session_command.js`,
  `hypaware-core/plugins-workspace/ai-gateway/src/index.js`, LLP 0067, and
  LLP 0212.

### `hyp client status [client] [--json]`

- **Status:** proposed new view, not a current command.
- **Required implementation:** select the client portion of
  `collectHypAwareStatus()` and preserve its attached, configured, provenance,
  path, port, entrypoint, and repair facts. It must not activate adapters or
  calculate attach state differently from `hyp status`.

### `hyp client attach [client] [--dry-run] [--json]`

- **Current implementation:** `hyp attach`; default client is `claude` and
  `all` is accepted. The positional and `--client` forms are case-insensitive;
  conflicting duplicates are usage errors.
- **Reads:** the config-active gateway registry, bundled and installed client
  descriptors, layered config, configured or live gateway endpoint, daemon
  status, client settings, attach markers, and client asset registrations.
- **Writes and effects:** invokes the adapter's managed settings write, may
  reattach a stale-port install, materializes that client's skills and
  subagents, and re-arms a refused org attach marker. `--dry-run` avoids writes.
- **Interactive repair:** for one known but inactive client on a TTY, it can
  offer to enable the adapter, update local config, restart the installed
  daemon, activate the plugin in-process, attach, and then offer history
  import. It can separately offer the explicit base-URL to proxy-mode
  migration. Bulk, JSON, dry-run, and non-TTY paths do not prompt.
- **Requirements:** a registered adapter and gateway capability. Endpoint
  resolution uses the in-process listener, configured listen address, or
  liveness-checked daemon status. Failure to prove an endpoint exits 1 with
  daemon repair guidance.
- **Output and exits:** adapters own per-client output. JSON keeps one machine
  payload per client. Unknown clients, disabled fleet-owned adapters, attach
  failures, and incomplete enablement exit 1; parse errors exit 2.
- **Evidence:** `src/core/commands/clients.js`, client adapters under
  `hypaware-core/plugins-workspace/{claude,codex,openclaw}/`, LLP 0174, LLP
  0238, LLP 0244, and `test/core/attach-*.test.js`.

### `hyp client detach [client] [--dry-run] [--purge] [--json]`

- **Current implementation:** `hyp detach`; `unattach` is an existing alias.
- **Reads and writes:** uses static client descriptors and the self-describing
  on-disk attach marker, not a live adapter. It removes only HypAware-managed
  settings and assets recorded by org-driven attach markers, restores prior
  values where recorded, and clears the marker. It never deletes recordings.
- **Availability:** works even when the gateway plugin is inactive or absent.
  `all` sweeps known client descriptors. No marker is an idempotent success.
- **Trust residue:** routine detach preserves the local interception CA,
  keychain trust, and launchd delivery for cheap reattach. `--purge` performs a
  best-effort removal of that residue. `--dry-run` changes nothing.
- **Failures:** parse errors exit 2. Per-client undo failures produce exit 1
  after attempting siblings. Trust purge is best-effort and reports lines.
- **Evidence:** `src/core/commands/clients.js`,
  `src/core/config/client_detach_disk.js`, LLP 0045, LLP 0138, LLP 0238, and
  `test/core/client-detach-*.test.js`.

### `hyp client history import [provider...] [flags]`

- **Current implementation:** `hyp backfill`.
- **Inputs:** providers, `--since`, `--until`, `--retention-days`, `--dry-run`,
  and `--json`. Retention precedence is flag, config cache retention, default.
- **Selection:** no provider names selects providers whose owner plugins are
  enabled in effective config. Explicit names can target any registered
  provider. Providers run sequentially.
- **Pipeline and writes:** scan, materialize through the registered backfill
  materializer, append into the same datasets and source partitions as live
  capture, then flush. `--dry-run` scans but skips materialization and writes.
- **Failures:** invalid dates or an inverted range exit 2. Unknown providers
  exit 1. A provider failure does not stop siblings; any failure makes the
  final exit 1. No selected providers is success with guidance.
- **Evidence:** `src/core/commands/backfill.js`,
  `src/core/registry/backfills.js`, and `test/core/backfill-*.test.js`.

### `hyp client history plan [provider...] [--retention-days <n>] [--json]`

- **Current implementation:** `hyp backfill plan`.
- **Behavior:** calls each selected provider's optional `plan()` and reports
  what it would scan, without materializing or writing rows.
- **Caveat:** provider plan-hook errors are printed but the current runner
  still returns 0. This weak scripting contract should be retained only for
  compatibility or tightened deliberately.
- **Evidence:** `src/core/commands/backfill.js` and
  `test/core/backfill-*.test.js`.

### `hyp client history providers [--json]`

- **Current implementation:** `hyp backfill list`.
- **Behavior:** lists every registered provider, including providers not
  selected by current config. Read-only; an empty registry succeeds.
- **Evidence:** `src/core/commands/backfill.js`.

### `hyp client skills install [--client <name>|all]`

- **Current implementation:** `hyp skills install`.
- **Writes:** replaces registered skill directories and subagent files in the
  selected clients' declared asset locations, idempotently. This is the manual
  repair path after an asset is edited or removed; attach performs the same
  materialization automatically.
- **Requirements and failures:** HOME must resolve. Unknown or failed plugin
  contributions are surfaced by the materializer. Parse errors exit 2; missing
  HOME exits 1; nothing to install is success.
- **Evidence:** `src/core/commands/clients.js`,
  `src/core/runtime/client_assets.js`, LLP 0107, and LLP 0138.

Claude account and Desktop commands are detailed in WP4 because their behavior
is entirely plugin-owned.

### `hyp privacy show [path] [--json]`

- **Current implementation:** `hyp policy show`; defaults to the caller cwd.
- **Reads only:** resolves the effective class (`sync`, `local-only`, or
  `ignore`), declaration, governing source and file, and best-effort residual
  cached-row count. It never deletes rows.
- **Output:** JSON preserves the older `ignore --check --json` machine shape.
  Human output distinguishes an explicit sync mark from the implicit default.
- **Failures:** parse errors exit 2; malformed machine-local store exits 1.
- **Evidence:** `src/core/commands/policy.js`,
  `src/core/commands/clients.js`, LLP 0103, and LLP 0111.

### `hyp privacy set <path> sync|local-only|ignore`

- **Current implementation:** `hyp policy set`.
- **Writes:** upserts one canonicalized machine-local policy entry at the exact
  cwd-relative path. It never writes `.hypignore` and never deletes cached
  rows. `sync` stores the internal `full` class as an explicit answered marker.
- **Semantics:** ignore prevents capture; local-only permits local query but
  drops rows at export; sync permits normal capture and export. A policy at
  least as restrictive is an idempotent success.
- **Failures:** required path/class and token errors exit 2; unreadable store or
  write failure exits 1.
- **Evidence:** same policy sources, LLP 0103, LLP 0110, and LLP 0111.

### `hyp privacy unset <path> [sync|local-only|ignore]`

- **Current implementation:** `hyp policy unset`.
- **Writes:** removes every machine-local entry governing the path, or only
  entries of the named class. It never touches `.hypignore` or cached rows.
  No governing entry is a success.
- **Evidence:** same policy sources and LLP 0111.

### `hyp privacy list [--json]`

- **Current implementation:** `hyp policy list`.
- **Reads:** enumerates machine-local directory entries, per-client opt-outs,
  and the new-folder ask preference. It cannot enumerate `.hypignore` files
  without a filesystem crawl, so those remain path-addressed via `show`.
- **Output:** empty state succeeds. JSON includes each store path.
- **Evidence:** `src/core/commands/policy.js` and LLP 0111.

### `hyp privacy ignore [path]`

- **Current implementation:** bare `hyp ignore`.
- **Writes:** a self-documenting `.hypignore` containing the `ignore` token.
  With no explicit path it writes at the containing git repository root, or
  cwd outside a repository. An explicit path is used exactly. An ancestor
  `.hypignore` makes the operation an idempotent success.
- **Effect:** future live and backfilled rows for the subtree are dropped at
  capture. Existing rows remain until purge. A running daemon observes the
  file after the matcher cache TTL, not necessarily instantly.
- **Failures:** usage errors exit 2; write failure exits 1.
- **Evidence:** `src/core/commands/clients.js`, LLP 0049, and LLP 0050.

### `hyp privacy unignore [path]`

- **Current implementation:** bare `hyp unignore`.
- **Writes:** removes the nearest governing `.hypignore`. It does not remove
  machine-local policy entries and does not delete cached rows. No governing
  dotfile is a success.
- **Evidence:** `src/core/commands/clients.js` and LLP 0049.

### `hyp privacy client [name] [sync|local-only] [--json]`

- **Current implementation:** `hyp policy client`.
- **Reads and writes:** lists or edits a machine-local per-client export opt-out
  store. `local-only` adds an entry and `sync` removes it, both idempotently.
- **Fleet constraint:** a source proven to be central-configured always syncs
  and cannot be opted out locally. Broken provenance resolution degrades to
  unknown so the user is not locked out, while the export resolver still
  applies its own fail-safe.
- **History boundary:** switching back to sync affects only future rows; rows
  withheld while opted out are not uploaded retroactively.
- **Failures:** unknown client or malformed arguments exit 2; centrally locked
  opt-out and store failures exit 1.
- **Evidence:** `src/core/commands/policy.js`, LLP 0188, and
  `test/core/policy-client-*.test.js`.

### `hyp privacy folders [ask|sync] [--json]`

- **Current implementation:** `hyp policy folders`.
- **Reads and writes:** reports or writes the machine-local standing answer for
  unclassified folders. `ask` enables the session-start question; `sync`
  suppresses the question and is the default.
- **Boundary:** changing this preference does not reclassify any folder and
  cannot override dotfiles or explicit policy entries.
- **Failures:** invalid mode exits 2; unreadable or unwritable preference exits
  1.
- **Evidence:** `src/core/commands/policy.js`, LLP 0106, and LLP 0200.

### `hyp privacy purge <path> | --session <id> | --ignored | --all [--yes] [--json]`

- **Current implementation:** `hyp purge`.
- **Destructive scope:** exactly one target. Deletes matching rows and
  partitions only from the intrinsic local cache. It never calls a sink or
  remote server and cannot retract exported copies. Surviving part identity
  and sink watermarks are preserved.
- **Confirmation:** TTY confirmation is required unless `--yes`; non-TTY
  without it exits 2. Declining succeeds.
- **Output:** reports rows and partitions removed; warns about similarly named
  directories not proven identical and recordable directories that a later
  history import can repopulate.
- **Failures:** target/flag errors exit 2; purge execution failures exit 1.
- **Evidence:** `src/core/commands/purge.js`, LLP 0104, and
  `test/core/purge-*.test.js`.

### `hyp join <url> [token] [--token-file <path>] [--bin <path>] [--no-daemon]`

- **Inputs:** HTTP(S) URL and exactly one nonempty token source: positional,
  file, or stdin.
- **Writes and effects:** validates and writes only the central seed layer,
  seeds client-sync state best-effort, supersedes a stale applied-config slot,
  then installs or restarts the daemon unless `--no-daemon`. The daemon pulls
  the full organization config later. Local config is not replaced.
- **Output:** states that configuration will be pulled. `--no-daemon` prints
  the command needed to finish.
- **Failures:** usage/credential shape errors exit 2; reads, validation, seed
  writes, or daemon installation failures exit 1.
- **Evidence:** `src/core/commands/central.js`, LLP 0025, and
  `test/core/join-*.test.js`.

### `hyp leave`

- **Behavior:** best-effort, resumable, idempotent teardown. Removes the
  central config layer, restarts the daemon so forwarding and config pull stop,
  reverses org-driven client attaches from disk, and removes the forward
  identity.
- **What remains:** local config, query history, cache, and daemon service.
  Local capture can continue. A centrally shaped sink manually copied into the
  local layer is not removed and is called out.
- **Output and failures:** no enrollment is a success. Partial failures exit 1
  with per-step repair commands; rerunning resumes from the remaining state.
- **Evidence:** `src/core/commands/central.js`, LLP 0063, and
  `test/core/leave-command.test.js`.
