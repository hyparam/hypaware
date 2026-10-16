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
  // path.posix here and below: these paths name locations on a darwin/linux
  // host and land inside plist/unit content, so they must keep POSIX form
  // even when rendered elsewhere (`--dry-run` on win32). Identical to
  // path.join on the platforms the service actually installs on.
  return path.posix.join(homeDir ?? os.homedir(), '.hyp', 'hypaware', 'logs')
}

/**
 * Default config path used by the installed service when the operator
 * does not pass `--config`. Lives next to the daemon state dir.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultConfigPath(homeDir) {
  return path.posix.join(homeDir ?? os.homedir(), '.hyp', 'hypaware-config.json')
}

/**
 * Default location for the macOS LaunchAgent plist directory.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultPlistDir(homeDir) {
  return path.posix.join(homeDir ?? os.homedir(), 'Library', 'LaunchAgents')
}

/**
 * Default location for systemd `--user` unit files.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultUnitDir(homeDir) {
  return path.posix.join(homeDir ?? os.homedir(), '.config', 'systemd', 'user')
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

/**
 * The note a run prints when the daemon install did not finish. Two callers
 * reach it: the enrolling login lane, whose sign-in and enrollment are a fact
 * by that point, and the picker finale, whose config is already committed.
 * Either way the only missing piece is the background service, so `context`
 * names what did land and the note reports a missing service, never a failed
 * sign-in and never a failed setup.
 *
 * The remediation prints only where it can work. `hyp daemon install` is the
 * fix on a platform with a service manager; on one without, no run of it
 * would finish, so the note says the machine captures nothing instead of
 * naming a command that cannot help (#978).
 *
 * Here rather than beside either caller: it branches on `platformIsSupported`,
 * and this is the leaf both lanes reach without closing an import cycle.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} [context] what did land, e.g. `'enrolled'`; omitted when the note stands alone
 * @returns {string}
 */
export function daemonIncompleteNote(platform, context) {
  const lead = context ? `${context}, but ` : ''
  return platformIsSupported(platform)
    ? `note: ${lead}the daemon install did not finish - run 'hyp daemon install'\n`
    : `note: ${lead}${platform} has no background service to install - nothing is captured on this machine\n`
}
