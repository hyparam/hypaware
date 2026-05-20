// @ts-check

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  SYSTEMD_UNIT_BASE,
  defaultLogDir,
  defaultUnitDir,
  unitFileName,
} from './platform.js'

/**
 * @typedef {Object} SystemctlResult
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {Object} SystemctlAdapter
 * @property {() => Promise<SystemctlResult>} daemonReload
 * @property {(unit: string) => Promise<SystemctlResult>} enable
 * @property {(unit: string) => Promise<SystemctlResult>} disable
 * @property {(unit: string) => Promise<SystemctlResult>} start
 * @property {(unit: string) => Promise<SystemctlResult>} stop
 * @property {(unit: string) => Promise<SystemctlResult>} restart
 * @property {(unit: string) => Promise<SystemctlResult>} status
 * @property {(unit: string) => Promise<SystemctlResult>} show
 */

/**
 * @typedef {Object} BuildUnitOptions
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} nodePath
 * @property {string} binPath
 * @property {string} configPath
 * @property {string} logDir
 * @property {Record<string,string>} [env]
 * @property {boolean} [restart]
 * @property {number} [restartSec]
 * @property {boolean} [foreground]
 */

/**
 * @typedef {Object} PlanSystemdInstallOptions
 * @property {string} binPath
 * @property {string} configPath
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [logDir]
 * @property {string} [nodePath]
 * @property {string} [homeDir]
 * @property {string} [unitDir]
 * @property {Record<string,string>} [env]
 * @property {boolean} [restart]
 * @property {number} [restartSec]
 * @property {boolean} [foreground]
 */

/**
 * @typedef {Object} SystemdInstallPlan
 * @property {'linux'} platform
 * @property {string} label
 * @property {string} unitName
 * @property {string} targetPath
 * @property {string} content
 * @property {string} binPath
 * @property {string} configPath
 * @property {string} logDir
 * @property {string} nodePath
 * @property {string} unitDir
 * @property {string[][]} manageCommands
 */

export class SystemdUnitError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, stderr?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'SystemdUnitError'
    /** @type {number | undefined} */
    this.exitCode = opts.exitCode
    /** @type {string | undefined} */
    this.stderr = opts.stderr
  }
}

/** @type {SystemctlAdapter} */
export const realSystemctl = {
  daemonReload() { return runSystemctl(['--user', 'daemon-reload']) },
  enable(unit) { return runSystemctl(['--user', 'enable', unit]) },
  disable(unit) { return runSystemctl(['--user', 'disable', unit]) },
  start(unit) { return runSystemctl(['--user', 'start', unit]) },
  stop(unit) { return runSystemctl(['--user', 'stop', unit]) },
  restart(unit) { return runSystemctl(['--user', 'restart', unit]) },
  status(unit) { return runSystemctl(['--user', 'status', unit]) },
  show(unit) {
    return runSystemctl(['--user', 'show', unit, '--property=LoadState,ActiveState,MainPID'])
  },
}

/**
 * @param {string[]} args
 * @returns {Promise<SystemctlResult>}
 */
