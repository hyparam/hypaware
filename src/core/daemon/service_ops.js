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
 * Error raised when a bounded service command passed its deadline and was
 * killed. A distinct name so a caller can tell "the probe did not answer"
 * apart from "the probe answered no": only the second is a fact about the
 * machine.
 */
export class ServiceCommandTimeoutError extends ServiceOpError {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'ServiceCommandTimeoutError'
  }
}

/**
 * How long a read-only status probe waits for a service command before it
 * gives up. Long enough for a cold `security verify-cert` (keychain open,
 * trust evaluation) on a healthy machine, short enough that the offline or
 * captive-portal host it exists for still gets a report.
 */
export const SERVICE_PROBE_TIMEOUT_MS = 5000

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
 * Error raised when a service-manager command outlived the timeout its
 * caller set. A rejection rather than a non-zero result on purpose: a
 * command that was killed never answered, and a probe that maps exit codes
 * to a boolean would otherwise read "killed" as "no" - a false negative
 * dressed as a measurement. Callers that already treat "the probe could not
 * run" as unknown get that answer for free.
 */
export class ServiceCommandTimeoutError extends ServiceOpError {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'ServiceCommandTimeoutError'
  }
}

/**
 * Env var that opts a test back into driving the host's own service
 * manager. Deliberately awkward to type: there is no legitimate use for
 * it in the traditional suite.
 */
const ALLOW_REAL_SERVICE_MANAGER_ENV = 'HYP_ALLOW_REAL_SERVICE_MANAGER'

/**
 * Whether this process is running tests.
 *
 * `NODE_TEST_CONTEXT` alone answers only one of three shapes: `node --test`
 * sets it in the children it forks, and only there. `node some.test.js`
 * (iterating on a single file) and
 * `node --test --experimental-test-isolation=none some.test.js` (reachable
 * from the repo's own entrypoint, which forwards extra args verbatim) both
 * leave it unset, and both used to spawn for real. The other two arms name
 * what those runs do carry: the flag stays in `execArgv`, and the test file
 * is on the command line.
 *
 * Over-answering here costs a refusal a caller can lift with
 * `HYP_ALLOW_REAL_SERVICE_MANAGER=1`; under-answering costs the host's
 * daemon. No command that reaches a service op (`hyp daemon ...`,
 * `hyp attach`, `hyp init`, `hyp join`) takes a file path, so no real
 * invocation puts a `.test.js` on the command line.
 *
 * @returns {boolean}
 * @ref LLP 0181#the-guard [implements]: the two extra arms are not defensive padding, both shapes were measured kicking the host's daemon after #602's first fix
 */
function underTestRunner() {
  if (process.env.NODE_TEST_CONTEXT !== undefined) return true
  if (process.execArgv.includes('--test')) return true
  return process.argv.slice(1).some((arg) => arg.endsWith('.test.js'))
}

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
  if (!underTestRunner()) return undefined
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
 * `timeoutMs` bounds how long the child may take. Opt-in, because the
 * commands that reach here are not alike: a mutation the user is answering
 * a password dialog for may legitimately take minutes, while a read-only
 * probe run from `hyp status` that has not answered in seconds is not going
 * to. Whoever knows which one it is sets the bound. On expiry the child is
 * killed and the promise rejects with {@link ServiceCommandTimeoutError};
 * `SIGKILL` rather than `SIGTERM` because the case worth bounding is a
 * process blocked on a GUI keychain prompt, which is exactly the state that
 * ignores a polite signal. Only a bounded caller is ever killed, so that
 * signal can never interrupt a half-applied mutation.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<ServiceCommandResult>}
 */
export function runServiceCommand(bin, args, opts = {}) {
  const refusal = serviceManagerSpawnRefusal(bin, args)
  // Reject rather than throw: callers such as `installLaunchAgent`'s
  // best-effort bootout attach a `.catch()` to the returned promise, which a
  // synchronous throw would sail straight past.
  if (refusal) return Promise.reject(refusal)
  const { timeoutMs } = opts
  return new Promise(function(resolve, reject) {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    if (timeoutMs !== undefined) {
      timer = setTimeout(function() {
        timedOut = true
        // Settle on the deadline itself, not on the kill's own `close`. A
        // child that leaves a grandchild holding the inherited pipe never
        // emits one, and waiting for it would reinstate the unbounded wait
        // this timer exists to remove. Detaching the three handles is what
        // lets the calling process exit while such a child winds down.
        proc.kill('SIGKILL')
        proc.stdout.destroy()
        proc.stderr.destroy()
        proc.unref()
        reject(new ServiceCommandTimeoutError(
          `'${[bin, ...args].join(' ')}' did not finish within ${timeoutMs}ms and was killed`
        ))
      }, timeoutMs)
      // Nothing should be kept alive waiting for this: the timer exists to
      // end a wait, never to extend the process past one.
      timer.unref()
    }
    proc.stdout.on('data', function(chunk) { stdout += chunk.toString('utf8') })
    proc.stderr.on('data', function(chunk) { stderr += chunk.toString('utf8') })
    proc.on('error', function(err) {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    proc.on('close', function(code) {
      if (timer) clearTimeout(timer)
      // The close that follows our own SIGKILL is not an answer, and the
      // promise has already rejected with the one that is.
      if (timedOut) return
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
