// @ts-check

import process from 'node:process'

import { Attr, getLogger, withSpan } from '../observability/index.js'

import {
  LAUNCH_LABEL,
  SYSTEMD_UNIT_BASE,
  daemonKindLabel,
  defaultConfigPath,
  defaultLogDir,
  platformIsSupported,
} from './platform.js'
import * as macos from './macos.js'
import * as linux from './linux.js'

/**
 * Resolve the default service label for `platform`. macOS uses the
 * reverse-DNS LaunchAgent label; Linux uses the short systemd unit
 * basename. Other platforms reuse the macOS label as a sensible
 * fallback (callers should already have refused unsupported platforms
 * by this point).
 *
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function defaultLabelFor(platform) {
  return platform === 'linux' ? SYSTEMD_UNIT_BASE : LAUNCH_LABEL
}

/**
 * @typedef {import('./macos.js').LaunchAgentInstallPlan} LaunchAgentInstallPlan
 * @typedef {import('./linux.js').SystemdInstallPlan} SystemdInstallPlan
 * @typedef {LaunchAgentInstallPlan | SystemdInstallPlan} DaemonInstallPlan
 */

/**
 * @typedef {Object} DaemonInstallOptions
 * @property {string} binPath              Absolute path to the HypAware CLI entrypoint.
 * @property {string} [configPath]         Config path passed to the daemon (defaults to ~/.hyp/hypaware-config.json).
 * @property {string} [label]              Override the launch label (defaults to com.hyperparam.hypaware).
 * @property {string} [logDir]             Override stdout/stderr log dir (defaults to ~/.hyp/hypaware/logs).
 * @property {string} [nodePath]           Override the node binary used as ProgramArguments[0] (defaults to process.execPath).
 * @property {string} [homeDir]            Override $HOME for resolving default dirs (used in tests).
 * @property {NodeJS.Platform} [platform]  Force platform selection for dry-runs / tests.
 * @property {Record<string,string>} [env] Extra environment variables for the launched daemon.
 * @property {boolean} [keepAlive]         macOS: KeepAlive (default true).
 * @property {boolean} [runAtLoad]         macOS: RunAtLoad (default true).
 * @property {boolean} [restart]           Linux: Restart=always vs Restart=no (default true).
 * @property {number}  [restartSec]        Linux: RestartSec= seconds (default 5).
 * @property {boolean} [foreground]        Pass `--foreground` to the daemon (default true).
 * @property {string} [plistDir]           macOS: override LaunchAgents dir.
 * @property {string} [unitDir]            Linux: override systemd --user unit dir.
 * @property {string} [description]        Linux: override [Unit] Description value.
 * @property {import('./macos.js').LaunchctlAdapter} [launchctl]
 * @property {import('./linux.js').SystemctlAdapter} [systemctl]
 * @property {string} [userDomain]         macOS: override the launchctl user domain (e.g. gui/501).
 */

/**
 * @typedef {Object} DaemonUninstallOptions
 * @property {string} [label]
 * @property {string} [homeDir]
 * @property {string} [plistDir]
 * @property {string} [unitDir]
 * @property {NodeJS.Platform} [platform]
 * @property {import('./macos.js').LaunchctlAdapter} [launchctl]
 * @property {import('./linux.js').SystemctlAdapter} [systemctl]
 * @property {string} [userDomain]
 */

/**
 * @typedef {Object} DaemonServiceOptions
 * @property {string} [label]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [homeDir]
 * @property {string} [plistDir]
 * @property {string} [unitDir]
 * @property {import('./macos.js').LaunchctlAdapter} [launchctl]
 * @property {import('./linux.js').SystemctlAdapter} [systemctl]
 * @property {string} [userDomain]
 */

export class DaemonInstallError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'DaemonInstallError'
  }
}

/**
 * Build the install plan for the target platform without writing
 * anything. Returns the rendered service-file content plus target
 * path and planned management commands. Used by `--dry-run` and the
 * `daemon_install_render` smoke.
 *
 * @param {DaemonInstallOptions} options
 * @returns {DaemonInstallPlan}
 */
export function planDaemonInstall(options) {
  const platform = options.platform ?? process.platform
  if (!platformIsSupported(platform)) {
    throw new DaemonInstallError(
      `unsupported platform: ${platform} (only darwin and linux are supported)`
    )
  }
  const configPath = options.configPath ?? defaultConfigPath(options.homeDir)
  const logDir = options.logDir ?? defaultLogDir(options.homeDir)
  /** @type {DaemonInstallOptions} */
  const merged = { ...options, configPath, logDir }
  if (platform === 'darwin') return macos.planLaunchAgentInstall(merged)
  return linux.planSystemdInstall(merged)
}

