# WP3: Host administration and development

Status: complete.

## Findings that affect the proposal

- `admin` is the right home for persistent service, config, cache, sink,
  plugin, remote-target, MCP, and derived-index operations. They are not part
  of the everyday read loop.
- `dev` cleanly separates plugin scaffolding/diagnosis and hermetic smokes.
- Moving `daemon` under `admin` requires dispatch boot-profile changes. Current
  no-activation handling keys only on the first token `daemon`, `status`,
  `smoke`, or `version`.
- `admin mcp serve` is a naming projection. Current `mcp` serves locally or
  proxies remotely; it does not have a literal `serve` subcommand.
- Bare `plugin update` means "refresh update metadata", while targeted update
  replaces code. The new help must preserve that meaningful overload.

## Canonical command semantics

### `hyp admin daemon install [flags]`

- **Current implementation:** `hyp daemon install`.
- **Inputs:** optional config path, binary path, `--dry-run`, and JSON only
  with dry-run. An internal/test platform selector accepts darwin or linux.
- **Dry run:** renders the exact launchd plist or systemd unit, target path,
  durable binary path, config, and log directory without writing or loading a
  service.
- **Wet effect:** writes the platform service definition, creates required log
  paths, and loads/enables the user service through the platform manager. A
  default npx cache binary is upgraded to a durable global binary when
  possible; explicit `--bin` is kept verbatim.
- **Failures:** missing binary/invalid flags exit 2; unsupported platform,
  filesystem, or service-manager failures exit 1.
- **Evidence:** `src/core/commands/daemon.js`,
  `src/core/daemon/install.js`, LLP 0025, and
  `test/core/daemon-install-*.test.js`.

### `hyp admin daemon uninstall`

- **Current implementation:** `hyp daemon uninstall`.
- **Effects:** removes the persistent platform service first, then performs a
  disk-driven sweep to detach clients that would otherwise point at a dead
  local gateway. It also removes proxy trust residue through the uninstall
  sweep.
- **What remains:** HypAware config, recorded cache, state, and daemon logs.
- **Partial failure:** if service removal fails, no detach occurs. If service
  removal succeeds but a detach fails, exit 1 explicitly says the service is
  gone and gives per-client repair commands. No arguments are accepted.
- **Evidence:** `src/core/commands/daemon.js`, LLP 0206, LLP 0238, and
  `test/core/daemon-uninstall-*.test.js`.

### `hyp admin daemon run --foreground [--config <path>]`

- **Effect:** boots the daemon runtime in the current process, starts configured
  sources/sinks, tends it until SIGINT/SIGTERM, then returns the daemon handle's
  exit code. It never backgrounds itself.
- **Requirements and failures:** `--foreground` is mandatory; usage errors
  exit 2 and boot/runtime errors exit 1.
- **Evidence:** `src/core/commands/daemon.js` and
  `src/core/daemon/runtime.js`.

### `hyp admin daemon start`

- **Effect:** asks launchd/systemd to start the already installed service.
- **Failures:** no installed service or service-manager failure exits 1;
  unexpected arguments exit 2.
- **Evidence:** `src/core/commands/daemon.js` and
  `src/core/daemon/install.js`.

### `hyp admin daemon status [--json]`

- **Reads only:** daemon status JSON, PID file, and process liveness. It reports
  state, live-derived uptime, source states, and instantiated sinks.
- **Output:** no status file is a successful "not started" result. JSON is a
  machine snapshot. This is narrower than overall `hyp status`.
- **Evidence:** `src/core/commands/daemon.js` and
  `src/core/daemon/status.js`.

### `hyp admin daemon stop`

- **Effect:** requests a graceful stop through the daemon runtime/PID channel
  and waits up to five seconds. Not running is success.
- **Failure:** a process that does not exit in the timeout returns 1.
- **Evidence:** `src/core/commands/daemon.js` and
  `src/core/daemon/runtime.js`.

### `hyp admin daemon restart`

- **Effect:** restarts the installed service through the service manager. If no
  service is installed, it stops any foreground daemon and prints how to start
  one again; it does not spawn a replacement itself.
- **Failures:** service restart or stop failure exits 1.
- **Evidence:** `src/core/commands/daemon.js`.

