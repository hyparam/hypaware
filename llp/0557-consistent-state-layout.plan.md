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
[LLP 0049](./0049-hypignore-usage-policy.spec.md) (usage-policy files),
[LLP 0066](./0066-session-opt-out.spec.md) and
[LLP 0403](./0403-persistent-session-exclusions.spec.md) (session ignores),
[LLP 0065](./0065-remote-credentials-lock.decision.md) (remote credentials),
[LLP 0471](./0471-sink-instance-bound-2226.design.md) (sink outbox retention)

> Draft 2026-10-25. Phase 1 is in progress on branch `state-layout`.
> Nothing on disk changes until phase 2.

## Summary

The kernel keeps about a dozen small JSON files under `<HYP_HOME>/hypaware`.
Each feature that added one chose its own home: some are bare files at the
state root, some sit alone in a folder named after the feature, one folder
holds two slots with etags and a symlink, and the processing daemon mirrors the
gateway's `run/` and `logs/` folders one level down. None of these paths is
defined in the shared path helper; seventeen modules each join their own
string, and seven of them resolve `HYP_HOME` independently.

This plan replaces that with one rule and four folders. Files are grouped by
how they are written, not by which feature owns them: cold state in `state/`,
hot runtime files in `run/`, append-heavy queues in `spool/`, and the one
secret alone at the root. It lands in three steps: centralize the paths with
no disk change, flip the layout with an idempotent boot-time move, then merge
the two stores whose file shapes change. The cache, exports, plugin state,
TLS and sink trees are unchanged; they already follow one convention each and
hold the performance-sensitive data.

## Motivation

The current tree, as found on a machine that has run every release since
v1.0:

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
                     config.b.json, config.b.etag, state.json, client-actions.json
    usage-policy/    first-sync-hold.json, folder-ask.json, local-only.json, client-sync.json
    product-telemetry/  policy.json, delivery.json, queue-v1/, dropped/
    session-ignores/ <sha256>.json ...
    run/             hypaware.pid, status.json, self-update.json, control/
    processing/      run/{hypaware.pid,status.json,control}, logs/daemon.log, supervisor/run
    logs/            daemon.log, daemon.out.log, daemon.err.log
    sinks/<instance>/outbox/
    tls/  cache/  plugins/  dev-telemetry/