/**
 * Render the install plan as the JSON-serializable payload emitted by
 * `hyp daemon install --dry-run --json`.
 *
 * @param {DaemonInstallOptions} options
 */
export function renderDaemonInstall(options) {
  const plan = planDaemonInstall(options)
  /** @type {{ unitName?: string, plistDir?: string, unitDir?: string }} */
  const platformExtras = {}
  if (plan.platform === 'linux') {
    platformExtras.unitName = plan.unitName
    platformExtras.unitDir = plan.unitDir
  } else {
    platformExtras.plistDir = plan.plistDir
  }
  return {
    platform: plan.platform,
    label: plan.label,
    targetPath: plan.targetPath,
    binPath: plan.binPath,
    configPath: plan.configPath,
    logDir: plan.logDir,
    nodePath: plan.nodePath,
    content: plan.content,
    manageCommands: plan.manageCommands,
    serviceKind: daemonKindLabel(plan.platform),
    ...platformExtras,
  }
}

/**
 * Install the platform-appropriate persistent service. Wraps the
 * platform-specific call in a `daemon.install` span and emits a
 * structured `daemon.install` log including platform, target path,
 * service label, and exit status.
 *
 * @param {DaemonInstallOptions} options
 * @returns {Promise<DaemonInstallPlan>}
 */
export async function installDaemon(options) {
  const platform = options.platform ?? process.platform
  if (!platformIsSupported(platform)) {
    throw new DaemonInstallError(
      `unsupported platform: ${platform} (only darwin and linux are supported)`
    )
  }
  const configPath = options.configPath ?? defaultConfigPath(options.homeDir)
  const logDir = options.logDir ?? defaultLogDir(options.homeDir)
  /** @type {DaemonInstallOptions} */
  const merged = { ...options, configPath, logDir }
  const log = getLogger('daemon')
  return withSpan(
    'daemon.install',
    {
      [Attr.COMPONENT]: 'daemon',
      [Attr.OPERATION]: 'daemon.install',
      hyp_platform: platform,
      service_label: merged.label ?? defaultLabelFor(platform),
      status: 'ok',
    },
    async function() {
      try {
        const plan = platform === 'darwin'
          ? await macos.installLaunchAgent(merged)
          : await linux.installSystemdUnit(merged)
        log.info('daemon.install', {
          hyp_platform: platform,
          service_label: plan.label,
          target_path: plan.targetPath,
          exit_status: 'ok',
        })
        return plan
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('daemon.install_failed', {
          hyp_platform: platform,
          service_label: merged.label ?? defaultLabelFor(platform),
          message,
          exit_status: 'failed',
        })
        throw err
      }
    },
    { component: 'daemon' },
  )
}

/**
 * Uninstall the platform-appropriate service. Leaves config,
 * recordings, exports, and client settings untouched.
 *
 * @param {DaemonUninstallOptions} options
 * @returns {Promise<void>}
 */