### `hyp admin config validate [--path <file>]`

- **Reads only:** path precedence is explicit flag, `HYP_CONFIG`, then the
  default under `HYP_HOME`. Loads JSON and validates schema plus cross-plugin,
  dataset, capability, and sink references against bundled and installed
  manifests.
- **Output:** success names path and plugin/sink counts. Failure lists stable
  error kinds and JSON pointers.
- **Failures:** parser/help posture exits 2 in the current runner; load or
  validation failure exits 1.
- **Evidence:** `src/core/commands/config.js`, `src/core/config/validate.js`,
  and `test/core/config-*.test.js`.

### `hyp admin cache status`

- **Current implementation:** `hyp query status`.
- **Reads only:** cache root, pending spool bytes, registered datasets, and
  each table partition's rows, files, snapshots, metadata bytes, layout,
  delete files, retention cutoff, and epoch where applicable.
- **Output and failures:** human-only status, normally exit 0. Low-level cache
  read failures currently propagate through dispatch as command failure.
- **Evidence:** `src/core/commands/query.js` and
  `src/core/cache/maintenance.js`.

### `hyp admin cache refresh [dataset]`

- **Current implementation:** `hyp query refresh`.
- **Writes:** discovers up to one million partitions for each selected
  registered dataset, forces its refresh hook, and force-flushes table paths.
  With no dataset it attempts all refreshable registered datasets.
- **Output:** number of selected datasets and newly written rows. An unknown
  dataset exits 1. Datasets without a refresh hook are counted as selected but
  skipped, an output ambiguity worth fixing later.
- **Evidence:** `src/core/commands/query.js`.

### `hyp admin cache maintain [dataset] [flags]`

- **Current implementation:** `hyp query maintain`.
- **Inputs:** `--dry-run`, `--force`, `--compact-only`, or `--expire-only`;
  compact-only and expire-only are mutually exclusive.
- **Writes:** on a normal wet run first migrates legacy partitions, then expires
  snapshots, compacts due partitions, re-settles fallback rows, and records
  maintenance cursors/rebaselines. Dry-run reports without committing.
- **Output:** per-partition action or degraded reason plus totals. It continues
  past partition failures and exits 1 if any failed; flag errors exit 2.
- **Evidence:** `src/core/commands/query.js`,
  `src/core/cache/maintenance.js`, LLP 0027, LLP 0207, LLP 0217, LLP 0218,
  and LLP 0220.

### `hyp admin sink maintain [instance] [--compact] [--dry-run]`

- **Current implementation:** `hyp sink maintain`.
- **Scope:** only instantiated Iceberg table-format sinks with blob stores.
  With no instance, handles all of them. No matching sinks is success.
- **Writes:** expires snapshots on exported tables. Data-file rewrites occur
  only with explicit `--compact`; daemon sink ticks never compact. Dry-run
  commits nothing.
- **Output:** per-table expired/compacted/skipped/conflict/failure details and
  totals. Unknown instance exits 1; parse errors exit 2; rewrite errors make
  the run exit 1 after processing siblings.
- **Evidence:** `src/core/commands/sink.js`,
  `hypaware-core/plugins-workspace/format-iceberg/src/maintenance.js`, and LLP
  0022.

### `hyp admin plugin install <source> [flags]`

- **Current implementation:** `hyp plugin install`.
- **Inputs:** package/name, git URL, or local directory; optional ref, git
  subdirectory, and `--yes`/`-y`.
- **Writes and effects:** resolves/fetches to staging, validates the manifest and
  entrypoint, computes content/manifest hashes, then atomically installs into
  the HypAware plugin state and updates the lock. Remote code is displayed and
  confirmed on a fully interactive terminal unless `--yes`; noninteractive
  remote install without confirmation exits 2. Local sources follow the trust
  policy in the installer.
- **Output and failures:** success names plugin, version, source kind, install
  directory, and resolved ref. Usage/trust confirmation failures exit 2;
  resolution, validation, or install failures exit 1.
- **Evidence:** `src/core/commands/plugin.js`, `src/core/plugin_install/`, and
  `test/core/plugin-install-*.test.js`.

### `hyp admin plugin list [--json]`

- **Reads only:** current active plugins and installed-plugin lock entries.
  JSON merges them with source, active state, install time, and update state.
