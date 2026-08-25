// @ts-check

// The kernel self-updater. This module is deliberately import-light:
// it must stay loadable even when the rest of a release is broken,
// because the pre-boot lane in `bin/hypaware.js` is what lets a
// crash-looping version jump forward to a fixed release.
// @ref LLP 0309#unstick-from-the-front [implements]: the check runs before the kernel boots, in a module that imports no kernel code

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { daemonRunDir } from '../daemon/pid.js'
import { atomicWriteJsonSync, readFileIfExistsSync } from '../util/fs_atomic.js'

/**
 * @import { CommandRunner } from '../../../src/core/cli/types.js'
 * @import { SelfInstallProvenance, SelfUpdatePassResult, SelfUpdateState } from '../../../src/core/update/types.js'
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const PROBE_TIMEOUT_MS = 5000
export const NPM_TIMEOUT_MS = 120_000
// How long a timed-out npm gets to honor SIGTERM before SIGKILL.
export const NPM_KILL_GRACE_MS = 5000
// An apply lock this old belonged to a process that died mid-install;
// honoring it forever would wedge updates permanently. The floor is the
// longest a live holder can legitimately hold it: `applySelfUpdate` runs
// two npm commands, each bounded by the timeout plus the kill grace. Two
// of those again is the margin - reclaiming a lock its owner still holds
// starts the second concurrent `npm install -g` this lock exists to
// prevent, so erring long costs a slower recovery and erring short costs
// the machine.
export const APPLY_LOCK_STALE_MS = 4 * (NPM_TIMEOUT_MS + NPM_KILL_GRACE_MS)
const DAILY_CHECK_MS = 24 * 60 * 60 * 1000
// One hour when the previous boot never reached healthy: a machine
// stuck on a broken release re-probes eagerly so it jumps to the fix
// soon after one is published.
const EAGER_CHECK_MS = 60 * 60 * 1000

/**
 * Must equal `DAEMON_RESTART_EXIT_CODE` in `src/core/daemon/runtime.js`.
 * Duplicated rather than imported so the pre-boot lane never loads the
 * daemon runtime; a test asserts the two stay in sync.
 */
export const SELF_UPDATE_RESTART_EXIT_CODE = 75

/**
 * Must equal `CONFIG_BASENAME` in `src/core/config/schema.js`.
 * Duplicated rather than imported for the same reason as the exit code
 * above; a test asserts the two stay in sync.
 */
const CONFIG_BASENAME = 'hypaware-config.json'

/**
 * Which config file holds the off switch, by the same precedence
 * `resolveConfigPath` (`src/core/runtime/boot.js`) applies when the
 * kernel boots: an explicit `--config` first, then `HYP_CONFIG`, then
 * `<HYP_HOME>/hypaware-config.json` (the state root's parent). The
 * explicit rung is not optional: the installed service unit always
 * renders `--config <path>` on both platforms, so without it an
 * `auto_update: false` written in a non-default config would not bind
 * in the pre-boot lane at all.
 *
 * @param {{ stateRoot: string, env: NodeJS.ProcessEnv, configPath?: string }} opts
 * @returns {string}
 */
function resolveLocalConfigPath(opts) {
  if (opts.configPath) return path.resolve(opts.configPath)
  if (opts.env.HYP_CONFIG) return path.resolve(opts.env.HYP_CONFIG)
  return path.join(path.dirname(opts.stateRoot), CONFIG_BASENAME)
}

/**
 * The `auto_update` flag straight off the local config file, for a
 * machine where no daemon boot has cached the effective flag yet. A bare
 * JSON read, not the config loader: importing the schema machinery here
 * would let a release broken in config parsing take the unstick lane
 * down with it. Central-layer merging is out of scope by the same
 * argument; the daemon-cached effective flag wins whenever it exists.
 *
 * Every failure reads as "no answer here", the read included: a config
 * that is a directory, or one the daemon's user cannot open, raises
 * something other than ENOENT, and a throw escaping this far would
 * disable the entire pass on a machine this lane exists to repair.
 *
 * @ref LLP 0309#config-key [implements]: the off switch binds before the first successful boot
 * @param {{ stateRoot: string, env: NodeJS.ProcessEnv, configPath?: string }} opts
 * @returns {boolean | undefined}
 */
