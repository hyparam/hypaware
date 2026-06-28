// @ts-check

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  LAUNCH_LABEL,
  defaultLogDir,
  defaultPlistDir,
  plistFileName,
} from './platform.js'

/**
 * @import {
 *   LaunchctlResult,
 *   LaunchctlAdapter,
 *   BuildPlistOptions,
 *   PlanLaunchAgentInstallOptions,
 *   LaunchAgentInstallPlan,
 * } from '../../../src/core/daemon/types.js'
 */

export class LaunchAgentError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, stderr?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'LaunchAgentError'
    /** @type {number | undefined} */
    this.exitCode = opts.exitCode
    /** @type {string | undefined} */
    this.stderr = opts.stderr
  }
}

/** @type {LaunchctlAdapter} */
export const realLaunchctl = {
  bootstrap(args) { return runLaunchctl(['bootstrap', ...args]) },
  bootout(args) { return runLaunchctl(['bootout', ...args]) },
  kickstart(args) { return runLaunchctl(['kickstart', ...args]) },
  print(args) { return runLaunchctl(['print', ...args]) },
}

/**
 * @param {string[]} args
 * @returns {Promise<LaunchctlResult>}
 */
function runLaunchctl(args) {
  return new Promise(function(resolve, reject) {
    const proc = spawn('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
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

  const stdoutPath = path.join(logDir, 'daemon.out.log')
  const stderrPath = path.join(logDir, 'daemon.err.log')

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
  return path.join(plistDir, plistFileName(label))
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
 * @ref LLP 0017#install-global-package-then-service-manager [implements] — launchd LaunchAgent pointed at the stable global binary, never an npx path
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

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms) })
}

const UNLOAD_POLL_ATTEMPTS = 30 // ~3s ceiling at 100ms each
const UNLOAD_POLL_INTERVAL_MS = 100
const BOOTSTRAP_MAX_RETRIES = 3
const BOOTSTRAP_RETRY_PAUSE_MS = 150

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
 * already loaded it is booted out first — and we wait for launchd to fully
 * release it — before the new plist is written and bootstrapped back in.
 * Bootstrap retries the transient EIO (`error 5`) launchd raises while an
 * unfinished teardown still holds the label, so a reinstall over a live
 * agent doesn't fail; genuine load errors still surface immediately.
 *
 * @param {PlanLaunchAgentInstallOptions & { launchctl?: LaunchctlAdapter, userDomain?: string, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<LaunchAgentInstallPlan>}
 * @ref LLP 0017#reinstall-waits-for-launchd-release [implements] — bootout is async; poll until released + bounded EIO retry
 */
export async function installLaunchAgent(options) {
  const plan = planLaunchAgentInstall(options)
  const launchctl = options.launchctl ?? realLaunchctl
  const userDomain = options.userDomain ?? defaultUserDomain()
  const sleep = options.sleep ?? defaultSleep
  const target = `${userDomain}/${plan.label}`

  fs.mkdirSync(plan.plistDir, { recursive: true })
  fs.mkdirSync(plan.logDir, { recursive: true })

  const printRes = await launchctl.print([target])
  if (printRes.exitCode === 0) {
    await launchctl.bootout([target]).catch(function() { /* best-effort */ })
    await waitUntilUnloaded(launchctl, target, sleep)
  }

  atomicWrite(plan.targetPath, plan.content)

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
  if (bootstrapRes.exitCode !== 0) {
    throw new LaunchAgentError(
      `failed to bootstrap LaunchAgent ${plan.label}: ${bootstrapRes.stderr.trim() || `exit ${bootstrapRes.exitCode}`}`,
      { exitCode: bootstrapRes.exitCode, stderr: bootstrapRes.stderr }
    )
  }
  return plan
}

/**
 * Boot out and remove a HypAware LaunchAgent. Tolerates already-unloaded
 * state and a missing plist file. Removes only the service artifact —
 * config, recordings, and logs are left untouched.
 *
 * @param {{ label?: string, plistDir?: string, homeDir?: string, launchctl?: LaunchctlAdapter, userDomain?: string }} options
 * @returns {Promise<void>}
 */
export async function uninstallLaunchAgent(options) {
  const launchctl = options.launchctl ?? realLaunchctl
  const label = options.label ?? LAUNCH_LABEL
  const plistDir = options.plistDir ?? defaultPlistDir(options.homeDir)
  const plistPath = plistPathFor(plistDir, label)
  const userDomain = options.userDomain ?? defaultUserDomain()
  const target = `${userDomain}/${label}`

  if (fs.existsSync(plistPath)) {
    await launchctl.bootout([target]).catch(function() { /* best-effort */ })
    try {
      fs.unlinkSync(plistPath)
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? /** @type {NodeJS.ErrnoException} */ (err).code
        : undefined
      if (code !== 'ENOENT') throw err
    }
  }
}

/**
 * Kickstart the installed LaunchAgent so it begins running.
 *
 * @param {{ label?: string, launchctl?: LaunchctlAdapter, userDomain?: string }} options
 * @returns {Promise<void>}
 */
export async function startLaunchAgent(options) {
  const launchctl = options.launchctl ?? realLaunchctl
  const label = options.label ?? LAUNCH_LABEL
  const userDomain = options.userDomain ?? defaultUserDomain()
  const target = `${userDomain}/${label}`
  const res = await launchctl.kickstart([target])
  if (res.exitCode !== 0) {
    throw new LaunchAgentError(
      `failed to kickstart ${label}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      { exitCode: res.exitCode, stderr: res.stderr }
    )
  }
}

/**
 * Stop the installed LaunchAgent via `launchctl bootout`. The plist
 * file is left on disk so a subsequent `daemon start` (kickstart) or
 * `daemon install` re-load can bring it back. To remove the plist,
 * use `uninstallLaunchAgent` instead.
 *
 * @param {{ label?: string, launchctl?: LaunchctlAdapter, userDomain?: string }} options
 * @returns {Promise<void>}
 */
export async function stopLaunchAgent(options) {
  const launchctl = options.launchctl ?? realLaunchctl
  const label = options.label ?? LAUNCH_LABEL
  const userDomain = options.userDomain ?? defaultUserDomain()
  const target = `${userDomain}/${label}`
  const res = await launchctl.bootout([target])
  if (res.exitCode !== 0 && !/No such process|Could not find|not\s*loaded/i.test(res.stderr)) {
    throw new LaunchAgentError(
      `failed to bootout ${label}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      { exitCode: res.exitCode, stderr: res.stderr }
    )
  }
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
  const launchctl = options.launchctl ?? realLaunchctl
  const label = options.label ?? LAUNCH_LABEL
  const userDomain = options.userDomain ?? defaultUserDomain()
  const target = `${userDomain}/${label}`
  const res = await launchctl.kickstart(['-k', target])
  if (res.exitCode !== 0) {
    throw new LaunchAgentError(
      `failed to kickstart -k ${label}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      { exitCode: res.exitCode, stderr: res.stderr }
    )
  }
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
  const launchctl = options.launchctl ?? realLaunchctl
  const label = options.label ?? LAUNCH_LABEL
  const userDomain = options.userDomain ?? defaultUserDomain()
  const result = await launchctl.print([`${userDomain}/${label}`])
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

/**
 * @param {string} targetPath
 * @param {string} content
 */
function atomicWrite(targetPath, content) {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmpPath, content, { mode: 0o644 })
  try {
    fs.renameSync(tmpPath, targetPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}
