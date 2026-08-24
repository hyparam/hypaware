// @ts-check

import os from 'node:os'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { ensureAiGatewayStorageContracts } from '../../ai-gateway/src/storage_contracts.js'
import { runSessionIgnore, runSessionStatus, runSessionUnignore } from '../../ai-gateway/src/session_command.js'
import { attachOpenCodePlugin } from './attach.js'
import { createOpenCodeBackfillProvider } from './backfill.js'
import { OPENCODE_CONFIG_SECTION, opencodeListenPort, validateOpenCodeConfig } from './config.js'
import { createStartOpenCodeSource } from './listener.js'

/** @import { ClientAttachContext, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */

const PLUGIN_NAME = '@hypaware/opencode'
const CLIENT_NAME = 'opencode'

export const configSection = { section: OPENCODE_CONFIG_SECTION, validate: validateOpenCodeConfig }

/**
 * @param {PluginActivationContext} ctx
 * @ref LLP 0306#decision [implements]: one endpoint-free adapter owns CLI and
 *   Desktop plugin capture plus bounded export recovery
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: OPENCODE_CONFIG_SECTION,
    validate: validateOpenCodeConfig,
  })

  ensureAiGatewayStorageContracts(ctx)
  const localPolicyPath = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  const ignoredSessions = new Set()
  ctx.backfills.register(createOpenCodeBackfillProvider({
    localOnlyListPath: localPolicyPath,
    ignoredSessions,
  }))

  ctx.sources.register({
    name: CLIENT_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Loopback OpenCode SDK snapshot listener for CLI and Desktop',
    configSection: OPENCODE_CONFIG_SECTION,
    start: createStartOpenCodeSource({ localOnlyListPath: localPolicyPath, ignoredSessions }),
  })

  registerSessionCommands(ctx)

  // @ref LLP 0306#endpoint-free-clients [implements]: install a local plugin
  //   file through the intrinsic registry, with no gateway endpoint
  ctx.clients.registerClient({
    name: CLIENT_NAME,
    requiresEndpoint: false,
    /** @param {ClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const endpoint = `http://127.0.0.1:${opencodeListenPort(ctx.config)}`
      await withSpan(
        'client.attach',
        {
          [Attr.PLUGIN]: PLUGIN_NAME,
          [Attr.OPERATION]: 'client.attach',
          client_name: CLIENT_NAME,
          hyp_client: CLIENT_NAME,
          dry_run: attachCtx.dryRun === true,
        },
        async (span) => {
          const result = await attachOpenCodePlugin({
            endpoint,
            version: ctx.plugin.version,
            env: ctx.env,
            homeDir: ctx.env.HOME ?? os.homedir(),
            dryRun: attachCtx.dryRun === true,
          })
          span.setAttribute('status', 'ok')
          span.setAttribute('changed', result.changed)
          ctx.log.info('opencode.attach.write', {
            [Attr.OPERATION]: 'client.attach',
            settings_path: result.settingsPath,
            changed: result.changed,
            dry_run: attachCtx.dryRun === true,
          })
          const payload = {
            status: 'ok',
            action: 'attach',
            client: CLIENT_NAME,
            dry_run: attachCtx.dryRun === true,
            settings_path: result.settingsPath,
            changed: result.changed,
            endpoint,
          }
          if (attachCtx.json) attachCtx.stdout.write(JSON.stringify(payload) + '\n')
          else attachCtx.stdout.write(
            `${result.changed ? 'Installed' : 'OpenCode plugin already current at'} ${result.settingsPath}. ` +
            'Restart OpenCode to load it.\n'
          )
        },
        { component: 'plugin.opencode' }
      )
    },
  })
}

/** @param {PluginActivationContext} ctx */
function registerSessionCommands(ctx) {
  if (ctx.commands.get('session ignore')) return
  for (const command of [
    {
      name: 'session ignore',
      summary: 'Stop recording this AI session on every local recorder (in-memory, until the daemon restarts)',
      usage: 'hyp session ignore [session-id] [--json]',
      run: runSessionIgnore,
    },
    {
      name: 'session unignore',
      summary: 'Resume recording this AI session',
      usage: 'hyp session unignore [session-id] [--json]',
      run: runSessionUnignore,
    },
    {
      name: 'session status',
      summary: 'Report whether this AI session is being dropped right now (fails closed)',
      usage: 'hyp session status [session-id] [--json]',
      run: runSessionStatus,
    },
  ]) {
    ctx.commands.register({
      ...command,
      plugin: PLUGIN_NAME,
      category: 'capture-movement',
      audience: 'everyday',
    })
  }
}