export async function uninstallDaemon(options) {
  const platform = options.platform ?? process.platform
  if (!platformIsSupported(platform)) {
    throw new DaemonInstallError(
      `unsupported platform: ${platform} (only darwin and linux are supported)`
    )
  }
  const log = getLogger('daemon')
  const label = options.label ?? defaultLabelFor(platform)
  await withSpan(
    'daemon.uninstall',
    {
      [Attr.COMPONENT]: 'daemon',
      [Attr.OPERATION]: 'daemon.uninstall',
      hyp_platform: platform,
      service_label: label,
      status: 'ok',
    },
    async function() {
      try {
        if (platform === 'darwin') {
          await macos.uninstallLaunchAgent(options)
        } else {
          await linux.uninstallSystemdUnit(options)
        }
        log.info('daemon.uninstall', {
          hyp_platform: platform,
          service_label: label,
          exit_status: 'ok',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('daemon.uninstall_failed', {
          hyp_platform: platform,
          service_label: label,
          message,
          exit_status: 'failed',
        })
        throw err
      }
    },
    { component: 'daemon' },
  )
}

/**
 * Start (or kickstart) the installed service.
 *
 * @param {DaemonServiceOptions} options
 * @returns {Promise<void>}
 */
export async function startServiceDaemon(options) {
  const platform = options.platform ?? process.platform
  if (!platformIsSupported(platform)) {
    throw new DaemonInstallError(`unsupported platform: ${platform}`)
  }
  const log = getLogger('daemon')
  const label = options.label ?? defaultLabelFor(platform)
  await withSpan(
    'daemon.start',
    {
      [Attr.COMPONENT]: 'daemon',
      [Attr.OPERATION]: 'daemon.start',
      hyp_platform: platform,
      service_label: label,
      status: 'ok',
    },
    async function() {
      try {
        if (platform === 'darwin') {
          await macos.startLaunchAgent(options)
        } else {
          await linux.startSystemdUnit(options)
        }
        log.info('daemon.start', {
          hyp_platform: platform,
          service_label: label,
          exit_status: 'ok',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('daemon.start_failed', {
          hyp_platform: platform,
          service_label: label,
          message,
          exit_status: 'failed',
        })
        throw err
      }
    },
    { component: 'daemon' },
  )
}

/**
 * Stop the installed service.
 *
 * @param {DaemonServiceOptions} options
 * @returns {Promise<void>}
 */
export async function stopServiceDaemon(options) {
  const platform = options.platform ?? process.platform
  if (!platformIsSupported(platform)) {
    throw new DaemonInstallError(`unsupported platform: ${platform}`)
  }
  const log = getLogger('daemon')
  const label = options.label ?? defaultLabelFor(platform)
  await withSpan(
    'daemon.stop',
    {
      [Attr.COMPONENT]: 'daemon',
      [Attr.OPERATION]: 'daemon.stop',
      hyp_platform: platform,
      service_label: label,
      status: 'ok',
    },
    async function() {
      try {
        if (platform === 'darwin') {
          await macos.stopLaunchAgent(options)
        } else {
          await linux.stopSystemdUnit(options)
        }
        log.info('daemon.stop', {
          hyp_platform: platform,
          service_label: label,
          exit_status: 'ok',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('daemon.stop_failed', {
          hyp_platform: platform,
          service_label: label,
          message,
          exit_status: 'failed',
        })
        throw err
      }
    },
    { component: 'daemon' },
  )
}

/**
 * Restart the installed service.
 *
 * @param {DaemonServiceOptions} options
 * @returns {Promise<void>}
 */
export async function restartServiceDaemon(options) {
  const platform = options.platform ?? process.platform
  if (!platformIsSupported(platform)) {
    throw new DaemonInstallError(`unsupported platform: ${platform}`)
  }
  if (platform === 'darwin') {
    await macos.restartLaunchAgent(options)
    return
  }
  await linux.restartSystemdUnit(options)
}

/**
 * Query installed + runtime status of the service. Emits a
 * `daemon.status` span (the runtime daemon also emits a per-process
 * `daemon.run` span; this one tracks the installer-facing query).
 *
 * @param {DaemonServiceOptions} options
 * @returns {Promise<{ installed: boolean, loaded: boolean, pid?: number, platform: NodeJS.Platform }>}
 */
export async function serviceDaemonStatus(options) {
  const platform = options.platform ?? process.platform
  if (!platformIsSupported(platform)) {
    return { installed: false, loaded: false, platform }
  }
  const log = getLogger('daemon')
  const label = options.label ?? defaultLabelFor(platform)
  return withSpan(
    'daemon.status',
    {
      [Attr.COMPONENT]: 'daemon',
      [Attr.OPERATION]: 'daemon.status',
      hyp_platform: platform,
      service_label: label,
      status: 'ok',
    },
    async function() {
      /** @type {boolean} */
      let installed
      /** @type {{ loaded: boolean, pid?: number }} */
      let runtime
      if (platform === 'darwin') {
        installed = macos.isLaunchAgentInstalled(options)
        runtime = await macos.launchAgentStatus(options)
      } else {
        installed = linux.isSystemdUnitInstalled(options)
        runtime = await linux.systemdUnitStatus(options)
      }
      log.info('daemon.status', {
        hyp_platform: platform,
        service_label: label,
        installed,
        loaded: runtime.loaded,
        exit_status: 'ok',
      })
      return { installed, loaded: runtime.loaded, pid: runtime.pid, platform }
    },
    { component: 'daemon' },
  )
}

export { LAUNCH_LABEL, daemonKindLabel, defaultConfigPath, defaultLogDir, platformIsSupported }
export { macos, linux }