export function readLocalConfigAutoUpdate(opts) {
  try {
    const raw = readFileIfExistsSync(resolveLocalConfigPath(opts))
    if (!raw) return undefined
    const parsed = JSON.parse(raw)
    const flag = parsed && typeof parsed === 'object' ? parsed.auto_update : undefined
    return typeof flag === 'boolean' ? flag : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function selfUpdateStateRoot(env) {
  const hypHome = env.HYP_HOME || path.join(os.homedir(), '.hyp')
  return path.join(hypHome, 'hypaware')
}

/**
 * @param {string} stateRoot
 * @returns {string}
 */
export function selfUpdateStatePath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'self-update.json')
}

/**
 * Total by construction: an empty state is the answer for a file that is
 * absent, corrupt, or unreadable alike. `describeSelfUpdate` runs inside
 * `hyp status` with no guard of its own, and a state file left behind
 * root-owned by a sudo install would otherwise take the whole report down.
 *
 * @param {string} stateRoot
 * @returns {SelfUpdateState}
 */
export function readSelfUpdateState(stateRoot) {
  try {
    const raw = readFileIfExistsSync(selfUpdateStatePath(stateRoot))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merge a patch into the persisted state. Read-modify-write keeps the
 * cached `auto_update` flag intact across probe updates and vice versa.
 *
 * @param {string} stateRoot
 * @param {Partial<SelfUpdateState>} patch
 * @returns {SelfUpdateState}
 */
export function writeSelfUpdateState(stateRoot, patch) {
  const next = { ...readSelfUpdateState(stateRoot), ...patch }
  fs.mkdirSync(daemonRunDir(stateRoot), { recursive: true })
  atomicWriteJsonSync(selfUpdateStatePath(stateRoot), next)
  return next
}

/**
 * Numeric semver comparison. Returns >0 when `a` is newer than `b`,
 * 0 when equal, <0 when older. A prerelease sorts below its release
 * (`1.2.0-rc.1 < 1.2.0`); unparseable input compares as not-newer.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  }
  if (pa.prerelease && !pb.prerelease) return -1
  if (!pa.prerelease && pb.prerelease) return 1
  return 0
}

/**
 * @param {string} value
 * @returns {{ nums: number[], prerelease: string } | null}
 */
function parseSemver(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim())
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ?? '',
  }
}

/**
 * Is this registry override safe to believe? https always is. Plain
 * http is trusted only on this machine, where a local Verdaccio is a
 * normal dev and test setup and nothing sits on the wire. Off-box http
 * is not: the probe's answer decides whether this install ever updates
 * again, so a spoofable "you are already current" is a mute button for
 * anyone on the path.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function registryUrlIsTrusted(raw) {
  /** @type {URL} */
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  // `hostname` keeps the brackets on an IPv6 literal.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') ||
    host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * The npm registry to probe: the standard `npm_config_registry` env
 * override when set and trusted, the public registry otherwise.
 * Reading `.npmrc` is deliberately out of scope for this import-light
 * module, so a private registry configured only there already probes
 * the default; an untrusted override degrading to that same default is
 * a path the module already walks, not a new failure mode.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveRegistryUrl(env) {
  const raw = env.npm_config_registry
  if (typeof raw === 'string' && registryUrlIsTrusted(raw)) {
    return raw.replace(/\/+$/, '')
  }
  return DEFAULT_REGISTRY
}

/**
 * Where is the running code installed from? Only a global npm install
 * may self-update: `npm install -g` from an npx cache or a dev
 * checkout would create a second, skewed install beside the one
 * actually running.
 *
 * @ref LLP 0309#global-install-only [implements]: provenance guard on the running package root
 * @param {{ packageRoot?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {SelfInstallProvenance}
 */
export function classifySelfProvenance(opts = {}) {
  const root = path.resolve(opts.packageRoot ?? PACKAGE_ROOT)
  const env = opts.env ?? process.env
  const segments = root.split(path.sep)
  if (segments.includes('_npx')) return 'npx'
  const cache = env.npm_config_cache ? path.resolve(env.npm_config_cache) : undefined
  if (cache && root.startsWith(path.join(cache, '_npx') + path.sep)) return 'npx'
  if (fs.existsSync(path.join(root, '.git'))) return 'checkout'
  if (!segments.includes('node_modules')) return 'checkout'
  return 'global-candidate'
}

