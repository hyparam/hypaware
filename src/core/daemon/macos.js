// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  LAUNCH_LABEL,
  defaultLogDir,
  defaultPlistDir,
  plistFileName,
} from './platform.js'
import { ServiceOpError, defaultSleep, ensureFsOp, ensureOk, runServiceCommand, unlinkServiceFile } from './service_ops.js'
import { atomicWriteFileSync } from '../util/fs_atomic.js'

/**
 * @import {
 *   LaunchctlResult,
 *   LaunchctlAdapter,
 *   BuildPlistOptions,
 *   PlanLaunchAgentInstallOptions,
 *   LaunchAgentInstallPlan,
 * } from '../../../src/core/daemon/types.js'
 */

export class LaunchAgentError extends ServiceOpError {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, stderr?: string }} [opts]
   */
  constructor(message, opts) {
    super(message, opts)
    this.name = 'LaunchAgentError'
  }
}

/** @type {LaunchctlAdapter} */
export const realLaunchctl = {
  bootstrap(args) { return runServiceCommand('launchctl', ['bootstrap', ...args]) },
  bootout(args) { return runServiceCommand('launchctl', ['bootout', ...args]) },
  kickstart(args) { return runServiceCommand('launchctl', ['kickstart', ...args]) },
  print(args) { return runServiceCommand('launchctl', ['print', ...args]) },
}

/**
 * Throw a {@link LaunchAgentError} when a launchctl command failed.
 *
 * @param {LaunchctlResult} res
 * @param {string} what
 * @returns {LaunchctlResult}
 */
function ensure(res, what) {
  return ensureOk(res, what, LaunchAgentError)
}

/**
 * Throw a {@link LaunchAgentError} when a filesystem step of the install
 * failed.
 *
 * @template T
 * @param {() => T} fn
 * @param {string} what
 * @returns {T}
 */
function ensureFs(fn, what) {
  return ensureFsOp(fn, what, LaunchAgentError)
}

/**
 * Resolve the launchctl adapter, label, and `<domain>/<label>` target
 * shared by every LaunchAgent operation.
 *
 * @param {{ label?: string, launchctl?: LaunchctlAdapter, userDomain?: string }} options
 */
function resolveTarget(options) {
  const launchctl = options.launchctl ?? realLaunchctl
  const label = options.label ?? LAUNCH_LABEL
  const userDomain = options.userDomain ?? defaultUserDomain()
  return { launchctl, label, userDomain, target: `${userDomain}/${label}` }
}

/**
 * Build the XML body of a HypAware LaunchAgent plist.
 *
 * Output is deterministic for the same inputs so tests can compare
 * against fixed strings. Strings are XML-escaped; ProgramArguments is
 * rendered with each argv element on its own line for readability.
 *
 * @param {BuildPlistOptions} options
 * @returns {string} The plist XML, with a trailing newline.
 */