- **Caveat:** human output labels every active plugin as bundled, even an
  installed plugin that is active. JSON resolves source from the lock and is
  more accurate.
- **Evidence:** `src/core/commands/plugin.js`.

### `hyp admin plugin info <plugin>`

- **Reads only:** installed lock entry. Prints source, install directory,
  content and manifest hashes, install time, and update metadata. Bundled-only
  plugins are reported as not installed.
- **Failures:** missing name exits 2; missing installed entry exits 1.
- **Evidence:** `src/core/commands/plugin.js`.

### `hyp admin plugin outdated [--json]`

- **Reads only:** cached update-check state in the lock. It does not contact
  sources. Empty/out-to-date is success.
- **Evidence:** `src/core/commands/plugin.js`.

### `hyp admin plugin update [plugin] [--yes]`

- **Two modes:** with a plugin, fetches, validates, diffs, confirms, and swaps
  the installed code using the install trust gate. Without a plugin, contacts
  each installed source only to refresh update metadata in the lock and does
  not install an update.
- **Writes and effects:** targeted mode replaces plugin files and lock entry;
  bare mode only rewrites lock update state. Network access can occur in both.
- **Failures:** parser/trust posture exits 2; update or update-check failures
  are execution failures. Current bare loop has no per-plugin recovery, so one
  thrown check can abort the command.
- **Evidence:** `src/core/commands/plugin.js` and
  `src/core/plugin_install/`.

### `hyp admin plugin remove <plugin>`

- **Writes:** removes the installed plugin directory and lock entry. It does
  not automatically edit local config entries that name the plugin.
- **Failures:** missing name exits 2; unknown/removal failure exits 1.
- **Evidence:** `src/core/commands/plugin.js` and
  `src/core/plugin_install/install.js`.

### `hyp admin remote add <name> <url>`

- **Writes:** create-or-augment the local config's `query.remotes` entry. The
  URL must be HTTP(S), is non-secret, and can be committed. An existing name is
  replaced. Credentials are untouched.
- **Output:** confirms target and points to login. Usage exits 2; config write
  failure exits 1.
- **Evidence:** `src/core/cli/remote_commands.js` and LLP 0033.

### `hyp admin remote login [name] [flags]`

- **Target:** optional name defaults to `query.default_remote`, then the
  shipped default.
- **Static mode:** `--token-file` or piped stdin stores a nonempty static token
  in the permission-restricted credential store. `--org` and `--host` are
  ignored with an explicit note. A token can be stored for a not-yet-configured
  target, with a repair note.
- **Browser mode:** default on a TTY, or forced by `--browser`. `--no-browser`
  prints the URL instead of opening it. `--org` selects an org and `--host`
  supplies the advisory machine label. The loopback authorization session is
  stored with refresh metadata.
- **Enrollment effect:** unless `--no-forward`, a fresh browser login can also
  enroll this machine, write a central sink/seed, seed its forwarding identity,
  open the first-sync review hold, install the daemon unless `--no-daemon`,
  wait for org config/client attachment, and print the privacy review surface.
  `--no-forward` makes it query-only.
- **Exclusivity:** refuses enrollment to a different server until `leave` has
  removed the current central layer, including when that layer is unreadable.
- **Failures:** usage/target/exclusivity errors exit 2; sign-in, store, seed,
  enrollment, or daemon failures exit 1 or the daemon's code. A completed
  login can therefore return nonzero when enrollment is incomplete.
- **Evidence:** `src/core/cli/remote_commands.js`,
  `src/core/remote/identity_client.js`, LLP 0058, LLP 0061, LLP 0063, LLP
  0100, and LLP 0101.

### `hyp admin remote list [--json]`

- **Reads only:** built-in plus configured targets, target-specific env-token
  presence, and stored credential presence. It reports only `env`, `stored`,
  or `missing`, never token values.
- **Output:** name, URL, and token source status. Empty state is success, though
  shipped built-ins normally make the list nonempty.
- **Evidence:** `src/core/cli/remote_commands.js` and LLP 0033.

### `hyp admin remote remove <name>`

- **Writes:** removes the local config target, clears it as default if needed,
  and deletes its stored credential. It does not alter environment variables,
  central enrollment, or server-side grants.