function runSystemctl(args) {
  return new Promise(function(resolve, reject) {
    const proc = spawn('systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
 * Build the body of the HypAware systemd `.service` unit.
 *
 * Output is deterministic for the same inputs so tests can compare
 * against fixed strings. ExecStart arguments are double-quoted only
 * when they contain characters outside the safe set; Environment
 * values are always quoted.
 *
 * @param {BuildUnitOptions} options
 * @returns {string} The unit file content with a trailing newline.
 */
export function buildUnit(options) {
  const label = options.label ?? SYSTEMD_UNIT_BASE
  const description = options.description ?? `HypAware daemon (${label})`
  const restart = options.restart !== false
  const restartSec = typeof options.restartSec === 'number' ? options.restartSec : 5
  const foreground = options.foreground !== false
  const { nodePath, binPath, configPath, logDir, env } = options

  if (!nodePath || typeof nodePath !== 'string') throw new SystemdUnitError('nodePath is required')
  if (!binPath || typeof binPath !== 'string') throw new SystemdUnitError('binPath is required')
  if (!configPath || typeof configPath !== 'string') throw new SystemdUnitError('configPath is required')
  if (!logDir || typeof logDir !== 'string') throw new SystemdUnitError('logDir is required')

  const stdoutPath = path.join(logDir, 'daemon.out.log')
  const stderrPath = path.join(logDir, 'daemon.err.log')

  /** @type {string[]} */
  const execArgs = [
    quoteExecArg(nodePath),
    quoteExecArg(binPath),
    'daemon',
    'run',
  ]
  if (foreground) execArgs.push('--foreground')
  execArgs.push('--config', quoteExecArg(configPath))

  const lines = [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execArgs.join(' ')}`,
    `Restart=${restart ? 'always' : 'no'}`,
  ]
  if (restart) lines.push(`RestartSec=${restartSec}`)
  lines.push(
    `StandardOutput=append:${stdoutPath}`,
    `StandardError=append:${stderrPath}`,
  )

  if (env !== undefined) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new SystemdUnitError('env must be an object of string values')
    }
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') {
        throw new SystemdUnitError(`env.${key} must be a string`)
      }
      lines.push(`Environment="${escapeQuoted(key)}=${escapeQuoted(value)}"`)
    }
  }

  lines.push(
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  )

  return lines.join('\n')
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteExecArg(value) {
  if (/^[A-Za-z0-9_\-./:=@%+]+$/.test(value)) return value
  return `"${escapeQuoted(value)}"`
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeQuoted(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * @param {string} unitDir
 * @param {string} [label]
 * @returns {string}
 */
export function unitPathFor(unitDir, label = SYSTEMD_UNIT_BASE) {
  return path.join(unitDir, unitFileName(label))
}

/**
 * Build the install plan without touching disk. Used by the dry-run
 * JSON output and the smoke flow.
 *
 * @param {PlanSystemdInstallOptions} options
 * @returns {SystemdInstallPlan}
 */
export function planSystemdInstall(options) {
  const label = options.label ?? SYSTEMD_UNIT_BASE
  const unitDir = options.unitDir ?? defaultUnitDir(options.homeDir)
  const logDir = options.logDir ?? defaultLogDir(options.homeDir)
  const nodePath = options.nodePath ?? process.execPath
  const content = buildUnit({
    label,
    description: options.description,
    nodePath,
    binPath: options.binPath,
    configPath: options.configPath,
    logDir,
    env: options.env,
    restart: options.restart,
    restartSec: options.restartSec,
    foreground: options.foreground,
  })
  const unitName = unitFileName(label)
  const targetPath = unitPathFor(unitDir, label)
  return {
    platform: 'linux',
    label,
    unitName,
    targetPath,
    content,
    binPath: options.binPath,
    configPath: options.configPath,
    logDir,
    nodePath,
    unitDir,
    manageCommands: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', unitName],
      ['systemctl', '--user', 'restart', unitName],
      ['systemctl', '--user', 'stop', unitName],
      ['systemctl', '--user', 'status', unitName],
    ],
  }
}

/**
 * Install or refresh a HypAware systemd user unit. Writes the unit
 * file atomically, runs `daemon-reload` so systemd picks up the new
 * content, then `enable` for persistence and `restart` to (re)start
 * the service.
 *
 * @param {PlanSystemdInstallOptions & { systemctl?: SystemctlAdapter }} options
 * @returns {Promise<SystemdInstallPlan>}
 */
export async function installSystemdUnit(options) {
  const plan = planSystemdInstall(options)
  const systemctl = options.systemctl ?? realSystemctl

  fs.mkdirSync(plan.unitDir, { recursive: true })
  fs.mkdirSync(plan.logDir, { recursive: true })

  atomicWrite(plan.targetPath, plan.content)

  const reload = await systemctl.daemonReload()
  if (reload.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to systemctl --user daemon-reload: ${reload.stderr.trim() || `exit ${reload.exitCode}`}`,
      { exitCode: reload.exitCode, stderr: reload.stderr }
    )
  }

  const enableRes = await systemctl.enable(plan.unitName)
  if (enableRes.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to enable ${plan.unitName}: ${enableRes.stderr.trim() || `exit ${enableRes.exitCode}`}`,
      { exitCode: enableRes.exitCode, stderr: enableRes.stderr }
    )
  }

  const restartRes = await systemctl.restart(plan.unitName)
  if (restartRes.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to restart ${plan.unitName}: ${restartRes.stderr.trim() || `exit ${restartRes.exitCode}`}`,
      { exitCode: restartRes.exitCode, stderr: restartRes.stderr }
    )
  }

  return plan
}

/**
 * Stop, disable, and remove a HypAware systemd unit. Tolerates
 * already-stopped / already-disabled state and a missing unit file.
 * Leaves config, recordings, and logs untouched per finish-v1.md
 * §Phase 4 work #6.
 *
 * @param {{ label?: string, unitDir?: string, homeDir?: string, systemctl?: SystemctlAdapter }} options
 * @returns {Promise<void>}
 */
export async function uninstallSystemdUnit(options) {
  const systemctl = options.systemctl ?? realSystemctl
  const label = options.label ?? SYSTEMD_UNIT_BASE
  const unitName = unitFileName(label)
  const unitDir = options.unitDir ?? defaultUnitDir(options.homeDir)
  const unitPath = unitPathFor(unitDir, label)

  if (!fs.existsSync(unitPath)) return

  await systemctl.stop(unitName).catch(function() { /* best-effort */ })
  await systemctl.disable(unitName).catch(function() { /* best-effort */ })

  try {
    fs.unlinkSync(unitPath)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? /** @type {NodeJS.ErrnoException} */ (err).code
      : undefined
    if (code !== 'ENOENT') throw err
  }

  await systemctl.daemonReload().catch(function() { /* best-effort */ })
}

/**
 * Start an installed systemd user unit.
 *
 * @param {{ label?: string, systemctl?: SystemctlAdapter }} options
 * @returns {Promise<void>}
 */
export async function startSystemdUnit(options) {
  const systemctl = options.systemctl ?? realSystemctl
  const label = options.label ?? SYSTEMD_UNIT_BASE
  const unitName = unitFileName(label)
  const res = await systemctl.start(unitName)
  if (res.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to start ${unitName}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      { exitCode: res.exitCode, stderr: res.stderr }
    )
  }
}