/**
 * @returns {{ name: string, version: string }}
 */
export function readSelfPackageIdentity(packageRoot = PACKAGE_ROOT) {
  const raw = fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  const parsed = JSON.parse(raw)
  return { name: String(parsed.name), version: String(parsed.version) }
}

/**
 * Probe the registry for the `latest` dist-tag. Throws on any failure;
 * callers record the error and move on (the check is best-effort).
 *
 * @param {{
 *   name: string,
 *   registryUrl: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<string>}
 */
export async function fetchLatestVersion(opts) {
  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const url = `${opts.registryUrl}/${encodeURIComponent(opts.name)}/latest`
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`registry responded ${res.status}`)
    const body = /** @type {{ version?: unknown } | null} */ (await res.json())
    const version = body && typeof body === 'object' ? body.version : undefined
    if (typeof version !== 'string' || !parseSemver(version)) {
      throw new Error('registry response had no parseable version')
    }
    return version
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Is the last probe stale enough to re-check? Daily normally, hourly
 * when the previous boot never reached healthy. The jitter fraction
 * stretches the daily interval by up to 25% so a fleet installed in
 * one MDM push does not probe in lockstep forever.
 *
 * @param {{
 *   state: SelfUpdateState,
 *   nowMs: number,
 *   eager: boolean,
 *   jitter?: number,
 * }} opts
 * @returns {boolean}
 */
export function shouldCheckNow({ state, nowMs, eager, jitter }) {
  if (!state.checked_at) return true
  const parsed = Date.parse(state.checked_at)
  if (Number.isNaN(parsed)) return true
  const base = eager ? EAGER_CHECK_MS : DAILY_CHECK_MS
  const fraction = typeof jitter === 'number' ? jitter : Math.random()
  const ttl = eager ? base : base + Math.floor(base * 0.25 * Math.min(1, Math.max(0, fraction)))
  return nowMs - parsed >= ttl
}

/**
 * Did the previous daemon boot fail before reaching healthy? Two shapes
 * count, because a broken release produces both: a status file frozen at
 * `starting` (the process died mid-boot and never rewrote it), and one at
 * `degraded` carrying a `boot_failed:` warning (the runtime caught the
 * boot throw and recorded it before exiting). A `degraded` file without
 * that warning is a healthy kernel with a failed source, which no amount
 * of updating fixes and which must not buy an hourly probe.
 *
 * @param {string} stateRoot
 * @returns {boolean}
 */
export function previousBootLooksStuck(stateRoot) {
  try {
    const raw = readFileIfExistsSync(path.join(daemonRunDir(stateRoot), 'status.json'))
    if (!raw) return false
    const parsed = JSON.parse(raw)
    if (parsed?.state === 'starting') return true
    if (parsed?.state !== 'degraded') return false
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : []
    return warnings.some((w) => String(w).startsWith('boot_failed'))
  } catch {
    return false
  }
}

/**
 * The environment npm runs in, with the directory of the running node
 * binary prepended to PATH.
 *
 * The daemon does not inherit a login shell's PATH: the LaunchAgent and
 * the systemd unit both run it through an absolute `process.execPath`
 * and render no environment block at all, so PATH is whatever the
 * service manager supplies - on launchd, `/usr/bin:/bin:/usr/sbin:/sbin`.
 * Homebrew (`/opt/homebrew/bin`), the nodejs.org installer
 * (`/usr/local/bin`) and nvm are all outside that, so a bare
 * `spawn('npm')` fails ENOENT and the automatic lane records
 * `npm_prefix_failed` forever while a hand-typed `hyp update` (with the
 * user's PATH) works. Prepending is the fix rather than resolving npm to
 * an absolute path, because npm's own shim starts `#!/usr/bin/env node`
 * and so needs the same directory reachable anyway.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function withNodeBinOnPath(env) {
  const nodeBin = path.dirname(process.execPath)
  if (!nodeBin || nodeBin === '.') return env
  const parts = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  if (parts[0] === nodeBin) return env
  return { ...env, PATH: [nodeBin, ...parts.filter((p) => p !== nodeBin)].join(path.delimiter) }
}

/**
 * Verify the running package root IS the npm global install, then run
 * `npm install -g <name>@<version>`. Returns rather than throws: every
 * caller treats failure as "record and degrade to a status notice".
 *
 * @ref LLP 0309#mechanism [implements]: npm install -g through the same lane setup uses; failure degrades, never loops
 * @param {{
 *   name: string,
 *   version: string,
 *   packageRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   runner?: CommandRunner,
 *   platform?: NodeJS.Platform,
 * }} opts
 * @returns {Promise<{ applied: boolean, reason?: string }>}
 */