export function buildPlist(options) {
  const {
    label = LAUNCH_LABEL,
    nodePath,
    binPath,
    configPath,
    logDir,
    env,
  } = options
  const keepAlive = options.keepAlive !== false
  const runAtLoad = options.runAtLoad !== false
  const foreground = options.foreground !== false

  if (!label || typeof label !== 'string') throw new LaunchAgentError('label is required')
  if (!nodePath || typeof nodePath !== 'string') throw new LaunchAgentError('nodePath is required')
  if (!binPath || typeof binPath !== 'string') throw new LaunchAgentError('binPath is required')
  if (!configPath || typeof configPath !== 'string') throw new LaunchAgentError('configPath is required')
  if (!logDir || typeof logDir !== 'string') throw new LaunchAgentError('logDir is required')

  const stdoutPath = path.posix.join(logDir, 'daemon.out.log')
  const stderrPath = path.posix.join(logDir, 'daemon.err.log')

  /** @type {string[]} */
  const programArgs = [nodePath, binPath, 'daemon', 'run']
  if (foreground) programArgs.push('--foreground')
  programArgs.push('--config', configPath)

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
  ]
  for (const arg of programArgs) {
    lines.push(`    <string>${escapeXml(arg)}</string>`)
  }
  lines.push(
    '  </array>',
    '  <key>RunAtLoad</key>',
    `  ${runAtLoad ? '<true/>' : '<false/>'}`,
    '  <key>KeepAlive</key>',
    `  ${keepAlive ? '<true/>' : '<false/>'}`,
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(stderrPath)}</string>`,
  )

  if (env !== undefined) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new LaunchAgentError('env must be an object of string values')
    }
    const entries = Object.entries(env)
    lines.push('  <key>EnvironmentVariables</key>')
    if (entries.length === 0) {
      lines.push('  <dict/>')
    } else {
      lines.push('  <dict>')
      for (const [key, value] of entries) {
        if (typeof value !== 'string') {
          throw new LaunchAgentError(`env.${key} must be a string`)
        }
        lines.push(`    <key>${escapeXml(key)}</key>`)
        lines.push(`    <string>${escapeXml(value)}</string>`)
      }
      lines.push('  </dict>')
    }
  }

  lines.push('</dict>', '</plist>', '')
  return lines.join('\n')
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * @param {string} plistDir
 * @param {string} [label]
 * @returns {string}
 */
export function plistPathFor(plistDir, label = LAUNCH_LABEL) {
  return path.posix.join(plistDir, plistFileName(label))
}

/**
 * @param {string} [uid]
 * @returns {string}
 */
function defaultUserDomain(uid) {
  if (uid !== undefined) return `gui/${uid}`
  const fromProcess = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (typeof fromProcess === 'number') return `gui/${fromProcess}`
  return 'gui/501'
}

/**
 * Build the install plan without touching disk. Used by the dry-run
 * JSON output and the smoke flow.
 *
 * @param {PlanLaunchAgentInstallOptions} options
 * @returns {LaunchAgentInstallPlan}
 * @ref LLP 0017#install-global-package-then-service-manager [implements]: launchd LaunchAgent pointed at the stable global binary, never an npx path
 */
export function planLaunchAgentInstall(options) {
  const label = options.label ?? LAUNCH_LABEL
  const plistDir = options.plistDir ?? defaultPlistDir(options.homeDir)
  const logDir = options.logDir ?? defaultLogDir(options.homeDir)
  const nodePath = options.nodePath ?? process.execPath
  const content = buildPlist({
    label,
    nodePath,
    binPath: options.binPath,
    configPath: options.configPath,
    logDir,
    env: options.env,
    keepAlive: options.keepAlive,
    runAtLoad: options.runAtLoad,
    foreground: options.foreground,
  })
  const targetPath = plistPathFor(plistDir, label)
  const target = `<user-domain>/${label}`
  return {
    platform: 'darwin',
    label,
    targetPath,
    content,
    binPath: options.binPath,
    configPath: options.configPath,
    logDir,
    nodePath,
    plistDir,
    manageCommands: [
      ['launchctl', 'bootstrap', '<user-domain>', targetPath],
      ['launchctl', 'bootout', target],
      ['launchctl', 'kickstart', '-k', target],
      ['launchctl', 'print', target],
    ],
  }
}

const UNLOAD_POLL_ATTEMPTS = 30 // ~3s ceiling at 100ms each
const UNLOAD_POLL_INTERVAL_MS = 100
const BOOTSTRAP_MAX_RETRIES = 3
const BOOTSTRAP_RETRY_PAUSE_MS = 150
const SPAWN_POLL_ATTEMPTS = 20 // ~2s ceiling at 100ms each
const SPAWN_POLL_INTERVAL_MS = 100

/**
 * Poll `launchctl print <target>` until the agent is gone (non-zero exit)
 * or the bound elapses. `launchctl bootout` is asynchronous: launchd may
 * still be tearing the service down after the command returns. Waiting for
 * the service to actually disappear closes the bootout→bootstrap race.
 *
 * @param {LaunchctlAdapter} launchctl
 * @param {string} target
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<void>}
 */
async function waitUntilUnloaded(launchctl, target, sleep) {
  for (let i = 0; i < UNLOAD_POLL_ATTEMPTS; i += 1) {
    const res = await launchctl.print([target])
    if (res.exitCode !== 0) return // launchd has released it
    await sleep(UNLOAD_POLL_INTERVAL_MS)
  }
}

/**
 * Poll `launchctl print <target>` until launchd reports a running pid, or
 * the bound elapses. This answers "did the job actually spawn", which is a
 * different question from "is the job loaded": a bootstrapped job whose
 * initial spawn launchd left pended prints fine and has no pid.
 *
 * @param {LaunchctlAdapter} launchctl
 * @param {string} target
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<number | undefined>} the pid, or undefined if it never ran
 */
async function waitForRunningPid(launchctl, target, sleep) {
  for (let i = 0; i < SPAWN_POLL_ATTEMPTS; i += 1) {
    const res = await launchctl.print([target])
    if (res.exitCode === 0) {
      const pid = parsePrintedPid(res.stdout)
      if (pid !== undefined) return pid
    }
    await sleep(SPAWN_POLL_INTERVAL_MS)
  }
  return undefined
}

/**
 * Is a failed bootstrap the transient EIO launchd returns while a prior
 * instance is still being released (`Bootstrap failed: 5: Input/output
 * error`)? Those are safe to retry; a genuine config/load error is not.
 *
 * @param {LaunchctlResult} res
 * @returns {boolean}
 */
function isTransientBootstrapError(res) {
  return res.exitCode === 5 || /\b5:\s*Input\/output|Input\/output error/i.test(res.stderr || '')
}

/**
 * Install or refresh a HypAware LaunchAgent. Idempotent: if the agent is
 * already loaded it is booted out first, and we wait for launchd to fully
 * release it before the new plist is written and bootstrapped back in.
 * Bootstrap retries the transient EIO (`error 5`) launchd raises while an
 * unfinished teardown still holds the label, so a reinstall over a live
 * agent doesn't fail; genuine load errors still surface immediately.
 *
 * The install does not return until the agent is observably running: it
 * kickstarts the bootstrapped label and polls for a pid, because a
 * bootstrap alone can leave the initial RunAtLoad spawn pended forever.
 *
 * @param {PlanLaunchAgentInstallOptions & { launchctl?: LaunchctlAdapter, userDomain?: string, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<LaunchAgentInstallPlan>}
 * @ref LLP 0017#reinstall-waits-for-launchd-release [implements]: bootout is async; poll until released + bounded EIO retry
 */
export async function installLaunchAgent(options) {
  const plan = planLaunchAgentInstall(options)
  const { launchctl, userDomain, target } = resolveTarget(options)
  const sleep = options.sleep ?? defaultSleep

  ensureFs(function() { fs.mkdirSync(plan.plistDir, { recursive: true }) }, `create ${plan.plistDir}`)
  ensureFs(function() { fs.mkdirSync(plan.logDir, { recursive: true }) }, `create ${plan.logDir}`)

  const printRes = await launchctl.print([target])
  if (printRes.exitCode === 0) {
    await launchctl.bootout([target]).catch(function() { /* best-effort */ })
    await waitUntilUnloaded(launchctl, target, sleep)
  }

  ensureFs(
    function() { atomicWriteFileSync(plan.targetPath, plan.content, { mode: 0o644 }) },
    `write ${plan.targetPath}`,
  )

  let bootstrapRes = await launchctl.bootstrap([userDomain, plan.targetPath])
  for (
    let attempt = 0;
    attempt < BOOTSTRAP_MAX_RETRIES && bootstrapRes.exitCode !== 0 && isTransientBootstrapError(bootstrapRes);
    attempt += 1
  ) {
    await waitUntilUnloaded(launchctl, target, sleep)
    await sleep(BOOTSTRAP_RETRY_PAUSE_MS)
    bootstrapRes = await launchctl.bootstrap([userDomain, plan.targetPath])
  }
  ensure(bootstrapRes, `bootstrap LaunchAgent ${plan.label}`)

  // RunAtLoad=false is the caller asking the installer not to start the
  // job, so it does not force a spawn and does not demand a pid. Whether
  // launchd runs it anyway is launchd's business: KeepAlive (this module's
  // default) keeps a loaded job running whatever RunAtLoad says.
  if (options.runAtLoad !== false) {
    // @ref LLP 0317#kickstart-then-verify [implements]: bootstrap only registers the job, so force the spawn and prove a pid before reporting success
    const kickRes = await launchctl.kickstart([target])
    const pid = await waitForRunningPid(launchctl, target, sleep)
    if (pid === undefined) {
      // Say why, and where to look next. `hyp daemon install` prints only
      // the message, so a reason left on the error alone never reaches the
      // person this failure exists to tell (`ensureOk` folds it in too).
      // Trailing period stripped because the clause after it opens with the
      // log path: launchctl stderr sometimes ends in one, and "in domain for
      // user.. /path" reads as a typo in the one message whose job is to be
      // read carefully.
      const why = (kickRes.stderr || '').trim().replace(/\.+$/, '')
      // The log is the second place to look, not the first. `StandardErrorPath`
      // is appended to, never truncated, so a job launchd never spawned leaves
      // whatever the previous run wrote sitting there looking current. Say that
      // out loud, and end on `launchctl print`, the probe that always has an
      // answer (`state = not running`, `pended nondemand spawn = speculative`)
      // and is copy-pasteable because nothing follows it.
      throw new LaunchAgentError(
        `bootstrapped LaunchAgent ${plan.label} but launchd never started it`
          + `${why ? `: ${why}` : ''}`
          + `. ${path.posix.join(plan.logDir, 'daemon.err.log')} is appended to across runs,`
          + ` so when the job never ran it holds only older output`
          + `; ask launchd itself: launchctl print ${target}`,
        // No exit code when the kickstart itself exited 0: a thrown error
        // tagged `exitCode: 0` reads as success to any caller that forwards
        // the field as a process exit status.
        { exitCode: kickRes.exitCode === 0 ? undefined : kickRes.exitCode, stderr: kickRes.stderr },
      )
    }
  }

  return plan
}

/**
 * Boot out and remove a HypAware LaunchAgent. Tolerates already-unloaded
 * state and a missing plist file. Removes only the service artifact.
 * Config, recordings, and logs are left untouched.
 *
 * @param {{ label?: string, plistDir?: string, homeDir?: string, launchctl?: LaunchctlAdapter, userDomain?: string }} options
 * @returns {Promise<void>}
 */
export async function uninstallLaunchAgent(options) {
  const { launchctl, label, target } = resolveTarget(options)
  const plistDir = options.plistDir ?? defaultPlistDir(options.homeDir)
  const plistPath = plistPathFor(plistDir, label)

  if (fs.existsSync(plistPath)) {
    await launchctl.bootout([target]).catch(function() { /* best-effort */ })
    unlinkServiceFile(plistPath)
  }
}

/**
 * Kickstart the installed LaunchAgent so it begins running.
 *
 * @param {{ label?: string, launchctl?: LaunchctlAdapter, userDomain?: string }} options
 * @returns {Promise<void>}
 */
export async function startLaunchAgent(options) {
  const { launchctl, label, target } = resolveTarget(options)
  ensure(await launchctl.kickstart([target]), `kickstart ${label}`)
}

/**
 * Restart the installed LaunchAgent. Uses `launchctl kickstart -k` so
 * the running process is terminated and then re-started without
 * touching the loaded plist.
 *
 * @param {{ label?: string, launchctl?: LaunchctlAdapter, userDomain?: string }} options
 * @returns {Promise<void>}
 */
export async function restartLaunchAgent(options) {
  const { launchctl, label, target } = resolveTarget(options)
  ensure(await launchctl.kickstart(['-k', target]), `kickstart -k ${label}`)
}

/**
 * Query whether the plist file is on disk.
 *
 * @param {{ label?: string, plistDir?: string, homeDir?: string }} options
 * @returns {boolean}
 */
export function isLaunchAgentInstalled(options) {
  const label = options.label ?? LAUNCH_LABEL
  const plistDir = options.plistDir ?? defaultPlistDir(options.homeDir)
  return fs.existsSync(plistPathFor(plistDir, label))
}

/**
 * Query the runtime status of a LaunchAgent via `launchctl print`.
 *
 * Returns `{ loaded: false }` when launchctl reports the service is
 * not in its domain. When loaded, includes a `pid` only if the agent
 * currently has a running process.
 *
 * @param {{ label?: string, launchctl?: LaunchctlAdapter, userDomain?: string, homeDir?: string, platform?: NodeJS.Platform }} options
 * @returns {Promise<{ loaded: boolean, pid?: number }>}
 */
export async function launchAgentStatus(options) {
  const { launchctl, target } = resolveTarget(options)
  const result = await launchctl.print([target])
  if (result.exitCode !== 0) return { loaded: false }
  const pid = parsePrintedPid(result.stdout)
  return pid === undefined ? { loaded: true } : { loaded: true, pid }
}

/**
 * Extract the numeric PID from a `launchctl print <target>` block.
 *
 * @param {string} stdout
 * @returns {number | undefined}
 */
function parsePrintedPid(stdout) {
  const match = /\bpid\s*=\s*(\d+)/i.exec(stdout)
  if (!match) return undefined
  const n = Number.parseInt(match[1], 10)
  return Number.isInteger(n) && n > 0 ? n : undefined
}
