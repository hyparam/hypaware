// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * @import { PluginName, PluginPaths } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Build a per-plugin `PluginPaths` bag. The kernel hands one of these
 * to every plugin during activation; the directories are stable across
 * boots (state/cache) or scoped to the current boot (temp).
 *
 * Per LLP 0004#state-directories:
 * - `rootDir`  the plugin's installed directory (where the manifest lives).
 * - `stateDir` `<state>/plugins/<name>` (durable per-plugin state).
 * - `cacheDir` `<state>/cache/plugins/<name>` (derivable per-plugin cache).
 * - `tempDir`  `<os-tmp>/<name>-<run-id>` (ephemeral per-boot scratch).
 *
 * Plugin names may contain a scope (`@hypaware/dummy-a`). The kernel
 * preserves the literal name in state/cache layouts (matching the npm
 * scoped-package convention) and sanitizes the temp dir slash because
 * it is single-purpose and not user-facing.
 *
 * Directories are created eagerly so plugins can write immediately
 * inside `activate(ctx)` without an mkdir dance. `stateDir` and
 * `cacheDir` outlive the boot; `tempDir` does not, and a CLI dispatch
 * that owns its kernel hands the set back to `reclaimPluginTempDirs`
 * at teardown (daemon and gateway boots, and injected kernels, do not).
 */

/**
 * Resolve the four standard plugin directories and create them on disk.
 *
 * @param {object} args
 * @param {PluginName} args.pluginName  Manifest `name`.
 * @param {string}     args.rootDir     Plugin installation root.
 * @param {string}     args.stateRoot   Kernel state root (e.g. `<HYP_HOME>/hypaware`).
 * @param {string}     args.runId       Kernel boot identifier (DEV_RUN_ID or similar).
 * @param {string}     [args.tmpRoot]   Override the OS temp root (tests).
 * @param {boolean}    [args.preview]   Resolve `stateDir`/`cacheDir` without creating them.
 * @returns {Promise<PluginPaths>}
 * @ref LLP 0004#state-directories [implements]: kernel-owned scoped per-plugin dirs; plugins never reach into each other's
 */