export async function applySelfUpdate(opts) {
  const env = withNodeBinOnPath(opts.env ?? process.env)
  const run = opts.runner ?? runCommand
  const packageRoot = path.resolve(opts.packageRoot ?? PACKAGE_ROOT)
  const platform = opts.platform ?? process.platform

  const prefixResult = await run('npm', ['config', 'get', 'prefix'], { env })
  if (prefixResult.exitCode !== 0) {
    return { applied: false, reason: 'npm_prefix_failed' }
  }
  const prefix = prefixResult.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  if (!prefix) return { applied: false, reason: 'npm_prefix_failed' }
  const globalRoot = platform === 'win32'
    ? path.join(prefix, 'node_modules', opts.name)
    : path.join(prefix, 'lib', 'node_modules', opts.name)
  if (realpathOrSelf(globalRoot) !== realpathOrSelf(packageRoot)) {
    return { applied: false, reason: 'not_global_install' }
  }

  const install = await run('npm', ['install', '-g', `${opts.name}@${opts.version}`], { env })
  if (install.exitCode !== 0) {
    return { applied: false, reason: 'npm_install_failed' }
  }
  // Believe the filesystem, not the exit code. Reporting `applied` is what
  // makes the daemon exit for a restart, so an npm that returned 0 without
  // replacing the global root would become a restart loop on the same
  // version instead of a recorded failure.
  if (readVersionAt(globalRoot) !== opts.version) {
    return { applied: false, reason: 'version_not_installed' }
  }
  return { applied: true }
}

/**
 * @param {string} root
 * @returns {string | null}
 */
