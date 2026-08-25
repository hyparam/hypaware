// @ts-check

// The kernel self-updater. This module is deliberately import-light:
// it must stay loadable even when the rest of a release is broken,
// because the pre-boot lane in `bin/hypaware.js` is what lets a
// crash-looping version jump forward to a fixed release.
// @ref LLP 0308#unstick-from-the-front [implements]: the check runs before the kernel boots, in a module that imports no kernel code

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
const NPM_TIMEOUT_MS = 120_000
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
 * @param {string} stateRoot
 * @returns {SelfUpdateState}
 */
export function readSelfUpdateState(stateRoot) {
  const raw = readFileIfExistsSync(selfUpdateStatePath(stateRoot))
  if (!raw) return {}
  try {
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
 * The npm registry to probe: the standard `npm_config_registry` env
 * override when set, the public registry otherwise. Reading `.npmrc`
 * is deliberately out of scope for this import-light module.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveRegistryUrl(env) {
  const raw = env.npm_config_registry
  if (typeof raw === 'string' && /^https?:\/\//.test(raw)) {
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
 * @ref LLP 0308#global-install-only [implements]: provenance guard on the running package root
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
 * Did the previous daemon boot fail before reaching healthy? The
 * status file's terminal states are `healthy` / `degraded` / `stopped`;
 * a file frozen at `starting` means the last boot died mid-way.
 *
 * @param {string} stateRoot
 * @returns {boolean}
 */
export function previousBootLooksStuck(stateRoot) {
  const raw = readFileIfExistsSync(path.join(daemonRunDir(stateRoot), 'status.json'))
  if (!raw) return false
  try {
    const parsed = JSON.parse(raw)
    return parsed?.state === 'starting'
  } catch {
    return false
  }
}

/**
 * Verify the running package root IS the npm global install, then run
 * `npm install -g <name>@<version>`. Returns rather than throws: every
 * caller treats failure as "record and degrade to a status notice".
 *
 * @ref LLP 0308#mechanism [implements]: npm install -g through the same lane setup uses; failure degrades, never loops
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
  const env = opts.env ?? process.env
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
  return { applied: true }
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
 *   autoUpdate?: boolean,
 *   force?: boolean,
 *   apply?: boolean,
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
    const auto = opts.autoUpdate ?? state.auto_update ?? true
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
    if (opts.apply === false) return { action: 'checked', reason: 'update_available', latest }
    if (provenance !== 'global-candidate') {
      return { action: 'checked', reason: provenance, latest }
    }

    const applied = await applySelfUpdate({
      name: identity.name,
      version: latest,
      packageRoot: opts.packageRoot,
      env,
      runner: opts.runner,
    })
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
 * @ref LLP 0308#cli-surface [implements]: an install that cannot self-update says so in status, never only in logs
 * @param {{ stateRoot: string, env: NodeJS.ProcessEnv }} opts
 * @returns {{ line: string | null, json: Record<string, unknown> }}
 */
export function describeSelfUpdate(opts) {
  const provenance = classifySelfProvenance({ env: opts.env })
  const state = readSelfUpdateState(opts.stateRoot)
  const identity = readSelfPackageIdentity()
  /** @type {Record<string, unknown>} */
  const json = {
    version: identity.version,
    auto_update: state.auto_update ?? true,
    provenance,
    ...(state.checked_at ? { checked_at: state.checked_at } : {}),
    ...(state.latest_version ? { latest_version: state.latest_version } : {}),
    ...(state.available !== undefined ? { available: state.available } : {}),
    ...(state.error ? { error: state.error } : {}),
  }
  // The text line derives only from the shared state file: the process
  // rendering status (an npx run, a checkout) is not necessarily the
  // install doing the updating, so its own provenance would mislead
  // here. JSON carries provenance for the curious.
  if (state.auto_update === false) {
    return { line: 'self-update: off (auto_update is false)', json }
  }
  if (state.error) {
    return {
      line: `self-update: degraded (${state.error}); run 'hyp update' or 'npm install -g ${identity.name}@latest'`,
      json,
    }
  }
  if (state.available && state.latest_version) {
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
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
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
