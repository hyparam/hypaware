// @ts-check

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { attach, defaultConfigPath, detach } from './settings.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayCapability} AiGatewayCapability */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayClientAttachContext} AiGatewayClientAttachContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayClientDetachContext} AiGatewayClientDetachContext */

const PLUGIN_NAME = '@hypaware/codex'
const CLIENT_NAME = 'codex'
const UPSTREAM_NAME = 'openai'

/**
 * Activate the `@hypaware/codex` adapter plugin.
 *
 * Resolves the `hypaware.ai-gateway` capability, registers the
 * OpenAI-compatible upstream preset, wires Codex's config.toml
 * attach/detach, and contributes the `hypaware-query` skill for
 * Codex installs.
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
    base_url: 'https://api.openai.com',
    path_prefix: '/v1',
    provider: 'openai',
  })

  gateway.registerClient({
    name: CLIENT_NAME,
    defaultUpstream: UPSTREAM_NAME,
    /** @param {AiGatewayClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const configPath = resolveConfigPath(ctx)

      return withSpan(
        'client.attach',
        {
          [Attr.PLUGIN]: PLUGIN_NAME,
          [Attr.OPERATION]: 'client.attach',
          client_name: CLIENT_NAME,
          dry_run: attachCtx.dryRun === true,
        },
        async (span) => {
          if (attachCtx.dryRun) {
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            attachCtx.stdout.write(`(dry-run) Would attach Codex via ${configPath}\n`)
            attachCtx.stdout.write('  Would set model_provider = hypaware\n')
            attachCtx.stdout.write('  Would set base_url to the local gateway endpoint /v1\n')
            return
          }
          const port = endpointPort(attachCtx.endpoint)
          try {
            const result = await attach({
              port,
              version: ctx.plugin.version,
              configPath,
            })
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            attachCtx.stdout.write(`✓ Codex attached (${configPath})\n`)
            attachCtx.stdout.write('  model_provider = hypaware\n')
            attachCtx.stdout.write(`  base_url = http://127.0.0.1:${port}/v1\n`)
            if (result.changed && result.prevValue !== undefined) {
              attachCtx.stdout.write(`  (previous model_provider was ${result.prevValue})\n`)
            }
          } catch (err) {
            span.setAttribute('status', 'failed')
            span.setAttribute('restored', false)
            throw err
          }
        },
        { component: 'plugin.codex' }
      )
    },
    /** @param {AiGatewayClientDetachContext} detachCtx */
    async detach(detachCtx) {
      const configPath = resolveConfigPath(ctx)

      return withSpan(
        'client.detach',
        {
          [Attr.PLUGIN]: PLUGIN_NAME,
          [Attr.OPERATION]: 'client.detach',
          client_name: CLIENT_NAME,
          dry_run: detachCtx.dryRun === true,
        },
        async (span) => {
          if (detachCtx.dryRun) {
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            detachCtx.stdout.write(`(dry-run) Would detach Codex from ${configPath}\n`)
            return
          }
          try {
            const result = await detach({ configPath })
            const restored = result.changed === true
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', restored)
            if (restored) {
              detachCtx.stdout.write(`✓ Codex reverted (${configPath})\n`)
              if (result.changed && result.removed !== undefined) {
                detachCtx.stdout.write(`  Removed base_url=${result.removed}\n`)
              }
              if (result.changed && result.restoredValue !== undefined) {
                detachCtx.stdout.write(`  Restored model_provider=${result.restoredValue}\n`)
              }
              if (result.changed && result.warning !== undefined) {
                detachCtx.stdout.write(`  warning: ${result.warning}\n`)
              }
            } else {
              detachCtx.stdout.write(`No HypAware marker found in ${configPath}; nothing to do.\n`)
            }
          } catch (err) {
            span.setAttribute('status', 'failed')
            span.setAttribute('restored', false)
            throw err
          }
        },
        { component: 'plugin.codex' }
      )
    },
  })

  const skillsRoot = path.resolve(skillsRootDir(), 'skills')
  ctx.skills.register({
    name: 'hypaware-query',
    plugin: PLUGIN_NAME,
    clients: ['codex'],
    sourceDir: path.join(skillsRoot, 'hypaware-query'),
  })
}

/**
 * @param {PluginActivationContext} ctx
 */
function resolveConfigPath(ctx) {
  const homeDir = ctx.env.HOME ?? os.homedir()
  return defaultConfigPath(ctx.env, homeDir)
}

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
    throw new Error(`@hypaware/codex: cannot derive port from endpoint '${endpoint}'`)
  }
  return port
}
