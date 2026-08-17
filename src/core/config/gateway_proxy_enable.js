// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { resolveConfigPath, resolveLayeredConfigFromDisk } from '../runtime/boot.js'
import { loadConfigFile, prepareLocalConfigWrite } from './schema.js'
import { defaultStateRoot, waitForLocalCa } from '../tls/ca.js'

/**
 * @import { CommandRunContext, HypAwareV2Config, PluginConfigInstance, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 * @import { GatewayProxyEnableResult, PluginMetadata } from '../../../src/core/config/types.js'
 * @import { DaemonServiceOptions } from '../../../src/core/daemon/types.js'
 */

const GATEWAY_PLUGIN = '@hypaware/ai-gateway'

/** How long to wait for the restarted gateway to mint the local CA. */
const CA_WAIT_DEFAULT_MS = 15_000

/**
 * The proxy-mode half of the LLP 0244 migration: turn a consented "yes" into
 * `proxy_mode: true` on the local gateway entry, bring the daemon back on the
 * new config, and wait until the gateway has minted the local CA, because the
 * attach that follows preflights on the CA's existence (LLP 0232) and would
 * otherwise silently land back on base-URL mode.
 *
 * Shares `enableClientAdapter`'s properties (LLP 0174): the caller owns
 * consent, the write is guarded (LLP 0031 backup) and never a rewrite, and
 * every step reports its own outcome so a write that landed before a failed
 * restart persists visibly.
 *
 * The write differs from adapter enablement in one way: it sets a key on the
 * existing local gateway entry instead of appending a missing plugin. When no
 * local entry exists the function refuses rather than inventing one:
 * a centrally-managed gateway is the fleet's to switch (a local copy would be
 * dropped as a collision by the LLP 0031 merge), and a config with no gateway
 * in any layer has a bigger problem than proxy mode.
 * @ref LLP 0244#enable-write [implements]: the consented switch reuses the enable steps with one new write shape, then waits for the CA
 *
 * @param {{
 *   ctx: CommandRunContext,
 *   knownPlugins?: Map<PluginName, PluginMetadata>,
 *   knownDatasets?: Set<string>,
 *   timeoutMs?: number,
 *   caTimeoutMs?: number,
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
 *   waitForCaFn?: (args: {
 *     stateRoot: string,
 *     timeoutMs?: number,
 *     sleep?: (ms: number) => Promise<void>,
 *     now?: () => number,
 *   }) => Promise<{ ready: boolean, certPath?: string }>,
 * }} args
 * @returns {Promise<GatewayProxyEnableResult>}
 */
