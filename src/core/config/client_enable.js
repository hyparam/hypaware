// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { resolveConfigPath, resolveLayeredConfigFromDisk } from '../runtime/boot.js'
import { loadConfigFile, prepareLocalConfigWrite } from './schema.js'

/**
 * @import { CommandRunContext, HypAwareV2Config, PluginConfigInstance, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ClientEnableResult, PluginMetadata } from '../../../src/core/config/types.js'
 * @import { DaemonServiceOptions } from '../../../src/core/daemon/types.js'
 */

/**
 * The enable half of the LLP 0174 attach flow: turn a consented "yes" into the
 * config entries that make the adapter activate, then bring the daemon back on
 * the new config so the gateway registry knows the client.
 *
 * Three properties define it, and each one is a refusal to invent a second
 * mechanism:
 *
 * - **Additive, never a rewrite.** The local layer is user-owned; enabling one
 *   adapter appends its entries and touches nothing else. `hyp init` is the
 *   flow that composes a whole config, and it stays the only one.
 * - **Effective-config aware.** The duplicate check runs against the *merged*
 *   layers, not the local file, so on a fleet-managed host an entry the central
 *   layer already names is never re-added locally, where LLP 0031's merge would
 *   drop it as a collision anyway.
 * - **Per-step, never all-or-nothing.** The write, the restart, and the bind
 *   wait each report their own outcome. A write that lands before a failed
 *   restart *persists*, and saying so (with the backup path) is what lets a
 *   re-run resume instead of re-asking.
 *
 * The caller owns consent and the bootstrap floor: this function never prompts,
 * and it must not be reached when no local config exists at all (that case is
 * `hyp init`'s, per LLP 0174 #bootstrap-floor).
 *
 * @param {{
 *   name: string,
 *   entries: PluginConfigInstance[],
 *   ctx: CommandRunContext,
 *   knownPlugins?: Map<PluginName, PluginMetadata>,
 *   knownDatasets?: Set<string>,
 *   timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   daemonStatus?: (options: DaemonServiceOptions) => Promise<{ installed: boolean }>,
 *   restartDaemon?: (options: DaemonServiceOptions) => Promise<void>,
 *   waitForBind?: (args: {
 *     env: NodeJS.ProcessEnv,
 *     homeDir?: string,
 *     timeoutMs?: number,
 *     sleep?: (ms: number) => Promise<void>,
 *   }) => Promise<{ bound: boolean, endpoint?: string }>,
 * }} args
 * @returns {Promise<ClientEnableResult>}
 * @ref LLP 0174#prompt [implements]: steps 1 and 2 of the accept path (guarded config write, then daemon restart + gateway-bind wait), reported per step
 */
