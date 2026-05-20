import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * @import {
 *   SystemctlResult,
 *   SystemctlAdapter,
 *   BuildUnitOptions,
 *   LinuxInstallOptions,
 *   LinuxUninstallOptions,
 *   LinuxStatusOptions,
 * } from './types.d.ts'
 */

const DEFAULT_UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user')

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
  restart(unit) { return runSystemctl(['--user', 'restart', unit]) },
  stop(unit) { return runSystemctl(['--user', 'stop', unit]) },
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
 * Build the body of a systemd .service unit file.
 *
 * Output is deterministic for the same inputs so tests can compare against
 * fixed strings. ExecStart arguments are double-quoted only when they contain
 * characters outside the safe set; Environment values are always quoted.
 *
 * @param {BuildUnitOptions} options
 * @returns {string} The unit file content with a trailing newline.
 */
export function buildUnit(options) {
  const { description, nodePath, binPath, configPath, logDir, env } = options
  const restart = options.restart !== false

  if (!description || typeof description !== 'string') throw new SystemdUnitError('description is required')
  if (!nodePath || typeof nodePath !== 'string') throw new SystemdUnitError('nodePath is required')
  if (!binPath || typeof binPath !== 'string') throw new SystemdUnitError('binPath is required')
  if (!configPath || typeof configPath !== 'string') throw new SystemdUnitError('configPath is required')
  if (!logDir || typeof logDir !== 'string') throw new SystemdUnitError('logDir is required')

  const stdoutPath = path.join(logDir, 'collectivus.log')
  const stderrPath = path.join(logDir, 'collectivus.err.log')

  const execStart = [
    quoteExecArg(nodePath),
    quoteExecArg(binPath),
    '--config',
    quoteExecArg(configPath),
  ].join(' ')

  const lines = [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    `Restart=${restart ? 'always' : 'no'}`,
  ]

  if (restart) lines.push('RestartSec=5')

  lines.push(
    `StandardOutput=append:${stdoutPath}`,
    `StandardError=append:${stderrPath}`
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
    ''
  )

  return lines.join('\n')
}

/**
 * Quote an ExecStart argument when it contains characters outside the safe
 * set; otherwise return it verbatim. systemd's exec parser treats unquoted
 * whitespace as an argument boundary.
 *
 * @param {string} value
 * @returns {string}
 */
function quoteExecArg(value) {
  if (/^[A-Za-z0-9_\-./:=@%+]+$/.test(value)) return value
  return `"${escapeQuoted(value)}"`
}

/**
 * Escape backslashes and double quotes for inclusion inside a `"..."` literal,
 * matching systemd's C-style escape rules.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeQuoted(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Install or refresh a systemd user unit.
 *
 * Writes the unit file atomically (tmp + rename), runs `daemon-reload` so
 * systemd picks up the new content, then `enable` for persistence and
 * `restart` to (re)start the service with the latest config. Idempotent:
 * re-running with unchanged inputs leaves the same file on disk and bounces
 * the service.
 *
 * @param {LinuxInstallOptions} options
 * @returns {Promise<void>}
 */
export async function installSystemdUnit(options) {
  const systemctl = options.systemctl ?? realSystemctl
  const unitDir = options.unitDir ?? DEFAULT_UNIT_DIR
  const nodePath = options.nodePath ?? process.execPath
  const description = options.description ?? `Collectivus daemon (${options.label})`

  const unitName = unitFileName(options.label)
  const unitPath = path.join(unitDir, unitName)
  const content = buildUnit({
    description,
    nodePath,
    binPath: options.binPath,
    configPath: options.configPath,
    logDir: options.logDir,
    env: options.env,
    restart: options.restart,
  })

  fs.mkdirSync(unitDir, { recursive: true })
  fs.mkdirSync(options.logDir, { recursive: true })

  atomicWrite(unitPath, content)

  const reload = await systemctl.daemonReload()
  if (reload.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to systemctl --user daemon-reload: ${reload.stderr.trim() || `exit ${reload.exitCode}`}`,
      { exitCode: reload.exitCode, stderr: reload.stderr }
    )
  }

  const enableResult = await systemctl.enable(unitName)
  if (enableResult.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to enable systemd user unit ${unitName}: ${enableResult.stderr.trim() || `exit ${enableResult.exitCode}`}`,
      { exitCode: enableResult.exitCode, stderr: enableResult.stderr }
    )
  }

  const restartResult = await systemctl.restart(unitName)
  if (restartResult.exitCode !== 0) {
    throw new SystemdUnitError(
      `failed to restart systemd user unit ${unitName}: ${restartResult.stderr.trim() || `exit ${restartResult.exitCode}`}`,
      { exitCode: restartResult.exitCode, stderr: restartResult.stderr }
    )
  }
}

