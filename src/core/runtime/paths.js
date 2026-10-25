// @ts-check

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getLogger } from '../observability/logger.js'

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

// ---------------------------------------------------------------------------
// Cold state and the move that put it there
//
// Everything the kernel writes on a user action or a server sync, and never on
// a timer, shares `<stateRoot>/state`; the one secret stays alone at the
// root so a backup or a diagnostic bundle can skip it by a single path. Each
// entry below
// names where the file lived before the move (`legacy`) and where it lives now
// (`current`). The table is both the path definition and the migration:
// `migrateStateLayout` walks it, and a process that finds a daemon from the
// previous release still running reads the legacy side, so the CLI and that
// daemon never disagree about where a file is.
// @ref LLP 0557#phase-2-cold-state-into-state [implements]: one table names every moved file on both sides, and nothing under `state/` is written on a timer
// ---------------------------------------------------------------------------

const COLD_STATE_DIRNAME = 'state'

/** @type {Record<string, { legacy: string, current: string, kind?: 'dir' | 'symlink' }>} */
const MOVED = {
  credentials: { legacy: 'remote-credentials.json', current: 'credentials.json' },
  clientAssets: { legacy: 'client-assets.json', current: 'state/client-assets.json' },
  configControlState: { legacy: 'config-control/state.json', current: 'state/config-control.json' },
  configControlActive: { legacy: 'config-control/active', current: 'state/managed-config.active', kind: 'symlink' },
  configControlSeed: { legacy: 'config-control/seed.json', current: 'state/managed-config.seed.json' },
  configSlotA: { legacy: 'config-control/config.a.json', current: 'state/managed-config.a.json' },
  configSlotB: { legacy: 'config-control/config.b.json', current: 'state/managed-config.b.json' },
  configSlotEtagA: { legacy: 'config-control/config.a.etag', current: 'state/managed-config.a.etag' },
  configSlotEtagB: { legacy: 'config-control/config.b.etag', current: 'state/managed-config.b.etag' },
  clientActions: { legacy: 'config-control/client-actions.json', current: 'state/client-actions.json' },
  clientActionLocks: { legacy: 'config-control/client-action-locks', current: 'state/client-action-locks', kind: 'dir' },
  selfUpdate: { legacy: 'run/self-update.json', current: 'state/self-update.json' },
  syncCheckProofs: { legacy: 'sync-check', current: 'state/sync-check', kind: 'dir' },
}

/** The directory the legacy central-layer files shared; removed once empty. */
const LEGACY_CONTROL_DIRNAME = path.dirname(MOVED.configControlState.legacy)

/** How many timestamped config backups `prepareLocalConfigWrite` keeps. */
export const CONFIG_BACKUPS_KEEP = 5

/**
 * Which side of the table each state root reads, decided once per process
 * and root. Settled lazily by the first helper that needs it, or explicitly
 * by a boot that wants the moves logged.
 * @type {Map<string, 'current' | 'legacy'>}
 */
const layoutByRoot = new Map()

/**
 * @param {string} stateRoot
 * @returns {'current' | 'legacy'}
 */
function layoutOf(stateRoot) {
  return layoutByRoot.get(stateRoot) ?? settleStateLayout(stateRoot)
}

/**
 * @param {string} stateRoot
 * @param {keyof typeof MOVED} key
 * @returns {string}
 */
function movedPath(stateRoot, key) {
  const entry = MOVED[key]
  return path.join(stateRoot, layoutOf(stateRoot) === 'legacy' ? entry.legacy : entry.current)
}

