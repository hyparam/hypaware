// @ts-check

import process from 'node:process'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { ensureDurableBinForNpx, isNpxBinPath } from '../cli/global_install.js'

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
 * @import {
 *   LaunchAgentInstallPlan,
 *   SystemdInstallPlan,
 *   DaemonInstallPlan,
 *   DaemonInstallOptions,
 *   DaemonUninstallOptions,
 *   DaemonServiceOptions,
 * } from '../../../src/core/daemon/types.js'
 * @import { DurableBinResult } from '../../../src/core/cli/types.js'
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
 * Run one installer-facing operation inside a `daemon.<op>` span with
 * the uniform ok / failed structured logs.
 *
 * @template T
 * @param {string} op
 * @param {NodeJS.Platform} platform
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {(result: T) => Record<string, unknown>} [okFields]  extra fields for the success log
 * @returns {Promise<T>}
 */
function withDaemonOp(op, platform, label, fn, okFields) {
  const log = getLogger('daemon')
  return withSpan(
    `daemon.${op}`,
    {
      [Attr.COMPONENT]: 'daemon',
      [Attr.OPERATION]: `daemon.${op}`,
      hyp_platform: platform,
      service_label: label,
      status: 'ok',
    },
    async function() {
      try {
        const result = await fn()
        log.info(`daemon.${op}`, {
          hyp_platform: platform,
          service_label: label,
          ...okFields?.(result),
          exit_status: 'ok',
        })
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error(`daemon.${op}_failed`, {
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
 * The single choke point that keeps a daemon from ever being pinned to
 * an ephemeral npx bin. When `npx hypaware` installs the daemon, the
 * resolved binPath points into npm's `~/.npm/_npx/<hash>/...` cache,
 * which vanishes the moment npx exits, leaving the host recorded but
 * with no `hyp` control surface (status/policy/detach/uninstall all
 * impossible). Every non-dry-run install funnels through `installDaemon`
 * (walkthrough finale, `hyp daemon install`, and the join/enroll lane),
 * so upgrading to a durable global bin here makes "a daemon is never
 * installed against an `_npx` bin" a single invariant instead of a
 * per-call-site obligation only the walkthrough remembered to honor.
 *
 * Escape hatches survive: an explicit `--bin` sets `binExplicit`, and
 * dry-run never reaches here (it renders through `planDaemonInstall`).
 *
 * @param {DaemonInstallOptions} options
 * @returns {Promise<{ binPath: string, globalInstall: DurableBinResult }>}
 */
async function resolveDurableBinPath(options) {
  const seam = options.durableBin ?? {}
  const env = seam.env ?? process.env
  if (options.binExplicit || !isNpxBinPath(options.binPath, env)) {
    return {
      binPath: options.binPath,
      globalInstall: { binPath: options.binPath, installed: false, skipped: true },
    }
  }
  const durable = await ensureDurableBinForNpx({
    binPath: options.binPath,
    env,
    stdout: seam.stdout ?? process.stdout,
    stderr: seam.stderr ?? process.stderr,
    ...(seam.runner ? { runner: seam.runner } : {}),
  })
  return { binPath: durable.binPath, globalInstall: durable }
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
  const merged = { ...options, configPath, logDir }
  return withDaemonOp(
    'install',
    platform,
    merged.label ?? defaultLabelFor(platform),
    // @ref LLP 0025#seed-config-mode [implements]: durable-bin upgrade lives here so join/login inherit it, not just the walkthrough
    /** @returns {Promise<DaemonInstallPlan>} */
    async () => {
      const { binPath, globalInstall } = await resolveDurableBinPath(merged)
      const withBin = binPath === merged.binPath ? merged : { ...merged, binPath }
      const plan = platform === 'darwin'
        ? await macos.installLaunchAgent(withBin)
        : await linux.installSystemdUnit(withBin)
      return Object.assign(plan, { globalInstall })
    },
    (plan) => ({
      target_path: plan.targetPath,
      global_install_installed: plan.globalInstall?.installed ?? false,
      global_install_skipped: plan.globalInstall?.skipped ?? true,
    }),
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
  await withDaemonOp(
    'uninstall',
    platform,
    options.label ?? defaultLabelFor(platform),
    () => platform === 'darwin' ? macos.uninstallLaunchAgent(options) : linux.uninstallSystemdUnit(options),
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
  await withDaemonOp(
    'start',
    platform,
    options.label ?? defaultLabelFor(platform),
    () => platform === 'darwin' ? macos.startLaunchAgent(options) : linux.startSystemdUnit(options),
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
