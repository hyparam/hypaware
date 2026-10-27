# LLP 0557: One layout for the kernel's small state files

**Type:** Plan
**Status:** Draft
**Systems:** Core, Daemon, Config, Usage-Policy, Observability
**Author:** Kenny
**Date:** 2026-10-25
**Related:** [LLP 0004](./0004-activation-and-paths.spec.md) (state
directories), [LLP 0038](./0038-split-query-export-daemon-from-gateway.rfc.md)
(the processing daemon's mirror tree), [LLP 0031](./0031-layered-config.decision.md)
and [LLP 0041](./0041-central-config-client-actions.design.md) (config-control),
[LLP 0523](./0523-client-action-markers-are-written-under-lock.decision.md)
(client-action locks), [LLP 0049](./0049-hypignore-usage-policy.spec.md)
(usage-policy files), [LLP 0066](./0066-session-opt-out.spec.md) and
[LLP 0403](./0403-persistent-session-exclusions.spec.md) (session ignores),
[LLP 0065](./0065-remote-credentials-lock.decision.md) (remote credentials),
[LLP 0471](./0471-sink-instance-bound-2226.design.md) (sink outbox retention)

> Draft 2026-10-25. Phase 1 landed in PR #2820. Phase 2 is on branch
> `state-layout-2`.

## Summary

The kernel keeps about a dozen small JSON files under `<HYP_HOME>/hypaware`.
Each feature that added one chose its own home: some are bare files at the
state root, some sit alone in a folder named after the feature, one folder
holds two slots with etags and a symlink, and the processing daemon mirrors the
gateway's `run/` and `logs/` folders one level down. Before this plan none of
these paths was defined in the shared path helper; seventeen modules each
joined their own string, and nine of them resolved `HYP_HOME` independently.

This plan replaces that with one rule: files are grouped by how they are
written, not by which feature owns them. Cold state goes in `state/`, hot
runtime files in `run/`, and the one secret sits alone at the root. It lands
in steps, each its own PR: centralize the paths with no disk change, move the
cold files with an idempotent boot-time rename, give the two daemons sibling
`run/` and `logs/` trees, then merge the two stores whose file shapes change.
The cache, exports, plugin state, TLS, sink and spool trees are unchanged;
they already follow one convention each, and two of them are named from
outside this codebase.

## Motivation

The tree before this plan, as found on a machine that has run every release
since v1.0:

```
<HYP_HOME>/
  hypaware-config.json
  hypaware-config.json.bak-<ts>      x14, one per `hyp setup` rewrite
  exports/
  spool/claude-bodies/
  hypaware/
    client-assets.json
    remote-credentials.json
    config-control/  active -> config.a.json, config.a.json, config.a.etag,
                     config.b.json, config.b.etag, state.json, client-actions.json,
                     client-action-locks/
    usage-policy/    first-sync-hold.json, folder-ask.json, local-only.json, client-sync.json
    product-telemetry/  policy.json, delivery.json, queue-v1/, dropped/
    session-ignores/ <sha256>.json ...
    sync-check/      <sha256>.json ...
    run/             hypaware.pid, status.json, self-update.json, control/
    processing/      run/{hypaware.pid,status.json,control}, logs/daemon.log, supervisor/run
    logs/            daemon.log, daemon.out.log, daemon.err.log
    sinks/<instance>/outbox/
    tls/  cache/  plugins/  dev-telemetry/
```

Three things are wrong with it, in order of cost:

1. **No single definition.** `src/core/runtime/paths.js` knew the plugin
   dirs and nothing else. The config-control dir name was a constant in two
   files; the usage-policy dir name a constant in four; `HYP_HOME` was
   resolved by hand in nine modules. Any layout change was a twenty-file
   diff with no test that checked the result was coherent.
2. **Inconsistent shape for the same kind of thing.** Four one-key JSON files
   in `usage-policy/` are written together and read together. Two session
   ignores are two files named by hash. `client-assets.json` is a bare file
   and `config-control/state.json` is a folder with one file, for the same
   reason: "this is not a control-plane marker". `self-update.json`, which
   is cold, lives in `run/`, which is hot.
3. **A mirror tree for the second daemon.** `processing/` reproduces `run/`
   and `logs/` so the same helpers work when pointed at a different root.
   That is convenient for the helper and confusing for an operator, who
   finds two `daemon.log` files and two `status.json` files at different
   depths.

The large trees are fine. `cache/datasets/<name>/source=<id>` and
`exports/<name>/source=<id>` use the same partitioning, which is where the
query and export performance lives. `plugins/<name>` is the LLP 0004 contract
and plugins depend on it. `sinks/<instance>/outbox` has its own retention
rule (LLP 0471). `tls/` holds a CA with its own trust story. This plan does
not touch them.

## Design

### The rule

Group by write pattern. Two patterns cover every file this plan moves, and
each gets one folder:

| Pattern | Folder | Written | Examples |
| --- | --- | --- | --- |
| Cold state | `state/` | On a user action or a server sync, at most a few times a day | policies, ledgers, managed config, update check, config backups |
| Hot runtime | `run/` | On a timer | pid, status, control socket |

The one secret, `credentials.json`, sits alone at the state root so a backup
or diagnostic bundle can exclude it by a single path. Nothing else is a bare
file at the root.

Nothing in `state/` may be written on a timer. That is the whole performance
argument: cold files can share a folder, and two of them can merge into one,
precisely because nothing rewrites them often. Hot files stay separate and
stay where they are. The client-action lock files are short-lived but are
written exactly when the marker they guard is, so they sit beside it in
`state/` (LLP 0523) rather than coupling a client action to the daemon's
`run/` directory being writable.

### Target layout

```
<HYP_HOME>/
  hypaware-config.json
  exports/                          unchanged
  spool/claude-bodies/              unchanged: Claude Code's settings name this path
  hypaware/
    credentials.json                was remote-credentials.json; mode 0600
    state/                          phase 2
      client-assets.json            was hypaware/client-assets.json
      client-actions.json           was config-control/client-actions.json
      config-control.json           was config-control/state.json
      managed-config.a.json         was config-control/config.a.json
      managed-config.a.etag
      managed-config.b.json
      managed-config.b.etag
      managed-config.active         was config-control/active (symlink)
      managed-config.seed.json      was config-control/seed.json
      self-update.json              was run/self-update.json
      sync-check/                   was hypaware/sync-check
      client-action-locks/          was config-control/client-action-locks
      config-backups/               was <HYP_HOME>/hypaware-config.json.bak-<ts>; newest 5 kept
      usage-policy.json             phase 4: merge of usage-policy/*.json
      session-ignores.json          phase 4: merge of session-ignores/<hash>.json
    run/
      gateway/                      phase 3; was run/
        hypaware.pid
        status.json
        control/
      processing/                   phase 3; was processing/run and processing/supervisor
        hypaware.pid
        status.json
        control/
        supervisor/
    logs/
      daemon.log                    unchanged
      daemon.out.log                unchanged
      daemon.err.log                unchanged
      processing.log                phase 3; was processing/logs/daemon.log
    product-telemetry/              unchanged: the queue, its delivery cursor and its policy
    sinks/  tls/  cache/  plugins/  dev-telemetry/    unchanged
```

Every path in it is named in one module, `src/core/runtime/paths.js`.

### Managed config keeps its slots

The a/b files, their etags and the `active` symlink are the commit point for
a central config swap (LLP 0031): rename the symlink and the new config is
live atomically. That is worth six files. They move into `state/` under one
`managed-config.` prefix so the folder reads as one concern, and the dedicated
folder goes. The symlink is relative and names a slot by basename, so the
migration recreates it against the new slot name instead of carrying it over
dangling.

### Usage policy becomes one file

`first-sync-hold`, `folder-ask`, `local-only` and `client-sync` are each a
`version` and one value. They are written by the same commands and read
together at boot. One `usage-policy.json` with four top-level keys replaces
them. The largest member, the local-only directory list, is user-curated and
stays in the hundreds of bytes, so rewriting the whole file on any change
costs nothing measurable. The folder stays where it is until the merge so
each file moves once.

### Session ignores become one file

A hash-named file per ignored session let a hook add an ignore without
reading anything (LLP 0403). Ignores are rare, user-driven, and few; a list in
one JSON file read once at boot is simpler and the hook's write stays a single
atomic rename. The store keeps the same interface. As with usage policy, the
folder moves when it merges.

### `self-update.json` moves out of `run/`

It is written once a day by the update check and read by `hyp status`. It is
cold and was only in `run/` because that folder existed. Its lock file, held
for the length of one update, stays in `run/`.

### The processing daemon gets a sibling, not a mirror

`run/<daemon>/` with `gateway` and `processing` replaces the root-swap trick.
The daemon helpers take the daemon name instead of a substituted root. Both
logs land in `logs/`, distinguished by filename, so one `tail -F logs/*.log`
sees both. This extends LLP 0038's "below `hypaware/processing`" wording; that
doc gets an `Extended-by` line when phase 3 lands.

### Config backups are capped and moved

`hyp setup` writes a timestamped backup beside the live config on every
rewrite and never prunes. Backups go under `state/config-backups/` and the
writer keeps the newest five. The backup is still taken before the write, as
LLP 0299 and the schema writer require. A config given by path backs up under
the same relative tree beside it. The migration moves the existing `.bak-*`
files in and prunes them by the same rule.

### The spool stays where Claude Code can find it

An earlier draft moved `<HYP_HOME>/spool` under `hypaware/`. Attaching Claude
Code writes the spool path into Claude Code's own settings as
`OTEL_LOG_RAW_API_BODIES=file:<dir>`, and Claude Code, not HypAware, writes
the bodies there. Moving the folder would strand every attached client until
it re-attached, for no gain in clarity. The spool is the one kernel-owned
path a client program holds, and it stays.

### Product telemetry stays in one folder

`product-telemetry/` holds a queue, the sender's delivery cursor and the
opt-in policy. The policy is cold, but it is the queue's gate and is read on
every enqueue; the cursor is written on every delivery. Splitting one file
out would leave a folder that is almost but not quite the queue. The folder
is one subsystem's spool and stays as it is.

### One table is the definition and the migration

`paths.js` holds a table of every moved file with its `legacy` and `current`
relative path. The helpers index into the table; `migrateStateLayout` walks
it. There is no third list to drift.

A process settles the layout for a state root once, on the first helper call
or explicitly at boot, and caches the answer per root. The daemon always
performs the move: it has just claimed the pid file, so no older daemon can be
reading the legacy paths, and it creates `state/` so a CLI started beside it
can tell it from a daemon of the previous release. Any other process that
finds a live pid at `run/hypaware.pid`, no `state/` directory and a file at a
legacy path is running beside such a daemon, and for the life of that
process it reads and writes the legacy side rather than moving files out from
under the daemon. That daemon's restart is the move. The window is one
upgrade; phase 5 removes the legacy side.

### Not changed, and why

- `cache/`, `exports/`, `plugins/`: performance and plugin contract; see
  Motivation.
- `spool/claude-bodies/`: named in Claude Code's settings; see above.
- `product-telemetry/`: one subsystem's queue with its own cursor and gate;
  see above.
- `sinks/<instance>/outbox/`: per-instance diagnostic history with its own
  retention (LLP 0471). It is a queue by shape but not by role, and moving
  it buys no simplification.
- `tls/`: the local CA. Its path is pinned in installed client trust
  settings and a move would invalidate them.
- `dev-telemetry/`: dev-only, opt-in, documented in the smoke contract.
- `<HYP_HOME>/hyp.json` and `<HYP_HOME>/backups/`: not written by this
  codebase.

## Phases

Each phase is one PR. A phase must not start until the previous one is on
`master`.

### Phase 1: one definition, no disk change

Extend `src/core/runtime/paths.js`, the existing home for kernel path logic,
with the remaining kernel paths. No new module.

- `hypHomeFromEnv(env, homeDir?)`, `stateRootOf(hypHome)` and
  `stateRootFromEnv(env, homeDir?)`: the one place `HYP_HOME` and the
  `hypaware` segment are resolved. `readObservabilityEnv` calls them and
  keeps its shape. `homeDir` stands in for `os.homedir()` so the LLP 0300
  callers pass `env.HOME` and an empty string still falls through.
- One pure function per file or folder in the inventory above
  (`configControlDir`, `configSlotPath(root, slot)`,
  `usagePolicyPath(root, kind)`, `sessionIgnoresDir`, `statusFilePath`,
  `sinkOutboxDir(root, instance)`, and so on). Functions rather than one
  path bag, so a per-message caller allocates one string, as today, and
  not an object of thirty.
- The daemon helpers (`daemonRunDir`, `daemonLogDir`, `daemonLogPath`,
  `processingStateRoot`, `pidFilePath`, `statusFilePath`,
  `selfUpdateStatePath`), `devTelemetryDir` and `captureSpoolRoot` move
  here from `daemon/pid.js`, `daemon/logs.js`, `daemon/status.js`,
  `update/self_update.js`, `observability/env.js` and `capture_spool.js`;
  their importers follow. No re-exports.
- Domain helpers that many callers and tests already import by name
  (`centralSeedPath`, `localOnlyListPath`, `remoteCredentialsPath`,
  `clientAssetStateRoot`, `defaultStateRoot`, `productRoot`,
  `walkthrough.resolveHypHome`) keep their names and delegate.
- Every other module drops its local constant or inline join and calls
  the helper: `config/apply.js`, `config/action_reconciler.js`,
  `config/client_recording.js`, `config/schema.js` (the config basename,
  as `LOCAL_CONFIG_BASENAME`), `usage-policy/{first_sync_hold, folder_ask,
  local_only, client_sync}.js`, `product_telemetry/policy.js`,
  `control/session_ignore_store.js`, `runtime/client_asset_ledger.js`,
  `remote/credentials.js`, `update/self_update.js`,
  `daemon/{pid,logs,status,gateway,runtime,control}.js`, `sinks/driver.js`,
  `tls/ca.js`, `runtime/{activation,boot}.js`, `cli/{walkthrough,
  dispatch}.js`, `commands/{ask,daemon,config,sync-check}.js`, and the
  Claude plugin's `hook_command.js`, which reached into the plugin state
  dir by literal path. `product_telemetry/outbox.js` keeps its children
  relative to the root it is given.
- `test/core/state-paths.test.js` pins every helper against the literal
  current layout, so phase 2 is a diff against a fixture rather than a
  hunt, and scans `src/` and the bundled plugins for any `path.join` of
  a state-root identifier with a layout literal outside `paths.js`.

Exit: `npm test` unchanged except the new test; `npm run typecheck` clean;
`du`/`find` on a running install shows the same tree before and after.
Landed in PR #2820.

### Phase 2: cold state into `state/`

- The moved-file table in `paths.js`, and the helpers for `credentials.json`,
  `client-assets.json`, the managed-config files, `client-actions.json`,
  `client-action-locks/`, `self-update.json` and `sync-check/` read from it.
  `configControlDir` becomes the directory holding the managed-config files,
  which is `state/`; `apply.js` still lists it for leftovers and creates it
  before the first write, and its leftover check filters by the helpers'
  basenames, so sharing the folder with the other cold files is safe.
- `settleStateLayout(stateRoot, { daemon, log })` decides the layout for a
  root once per process, as described above. `runDaemon` calls it with
  `daemon: true` right after claiming the pid file; `bootKernel` calls it
  for every boot before the first cold read, which for the daemon is a
  cached lookup. A helper called before either (the pre-boot `daemon
  status` path, a test) settles lazily with the same rule.
- `migrateStateLayout(stateRoot)` performs the move: for each table entry
  whose legacy path exists and whose current path does not, `mkdir -p` the
  parent and `rename`; the pointer symlink is recreated against the new
  slot name. The config backups beside the local config move into
  `state/config-backups/` and are pruned to five. The empty `config-control/`
  is removed. Each move is logged at info as `state_layout.moved` with
  `component=state-layout`; a move that fails is logged at warn and
  skipped, never fatal. A fresh tree is left exactly as found: `state/` is
  created only when something moves into it or the daemon asks, so a
  preview boot (LLP 0525) still creates nothing.
- `prepareLocalConfigWrite` writes its backup through `configBackupPath`
  and prunes with `pruneConfigBackups` after the copy.
- `docs/CONFIGURATION.md` "Know where data lives", `docs/QUERYING.md`,
  `docs/integrations/ci-and-headless.md` and the `hypaware-reference` skill
  name the new paths. LLP 0031, LLP 0041 and LLP 0523 get `Extended-by`
  lines; LLP 0004's is adjusted.
- The phase 1 fixture becomes the new layout; a second list pins the legacy
  side, and a test builds the legacy tree in a temp dir, migrates it twice,
  and asserts the new tree, an empty old tree, the recreated symlink, the
  five newest backups, and that unmoved neighbours are untouched. Two more
  tests pin the fresh-tree and live-older-daemon cases.

Exit: those tests; `npm test` otherwise unchanged in count; the
`status_diagnostics` and `join_flow_remote_config` smokes green.

### Phase 3: the daemons' run and log trees

- `run/gateway/` and `run/processing/` replace `run/` and
  `processing/{run,supervisor}`; `logs/processing.log` replaces
  `processing/logs/daemon.log`. The daemon helpers take the daemon name
  (`pidFilePath(root, daemon)`, and so on) and `runtimeStateRoot` goes.
- `run/` files are not migrated. They are ephemeral; the new daemon writes
  under its own folder and removes the old `run/*` files and the
  `processing/` tree after claiming its pid.
- The legacy-daemon test moves to the pid file's new location; the
  `state/` marker from phase 2 keeps working because the daemon still
  creates it.
- `docs/TROUBLESHOOTING.md` "Find diagnostic logs" and LLP 0038's
  `Extended-by` line.

Exit: the fixtures; the `daemon_foreground_start_stop` and
`status_diagnostics` smokes green.

### Phase 4: merge the two stores

- `state/usage-policy.json`: the four stores share one file with four keys.
  On read, if the merged file is missing and any of the four old files exists
  in `usage-policy/`, read them, write the merged file atomically, then
  remove the folder. The four module interfaces are unchanged.
- `state/session-ignores.json`: the store reads the merged list; if absent, it
  folds every `<hash>.json` in `session-ignores/` into the list, writes it,
  then removes the folder. The hook's add path stays a single atomic write.
- `docs/PRIVACY.md` and `docs/CLI_REFERENCE.md` name the new files.

Exit: existing store tests pass against the merged shape; one test per store
for the fold.

### Phase 5: remove the shims

Two releases after phase 4: delete the legacy side of the table, the
legacy-daemon rule in `settleStateLayout`, the per-store fold code, and the
`migrateStateLayout` call. Leave the function's tests deleted with it. Note
the removal in the release notes and name the oldest version that upgrades
cleanly.

## Performance

No hot path changes. `status.json` and the pid file are written at the same
cadence. The layout decision is one map lookup per helper call once a root
is settled, and a dozen `lstat` calls the first time; the migration does no
other IO when the tree is already current. The usage-policy merge turns four
small reads into one at boot and four small writes into one whole-file
rewrite per change, where the file is hundreds of bytes and changes are
user-driven. Backups are capped, so a long-lived install no longer grows one
file per rewrite. Memory is unchanged: every file here is already read fully
into memory, and the per-root cache holds one short string per state root
the process has touched.

## Open questions

- Whether `tls/` should move into `state/` in a later phase. It is cold
  state, but installed trust settings name its path.
- Whether `sinks/<instance>/outbox/` should join a queue folder. It is left
  where it is for now because LLP 0471's retention rule names it.

## References

- LLP 0004 #state-directories, the kernel-owned layout this extends
- LLP 0031 #physical-layout, the managed config files
- LLP 0038, the processing daemon's root
- LLP 0471, sink diagnostic history retention
- LLP 0299, confirm prompts and the backup-before-write rule
- LLP 0525, the preview boot that must leave the tree as it found it