export async function createPluginPaths({ pluginName, rootDir, stateRoot, runId, tmpRoot, preview }) {
  if (!pluginName) throw new Error('createPluginPaths: pluginName is required')
  if (!rootDir) throw new Error('createPluginPaths: rootDir is required')
  if (!stateRoot) throw new Error('createPluginPaths: stateRoot is required')
  if (!runId) throw new Error('createPluginPaths: runId is required')

  const stateDir = pluginStateDir(stateRoot, pluginName)
  const cacheDir = path.join(cacheRootOf(stateRoot), 'plugins', pluginName)
  const tempBase = tmpRoot ?? os.tmpdir()
  // `runId` reaches here straight from `DEV_RUN_ID` (or similar) and is not
  // otherwise validated, so without sanitizing it the same way as `pluginName`
  // it could contribute `/` or `..` segments that `path.join` normalizes right
  // out of `tempBase`. Teardown recursively deletes this path, so an
  // unsanitized `runId` would turn an attacker- or accident-controlled env
  // var into an arbitrary recursive delete.
  const intendedTempDir = path.join(tempBase, `${sanitizeTempSegment(pluginName)}-${sanitizeTempSegment(runId)}`)

  // A preview boot (`hyp setup --dry-run`) must leave the user's state root
  // as it found it, so the two durable dirs are named but not created. The
  // temp dir below is still made: it is outside the state root and the boot
  // that owns it reclaims it at teardown.
  // @ref LLP 0525#preview-boot [implements]: a preview boot resolves the durable plugin dirs without creating them
  await Promise.all([
    ...(preview ? [] : [
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(cacheDir, { recursive: true }),
    ]),
    fs.mkdir(tempBase, { recursive: true }),
  ])

  // The temp dir name is derived only from plugin name and runId, so two boots
  // sharing a runId (two kernel boots in one process, which several smokes and
  // any embedder that boots twice can do) resolve to the same directory.
  // Reclaim deletes whatever this boot thinks it owns at teardown, so adopting
  // a directory another live boot created would delete that boot's in-flight
  // scratch out from under it. Whoever creates the directory owns it; everyone
  // else takes a unique sibling.
  //
  // The probe has to be a *non-recursive* mkdir. `{ recursive: true }` resolves
  // to "the first directory path created", which is an ancestor rather than
  // `intendedTempDir` whenever an ancestor was missing too, so with an injected
  // `tmpRoot` that does not exist yet (several smokes, and
  // test/core/activation-env-forwarding.test.js, pass exactly that) two
  // concurrent boots could each see a non-`undefined` return and both conclude
  // they created the leaf. `tempBase` is created above, and a plain mkdir is
  // atomic: exactly one caller creates the leaf, every other gets EEXIST.
  let tempDir = intendedTempDir
  try {
    await fs.mkdir(intendedTempDir)
  } catch (err) {
    if (!err || /** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err
    tempDir = await fs.mkdtemp(`${intendedTempDir}-`)
  }

  return { rootDir, stateDir, cacheDir, tempDir }
}

/**
 * Remove the per-boot temp directories a kernel boot created. The boot that
 * made them is the only thing that can know it is finished with them, and
 * until issue #2465 nothing removed them at all: one directory per activated
 * plugin stayed in the user's temp root until the OS temp reaper got to it.
 *
 * @param {Iterable<string>} tempDirs `PluginPaths.tempDir` values from one boot.
 * @returns {Promise<void>}
 */
export async function reclaimPluginTempDirs(tempDirs) {
  for (const dir of tempDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // Teardown runs after the command rendered its result, so a scratch dir
      // we cannot remove is a leak, not a failure the caller can act on.
    }
  }
}

/**
 * The durable per-plugin state directory, `<stateRoot>/plugins/<name>`, without
 * creating it.
 *
 * `createPluginPaths` is the activation-time path: it mkdirs the dirs (all but
 * the durable two on a preview boot) and hands the bag to the plugin. The
 * kernel sometimes needs to *read* a plugin's durable state outside
 * activation (the `hyp sync` consent preview reads a sink instance's
 * watermarks to say how much is queued), and creating directories as a side
 * effect of a read is the wrong shape for a `--dry-run`. Same join, one source
 * of truth, no mkdir.
 *
 * @ref LLP 0004#state-directories [constrained-by]: the kernel owns the layout, so a kernel-side reader derives the path here instead of re-guessing it
 * @param {string} stateRoot Kernel state root (e.g. `<HYP_HOME>/hypaware`).
 * @param {string} pluginName Manifest `name`.
 * @returns {string}
 */
export function pluginStateDir(stateRoot, pluginName) {
  if (!stateRoot) throw new Error('pluginStateDir: stateRoot is required')
  if (!pluginName) throw new Error('pluginStateDir: pluginName is required')
  return path.join(stateRoot, 'plugins', pluginName)
}

/**
 * Collapse a plugin name into a single filesystem segment. `/` becomes
 * `__` so a scoped plugin's temp dir is one directory rather than a
 * nested tree; characters outside `[A-Za-z0-9._@-]` get replaced with
 * `_` to keep the result safe on every platform we run on.
 *
 * @param {string} name
 */
function sanitizeTempSegment(name) {
  return name.replace(/\//g, '__').replace(/[^A-Za-z0-9._@-]/g, '_')
}

// ---------------------------------------------------------------------------
// Kernel-owned state paths
//
// Every file and directory the kernel itself keeps under `HYP_HOME` is named
// here and nowhere else. Stores import the function for their file; they do
// not carry a directory constant of their own. The layout is the one LLP 0004
// describes; the segment strings below are the single place to change when it
// moves.
// @ref LLP 0557#phase-1-one-definition-no-disk-change [implements]: one module names every kernel state path, so a layout change is a diff here plus a fixture
// ---------------------------------------------------------------------------

const HYP_HOME_DIRNAME = '.hyp'
const STATE_ROOT_DIRNAME = 'hypaware'

/**
 * `HYP_HOME`: the env override when set, else `<home>/.hyp`.
 *
 * `homeDir` stands in for `os.homedir()` for callers that operate on a
 * specific home (a disk-driven detach, every sandboxed test) and must not fall
 * through to the ambient one. An empty string is never a home: it would make
 * the result cwd-relative, so it falls through like `undefined`.
 * @ref LLP 0300#home-resolution [constrained-by]: '' is never a home
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homeDir]
 * @returns {string}
 */
export function hypHomeFromEnv(env = process.env, homeDir) {
  if (env.HYP_HOME) return env.HYP_HOME
  return path.join(homeDir || os.homedir(), HYP_HOME_DIRNAME)
}

/**
 * The kernel state root, `<HYP_HOME>/hypaware`.
 * @param {string} hypHome
 * @returns {string}
 */
export function stateRootOf(hypHome) {
  return path.join(hypHome, STATE_ROOT_DIRNAME)
}

/**
 * `stateRootOf(hypHomeFromEnv(env, homeDir))`, for the callers that have no
 * booted kernel to ask (detach, uninstall, the update check).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homeDir]
 * @returns {string}
 */
export function stateRootFromEnv(env = process.env, homeDir) {
  return stateRootOf(hypHomeFromEnv(env, homeDir))
}

/**
 * The user's local config layer, `<HYP_HOME>/hypaware-config.json`. Named
 * here so the state tree below it and the config beside it come from one
 * place; `config/schema.js` owns reading and writing it.
 */
export const LOCAL_CONFIG_BASENAME = 'hypaware-config.json'

/** @param {string} hypHome @returns {string} */
export function localConfigPath(hypHome) {
  return path.join(hypHome, LOCAL_CONFIG_BASENAME)
}

/**
 * Root of the capture spools, `<HYP_HOME>/spool`. Each client adapter that
 * spools raw bodies owns one child directory.
 * @ref LLP 0253#spool-location [implements]: a path under the HypAware home is what `hyp purge` and detach can find without being told
 * @param {string} hypHome
 * @returns {string}
 */
export function captureSpoolRoot(hypHome) {
  return path.join(hypHome, 'spool')
}

/**
 * Where `hyp ask` keeps its first-look evidence, `<HYP_HOME>/ask`.
 * @param {string} hypHome
 * @returns {string}
 */
export function askRoot(hypHome) {
  return path.join(hypHome, 'ask')
}

/**
 * The intrinsic query cache, `<stateRoot>/cache`.
 * @param {string} stateRoot
 * @returns {string}
 */
export function cacheRootOf(stateRoot) {
  return path.join(stateRoot, 'cache')
}

/**
 * Remote credentials (tokens for every enrolled server), mode 0600.
 * @param {string} stateRoot
 * @returns {string}
 */
export function credentialsPath(stateRoot) {
  return path.join(stateRoot, 'remote-credentials.json')
}

/**
 * The ledger of client assets HypAware itself wrote. A sibling of
 * `config-control/`, not inside it: this is not a control-plane marker.
 * @param {string} stateRoot
 * @returns {string}
 */
export function clientAssetLedgerPath(stateRoot) {
  return path.join(stateRoot, 'client-assets.json')
}

/**
 * The central config-control directory: the applied slots, their etags, the
 * active-slot pointer, the join seed, the apply state and the action marker.
 * @ref LLP 0031#physical-layout [implements]: the central layer's files live together, off the user-facing config path
 * @param {string} stateRoot
 * @returns {string}
 */
export function configControlDir(stateRoot) {
  return path.join(stateRoot, 'config-control')
}

/**
 * The apply engine's own state record.
 * @param {string} stateRoot
 * @returns {string}
 */
export function configControlStatePath(stateRoot) {
  return path.join(configControlDir(stateRoot), 'state.json')
}

/**
 * The active-slot pointer: a relative symlink at this path naming the live
 * `config.{a,b}.json` slot. Kept inside `config-control/` so the user's local
 * config is a plain file and the atomic symlink flip stays crash-safe.
 * @ref LLP 0031#physical-layout [constrained-by]: active-slot pointer relocated into config-control/
 * @param {string} stateRoot
 * @returns {string}
 */
export function configControlActivePath(stateRoot) {
  return path.join(configControlDir(stateRoot), 'active')
}

/**
 * The join seed: the initial central layer `hyp join` writes (mode 0600, it
 * holds the policy token), retired by the first successful apply.
 * @ref LLP 0031#physical-layout [implements]: dedicated central-seed file, not hypaware-config.json
 * @param {string} stateRoot
 * @returns {string}
 */
export function configControlSeedPath(stateRoot) {
  return path.join(configControlDir(stateRoot), 'seed.json')
}

/**
 * An applied central config slot.
 * @param {string} stateRoot
 * @param {'a' | 'b'} slot
 * @returns {string}
 */
export function configSlotPath(stateRoot, slot) {
  return path.join(configControlDir(stateRoot), `config.${slot}.json`)
}

/**
 * The etag recorded beside an applied slot.
 * @param {string} stateRoot
 * @param {'a' | 'b'} slot
 * @returns {string}
 */
export function configSlotEtagPath(stateRoot, slot) {
  return path.join(configControlDir(stateRoot), `config.${slot}.etag`)
}

/**
 * The client-action marker: which central requests this host has completed.
 * @ref LLP 0041#idempotency-and-completion-state [implements]: marker file config-control/client-actions.json
 * @param {string} stateRoot
 * @returns {string}
 */
export function clientActionsPath(stateRoot) {
  return path.join(configControlDir(stateRoot), 'client-actions.json')
}

/**
 * Per-request lifecycle locks for client actions, one file per
 * `(kind, requestKey)` while it is held. Released locks are deleted, so the
 * directory holds only the keys someone is working on right now.
 * @ref LLP 0523#two-locks [implements]: a per-key lock around the effect, a brief store lock around the marker write
 * @param {string} stateRoot
 * @returns {string}
 */
export function clientActionLocksDir(stateRoot) {
  return path.join(configControlDir(stateRoot), 'client-action-locks')
}

/**
 * One of the four usage-policy records. Each is a `version` and one value,
 * written by the same commands and read together at boot.
 * @param {string} stateRoot
 * @param {'first-sync-hold' | 'folder-ask' | 'local-only' | 'client-sync'} kind
 * @returns {string}
 */
export function usagePolicyPath(stateRoot, kind) {
  return path.join(stateRoot, 'usage-policy', `${kind}.json`)
}

/**
 * Persistent session opt-outs, one marker file per ignored session.
 * @ref LLP 0403#storage [implements]: independent markers persist opt-outs
 * @param {string} stateRoot
 * @returns {string}
 */
export function sessionIgnoresDir(stateRoot) {
  return path.join(stateRoot, 'session-ignores')
}

/**
 * Product telemetry: the opt-in policy, the delivery record and the outbox
 * queue, all below one root (`product_telemetry/outbox.js` names the children).
 * @param {string} stateRoot
 * @returns {string}
 */
export function productTelemetryRoot(stateRoot) {
  return path.join(stateRoot, 'product-telemetry')
}

/**
 * `hyp sync-check` proofs, one file per server endpoint.
 * @param {string} stateRoot
 * @returns {string}
 */
export function syncCheckProofDir(stateRoot) {
  return path.join(stateRoot, 'sync-check')
}

/**
 * The local proxy certificate authority (`tls/ca.js` names the files).
 * @param {string} stateRoot
 * @returns {string}
 */
export function tlsDir(stateRoot) {
  return path.join(stateRoot, 'tls')
}

/**
 * Dev-telemetry JSONL outputs, written only with `HYP_DEV_TELEMETRY=1`.
 * @param {string} stateRoot
 * @returns {string}
 */
export function devTelemetryDir(stateRoot) {
  return path.join(stateRoot, 'dev-telemetry')
}

/**
 * The daemon's runtime files (pid, status, control channel). The processing
 * daemon keeps its own copy of this tree below `processingStateRoot`.
 * @param {string} stateRoot
 * @returns {string}
 */
export function daemonRunDir(stateRoot) {
  return path.join(stateRoot, 'run')
}

/**
 * The PID file. There is exactly one daemon per `HYP_HOME`, so a single fixed
 * filename keeps `daemon stop` / `daemon status` simple.
 * @param {string} stateRoot
 * @returns {string}
 */
export function pidFilePath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'hypaware.pid')
}

/**
 * The daemon status snapshot, rewritten at each lifecycle transition so a
 * parallel `hyp daemon status --json` sees a consistent picture without
 * walking the kernel.
 * @param {string} stateRoot
 * @returns {string}
 */
export function statusFilePath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'status.json')
}