export async function enableGatewayProxyMode({
  ctx,
  knownPlugins,
  knownDatasets,
  timeoutMs,
  caTimeoutMs,
  sleep,
  now,
  daemonStatus,
  restartDaemon,
  waitForBind,
  waitForCaFn,
}) {
  const log = getLogger('config')
  const obsEnv = readObservabilityEnv(ctx.env)
  const configPath = resolveConfigPath({ env: ctx.env, hypHome: obsEnv.hypHome })
  const homeDir = ctx.env.HOME ?? os.homedir()

  return withSpan(
    'config.gateway_proxy_enable',
    {
      [Attr.COMPONENT]: 'config',
      [Attr.OPERATION]: 'config.gateway_proxy_enable',
      config_path: configPath,
    },
    async (span) => {
      /** @type {GatewayProxyEnableResult} */
      const result = {
        ok: false,
        outcome: 'failed',
        configPath,
        daemonInstalled: false,
        bound: false,
        caReady: false,
        steps: { write: 'n/a', restart: 'n/a', wait: 'n/a', ca: 'n/a' },
      }

      // ---- Step 0: where does the gateway entry live? -----------------------

      const loaded = await loadConfigFile(configPath)
      if (!loaded.ok && loaded.errorKind !== 'config_missing') {
        return fail(result, span, log, 'write', 'config_write_failed', loaded.message)
      }
      /** @type {HypAwareV2Config} */
      const base = loaded.ok ? loaded.config : { version: 2, plugins: [] }

      /** @type {PluginConfigInstance | undefined} */
      let effectiveGateway
      /** @type {PluginConfigInstance | undefined} */
      let centralGateway
      try {
        const layered = await resolveLayeredConfigFromDisk({
          stateRoot: obsEnv.stateDir,
          configPath,
          ...(knownPlugins ? { knownPlugins } : {}),
          ...(knownDatasets ? { knownDatasets } : {}),
        })
        effectiveGateway = (layered.effective?.plugins ?? []).find(
          (entry) => entry.name === GATEWAY_PLUGIN
        )
        centralGateway = (layered.centralConfig?.plugins ?? []).find(
          (entry) => entry.name === GATEWAY_PLUGIN
        )
      } catch {
        // A layer that will not resolve proves nothing; the local file below
        // still decides what this function may write.
      }

      if (effectiveGateway?.config?.proxy_mode === true) {
        result.ok = true
        result.outcome = 'already'
        span.setAttribute('outcome', 'already')
        span.setAttribute('status', 'ok')
        return result
      }

      // Central ownership is decided by the central layer NAMING the plugin,
      // not by the local file lacking it: on a fleet host both layers can
      // carry a gateway entry, and the LLP 0031 merge drops the local one as
      // a collision. Writing proxy_mode into an entry the merge discards
      // produces a daemon that restarts without proxy mode and a CA wait
      // that can only time out (found live, 2026-08-17).
      // @ref LLP 0244#central-managed [implements]: the local CLI never fights the central layer over the gateway block
      const localGateway = (base.plugins ?? []).find((entry) => entry.name === GATEWAY_PLUGIN)
      if (centralGateway || !localGateway) {
        const outcome = centralGateway ? 'central_managed' : 'no_gateway'
        result.outcome = outcome
        result.message = centralGateway
          ? 'the gateway config is owned by the central (fleet) layer, which outranks any local edit; enable proxy_mode in the fleet config instead'
          : `no ${GATEWAY_PLUGIN} entry in any config layer`
        span.setAttribute('outcome', outcome)
        span.setAttribute('status', 'ok')
        return result
      }

      // ---- Step 1: the guarded local write ----------------------------------

      const nextPlugins = (base.plugins ?? []).map((entry) =>
        entry === localGateway
          ? { ...entry, config: { ...(entry.config ?? {}), proxy_mode: true } }
          : entry
      )
      const nextConfig = { ...base, plugins: nextPlugins }

      try {
        const guard = await prepareLocalConfigWrite({
          targetPath: configPath,
          force: true,
          ...(now ? { now } : {}),
        })
        if (!guard.proceed) {
          return fail(result, span, log, 'write', 'config_write_failed', guard.message ?? 'config write refused')
        }
        if (guard.backupPath) result.backupPath = guard.backupPath
        await fs.mkdir(path.dirname(configPath), { recursive: true })
        await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8')
      } catch (err) {
        return fail(result, span, log, 'write', 'config_write_failed', describeError(err))
      }

      result.steps.write = 'ok'
      result.outcome = 'enabled'
      log.info('config.gateway_proxy_enable.write', {
        [Attr.COMPONENT]: 'config',
        config_path: configPath,
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
        svc = { installed: false }
      }
      result.daemonInstalled = svc.installed

      if (!svc.installed) {
        // The write is the whole job here; the daemon ladder in attach names
        // what to run next, same as adapter enablement (LLP 0174
        // #bootstrap-floor).
        result.ok = true
        span.setAttribute('daemon_installed', false)
        span.setAttribute('outcome', 'enabled')
        span.setAttribute('status', 'ok')
        return result
      }

      const restartFn = restartDaemon ?? (await import('../daemon/install.js')).restartServiceDaemon
      try {
        await restartFn({ homeDir })
      } catch (err) {
        return fail(result, span, log, 'restart', 'daemon_restart_failed', describeError(err))
      }
      result.steps.restart = 'ok'

      const waitFn = waitForBind ?? (await import('../cli/remote_commands.js')).waitForGatewayBind
      const bind = await waitFn({
        env: ctx.env,
        homeDir,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(sleep ? { sleep } : {}),
      })
      result.bound = bind.bound
      if (!bind.bound) {
        return fail(
          result, span, log, 'wait', 'gateway_bind_timeout',
          'the daemon restarted but its gateway did not publish a bound port in time'
        )
      }
      if (bind.endpoint) result.endpoint = bind.endpoint
      result.steps.wait = 'ok'

      // ---- Step 3: wait for the CA ------------------------------------------

      // Attach preflights on the CA file, not on config (LLP 0232), so
      // returning before the gateway has minted it would hand the caller a
      // proxy-mode daemon and a base-URL attach.
      const waitCa = waitForCaFn ?? waitForLocalCa
      const caWait = await waitCa({
        stateRoot: defaultStateRoot(ctx.env),
        timeoutMs: caTimeoutMs ?? CA_WAIT_DEFAULT_MS,
        ...(sleep ? { sleep } : {}),
        ...(now ? { now } : {}),
      })
      result.caReady = caWait.ready
      if (caWait.certPath) result.caCertPath = caWait.certPath
      if (!result.caReady) {
        return fail(
          result, span, log, 'ca', 'ca_wait_timeout',
          'the gateway restarted with proxy_mode on but did not mint the local CA in time'
        )
      }
      result.steps.ca = 'ok'
      result.ok = true
      span.setAttribute('outcome', 'enabled')
      span.setAttribute('status', 'ok')
      log.info('config.gateway_proxy_enable.ready', {
        [Attr.COMPONENT]: 'config',
        config_path: configPath,
        ca_cert_path: result.caCertPath ?? '',
        status: 'ok',
      })
      return result
    },
    { component: 'config' },
  )
}

/**
 * @param {GatewayProxyEnableResult} result
 * @param {{ setAttribute(key: string, value: string | number | boolean): unknown }} span
 * @param {{ error(event: string, attrs: Record<string, unknown>): unknown }} log
 * @param {'write' | 'restart' | 'wait' | 'ca'} step
 * @param {string} errorKind
 * @param {string} message
 * @returns {GatewayProxyEnableResult}
 */
function fail(result, span, log, step, errorKind, message) {
  result.steps[step] = 'failed'
  result.failedStep = step
  result.message = message
  span.setAttribute('error_kind', errorKind)
  span.setAttribute('status', 'failed')
  log.error(`config.gateway_proxy_enable.${step}_failed`, {
    [Attr.COMPONENT]: 'config',
    [Attr.ERROR_KIND]: errorKind,
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