/** @param {string} p */
function lexists(p) {
  try {
    fsSync.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * True while a daemon from before the move is still running against this
 * root: its pid file names a live process, nothing has marked the tree
 * current, and at least one file still sits at a legacy path. A CLI in that
 * window reads and writes the legacy side rather than moving files out from
 * under the daemon; the daemon's own restart performs the move.
 * @param {string} stateRoot
 */
function previousReleaseDaemonIsLive(stateRoot) {
  if (lexists(path.join(stateRoot, COLD_STATE_DIRNAME))) return false
  /** @type {unknown} */
  let pid
  try {
    pid = JSON.parse(fsSync.readFileSync(pidFilePath(stateRoot), 'utf8')).pid
  } catch {
    return false
  }
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
  } catch (err) {
    // EPERM is a pid some process still holds.
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EPERM') return false
  }
  return Object.values(MOVED).some((entry) => lexists(path.join(stateRoot, entry.legacy)))
}

/**
 * Decide which layout this process reads for `stateRoot`, and perform the
 * move when it is safe to. The daemon always moves: it has just claimed the
 * pid file, so no older daemon can be reading the legacy paths. Anything else
 * defers to a live daemon from the previous release and reads what that
 * daemon reads. Idempotent and cheap to repeat: a settled root costs a map
 * lookup, an unsettled one a handful of `lstat` calls.
 *
 * @param {string} stateRoot
 * @param {{ daemon?: boolean, log?: { info(event: string, fields?: Record<string, unknown>): void, warn(event: string, fields?: Record<string, unknown>): void } }} [opts]
 * @returns {'current' | 'legacy'}
 */
export function settleStateLayout(stateRoot, opts = {}) {
  const settled = layoutByRoot.get(stateRoot)
  if (settled && !opts.daemon) return settled
  /** @type {'current' | 'legacy'} */
  let mode = 'current'
  if (!opts.daemon && previousReleaseDaemonIsLive(stateRoot)) {
    mode = 'legacy'
  } else {
    migrateStateLayout(stateRoot, { log: opts.log, markCurrent: opts.daemon === true })
  }
  layoutByRoot.set(stateRoot, mode)
  return mode
}

/**
 * Move every file the table names from its legacy path to its current one.
 * Same filesystem, one `rename` per file, so each move is atomic and a crash
 * halfway resumes on the next call. A file already at its current path is
 * left alone, as is a legacy file whose current path is taken. Config
 * backups beside `hypaware-config.json` move under `state/config-backups`
 * and are pruned to the newest {@link CONFIG_BACKUPS_KEEP}. The legacy
 * `config-control/` directory is removed once it is empty.
 *
 * `state/` itself is only created when something moves into it or
 * `markCurrent` asks for it (the daemon does, so a CLI started beside a
 * fresh daemon can tell it from one of the previous release). A preview boot
 * on a fresh tree therefore still leaves the tree as it found it.
 *
 * @param {string} stateRoot
 * @param {{ log?: { info(event: string, fields?: Record<string, unknown>): void, warn(event: string, fields?: Record<string, unknown>): void }, markCurrent?: boolean }} [opts]
 * @returns {Array<{ from: string, to: string }>} the moves performed
 */
export function migrateStateLayout(stateRoot, opts = {}) {
  /** @type {Array<{ from: string, to: string }>} */
  const moved = []
  if (!lexists(stateRoot)) return moved
  const log = opts.log ?? getLogger('kernel')
  const stateDir = path.join(stateRoot, COLD_STATE_DIRNAME)
  const mkdir = (/** @type {string} */ dir) => fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (opts.markCurrent) mkdir(stateDir)

  for (const entry of Object.values(MOVED)) {
    const from = path.join(stateRoot, entry.legacy)
    const to = path.join(stateRoot, entry.current)
    if (!lexists(from) || lexists(to)) continue
    try {
      mkdir(path.dirname(to))
      if (entry.kind === 'symlink') {
        // The pointer is a relative symlink naming a slot by basename; the
        // slot was renamed too, so the link is recreated against the new name
        // rather than carried over dangling.
        fsSync.symlinkSync(currentBasenameOf(fsSync.readlinkSync(from)), to)
        fsSync.unlinkSync(from)
      } else {
        fsSync.renameSync(from, to)
      }
      moved.push({ from, to })
    } catch (err) {
      log.warn('state_layout.move_failed', { from, to, message: err instanceof Error ? err.message : String(err) })
    }
  }

  // Backups are a family of files rather than one path: every
  // `hypaware-config.json.bak-<ts>` beside the local config moves in, then
  // the family is capped like a fresh write would cap it.
  const hypHome = path.dirname(stateRoot)
  const backupsDir = configBackupsDir(stateRoot)
  /** @type {string[]} */
  let names = []
  try {
    names = fsSync.readdirSync(hypHome).filter((name) => name.startsWith(`${LOCAL_CONFIG_BASENAME}.bak-`))
  } catch { /* an unreadable home has nothing to move */ }
  for (const name of names) {
    const from = path.join(hypHome, name)
    const to = path.join(backupsDir, name)
    if (lexists(to)) continue
    try {
      mkdir(backupsDir)
      fsSync.renameSync(from, to)
      moved.push({ from, to })
    } catch (err) {
      log.warn('state_layout.move_failed', { from, to, message: err instanceof Error ? err.message : String(err) })
    }
  }
  if (names.length > 0) pruneConfigBackups(backupsDir, LOCAL_CONFIG_BASENAME)

  try {
    fsSync.rmdirSync(path.join(stateRoot, LEGACY_CONTROL_DIRNAME))
  } catch { /* absent, or still holding something that is not ours to move */ }

  for (const move of moved) log.info('state_layout.moved', { component: 'state-layout', ...move })
  return moved
}

/**
 * The basename a legacy symlink target takes after the move, or the target
 * unchanged when it is not one the table knows.
 * @param {string} target
 */
function currentBasenameOf(target) {
  for (const entry of Object.values(MOVED)) {
    if (path.basename(entry.legacy) === target) return path.basename(entry.current)
  }
  return target
}

/**
 * Keep the newest {@link CONFIG_BACKUPS_KEEP} backups of `basename` in
 * `dir` and remove the rest. The stamp is an ISO time with its separators
 * flattened, so name order is time order.
 * @param {string} dir
 * @param {string} basename
 */
export function pruneConfigBackups(dir, basename) {
  const prefix = `${basename}.bak-`
  /** @type {string[]} */
  let names
  try {
    names = fsSync.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort()
  } catch {
    return
  }
  for (const name of names.slice(0, Math.max(0, names.length - CONFIG_BACKUPS_KEEP))) {
    try {
      fsSync.unlinkSync(path.join(dir, name))
    } catch { /* a backup that cannot be removed is not worth failing the write for */ }
  }
}

/**
 * The cold-state directory, `<stateRoot>/state`.
 * @param {string} stateRoot
 * @returns {string}
 */
export function coldStateDir(stateRoot) {
  return path.join(stateRoot, COLD_STATE_DIRNAME)
}

/**
 * Where `prepareLocalConfigWrite` keeps the timestamped copies it takes
 * before replacing the local config.
 * @param {string} stateRoot
 * @returns {string}
 */
export function configBackupsDir(stateRoot) {
  return path.join(coldStateDir(stateRoot), 'config-backups')
}

/**
 * The backup path for one rewrite of the config at `targetPath`. The state
 * root is the one beside the config, so the default config backs up under
 * `<HYP_HOME>/hypaware/state/config-backups` and a config given by path
 * backs up under the same relative tree beside it. While a daemon from the
 * previous release is live the copy lands beside the config, as it used to.
 * @param {string} targetPath
 * @param {string} stamp
 * @returns {string}
 */
export function configBackupPath(targetPath, stamp) {
  const name = `${path.basename(targetPath)}.bak-${stamp}`
  const stateRoot = stateRootOf(path.dirname(targetPath))
  if (layoutOf(stateRoot) === 'legacy') return path.join(path.dirname(targetPath), name)
  return path.join(configBackupsDir(stateRoot), name)
}

/**
 * Remote credentials (tokens for every enrolled server), mode 0600. Alone at
 * the state root on purpose: the one path a backup or a bundle must skip.
 * @param {string} stateRoot
 * @returns {string}
 */
export function credentialsPath(stateRoot) {
  return movedPath(stateRoot, 'credentials')
}

/**
 * The ledger of client assets HypAware itself wrote.
 * @param {string} stateRoot
 * @returns {string}
 */
export function clientAssetLedgerPath(stateRoot) {
  return movedPath(stateRoot, 'clientAssets')
}

/**
 * The directory holding the managed (central) config files: the applied
 * slots, their etags, the active-slot pointer, the join seed and the apply
 * state. They share `state/` with the other cold files under one
 * `managed-config.` prefix; this is the directory to create before the first
 * write and to list for leftovers.
 * @ref LLP 0031#physical-layout [implements]: the central layer's files live together, off the user-facing config path
 * @param {string} stateRoot
 * @returns {string}
 */
export function configControlDir(stateRoot) {
  return path.dirname(movedPath(stateRoot, 'configControlState'))
}

/**
 * The apply engine's own state record.
 * @param {string} stateRoot
 * @returns {string}
 */
export function configControlStatePath(stateRoot) {
  return movedPath(stateRoot, 'configControlState')
}

/**
 * The active-slot pointer: a relative symlink at this path naming the live
 * slot by basename. Kept beside the slots so the user's local config is a
 * plain file and the atomic symlink flip stays crash-safe.
 * @ref LLP 0031#physical-layout [constrained-by]: the pointer sits beside the slots, never at the user-facing config path
 * @param {string} stateRoot
 * @returns {string}
 */
export function configControlActivePath(stateRoot) {
  return movedPath(stateRoot, 'configControlActive')
}

/**
 * The join seed: the initial central layer `hyp join` writes (mode 0600, it
 * holds the policy token), retired by the first successful apply.
 * @ref LLP 0031#physical-layout [implements]: dedicated central-seed file, not hypaware-config.json
 * @param {string} stateRoot
 * @returns {string}
 */
export function configControlSeedPath(stateRoot) {
  return movedPath(stateRoot, 'configControlSeed')
}

/**
 * An applied central config slot.
 * @param {string} stateRoot
 * @param {'a' | 'b'} slot
 * @returns {string}
 */
export function configSlotPath(stateRoot, slot) {
  return movedPath(stateRoot, slot === 'a' ? 'configSlotA' : 'configSlotB')
}

/**
 * The etag recorded beside an applied slot.
 * @param {string} stateRoot
 * @param {'a' | 'b'} slot
 * @returns {string}
 */
export function configSlotEtagPath(stateRoot, slot) {
  return movedPath(stateRoot, slot === 'a' ? 'configSlotEtagA' : 'configSlotEtagB')
}

/**
 * The client-action marker: which central requests this host has completed.
 * @ref LLP 0041#idempotency-and-completion-state [implements]: one marker file per host, now `state/client-actions.json`
 * @param {string} stateRoot
 * @returns {string}
 */
export function clientActionsPath(stateRoot) {
  return movedPath(stateRoot, 'clientActions')
}

/**
 * Per-request lifecycle locks for client actions, one file per
 * `(kind, requestKey)` while it is held. Released locks are deleted, so the
 * directory holds only the keys someone is working on right now. It sits
 * beside the marker it guards, written at the same cadence, so a client
 * action never depends on the daemon's `run/` directory being writable.
 * @ref LLP 0523#two-locks [implements]: a per-key lock around the effect, a brief store lock around the marker write
 * @param {string} stateRoot
 * @returns {string}
 */
export function clientActionLocksDir(stateRoot) {
  return movedPath(stateRoot, 'clientActionLocks')
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
  return movedPath(stateRoot, 'syncCheckProofs')
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
 * Written once a day and read by `hyp status`: cold, so it lives with the
 * cold state and not in `run/`.
 * @param {string} stateRoot
 * @returns {string}
 */
export function selfUpdateStatePath(stateRoot) {
  return movedPath(stateRoot, 'selfUpdate')
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