/**
 * Stop an installed systemd user unit.
 *
 * @param {{ label?: string, systemctl?: SystemctlAdapter }} options
 * @returns {Promise<void>}
 */
export async function stopSystemdUnit(options) {
  const systemctl = options.systemctl ?? realSystemctl
  const label = options.label ?? SYSTEMD_UNIT_BASE
  const unitName = unitFileName(label)
  const res = await systemctl.stop(unitName)
  if (res.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to stop ${unitName}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      { exitCode: res.exitCode, stderr: res.stderr }
    )
  }
}

/**
 * Restart an installed systemd user unit.
 *
 * @param {{ label?: string, systemctl?: SystemctlAdapter }} options
 * @returns {Promise<void>}
 */
export async function restartSystemdUnit(options) {
  const systemctl = options.systemctl ?? realSystemctl
  const label = options.label ?? SYSTEMD_UNIT_BASE
  const unitName = unitFileName(label)
  const res = await systemctl.restart(unitName)
  if (res.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to restart ${unitName}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      { exitCode: res.exitCode, stderr: res.stderr }
    )
  }
}

/**
 * Query whether the unit file is on disk.
 *
 * @param {{ label?: string, unitDir?: string, homeDir?: string }} options
 * @returns {boolean}
 */
export function isSystemdUnitInstalled(options) {
  const label = options.label ?? SYSTEMD_UNIT_BASE
  const unitDir = options.unitDir ?? defaultUnitDir(options.homeDir)
  return fs.existsSync(unitPathFor(unitDir, label))
}

/**
 * Query the runtime status of the systemd user unit via
 * `systemctl --user show <unit>`.
 *
 * @param {{ label?: string, systemctl?: SystemctlAdapter }} options
 * @returns {Promise<{ loaded: boolean, pid?: number }>}
 */
export async function systemdUnitStatus(options) {
  const systemctl = options.systemctl ?? realSystemctl
  const label = options.label ?? SYSTEMD_UNIT_BASE
  const unitName = unitFileName(label)
  const result = await systemctl.show(unitName)
  if (result.exitCode !== 0) return { loaded: false }
  const props = parseShowOutput(result.stdout)
  if (props.LoadState !== 'loaded') return { loaded: false }
  const pid = parsePid(props.MainPID)
  return pid === undefined ? { loaded: true } : { loaded: true, pid }
}

/**
 * @param {string} stdout
 * @returns {Record<string,string>}
 */
function parseShowOutput(stdout) {
  /** @type {Record<string,string>} */
  const out = {}
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parsePid(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const n = Number.parseInt(value, 10)
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
