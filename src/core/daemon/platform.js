// @ts-check

import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Stable label for the macOS LaunchAgent. Used both as the plist
 * `Label` value and as the plist filename (`<label>.plist`).
 */
export const LAUNCH_LABEL = 'com.hyperparam.hypaware'

/**
 * Stable basename for the systemd user unit. The unit file is written
 * as `<basename>.service` under `~/.config/systemd/user/`. macOS uses
 * the reverse-DNS `LAUNCH_LABEL` instead; Linux follows the systemd
 * convention of a short, human-friendly unit name.
 */
export const SYSTEMD_UNIT_BASE = 'hypaware'

/**
 * Default directory for daemon stdout/stderr logs: `~/.hyp/hypaware/logs`.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultLogDir(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'hypaware', 'logs')
}

/**
 * Default config path used by the installed service when the operator
 * does not pass `--config`. Lives next to the daemon state dir.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultConfigPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'hypaware-config.json')
}

/**
 * Default location for the macOS LaunchAgent plist directory.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultPlistDir(homeDir) {
  return path.join(homeDir ?? os.homedir(), 'Library', 'LaunchAgents')
}

/**
 * Default location for systemd `--user` unit files.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultUnitDir(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.config', 'systemd', 'user')
}

/**
 * Filename for the macOS plist given the launch label.
 *
 * @param {string} [label]
 * @returns {string}
 */
export function plistFileName(label = LAUNCH_LABEL) {
  return `${label}.plist`
}

/**
 * Filename for the systemd unit given the launch label. Accepts either
 * a bare label or a label already ending in `.service`.
 *
 * @param {string} [label]
 * @returns {string}
 */
export function unitFileName(label = SYSTEMD_UNIT_BASE) {
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('label is required')
  }
  return label.endsWith('.service') ? label : `${label}.service`
}

/**
 * Human-readable description of the daemon artifact for `platform`.
 * Used in install/uninstall success messages so Linux output does not
 * claim a "LaunchAgent" was touched when in fact a systemd user unit
 * was, and vice versa.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function daemonKindLabel(platform = process.platform) {
  if (platform === 'darwin') return `LaunchAgent: ${LAUNCH_LABEL}`
  if (platform === 'linux') return `systemd unit: ${unitFileName(SYSTEMD_UNIT_BASE)}`
  return `daemon (${platform})`
}

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 * @ref LLP 0017#install-global-package-then-service-manager [constrained-by]: V1 service install targets macOS launchd + Linux systemd only
 */
export function platformIsSupported(platform = process.platform) {
  return platform === 'darwin' || platform === 'linux'
}
