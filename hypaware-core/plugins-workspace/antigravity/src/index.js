// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { SHARED_SKILLS_DIR } from '../../../skills/index.js'
import { runSessionIgnore, runSessionStatus, runSessionUnignore } from '../../ai-gateway/src/session_command.js'
import { ensureAiGatewayStorageContracts } from '../../ai-gateway/src/storage_contracts.js'
import { attachAntigravityPlugin } from './attach.js'
import { createAntigravityBackfillProvider } from './backfill.js'
import {
  DEFAULT_ANTIGRAVITY_CLI_SUBDIR,
  resolveAntigravityAppDataDir,
  validateAntigravityConfig,
} from './config.js'
import { startAntigravitySource } from './source.js'

/**
 * @import { ClientAttachContext, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AntigravityVariantOptions } from './types.js'
 */

const SHARED_SKILLS = ['hypaware-query', 'hypaware-reference', 'hypaware-privacy']
const SHARED_AGENT = 'hypaware-analyst'

const CLI_VARIANT = /** @type {AntigravityVariantOptions} */ ({
  pluginName: '@hypaware/antigravity',
  clientName: 'antigravity',
  configSectionName: 'antigravity',
  defaultAppDataSubdir: DEFAULT_ANTIGRAVITY_CLI_SUBDIR,
  entrypoint: 'cli',
  excludeCliSyncedSummaries: false,
})

/**
 * Shared activation helper used by `@hypaware/antigravity` (CLI) and
 * `@hypaware/antigravity-desktop` (Desktop).
 *
 * @param {PluginActivationContext} ctx
 * @param {AntigravityVariantOptions} [variant]
 */
export async function activateAntigravityVariant(ctx, variant = CLI_VARIANT) {
  ctx.permissions.require('read_home')
  ctx.permissions.require('write_home')
  ctx.permissions.require('read_state')
  ctx.permissions.require('write_state')

  ctx.configRegistry.registerSection({
    section: variant.configSectionName,
    plugin: variant.pluginName,
    validate: (raw) => validateAntigravityConfig(raw, variant.configSectionName),
  })

  ensureAiGatewayStorageContracts(ctx)

  const localPolicyPath = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  const ignoredSessions = new SessionIgnoreSet(readObservabilityEnv(ctx.env).stateDir, ctx.log)

  ctx.backfills.register(
    createAntigravityBackfillProvider({
      variant,
      config: ctx.config,
      paths: ctx.paths,
      localOnlyListPath: localPolicyPath,
      ignoredSessions,
    })
  )

  ctx.sources.register({
    name: variant.clientName,
    plugin: variant.pluginName,
    summary: `Poll ~/${variant.defaultAppDataSubdir}/conversation_summaries.db and brain transcripts, projecting changed conversations into ai_gateway_messages.`,
    configSection: variant.configSectionName,
    start: (sourceCtx) => startAntigravitySource(sourceCtx, { variant, localOnlyListPath: localPolicyPath, ignoredSessions }),
  })

  registerSessionCommands(ctx, variant.pluginName)

  const claudePluginDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../claude'
  )
  for (const name of SHARED_SKILLS) {
    ctx.skills.register({
      name,
      plugin: variant.pluginName,
      clients: [variant.clientName],
      sourceDir: path.join(SHARED_SKILLS_DIR, name),
    })
  }

  ctx.agents.register({
    name: SHARED_AGENT,
    plugin: variant.pluginName,
    clients: [variant.clientName],
    sourceFile: path.join(claudePluginDir, 'agents', `${SHARED_AGENT}.md`),
  })

  ctx.clients.registerClient({
    name: variant.clientName,
    requiresEndpoint: false,
    /** @param {ClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const result = await attachAntigravityPlugin({
        version: ctx.plugin.version,
        clientName: variant.clientName,
        env: ctx.env,
        homeDir: ctx.env.HOME ?? os.homedir(),
        dryRun: attachCtx.dryRun === true,
      })
      const payload = {
        status: 'ok',
        action: 'attach',
        client: variant.clientName,
        dry_run: attachCtx.dryRun === true,
        settings_path: result.settingsPath,
        changed: result.changed,
      }
      if (attachCtx.json) {
        attachCtx.stdout.write(JSON.stringify(payload) + '\n')
      } else if (attachCtx.dryRun === true) {
        attachCtx.stdout.write(
          `${result.changed ? 'Would install' : 'Antigravity plugin already current at'} ${result.settingsPath}. ` +
          'Dry run: nothing was written.\n'
        )
      } else if (result.changed) {
        attachCtx.stdout.write(
          `Installed ${result.settingsPath}. Restart Antigravity to load it.\n` +
          `  It adds the ${SHARED_SKILLS.join(', ')} skills and the ${SHARED_AGENT} subagent from ${path.dirname(result.settingsPath)}.\n`
        )
      } else {
        attachCtx.stdout.write(`Antigravity plugin already current at ${result.settingsPath}.\n`)
      }
      if (!attachCtx.json) {
        const appDataDir = resolveAntigravityAppDataDir({
          config: ctx.config,
          env: ctx.env,
          defaultAppDataSubdir: variant.defaultAppDataSubdir,
        })
        // The picker offers a variant only when its detect file exists; a
        // direct attach can reach here without one.
        const detectFile = variant.entrypoint === 'cli' ? 'settings.json' : 'conversation_summaries.db'
        if (!(await pathExists(path.join(appDataDir, detectFile)))) {
          const label = variant.entrypoint === 'cli' ? 'Antigravity CLI' : 'Antigravity Desktop'
          attachCtx.stdout.write(`  ${label} not found at ${appDataDir}; the plugin will load once it is installed.\n`)
        }
      }
    },
  })
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * @param {PluginActivationContext} ctx
 * @param {string} pluginName
 */
function registerSessionCommands(ctx, pluginName) {
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
      plugin: pluginName,
      category: 'capture-movement',
      audience: 'everyday',
    })
  }
}

