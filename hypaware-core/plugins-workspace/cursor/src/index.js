// @ts-check

import os from 'node:os'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { ensureAiGatewayStorageContracts } from '../../ai-gateway/src/storage_contracts.js'
import { runSessionIgnore, runSessionStatus, runSessionUnignore } from '../../ai-gateway/src/session_command.js'
import { attachCursorHooks } from './attach.js'
import { cursorListenPort, validateCursorConfig } from './config.js'
import { createStartCursorSource } from './listener.js'
import { createCursorBackfillProvider } from './recovery.js'

/** @import { ClientAttachContext, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */

const PLUGIN_NAME = '@hypaware/cursor'
const CLIENT_NAME = 'cursor'
const CURSOR_CONFIG_SECTION = 'cursor'

export const configSection = { section: CURSOR_CONFIG_SECTION, validate: validateCursorConfig }

/**
 * @param {PluginActivationContext} ctx
 * @ref LLP 0399#capture: one endpoint-free adapter recovers native editor and CLI sessions
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: CURSOR_CONFIG_SECTION,
    validate: validateCursorConfig,
  })

  ensureAiGatewayStorageContracts(ctx)
  const localPolicyPath = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  const ignoredSessions = new Set()
  const activeRecoveries = new Set()
  ctx.backfills.register(createCursorBackfillProvider({ env: ctx.env, localOnlyListPath: localPolicyPath, ignoredSessions, activeRecoveries, config: ctx.config }))
  ctx.sources.register({
    name: CLIENT_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Cursor native recovery and file observations for editor and CLI',
    configSection: CURSOR_CONFIG_SECTION,
    start: createStartCursorSource({ localOnlyListPath: localPolicyPath, ignoredSessions, activeRecoveries }),
  })

  registerSessionCommands(ctx)

  // @ref LLP 0306#endpoint-free-clients [implements]: install native hooks
  //   into the shared configuration through the intrinsic registry, with no gateway endpoint
  ctx.clients.registerClient({
    name: CLIENT_NAME,
    requiresEndpoint: false,
    /** @param {ClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const endpoint = `http://127.0.0.1:${cursorListenPort(ctx.config)}`
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
          const result = await attachCursorHooks({
            endpoint,
            version: ctx.plugin.version,
            env: ctx.env,
            homeDir: ctx.env.HOME ?? os.homedir(),
            dryRun: attachCtx.dryRun === true,
          })
          span.setAttribute('status', 'ok')
          span.setAttribute('changed', result.changed)
          ctx.log.info('cursor.attach.write', {
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
            `${result.changed ? 'Would install hooks at' : 'Cursor hooks already current at'} ${result.settingsPath}. ` +
            'Dry run: nothing was written.\n'
          )
          else attachCtx.stdout.write(
            `${result.changed ? 'Installed hooks at' : 'Cursor hooks already current at'} ${result.settingsPath}. ` +
            'Cursor reloads hooks automatically. Native editor and CLI sessions supply conversation recovery; hooks retain file observations. Normalized usage remains unavailable.\n'
          )
        },
        { component: 'plugin.cursor' }
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
