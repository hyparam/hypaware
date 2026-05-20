import process from 'node:process'
import * as linux from './linux.js'
import * as macos from './macos.js'

/**
 * @import { DaemonInstallOptions, DaemonUninstallOptions } from './types.d.ts'
 */

export class DaemonError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'DaemonError'
  }
}

/**
 * Install the platform-appropriate daemon to keep the collectivus process
 * running across reboots. Dispatches to a LaunchAgent on macOS and a systemd
 * user unit on Linux; throws a clear error on other platforms so the CLI can
 * surface it.
 *
 * @param {DaemonInstallOptions} options
 * @returns {Promise<void>}
 */
export async function installDaemon(options) {
  if (process.platform === 'darwin') {
    await macos.installLaunchAgent(options)
    return
  }
  if (process.platform === 'linux') {
    await linux.installSystemdUnit(options)
    return
  }
  throw new DaemonError(`unsupported platform: ${process.platform} (only darwin and linux are supported)`)
}

/**
 * Inverse of `installDaemon`. Same platform dispatch.
 *
 * @param {DaemonUninstallOptions} options
 * @returns {Promise<void>}
 */
export async function uninstallDaemon(options) {
  if (process.platform === 'darwin') {
    await macos.uninstallLaunchAgent(options)
    return
  }
  if (process.platform === 'linux') {
    await linux.uninstallSystemdUnit(options)
    return
  }
  throw new DaemonError(`unsupported platform: ${process.platform} (only darwin and linux are supported)`)
}

export { linux, macos }
