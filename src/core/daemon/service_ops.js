// @ts-check

import { spawn } from 'node:child_process'
import fs from 'node:fs'

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
 * Spawn a service-manager binary and collect its output. Never rejects
 * on a non-zero exit: callers decide what failure means (see
 * {@link ensureOk}).
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {Promise<ServiceCommandResult>}
 */
export function runServiceCommand(bin, args) {
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
