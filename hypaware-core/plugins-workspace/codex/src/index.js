// @ts-check

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
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

  const logger = getLogger('plugin.codex')

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
          hyp_client: CLIENT_NAME,
          dry_run: attachCtx.dryRun === true,
        },
        async (span) => {
          if (attachCtx.dryRun) {
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            const port = safeEndpointPort(attachCtx.endpoint)
            writeAttachOutput(attachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: true,
              configPath,
              port,
              changed: false,
            })
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
            logger.info('client.attach.write', {
              hyp_plugin: PLUGIN_NAME,
              hyp_client: CLIENT_NAME,
              config_path: configPath,
              port,
              changed: result.changed === true,
            })
            writeAttachOutput(attachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: false,
              configPath,
              port,
              changed: result.changed === true,
              prevValue: result.changed && result.prevValue !== undefined
                ? result.prevValue
                : undefined,
            })
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
          hyp_client: CLIENT_NAME,
          dry_run: detachCtx.dryRun === true,
        },
        async (span) => {
          if (detachCtx.dryRun) {
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            writeDetachOutput(detachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: true,
              configPath,
              changed: false,
            })
            return
          }
          try {
            const result = await detach({ configPath })
            const restored = result.changed === true
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', restored)
            if (restored) {
              logger.info('client.detach.write', {
                hyp_plugin: PLUGIN_NAME,
                hyp_client: CLIENT_NAME,
                config_path: configPath,
                changed: true,
              })
            }
            writeDetachOutput(detachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: false,
              configPath,
              changed: restored,
              removed: result.changed && result.removed !== undefined
                ? result.removed
                : undefined,
              restoredValue: result.changed && result.restoredValue !== undefined
                ? result.restoredValue
                : undefined,
              warning: result.changed && result.warning !== undefined
                ? result.warning
                : undefined,
            })
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

/**
 * Like `endpointPort`, but tolerates the placeholder dry-run endpoint
 * (`http://127.0.0.1:0`) the dispatcher uses when the gateway source
 * is not yet started.
 *
 * @param {string} endpoint
 * @returns {number | undefined}
 */
function safeEndpointPort(endpoint) {
  try {
    const url = new URL(endpoint)
    const port = Number.parseInt(url.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return port
  } catch {
    return undefined
  }
}

/**
 * Render attach output: JSON when the attach context sets `json`,
 * otherwise the human prose the V0 adapter emitted.
 *
 * @param {AiGatewayClientAttachContext} attachCtx
 * @param {{
 *   status: 'ok' | 'failed',
 *   client: string,
 *   dryRun: boolean,
 *   configPath: string,
 *   port: number | undefined,
 *   changed: boolean,
 *   prevValue?: string,
 * }} fields
 */
function writeAttachOutput(attachCtx, fields) {
  if (attachCtx.json) {
    /** @type {Record<string, unknown>} */
    const payload = {
      status: fields.status,
      action: 'attach',
      client: fields.client,
      dry_run: fields.dryRun,
      config_path: fields.configPath,
      changed: fields.changed,
    }
    if (fields.port !== undefined) {
      payload.port = fields.port
      payload.base_url = `http://127.0.0.1:${fields.port}/v1`
    }
    if (fields.prevValue !== undefined) payload.prev_value = fields.prevValue
    attachCtx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (fields.dryRun) {
    attachCtx.stdout.write(`(dry-run) Would attach Codex via ${fields.configPath}\n`)
    attachCtx.stdout.write('  Would set model_provider = hypaware\n')
    attachCtx.stdout.write('  Would set base_url to the local gateway endpoint /v1\n')
    return
  }
  attachCtx.stdout.write(`✓ Codex attached (${fields.configPath})\n`)
  attachCtx.stdout.write('  model_provider = hypaware\n')
  if (fields.port !== undefined) {
    attachCtx.stdout.write(`  base_url = http://127.0.0.1:${fields.port}/v1\n`)
  }
  if (fields.prevValue !== undefined) {
    attachCtx.stdout.write(`  (previous model_provider was ${fields.prevValue})\n`)
  }
}

/**
 * Render detach output: JSON when the detach context sets `json`,
 * otherwise the human prose.
 *
 * @param {AiGatewayClientDetachContext} detachCtx
 * @param {{
 *   status: 'ok' | 'failed',
 *   client: string,
 *   dryRun: boolean,
 *   configPath: string,
 *   changed: boolean,
 *   removed?: string,
 *   restoredValue?: string,
 *   warning?: string,
 * }} fields
 */
function writeDetachOutput(detachCtx, fields) {
  if (detachCtx.json) {
    /** @type {Record<string, unknown>} */
    const payload = {
      status: fields.status,
      action: 'detach',
      client: fields.client,
      dry_run: fields.dryRun,
      config_path: fields.configPath,
      changed: fields.changed,
    }
    if (fields.removed !== undefined) payload.removed = fields.removed
    if (fields.restoredValue !== undefined) payload.restored_value = fields.restoredValue
    if (fields.warning !== undefined) payload.warning = fields.warning
    detachCtx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (fields.dryRun) {
    detachCtx.stdout.write(`(dry-run) Would detach Codex from ${fields.configPath}\n`)
    return
  }
  if (fields.changed) {
    detachCtx.stdout.write(`✓ Codex reverted (${fields.configPath})\n`)
    if (fields.removed !== undefined) {
      detachCtx.stdout.write(`  Removed base_url=${fields.removed}\n`)
    }
    if (fields.restoredValue !== undefined) {
      detachCtx.stdout.write(`  Restored model_provider=${fields.restoredValue}\n`)
    }
    if (fields.warning !== undefined) {
      detachCtx.stdout.write(`  warning: ${fields.warning}\n`)
    }
  } else {
    detachCtx.stdout.write(`No HypAware marker found in ${fields.configPath}; nothing to do.\n`)
  }
}