function readVersionAt(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Best-effort cross-process mutex around `npm install -g`. The daemon's
 * periodic lane and a hand-typed `hyp update` can reach the install at the
 * same moment, and two npm global installs racing over one package
 * directory is the single failure that can leave a machine with no
 * runnable kernel at all. Returns a release function, or null when another
 * process holds the lock. Anything that is not lock contention (an
 * unwritable run directory, a read-only filesystem) throws instead of
 * returning null: it still fails closed, but reporting it as "another
 * update is already running" sends the operator looking for a process
 * that does not exist.
 *
 * @param {string} stateRoot
 * @returns {(() => void) | null}
 */
export function acquireApplyLock(stateRoot) {
  const runDir = daemonRunDir(stateRoot)
  const lockPath = path.join(runDir, 'self-update.lock')
  fs.mkdirSync(runDir, { recursive: true })
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }))
      } finally {
        fs.closeSync(fd)
      }
      return () => {
        // Only ever remove our own lock. A stale-reclaim by another
        // process replaces the file, and unlinking unconditionally would
        // hand a third process the lock while the second still holds it.
        try {
          const held = JSON.parse(readFileIfExistsSync(lockPath) ?? 'null')
          if (held?.token !== token) return
        } catch { return }
        try { fs.unlinkSync(lockPath) } catch { /* already gone */ }
      }
    } catch (err) {
      // Only EEXIST means somebody else holds it. EACCES, EROFS and the
      // rest are this machine's problem and belong in front of a human.
      if (errnoCode(err) !== 'EEXIST') throw err
      if (attempt > 0) return null
      /** @type {number | null} */
      let ageMs = null
      try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs } catch { ageMs = null }
      if (ageMs !== null && ageMs < APPLY_LOCK_STALE_MS) return null
      try { fs.unlinkSync(lockPath) } catch { /* raced; the retry decides */ }
    }
  }
  return null
}

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errnoCode(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * @param {string} p
 * @returns {string}
 */
function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * One self-update pass: decide, probe, record, and (when eligible and
 * enabled) apply. Shared by the pre-boot lane, the daemon's periodic
 * lane, and `hyp update` (which sets `force` to bypass the TTL).
 *
 * Never throws: every failure lands on the state file's `error` field
 * and in the returned reason.
 *
 * @param {{
 *   stateRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   configPath?: string,
 *   autoUpdate?: boolean,
 *   force?: boolean,
 *   packageRoot?: string,
 *   runner?: CommandRunner,
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date,
 *   jitter?: number,
 *   log?: (event: string, fields?: Record<string, unknown>) => void,
 * }} [opts]
 * @returns {Promise<SelfUpdatePassResult>}
 */
export async function runSelfUpdatePass(opts = {}) {
  const env = opts.env ?? process.env
  const stateRoot = opts.stateRoot ?? selfUpdateStateRoot(env)
  const log = opts.log ?? (() => {})
  const nowMs = (opts.now ?? (() => new Date()))().getTime()

  try {
    const state = readSelfUpdateState(stateRoot)
    // The cached effective flag (central-aware, written at boot) wins;
    // until a boot has cached it, fall back to the local config file so
    // an `auto_update: false` written before first start still binds.
    const auto = opts.autoUpdate ?? state.auto_update ??
      readLocalConfigAutoUpdate({ stateRoot, env, configPath: opts.configPath }) ?? true
    if (!auto && !opts.force) {
      return { action: 'skipped', reason: 'auto_update_off' }
    }

    const provenance = classifySelfProvenance({ packageRoot: opts.packageRoot, env })
    if (provenance !== 'global-candidate' && !opts.force) {
      // Dev checkouts and npx runs never probe: hermetic smokes boot
      // the daemon from the repo checkout and must not touch the
      // network. `hyp update` still probes (force) but cannot apply.
      log('self_update.skipped', { reason: provenance })
      return { action: 'skipped', reason: provenance }
    }

    if (!opts.force) {
      const eager = previousBootLooksStuck(stateRoot)
      if (!shouldCheckNow({ state, nowMs, eager, jitter: opts.jitter })) {
        return { action: 'none' }
      }
    }

    const identity = readSelfPackageIdentity(opts.packageRoot)
    /** @type {string} */
    let latest
    try {
      latest = await fetchLatestVersion({
        name: identity.name,
        registryUrl: resolveRegistryUrl(env),
        fetchImpl: opts.fetchImpl,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      writeSelfUpdateState(stateRoot, {
        checked_at: new Date(nowMs).toISOString(),
        error: `probe_failed: ${message}`,
      })
      log('self_update.probe_failed', { error_kind: 'probe_failed', detail: message })
      return { action: 'checked', reason: 'probe_failed' }
    }

    const available = compareSemver(latest, identity.version) > 0
    writeSelfUpdateState(stateRoot, {
      checked_at: new Date(nowMs).toISOString(),
      latest_version: latest,
      available,
      error: undefined,
    })
    log('self_update.checked', { latest_version: latest, available })
    if (!available) return { action: 'checked', latest }
    if (provenance !== 'global-candidate') {
      return { action: 'checked', reason: provenance, latest }
    }

    // Single-flight across processes, not just within one: the daemon's
    // lane and a hand-typed `hyp update` can arrive together. A lock this
    // cannot take for a reason other than contention throws, landing on
    // the outer catch with its errno in the log rather than reporting a
    // rival process that does not exist.
    const releaseLock = acquireApplyLock(stateRoot)
    if (!releaseLock) {
      log('self_update.apply_locked', { latest_version: latest })
      return { action: 'checked', reason: 'apply_locked', latest }
    }
    /** @type {{ applied: boolean, reason?: string }} */
    let applied
    try {
      applied = await applySelfUpdate({
        name: identity.name,
        version: latest,
        packageRoot: opts.packageRoot,
        env,
        runner: opts.runner,
      })
    } finally {
      releaseLock()
    }
    writeSelfUpdateState(stateRoot, {
      last_apply: {
        at: new Date(nowMs).toISOString(),
        from: identity.version,
        to: latest,
        ok: applied.applied,
        ...(applied.reason ? { error: applied.reason } : {}),
      },
      ...(applied.applied ? { available: false } : { error: `apply_failed: ${applied.reason}` }),
    })
    if (!applied.applied) {
      log('self_update.apply_failed', { error_kind: applied.reason, latest_version: latest })
      return { action: 'checked', reason: applied.reason, latest }
    }
    log('self_update.applied', { from: identity.version, to: latest })
    return { action: 'updated', latest }
  } catch (err) {
    // The updater must never take the daemon down with it.
    const message = err instanceof Error ? err.message : String(err)
    log('self_update.error', { error_kind: 'unexpected', detail: message })
    return { action: 'skipped', reason: 'unexpected_error' }
  }
}

/**
 * Summarize self-update health for `hyp status`: pure local reads, no
 * network. `line` is null when there is nothing worth a human's eye
 * (healthy automatic updates with nothing pending); `json` always
 * carries the full picture for `--json`.
 *
 * @ref LLP 0309#cli-surface [implements]: an install that cannot self-update says so in status, never only in logs
 * @param {{ stateRoot: string, env: NodeJS.ProcessEnv }} opts
 * @returns {{ line: string | null, json: Record<string, unknown> }}
 */
export function describeSelfUpdate(opts) {
  const provenance = classifySelfProvenance({ env: opts.env })
  const state = readSelfUpdateState(opts.stateRoot)
  // `hyp status` must survive its own updater. An in-flight
  // `npm install -g` briefly leaves this package root without a
  // package.json, and a throw here would take the whole status report
  // down at exactly the moment an operator is asking what is going on.
  /** @type {{ name: string, version: string }} */
  let identity
  try {
    identity = readSelfPackageIdentity()
  } catch {
    identity = { name: 'hypaware', version: 'unknown' }
  }
  // The same precedence the updater itself applies, so status cannot
  // report the switch as on while the pass is already honoring an off
  // written in config but not yet cached by a boot.
  const autoUpdate = state.auto_update ?? readLocalConfigAutoUpdate(opts) ?? true
  // Re-derive availability from the version actually running rather than
  // trusting the flag the last probe wrote: a manual `npm install -g`
  // (or `hyp update` from another shell) satisfies a pending update
  // without clearing it, and status would advertise '1.27.0 available
  // (running 1.27.0)' until the next probe up to a day later.
  const available = state.available === undefined
    ? undefined
    : Boolean(state.available && state.latest_version &&
      compareSemver(state.latest_version, identity.version) > 0)
  /** @type {Record<string, unknown>} */
  const json = {
    version: identity.version,
    auto_update: autoUpdate,
    provenance,
    ...(state.checked_at ? { checked_at: state.checked_at } : {}),
    ...(state.latest_version ? { latest_version: state.latest_version } : {}),
    ...(available !== undefined ? { available } : {}),
    ...(state.error ? { error: state.error } : {}),
  }
  // The text line derives only from the shared state file: the process
  // rendering status (an npx run, a checkout) is not necessarily the
  // install doing the updating, so its own provenance would mislead
  // here. JSON carries provenance for the curious.
  if (autoUpdate === false) {
    return { line: 'self-update: off (auto_update is false)', json }
  }
  // A probe failure is usually just a laptop off the network, and it
  // clears itself on the next successful check. Rendering it would put
  // a degraded line on every `hyp status` for the length of a flight.
  // It stays in `json` for anyone actually diagnosing the updater.
  if (state.error && !state.error.startsWith('probe_failed')) {
    return {
      line: `self-update: degraded (${state.error}); run 'hyp update' or 'npm install -g ${identity.name}@latest'`,
      json,
    }
  }
  if (available && state.latest_version) {
    return { line: `self-update: ${state.latest_version} available (running ${identity.version})`, json }
  }
  return { line: null, json }
}

/** @type {CommandRunner} */
function runCommand(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** @type {Buffer[]} */
    const stdoutChunks = []
    /** @type {Buffer[]} */
    const stderrChunks = []
    let settled = false
    // Two-stage kill: an npm that ignores SIGTERM would otherwise leave
    // this promise pending forever, and the daemon's `selfUpdateInFlight`
    // guard pinned with it - no further check for the life of the process.
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const hard = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(-1)
      }, NPM_KILL_GRACE_MS)
      hard.unref?.()
    }, NPM_TIMEOUT_MS)
    timer.unref?.()
    /** @param {number} exitCode */
    function finish(exitCode) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    }
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
  })
}
