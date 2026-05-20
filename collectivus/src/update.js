import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { readPackageVersion } from './cli/common.js'

const REGISTRY_URL = 'https://registry.npmjs.org/collectivus/latest'
const DEFAULT_FETCH_TIMEOUT_MS = 1000
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Fetch the latest published version of `collectivus` from the npm registry.
 * Aborts after `timeoutMs`; returns undefined on any failure (network,
 * non-200, parse, abort) so callers can treat "no answer" and "no update"
 * the same way.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<string | undefined>}
 */
export async function fetchLatestVersion(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const fetchFn = options.fetchFn ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetchFn(REGISTRY_URL, { signal: controller.signal })
    if (!response.ok) return
    const data = await response.json()
    const version = data && typeof data === 'object' && /** @type {{ version?: unknown }} */ (data).version
    if (typeof version === 'string') return version
  } catch {
    // fall through to undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether the running script lives somewhere `npm install -g` can replace.
 *
 * Skipped when the bin path:
 *  - isn't under a `node_modules` directory (likely a source checkout — we
 *    don't want to clobber a developer's local code), or
 *  - is under an `_npx` cache (per-invocation unpack; updating it doesn't
 *    affect future runs and the supervisor would respawn from a path that
 *    no longer exists).
 *
 * @param {string} binPath
 * @returns {boolean}
 */
export function canSelfUpdate(binPath) {
  if (typeof binPath !== 'string' || binPath.length === 0) return false
  if (/[/\\]_npx[/\\]/.test(binPath)) return false
  return /[/\\]node_modules[/\\]/.test(binPath)
}

/**
 * Spawn `npm install -g collectivus@<version>` and resolve with whether it
 * exited 0. Runs the `npm` adjacent to the current `node` binary so the
 * call works under launchd / systemd, where PATH is typically empty.
 *
 * @param {string} version Target semver, e.g. `"1.3.0"`.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.npmPath] Override (test injection / non-default install layouts).
 * @param {(command: string, args: string[], opts: { signal: AbortSignal }) => Promise<number>} [options.run]
 * @returns {Promise<boolean>}
 */
export async function runNpmInstall(version, options = {}) {
  const run = options.run ?? defaultRun
  const npmPath = options.npmPath ?? path.join(path.dirname(process.execPath), 'npm')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const exit = await run(npmPath, ['install', '-g', `collectivus@${version}`], { signal: controller.signal })
    return exit === 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One self-update attempt: read the current version, ask the registry,
 * and if a newer version is published install it. Returns the newly
 * installed version on success, or undefined when nothing happened
 * (already current, registry unreachable, install failed, or the bin
 * path isn't safe to replace).
 *
 * Never throws — any unexpected failure (e.g. `readVersion` blowing up
 * on a corrupt package.json) is swallowed so the daily scheduler can
 * just try again on the next tick.
 *
 * @param {object} [options]
 * @param {string} [options.binPath]
 * @param {() => string} [options.readVersion]
 * @param {() => Promise<string | undefined>} [options.fetchLatest]
 * @param {(version: string) => Promise<boolean>} [options.install]
 * @param {{ write: (s: string) => void }} [options.log]
 * @returns {Promise<string | undefined>}
 */
export async function selfUpdate(options = {}) {
  const binPath = options.binPath ?? process.argv[1] ?? ''
  const readVersion = options.readVersion ?? readPackageVersion
  const fetchLatest = options.fetchLatest ?? fetchLatestVersion
  const install = options.install ?? ((/** @type {string} */ v) => runNpmInstall(v))
  const log = options.log ?? process.stdout

  try {
    if (!canSelfUpdate(binPath)) return

    const currentVersion = readVersion()
    const latest = await fetchLatest()
    if (!latest || latest === currentVersion) return

    log.write(`[collectivus] update available: ${currentVersion} -> ${latest}; running npm install -g collectivus@${latest}\n`)
    const installed = await install(latest)
    if (!installed) {
      log.write(`[collectivus] self-update to ${latest} failed; staying on ${currentVersion}\n`)
      return
    }
    log.write(`[collectivus] installed ${latest}\n`)
    return latest
  } catch {
    // fall through to undefined
  }
}

/**
 * Whether the current process appears to be running under a supervisor
 * that will respawn it after a clean exit. Used to gate the post-install
 * SIGTERM: without a supervisor, killing ourselves would just take the
 * collector offline. Detection is best-effort env-based:
 *  - launchd sets `XPC_SERVICE_NAME` for any launched job
 *  - systemd sets `INVOCATION_ID` for any started unit
 *  - explicit override via `COLLECTIVUS_SUPERVISED=1`
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isSupervised(env = process.env) {
  if (env.COLLECTIVUS_SUPERVISED === '1') return true
  if (typeof env.XPC_SERVICE_NAME === 'string' && env.XPC_SERVICE_NAME.length > 0) return true
  if (typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.length > 0) return true
  return false
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ signal: AbortSignal }} opts
 * @returns {Promise<number>}
 */
function defaultRun(command, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', signal: opts.signal })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code === null ? -1 : code))
  })
}