```

Three things are wrong with it, in order of cost:

1. **No single definition.** `src/core/runtime/paths.js` knows the plugin
   dirs and nothing else. The config-control dir name is a constant in two
   files; the usage-policy dir name is a constant in four; `HYP_HOME` is
   resolved by hand in nine modules (`activation.js`, `self_update.js`,
   `client_asset_ledger.js`, `tls/ca.js`, `walkthrough.js`, `ask.js`,
   `commands/daemon.js`, `commands/config.js` and `observability/env.js`).
   Any layout change today is a twenty-file diff with no test that checks
   the result is coherent.
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

Group by write pattern. Three patterns exist here and each gets one folder:

| Pattern | Folder | Written | Examples |
| --- | --- | --- | --- |
| Cold state | `state/` | On a user action or a server sync, at most a few times a day | policies, ledgers, managed config, update check |
| Hot runtime | `run/` | On a timer, every few seconds | pid, status, control socket |
| Queue | `spool/` | Append per event, many small files, drained by a worker | telemetry batches, captured bodies |

The one secret, `credentials.json`, sits alone at the state root so a backup
or diagnostic bundle can exclude it by a single path. Nothing else is a bare
file at the root.

Nothing in `state/` may be written on a timer. That is the whole performance
argument: cold files can share a folder, and two of them can merge into one,
precisely because nothing rewrites them often. Hot files stay separate and
stay where they are.

### Target layout

```
<HYP_HOME>/
  hypaware-config.json
  exports/                          unchanged
  hypaware/
    credentials.json                was remote-credentials.json; mode 0600
    state/
      client-assets.json            was hypaware/client-assets.json
      client-actions.json           was config-control/client-actions.json
      config-control.json           was config-control/state.json
      managed-config.a.json         was config-control/config.a.json
      managed-config.a.etag
      managed-config.b.json
      managed-config.b.etag
      managed-config.active         was config-control/active (symlink)
      usage-policy.json             merge of the four usage-policy/*.json
      session-ignores.json          merge of session-ignores/<hash>.json
      telemetry-policy.json         was product-telemetry/policy.json
      telemetry-delivery.json       was product-telemetry/delivery.json
      self-update.json              was run/self-update.json
      config-backups/               was <HYP_HOME>/hypaware-config.json.bak-<ts>; newest 5 kept
    run/
      gateway/                      was run/
        hypaware.pid
        status.json
        control/
      processing/                   was processing/run and processing/supervisor
        hypaware.pid
        status.json
        control/
        supervisor/
    logs/
      daemon.log                    unchanged
      daemon.out.log                unchanged
      daemon.err.log                unchanged
      processing.log                was processing/logs/daemon.log
    spool/
      claude-bodies/                was <HYP_HOME>/spool/claude-bodies
      telemetry/
        queue/                      was product-telemetry/queue-v1
        dropped/                    was product-telemetry/dropped
    sinks/  tls/  cache/  plugins/  dev-telemetry/    unchanged
```

Twenty-two paths become seventeen, nine folders become four, and every one of
them is named in one module.

### Decisions worth recording

**Managed config keeps its slots.** The a/b files, their etags and the
`active` symlink are the commit point for a central config swap
(LLP 0031): rename the symlink and the new config is live atomically. That
is worth five files. They move into `state/` under one `managed-config.`
prefix so the folder reads as one concern, and the dedicated folder goes.

**Usage policy becomes one file.** `first-sync-hold`, `folder-ask`,
`local-only` and `client-sync` are each a `version` and one value. They are
written by the same commands and read together at boot. One
`usage-policy.json` with four top-level keys replaces them. The largest
member, the local-only directory list, is user-curated and stays in the
hundreds of bytes, so rewriting the whole file on any change costs nothing
measurable.

**Session ignores become one file.** A hash-named file per ignored session
let a hook add an ignore without reading anything (LLP 0403). Ignores are
rare, user-driven, and few; a list in one JSON file read once at boot is
simpler and the hook's write stays a single atomic rename. The store keeps
the same interface.

**`self-update.json` moves out of `run/`.** It is written once a day by the
update check and read by `hyp status`. It is cold and was only in `run/`
because that folder existed.

**The processing daemon gets a sibling, not a mirror.** `run/<daemon>/`
with `gateway` and `processing` replaces the root-swap trick. The daemon
helpers take the daemon name instead of a substituted root. Both logs land
in `logs/`, distinguished by filename, so one `tail -F logs/*.log` sees
both. This extends LLP 0038's "below `hypaware/processing`" wording; that
doc gets an `Extended-by` line when phase 2 lands.

**Config backups are capped and moved.** `hyp setup` writes a timestamped
backup beside the live config on every rewrite and never prunes. Backups go
under `state/config-backups/` and the writer keeps the newest five. The
backup is still taken before the write, as LLP 0299 and the schema writer
require.

**`spool/` moves under `hypaware/`.** `<HYP_HOME>/spool` was the only
kernel-owned folder outside `hypaware/` besides `exports/`. Exports are a
user-facing product output and stay; the spool is internal and joins the
telemetry queue in one place.

### Not changed, and why

- `cache/`, `exports/`, `plugins/`: performance and plugin contract; see
  Motivation.
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
  relative to the root it is given; phase 2 splits that root.
- `test/core/state-paths.test.js` pins every helper against the literal
  current layout, so phase 2 is a diff against a fixture rather than a
  hunt, and scans `src/` and the bundled plugins for any `path.join` of
  a state-root identifier with a layout literal outside `paths.js`.

Exit: `npm test` unchanged except the new test; `npm run typecheck` clean;
`du`/`find` on a running install shows the same tree before and after.
Landed on branch `state-layout`.

### Phase 2: flip the layout and move

- The helpers return the target layout. The phase 1 fixture becomes the
  old layout and a second fixture pins the new one.
- `migrateStateLayout(stateRoot)` runs once per process before any reader
  opens a state file: at daemon start, and at CLI boot when no daemon pid is
  live. For each (old, new) pair in the fixture: if old exists and new does
  not, `mkdir -p` the parent and `rename`. Same filesystem, atomic, about
  twenty `stat` calls. A crash halfway resumes on the next boot. Each move
  is logged at info with `component=state-layout`. The (old, new) table is
  the two fixtures zipped by key, not a third list.
- A live daemon from the previous release is not disturbed. For that one
  release, a CLI that finds a file at neither new path nor old path treats
  it as absent, as today, and a file found only at the old path is read
  from there. The fallback is one `stat` per cold file per boot and lives in
  `paths.js`, not in the stores.
- `run/` files are not moved. They are ephemeral; the new daemon writes
  under `run/gateway/` and `run/processing/` and removes the old `run/*`
  and `processing/` leftovers after claiming its pid.
- `hyp setup` writes backups under `state/config-backups/` and prunes to
  the newest five. Existing `.bak-*` files at `<HYP_HOME>` are moved in,
  then pruned by the same rule.
- `docs/CONFIGURATION.md` "Know where data lives", `docs/PRIVACY.md`,
  `docs/TROUBLESHOOTING.md` and the `hypaware-reference` skill's path list
  are updated in the same commit. LLP 0004 and LLP 0038 get `Extended-by`
  lines.

Exit: the two fixtures; a test that builds the old tree in a temp dir, runs
the migration twice, and asserts the new tree and an empty old tree; the
`status_diagnostics` and `daemon_foreground_start_stop` smokes green.

### Phase 3: merge the two stores

- `usage-policy.json`: the four stores share one file with four keys. On
  read, if the merged file is missing and any of the four old files exists
  at its phase 2 location, read them, write the merged file atomically, then
  unlink the old four. The four module interfaces are unchanged.
- `session-ignores.json`: the store reads the merged list; if absent, it
  folds every `<hash>.json` in the old folder into the list, writes it,
  then removes the folder. The hook's add path stays a single atomic
  write.

Exit: existing store tests pass against the merged shape; one test per store
for the fold.

### Phase 4: remove the shims

Two releases after phase 3: delete the old-layout fixture, the read
fallback, the per-store fold code, and the `migrateStateLayout` call. Leave
the function's test deleted with it. Note the removal in the release notes
and name the oldest version that upgrades cleanly.

## Performance

No hot path changes. `status.json` and the pid file are written at the same
cadence to a folder one level deeper. The migration is bounded by the fixture
size, runs once per process, and does no IO when the tree is already current
beyond the `stat` calls. The usage-policy merge turns four small reads into
one at boot and four small writes into one whole-file rewrite per change,
where the file is hundreds of bytes and changes are user-driven. Memory is
unchanged: every file here is already read fully into memory.

## Open questions

- Whether `tls/` should move into `state/` in a later phase. It is cold
  state, but installed trust settings name its path.
- Whether `sinks/<instance>/outbox/` should join `spool/`. It is left where
  it is for now because LLP 0471's retention rule names it.

## References

- LLP 0004 #state-directories, the kernel-owned layout this extends
- LLP 0038, the processing daemon's root
- LLP 0471, sink diagnostic history retention
- LLP 0299, confirm prompts and the backup-before-write rule
