// @ts-check

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

/**
 * What a service-manager command returned. Structurally identical to
 * the platform modules' `LaunchctlResult`/`SystemctlResult`.
 *
 * @typedef {{ exitCode: number, stdout: string, stderr: string }} ServiceCommandResult
 */

/**
 * Error raised when a service-manager operation (launchctl, systemctl)
 * fails. The platform modules subclass this so callers can still match
 * on the platform-specific name.
 */
export class ServiceOpError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, stderr?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ServiceOpError'
    /** @type {number | undefined} */
    this.exitCode = opts.exitCode
    /** @type {string | undefined} */
    this.stderr = opts.stderr
  }
}

/**
 * Error raised when the test-runner guard refuses to spawn a service
 * manager. A distinct name so a caller (or a test) can tell "we declined
 * to touch the host" apart from "the service manager said no".
 */
export class ServiceManagerSandboxError extends ServiceOpError {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'ServiceManagerSandboxError'
  }
}

/**
 * Env var that opts a test back into driving the host's own service
 * manager. Deliberately awkward to type: there is no legitimate use for
 * it in the traditional suite.
 */
const ALLOW_REAL_SERVICE_MANAGER_ENV = 'HYP_ALLOW_REAL_SERVICE_MANAGER'

/**
 * Refuse, under the test runner, to spawn a real service manager.
 *
 * launchd and systemd address a service by label inside a **per-uid**
 * namespace. A test that points `HOME` / `HYP_HOME` at a temp dir moves
 * only the plist/unit file it writes; `launchctl kickstart -k
 * gui/<uid>/com.hyperparam.hypaware` still names the developer's own
 * daemon. So a fixture that drops a marker under the real label and lets
 * the restart run reaches out of its sandbox and kicks the host's daemon,
 * severing every in-flight proxied stream.
 *
 * Returns the refusal to reject with, or `undefined` to proceed.
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {ServiceManagerSandboxError | undefined}
 * @ref LLP 0181#the-guard [implements]: the seam every service-manager spawn passes through is where the refusal lives, so no future fixture can route around it
 */
function serviceManagerSpawnRefusal(bin, args) {
  if (process.env.NODE_TEST_CONTEXT === undefined) return undefined
  if (process.env[ALLOW_REAL_SERVICE_MANAGER_ENV] === '1') return undefined
  return new ServiceManagerSandboxError(
    `refusing to run '${[bin, ...args].join(' ')}' from the test runner: a temp HOME does not ` +
    `sandbox launchd/systemd, whose service labels live in a per-uid namespace, so this would ` +
    `act on the host's own daemon. Inject a fake launchctl/systemctl adapter instead, or set ` +
    `${ALLOW_REAL_SERVICE_MANAGER_ENV}=1 if you really do mean this machine's service manager.`
  )
}

/**
 * Spawn a service-manager binary and collect its output. Never rejects
 * on a non-zero exit: callers decide what failure means (see
 * {@link ensureOk}). Rejects without spawning under the test runner (see
 * {@link serviceManagerSpawnRefusal}).
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {Promise<ServiceCommandResult>}
 */
export function runServiceCommand(bin, args) {
  const refusal = serviceManagerSpawnRefusal(bin, args)
  // Reject rather than throw: callers such as `installLaunchAgent`'s
  // best-effort bootout attach a `.catch()` to the returned promise, which a
  // synchronous throw would sail straight past.
  if (refusal) return Promise.reject(refusal)
  return new Promise(function(resolve, reject) {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', function(chunk) { stdout += chunk.toString('utf8') })
    proc.stderr.on('data', function(chunk) { stderr += chunk.toString('utf8') })
    proc.on('error', reject)
    proc.on('close', function(code) {
      resolve({ exitCode: code === null ? -1 : code, stdout, stderr })
    })
  })
}

/**
 * Throw `ErrorClass` when a service-manager command failed.
 *
 * @param {ServiceCommandResult} res
 * @param {string} what  human description of the command, e.g. `kickstart <label>`
 * @param {new (message: string, opts?: { exitCode?: number, stderr?: string }) => Error} ErrorClass
 * @returns {ServiceCommandResult}
 */
export function ensureOk(res, what, ErrorClass) {
  if (res.exitCode !== 0) {
    throw new ErrorClass(
      `failed to ${what}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      { exitCode: res.exitCode, stderr: res.stderr }
    )
  }
  return res
}

/**
 * Remove a service file, tolerating one already removed. Any error
 * other than ENOENT still throws.
 *
 * @param {string} filePath
 */
export function unlinkServiceFile(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? /** @type {NodeJS.ErrnoException} */ (err).code
      : undefined
    if (code !== 'ENOENT') throw err
  }
}
