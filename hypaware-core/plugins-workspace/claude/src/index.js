// @ts-check

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { attach, defaultSettingsPath, detach } from './settings.js'
import { createClaudeTranscriptEnricher } from './enricher.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayCapability} AiGatewayCapability */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayClientAttachContext} AiGatewayClientAttachContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayClientDetachContext} AiGatewayClientDetachContext */

const PLUGIN_NAME = '@hypaware/claude'
const CLIENT_NAME = 'claude'
const UPSTREAM_NAME = 'anthropic'

/**
 * Activate the `@hypaware/claude` adapter plugin.
 *
 * Resolves the `hypaware.ai-gateway` capability, registers the
 * Anthropic upstream preset, wires attach/detach against
 * `~/.claude/settings.json`, registers the transcript enricher,
 * and contributes the three Claude-targeted helper skills.
 *
 * Each attach/detach emits a `client.attach`/`client.detach` span
 * tagged with `hyp_plugin`, `client_name`, `status`, and
 * `restored=true|false`.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  /** @type {AiGatewayCapability} */
  const gateway = ctx.requireCapability('hypaware.ai-gateway', '^1.0.0')

  gateway.registerUpstreamPreset({
    name: UPSTREAM_NAME,
    base_url: 'https://api.anthropic.com',
    path_prefix: '/',
    provider: 'anthropic',
  })

  gateway.registerClient({
    name: CLIENT_NAME,
    defaultUpstream: UPSTREAM_NAME,
    /** @param {AiGatewayClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const homeDir = ctx.env.HOME ?? os.homedir()
      const settingsPath = defaultSettingsPath(homeDir)
      const port = endpointPort(attachCtx.endpoint)

      return withSpan(
        'client.attach',
        {
          [Attr.PLUGIN]: PLUGIN_NAME,
          [Attr.OPERATION]: 'client.attach',
          client_name: CLIENT_NAME,
        },
        async (span) => {
          try {
            const result = await attach({
              port,
              version: ctx.plugin.version,
              settingsPath,
            })
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            attachCtx.stdout.write(`✓ Claude Code attached (${settingsPath})\n`)
            attachCtx.stdout.write(`  ANTHROPIC_BASE_URL = http://127.0.0.1:${port}\n`)
            if (result.changed && result.prevValue !== undefined) {
              attachCtx.stdout.write(`  (previous ANTHROPIC_BASE_URL was ${result.prevValue})\n`)
            }
          } catch (err) {
            span.setAttribute('status', 'failed')
            span.setAttribute('restored', false)
            throw err
          }
        },
        { component: 'plugin.claude' }
      )
    },
    /** @param {AiGatewayClientDetachContext} detachCtx */
    async detach(detachCtx) {
      const homeDir = ctx.env.HOME ?? os.homedir()
      const settingsPath = defaultSettingsPath(homeDir)

      return withSpan(
        'client.detach',
        {
          [Attr.PLUGIN]: PLUGIN_NAME,
          [Attr.OPERATION]: 'client.detach',
          client_name: CLIENT_NAME,
        },
        async (span) => {
          try {
            const result = await detach({ settingsPath })
            const restored = result.changed === true
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', restored)
            if (restored) {
              detachCtx.stdout.write(`✓ Claude Code reverted (${settingsPath})\n`)
              if (result.changed && result.removed !== undefined) {
                detachCtx.stdout.write(`  Removed ANTHROPIC_BASE_URL=${result.removed}\n`)
              }
              if (result.changed && result.warning !== undefined) {
                detachCtx.stdout.write(`  warning: ${result.warning}\n`)
              }
            } else {
              detachCtx.stdout.write(`No HypAware marker found in ${settingsPath}; nothing to do.\n`)
            }
          } catch (err) {
            span.setAttribute('status', 'failed')
            span.setAttribute('restored', false)
            throw err
          }
        },
        { component: 'plugin.claude' }
      )
    },
  })

  const enricher = createClaudeTranscriptEnricher({
    homeDir: ctx.env.HOME ?? os.homedir(),
  })
  gateway.registerMessageEnricher({
    name: 'claude-transcript',
    enrich(row) {
      return enricher(row)
    },
  })

  const skillsRoot = path.resolve(skillsRootDir(), 'skills')
  for (const skillName of ['hypaware-query', 'hypaware-ignore', 'hypaware-unignore']) {
    ctx.skills.register({
      name: skillName,
      plugin: PLUGIN_NAME,
      clients: ['claude'],
      sourceDir: path.join(skillsRoot, skillName),
    })
  }
}

/**
 * Compute the plugin root by walking up from this file. Used to
 * resolve bundled skill directories without baking absolute paths
 * into the manifest. `import.meta.url` points at `src/index.js`;
 * the plugin root is its parent's parent.
 */
function skillsRootDir() {
  const here = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(here), '..')
}

/**
 * @param {string} endpoint
 * @returns {number}
 */
function endpointPort(endpoint) {
  const url = new URL(endpoint)
  const port = Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`@hypaware/claude: cannot derive port from endpoint '${endpoint}'`)
  }
  return port
}
