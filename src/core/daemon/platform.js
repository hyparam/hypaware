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
 * Task Scheduler folder the per-user Windows daemon task lives in. The task
 * itself is `\<WIN32_TASK_FOLDER>\<SID>`: the library is machine-wide with no
 * per-user domain (unlike `launchctl … gui/<uid>` / `systemctl --user`), so
 * the user's SID keys the leaf to keep two users on one machine apart.
 * @ref LLP 0584#naming [implements]: the task is keyed per-user by SID
 */
export const WIN32_TASK_FOLDER = 'hypaware'

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
  if (platform === 'win32') return `Scheduled Task: \\${WIN32_TASK_FOLDER}`
  return `daemon (${platform})`
}

/**
 * Whether the daemon service family (`hyp daemon install / uninstall / start /
 * stop / restart / status`) is supported on `platform`. win32 joined macOS and
 * Linux once the Scheduled Task backend landed (LLP 0584): the gate LLP 0300
 * named as "falling only with a Windows service installer".
 *
 * This is deliberately wider than {@link setupPlatformIsSupported}: the service
 * family opens on win32 now, while the full `hyp setup` wizard stays gated for
 * a focused follow-up (LLP 0584 #gate).
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 * @ref LLP 0584#task [implements]: the per-user Scheduled Task backend lets this gate include win32
 */
export function platformIsSupported(platform = process.platform) {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
}

/**
 * Whether the guided `hyp setup` onboarding wizard runs on `platform`. Still
 * macOS/Linux only: LLP 0584 opened the daemon service family on win32 but
 * deliberately left the wizard — first-look, the attach cascade, skills,
 * backfill, the finale — gated for its own pass, since that interactive
 * surface has never run end-to-end on Windows. A Windows user onboards with
 * `hyp daemon install` and `hyp client attach <x>` until that follow-up.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 * @ref LLP 0584#gate [implements]: the installer opens; the setup wizard does not, yet
 */
export function setupPlatformIsSupported(platform = process.platform) {
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
 * would finish, so the note names the missing service instead of a command
 * that cannot help (#978). It stops there: `hyp daemon run --foreground`
 * still captures on such a platform, so claiming nothing can be captured
 * would be an absolute the CLI itself disproves (#1381).
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
    : `note: ${lead}${platform} has no background service to install\n`
}

/**
 * What setup prints when it refuses a platform with no service manager, or
 * `undefined` when the platform is supported (#975). Here for the same reason
 * as `daemonIncompleteNote`: dispatch refuses every CLI setup form and the
 * wizard refuses a direct `runInitWizard` call, and this leaf is reachable
 * from both without an import cycle.
 *
 * @param {NodeJS.Platform} platform
 * @returns {string | undefined}
 */
export function setupUnsupportedNote(platform) {
  if (setupPlatformIsSupported(platform)) return undefined
  return `hyp setup: unsupported platform: ${platform} (only macOS and Linux are supported)\n`
    + '  nothing was changed: no sign-in, enrollment or config write happened\n'
}