/**
 * Stop, disable, and remove a systemd user unit.
 *
 * Tolerates already-stopped / already-disabled state and a missing unit file.
 * The stop and disable steps are best-effort so a stale unit file can always
 * be cleaned up even when systemctl reports the unit was already gone. After
 * removing the file we run a final `daemon-reload` to drop systemd's cached
 * registration.
 *
 * @param {LinuxUninstallOptions} options
 * @returns {Promise<void>}
 */
export async function uninstallSystemdUnit(options) {
  const systemctl = options.systemctl ?? realSystemctl
  const unitDir = options.unitDir ?? DEFAULT_UNIT_DIR
  const unitName = unitFileName(options.label)
  const unitPath = path.join(unitDir, unitName)

  if (!fs.existsSync(unitPath)) return

  await systemctl.stop(unitName) // best-effort; tolerate failures
  await systemctl.disable(unitName) // best-effort; tolerate failures

  try {
    fs.unlinkSync(unitPath)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code !== 'ENOENT') throw err
  }

  await systemctl.daemonReload() // best-effort; clears cached registration
}

/**
 * Query whether the unit file for a label is installed on disk.
 *
 * @param {{ label: string, unitDir?: string }} options
 * @returns {Promise<boolean>}
 */
export function isSystemdUnitInstalled(options) {
  const unitDir = options.unitDir ?? DEFAULT_UNIT_DIR
  return Promise.resolve(fs.existsSync(path.join(unitDir, unitFileName(options.label))))
}

/**
 * Query the runtime status of a systemd user unit via
 * `systemctl --user show <unit>`.
 *
 * Returns `{ loaded: false }` when systemctl reports a non-zero exit code or
 * the unit's LoadState is not `loaded`. When loaded, includes a `pid` only if
 * MainPID is a positive integer — units that are loaded but not currently
 * running report `MainPID=0` and surface as `{ loaded: true }` with no pid.
 *
 * @param {LinuxStatusOptions} options
 * @returns {Promise<{ loaded: boolean, pid?: number }>}
 */
export async function systemdUnitStatus(options) {
  const systemctl = options.systemctl ?? realSystemctl
  const unitName = unitFileName(options.label)
  const result = await systemctl.show(unitName)
  if (result.exitCode !== 0) return { loaded: false }

  const props = parseShowOutput(result.stdout)
  if (props.LoadState !== 'loaded') return { loaded: false }

  const pid = parsePid(props.MainPID)
  return pid === undefined ? { loaded: true } : { loaded: true, pid }
}

/**
 * Parse `systemctl show` key=value output into a plain object. Lines without
 * an `=` are ignored.
 *
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
function parseShowOutput(stdout) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    out[key] = line.slice(eq + 1)
  }
  return out
}

/**
 * Convert a MainPID property value to a positive integer, returning undefined
 * for `0`, missing, or non-numeric values.
 *
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parsePid(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n <= 0) return undefined
  return n
}

/**
 * Resolve a label to a `<label>.service` filename. Labels that already end in
 * `.service` are accepted verbatim so callers can pass either form.
 *
 * @param {string} label
 * @returns {string}
 */
function unitFileName(label) {
  if (!label || typeof label !== 'string') {
    throw new SystemdUnitError('label is required')
  }
  return label.endsWith('.service') ? label : `${label}.service`
}

/**
 * Write `content` to `targetPath` atomically by writing to a sibling tmp
 * file and renaming. fs.renameSync is atomic on the same filesystem on
 * Linux, so a crash mid-write leaves the previous file (or no file) intact.
 *
 * @param {string} targetPath
 * @param {string} content
 * @returns {void}
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