/**
 * Activate `@hypaware/antigravity` (Antigravity CLI collector).
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  await activateAntigravityVariant(ctx, CLI_VARIANT)
}

export {
  ANTIGRAVITY_PLUGIN_MANIFEST_REL,
  ANTIGRAVITY_PLUGIN_MARKER,
  antigravityPluginManifestPath,
  attachAntigravityPlugin,
  renderAntigravityPluginManifest,
} from './attach.js'
export {
  ANTIGRAVITY_BACKFILL_TARGET,
  createAntigravityBackfillProvider,
} from './backfill.js'
export {
  DEFAULT_ANTIGRAVITY_CLI_SUBDIR,
  DEFAULT_ANTIGRAVITY_DESKTOP_SUBDIR,
  DEFAULT_POLL_INTERVAL,
  parsePollIntervalMs,
  resolveAntigravityAppDataDir,
  validateAntigravityConfig,
} from './config.js'
export { deriveRepoFromCwd, redactRemoteUserinfo } from './git_repo.js'
export {
  ANTIGRAVITY_PROVIDER,
  DEFAULT_ANTIGRAVITY_MODEL,
  extractUserRequestText,
  normalizeIsoTimestamp,
  parseTranscriptJsonl,
  projectAntigravityConversation,
  resolveCwdFromWorkspaceUris,
} from './projector.js'
export { startAntigravitySource } from './source.js'
export {
  CLI_TRAJECTORY_SOURCE,
  DEFAULT_BUSY_RETRY_ATTEMPTS,
  DEFAULT_BUSY_RETRY_DELAY_MS,
  isSqliteBusyError,
  listAntigravityConversations,
  statConversationTranscript,
  withBusyRetry,
} from './summaries_db.js'
export {
  loadWatermarkState,
  saveWatermarkState,
  watermarkFilePath,
} from './watermark.js'