export async function enableClientAdapter({
  name,
  entries,
  ctx,
  knownPlugins,
  knownDatasets,
  timeoutMs,
  sleep,
  now,
  daemonStatus,
  restartDaemon,
  waitForBind,
}) {
  const log = getLogger('config')
  const obsEnv = readObservabilityEnv(ctx.env)
  const configPath = resolveConfigPath({ env: ctx.env, hypHome: obsEnv.hypHome })
  const homeDir = ctx.env.HOME ?? os.homedir()

  return withSpan(
    'config.client_enable',
    {
      [Attr.COMPONENT]: 'config',
      [Attr.OPERATION]: 'config.client_enable',
      hyp_client: name,
      config_path: configPath,
      requested_plugins: entries.map((entry) => entry.name).join(','),
    },
    async (span) => {
      /** @type {ClientEnableResult} */
      const result = {
        ok: false,
        name,
        configPath,
        addedPlugins: [],
        daemonInstalled: false,
        bound: false,
        steps: { write: 'failed', restart: 'n/a', wait: 'n/a' },
        completed: 'n/a',
      }

      // ---- Step 1: the guarded, additive local write ------------------------

      const loaded = await loadConfigFile(configPath)
      if (!loaded.ok && loaded.errorKind !== 'config_missing') {
        // Only a genuinely absent file gets the empty-config floor. An
        // unreadable or malformed one must not be silently replaced by a
        // two-entry config: that would discard the user's local layer under
        // the banner of an additive edit.
        return failWrite(result, span, log, name, loaded.message)
      }
      /** @type {HypAwareV2Config} */
      const base = loaded.ok ? loaded.config : { version: 2, plugins: [] }

      /** @type {Set<string>} */
      let present
      try {
        const layered = await resolveLayeredConfigFromDisk({
          stateRoot: obsEnv.stateDir,
          configPath,
          ...(knownPlugins ? { knownPlugins } : {}),
          ...(knownDatasets ? { knownDatasets } : {}),
        })
        present = new Set([
          ...(layered.effective?.plugins ?? []).map((entry) => entry.name),
          // The local file too, not just the merge: an entry the merge dropped
          // is still physically in the file, and appending a second copy of it
          // would turn a dropped entry into a duplicate-plugin config error.
          ...(base.plugins ?? []).map((entry) => entry.name),
        ])
      } catch {
        // A layer that will not resolve cannot prove anything is already
        // enabled, but the local file we are about to rewrite still can.
        present = new Set((base.plugins ?? []).map((entry) => entry.name))
      }

      const toAppend = entries.filter((entry) => !present.has(entry.name))
      const nextConfig = { ...base, plugins: [...(base.plugins ?? []), ...toAppend] }

      // LLP 0031's backup-before-replace guard, with `force` because this is a
      // program-driven additive edit already sitting behind its own consent
      // prompt - not `init`'s whole-config overwrite, which is what the
      // interactive confirm exists to protect against.
      // @ref LLP 0031#local-layer-writers [implements]: the enable write reuses init's guard rather than adding a second local-layer writer
      try {
        const guard = await prepareLocalConfigWrite({
          targetPath: configPath,
          force: true,
          ...(now ? { now } : {}),
        })
        if (!guard.proceed) {
          return failWrite(result, span, log, name, guard.message ?? 'config write refused')
        }
        if (guard.backupPath) result.backupPath = guard.backupPath
        await fs.mkdir(path.dirname(configPath), { recursive: true })
        await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8')
      } catch (err) {
        return failWrite(result, span, log, name, describeError(err))
      }

      result.steps.write = 'ok'
      result.completed = 'write'
      result.addedPlugins = toAppend.map((entry) => /** @type {PluginName} */ (entry.name))
      log.info('config.client_enable.write', {
        [Attr.COMPONENT]: 'config',
        hyp_client: name,
        config_path: configPath,
        added_plugins: result.addedPlugins.join(','),
        ...(result.backupPath ? { backup_path: result.backupPath } : {}),
        status: 'ok',
      })

      // ---- Step 2: restart the daemon and wait for the gateway to bind ------

      const statusFn = daemonStatus ?? (await import('../daemon/install.js')).serviceDaemonStatus
      /** @type {{ installed: boolean }} */
      let svc
      try {
        svc = await statusFn({ homeDir })
      } catch {
        // `serviceDaemonStatus` already degrades a missing service manager to
        // "not installed"; a throw past that is still not evidence of an
        // installed daemon, so treat it as the not-installed case rather than
        // failing an enable whose write already landed.
        svc = { installed: false }
      }
      result.daemonInstalled = svc.installed

      if (!svc.installed) {
        // Nothing to restart and nothing that will bind: the write is the whole
        // job here, and attach's own endpoint-resolution ladder is what names
        // `hyp daemon install` / `hyp daemon start` next (LLP 0174
        // #bootstrap-floor). Enabling gains no daemon orchestration of its own.
        result.ok = true
        result.completed = 'n/a'
        span.setAttribute('daemon_installed', false)
        span.setAttribute('status', 'ok')
        log.info('config.client_enable.no_daemon', {
          [Attr.COMPONENT]: 'config',
          hyp_client: name,
          status: 'ok',
        })
        return result
      }

      const restartFn = restartDaemon ?? (await import('../daemon/install.js')).restartServiceDaemon
      try {
        await restartFn({ homeDir })
      } catch (err) {
        result.steps.restart = 'failed'
        result.failedStep = 'restart'
        result.message = describeError(err)
        span.setAttribute('error_kind', 'daemon_restart_failed')
        span.setAttribute('status', 'failed')
        log.error('config.client_enable.restart_failed', {
          [Attr.COMPONENT]: 'config',
          hyp_client: name,
          [Attr.ERROR_KIND]: 'daemon_restart_failed',
          message: result.message,
        })
        return result
      }
      result.steps.restart = 'ok'
      result.completed = 'restart'

      const waitFn = waitForBind ?? (await import('../cli/remote_commands.js')).waitForGatewayBind
      const bind = await waitFn({
        env: ctx.env,
        homeDir,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(sleep ? { sleep } : {}),
      })
      result.bound = bind.bound
      if (!bind.bound) {
        result.steps.wait = 'failed'
        result.failedStep = 'wait'
        result.message = 'the daemon restarted but its gateway did not publish a bound port in time'
        span.setAttribute('error_kind', 'gateway_bind_timeout')
        span.setAttribute('status', 'failed')
        log.warn('config.client_enable.bind_timeout', {
          [Attr.COMPONENT]: 'config',
          hyp_client: name,
          [Attr.ERROR_KIND]: 'gateway_bind_timeout',
        })
        return result
      }
      if (bind.endpoint) result.endpoint = bind.endpoint
      result.steps.wait = 'ok'
      result.completed = 'wait'
      result.ok = true
      span.setAttribute('status', 'ok')
      log.info('config.client_enable.bound', {
        [Attr.COMPONENT]: 'config',
        hyp_client: name,
        status: 'ok',
      })
      return result
    },
    { component: 'config' },
  )
}

/**
 * Shape the "the write itself failed" verdict: nothing else was attempted, so
 * the caller can say plainly that nothing changed.
 *
 * @param {ClientEnableResult} result
 * @param {{ setAttribute(key: string, value: string | number | boolean): unknown }} span
 * @param {{ error(event: string, attrs: Record<string, unknown>): unknown }} log
 * @param {string} name
 * @param {string} message
 * @returns {ClientEnableResult}
 */
function failWrite(result, span, log, name, message) {
  result.steps.write = 'failed'
  result.failedStep = 'write'
  result.message = message
  span.setAttribute('error_kind', 'config_write_failed')
  span.setAttribute('status', 'failed')
  log.error('config.client_enable.write_failed', {
    [Attr.COMPONENT]: 'config',
    hyp_client: name,
    [Attr.ERROR_KIND]: 'config_write_failed',
    message,
  })
  return result
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}