/**
 * The self-update check record (last check, latest version, boot failures).
 * @param {string} stateRoot
 * @returns {string}
 */
export function selfUpdateStatePath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'self-update.json')
}

/**
 * The daemon's line-oriented log directory. OTel logs land in
 * `devTelemetryDir` or go over OTLP; this holds the sidecar a human tails.
 * @param {string} stateRoot
 * @returns {string}
 */
export function daemonLogDir(stateRoot) {
  return path.join(stateRoot, 'logs')
}

/**
 * The daemon's structured log. The name is fixed per `HYP_HOME` so
 * `tail -F` survives restarts; the run id is inside each record.
 * @param {string} stateRoot
 * @returns {string}
 */
export function daemonLogPath(stateRoot) {
  return path.join(daemonLogDir(stateRoot), 'daemon.log')
}

/**
 * The state root the supervised processing daemon keeps its own runtime files
 * under. Its pid, status, control and log paths are the ordinary ones rooted
 * here, so a reader that wants the processor's copy of one derives it through
 * this rather than repeating the segment. The gateway keeps the primary root.
 * @ref LLP 0038#lifecycle-and-operator-behavior [implements]: the processor's runtime files live below `hypaware/processing`
 * @param {string} stateRoot
 * @returns {string}
 */
export function processingStateRoot(stateRoot) {
  return path.join(stateRoot, 'processing')
}

/**
 * The gateway's supervisor control files for the processing child.
 * @param {string} stateRoot
 * @returns {string}
 */
export function processingSupervisorDir(stateRoot) {
  return path.join(processingStateRoot(stateRoot), 'supervisor')
}

/**
 * Per-sink-instance state (export progress, diagnostic history).
 * @param {string} stateRoot
 * @returns {string}
 */
export function sinksRoot(stateRoot) {
  return path.join(stateRoot, 'sinks')
}

/**
 * A sink instance's retained failure diagnostics.
 * @param {string} stateRoot
 * @param {string} instance
 * @returns {string}
 */
export function sinkOutboxDir(stateRoot, instance) {
  return path.join(sinksRoot(stateRoot), instance, 'outbox')
}
