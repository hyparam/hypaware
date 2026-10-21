// @ts-check

import os from 'node:os'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { ensureAiGatewayStorageContracts } from '../../ai-gateway/src/storage_contracts.js'
import { runSessionIgnore, runSessionStatus, runSessionUnignore } from '../../ai-gateway/src/session_command.js'
import { registerNeutralSkills } from '../../../skills/index.js'
import { attachDroidHooks } from './attach.js'
import { createDroidBackfillProvider } from './backfill.js'
import { DROID_CONFIG_SECTION, droidListenPort, validateDroidConfig } from './config.js'
import { createStartDroidSource } from './listener.js'

/** @import { ClientAttachContext, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */

const PLUGIN_NAME = '@hypaware/droid'
const CLIENT_NAME = 'droid'

export const configSection = { section: DROID_CONFIG_SECTION, validate: validateDroidConfig }

/**
 * @param {PluginActivationContext} ctx
 * @ref LLP 0551#capture: hook notifications and native recovery share one projector
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: DROID_CONFIG_SECTION,
    validate: validateDroidConfig,
  })

  ensureAiGatewayStorageContracts(ctx)
  const localPolicyPath = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  const ignoredSessions = new SessionIgnoreSet(readObservabilityEnv(ctx.env).stateDir, ctx.log)
  ctx.backfills.register(createDroidBackfillProvider({
    localOnlyListPath: localPolicyPath,
    ignoredSessions,
    env: ctx.env,
    config: ctx.config,
  }))

  ctx.sources.register({
    name: CLIENT_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Loopback Droid transcript-change listener',
    configSection: DROID_CONFIG_SECTION,
    start: createStartDroidSource({ localOnlyListPath: localPolicyPath, ignoredSessions }),
  })

  registerSessionCommands(ctx)
  registerNeutralSkills(ctx, PLUGIN_NAME, CLIENT_NAME)

  // @ref LLP 0551#attachment [implements]: install native hook
  //   commands through the intrinsic registry, with no gateway endpoint
  ctx.clients.registerClient({
    name: CLIENT_NAME,
    requiresEndpoint: false,
    /** @param {ClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const endpoint = `http://127.0.0.1:${droidListenPort(ctx.config)}`
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
          const result = await attachDroidHooks({
            endpoint,
            version: ctx.plugin.version,
            env: ctx.env,
            homeDir: ctx.env.HOME ?? os.homedir(),
            dryRun: attachCtx.dryRun === true,
          })
          span.setAttribute('status', 'ok')
          span.setAttribute('changed', result.changed)
          ctx.log.info('droid.attach.write', {
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
          // A dry run reports `changed: true` for work it deliberately did not
          // do, so the human line must not claim an install or ask for a
          // restart that nothing needs.
          else if (attachCtx.dryRun === true) attachCtx.stdout.write(
            `${result.changed ? 'Would install' : 'Droid hooks already current at'} ${result.settingsPath}. ` +
            'Dry run: nothing was written.\n'
          )
          else attachCtx.stdout.write(
            `${result.changed ? 'Installed' : 'Droid hooks already current at'} ${result.settingsPath}. ` +
            'Restart Droid to load the hooks.\n'
          )
        },
        { component: 'plugin.droid' }
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
      summary: 'Stop recording this AI session on every local recorder (saved until explicitly unignored)',
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