- **Partial failure:** config removal can succeed before credential lock/removal
  fails; the command reports that state and exits 1. Nothing found exits 1.
- **Evidence:** `src/core/cli/remote_commands.js` and LLP 0033.

### `hyp admin mcp serve [--remote <target>]`

- **Current implementation:** `hyp mcp [--remote <target>]`.
- **Local mode:** serves every active typed verb as an MCP JSON-RPC tool over
  stdio. Stdout is protocol-only; lifecycle diagnostics go to stderr. The
  caller cwd becomes the privacy context. Local stdio is trusted and can expose
  operator-class verbs.
- **Remote mode:** acts as a stdio proxy for clients without native remote MCP,
  injecting the named target's stored credential.
- **Limits:** `--http` is parsed but explicitly refused in V1. The command
  blocks until stdin closes. Parser/unsupported transport exits 2; protocol
  handler errors are logged and the server continues where possible.
- **Evidence:** `src/core/commands/mcp.js`, `src/core/mcp/`, and LLP 0034.

### `hyp admin graph project|compact`, `vector status`, `enrichment *`,
`source gascity *`, and `client claude-desktop profile|install-helper`

These are plugin-owned administrative commands. Exact semantics and current
contract mismatches are in WP4.

### `hyp admin version`

- **Current implementation:** `hyp version`; `hyp --version` and `-V` have a
  shorter pre-boot path.
- **Reads only:** package version and resolved environment. Prints HypAware,
  Node, platform/architecture, and HYP_HOME. No plugin activation.
- **Evidence:** `src/core/commands/misc.js` and `src/core/cli/dispatch.js`.

### `hyp dev plugin doctor [dir] [--json]`

- **Current implementation:** `hyp plugin doctor`.
- **Reads and executes:** checks manifest, entrypoint, declared contributions,
  capabilities, and related static contracts, then performs a sandboxed dry-run
  activation to compare registrations with declarations. Defaults to cwd.
- **Output:** complete diagnostic report, not fail-fast. Warnings permit exit
  0; any error-severity finding exits 1. Flag errors exit 2.
- **Evidence:** `src/core/commands/plugin.js`, `src/core/plugin_doctor/`, and
  `test/core/plugin-doctor-*.test.js`.

### `hyp dev plugin new <name> [--kind source|sink|dataset] [--dir <path>]`

- **Current implementation:** `hyp plugin new`.
- **Writes:** creates a plugin scaffold under the target directory, default
  kind source, designed to pass plugin doctor. It prints every created file and
  the next doctor command.
- **Failures:** bad/missing args exit 2; existing-path or filesystem/scaffold
  errors exit 1.
- **Evidence:** `src/core/commands/plugin.js` and
  `src/core/plugin_doctor/scaffold.js`.

### `hyp dev smoke <flow-name>`

- **Current implementation:** `hyp smoke`; explicitly internal.
- **Effect:** spawns a new Node process running `__smoke_internal` for the named
  hermetic flow. The child owns a fresh temporary HYP_HOME and observability;
  stdio is inherited and the child status is propagated.
- **Boundary:** these are deterministic developer workflows, not installed
  daemon acceptance tests and not proof of production telemetry defaults.
- **Failures:** missing flow exits 2; spawn failure exits 1; otherwise exact
  child exit status.
- **Evidence:** `src/core/commands/misc.js`, `hypaware-core/smoke/`, and
  repository `AGENTS.md` smoke-test model.

## Boot-profile implementation requirement

Current dispatch decides profile from `argv[0]`: `init` and bare invocation use
`all-available`; `daemon`, `status`, `smoke`, and `version` activate nothing;
everything else activates effective-config plugins. The proposed aliases need
semantic classification, not first-token spelling:

- `setup` and bare `hyp`: `all-available`
- `status`, every `admin daemon` command, `admin version`, and `dev smoke`:
  no plugin activation
- plugin-aware admin, query, report, sync, client, privacy, session, join, and
  leave commands: config profile, except where current commands already have a
  narrower safe path

Without this change, moving daemon/smoke/version changes observable side
effects by activating listeners and sinks before an administrative command.

Evidence: `src/core/cli/dispatch.js`.
