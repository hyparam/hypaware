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
 * @typedef {Object} LaunchctlResult
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {Object} LaunchctlAdapter
 * @property {(args: string[]) => Promise<LaunchctlResult>} bootstrap
 * @property {(args: string[]) => Promise<LaunchctlResult>} bootout
 * @property {(args: string[]) => Promise<LaunchctlResult>} kickstart
 * @property {(args: string[]) => Promise<LaunchctlResult>} print
 */

/**
 * @typedef {Object} BuildPlistOptions
 * @property {string} [label]
 * @property {string} nodePath
 * @property {string} binPath
 * @property {string} configPath
 * @property {string} logDir
 * @property {Record<string,string>} [env]
 * @property {boolean} [keepAlive]
 * @property {boolean} [runAtLoad]
 * @property {boolean} [foreground]
 */

/**
 * @typedef {Object} PlanLaunchAgentInstallOptions
 * @property {string} binPath
 * @property {string} configPath
 * @property {string} [label]
 * @property {string} [logDir]
 * @property {string} [nodePath]
 * @property {string} [homeDir]
 * @property {string} [plistDir]
 * @property {Record<string,string>} [env]
 * @property {boolean} [keepAlive]
 * @property {boolean} [runAtLoad]
 * @property {boolean} [foreground]
 */

/**
 * @typedef {Object} LaunchAgentInstallPlan
 * @property {'darwin'} platform
 * @property {string} label
 * @property {string} targetPath
 * @property {string} content
 * @property {string} binPath
 * @property {string} configPath
 * @property {string} logDir
 * @property {string} nodePath
 * @property {string} plistDir
 * @property {string[][]} manageCommands
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
 * Install or refresh a HypAware LaunchAgent. Idempotent: if the agent
 * is already loaded, it is booted out first before the new plist is
 * written and bootstrapped back in.
 *
 * @param {PlanLaunchAgentInstallOptions & { launchctl?: LaunchctlAdapter, userDomain?: string }} options
 * @returns {Promise<LaunchAgentInstallPlan>}
 */
export async function installLaunchAgent(options) {
  const plan = planLaunchAgentInstall(options)
  const launchctl = options.launchctl ?? realLaunchctl
  const userDomain = options.userDomain ?? defaultUserDomain()
  const target = `${userDomain}/${plan.label}`

  fs.mkdirSync(plan.plistDir, { recursive: true })
  fs.mkdirSync(plan.logDir, { recursive: true })

  const printRes = await launchctl.print([target])
  if (printRes.exitCode === 0) {
    await launchctl.bootout([target]).catch(function() { /* best-effort */ })
  }

  atomicWrite(plan.targetPath, plan.content)

  const bootstrapRes = await launchctl.bootstrap([userDomain, plan.targetPath])
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
 * state and a missing plist file. Leaves config, recordings, and logs
 * untouched per finish-v1.md §Phase 4 work #6.
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
 * @param {{ label?: string, launchctl?: LaunchctlAdapter, userDomain?: string }} options
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
