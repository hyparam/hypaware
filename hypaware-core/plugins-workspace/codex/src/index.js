// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { createCodexBackfillProvider } from './backfill.js'
import { CODEX_CONFIG_SECTION, validateCodexConfig } from './config.js'
import { createCodexExchangeProjector } from './exchange-projector.js'
import { createRolloutCwdResolver } from './rollout-cwd.js'
import { attach, defaultConfigPath } from './settings.js'
import { runCodexClassifyHook } from './classify_hook.js'
import { errCode } from 'hypaware/core/util'

/**
 * @import { AiGatewayCapability, AiGatewayClientAttachContext, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/codex'
const CLIENT_NAME = 'codex'
const UPSTREAM_NAME = 'openai'
const CHATGPT_UPSTREAM_NAME = 'chatgpt'

/**
 * The plugin's `config_sections` validator, surfaced as a side-effect-free
 * export so the kernel apply path can validate this plugin's `config` block
 * (the `backfill` policy) *before* the plugin is ever activated: e.g. a
 * central config that first introduces `@hypaware/codex`. It is the same
 * registration `activate()` hands `ctx.configRegistry.registerSection`;
 * importing this module never runs `activate()`, so discovery is safe.
 *
 * @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]: the plugin owns + exposes its own `backfill` validator
 * @type {{ section: string, validate: typeof validateCodexConfig }}
 */
export const configSection = { section: CODEX_CONFIG_SECTION, validate: validateCodexConfig }

/**
 * Activate the `@hypaware/codex` adapter plugin.
 *
 * Resolves the `hypaware.ai-gateway` capability, registers the
 * OpenAI-compatible upstream preset, wires Codex's config.toml
 * `attach()`, and contributes the `hypaware-query`, `hypaware-graph`,
 * and `hypaware-sensitive-scan` skills plus the AI report skills
 * (usage, plus the superseded adoption/spend, improvement, security)
 * and the report-to-html renderer for Codex installs.
 *
 * `attach()` emits a `client.attach` span tagged with `hyp_plugin`,
 * `client_name`, `status`, and `restored=true|false`. The reversing
 * detach is the single core disk-driven undo (LLP 0045 §Part 3), not a
 * per-adapter hook.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0016#knows-nothing-about-claude-or-codex [implements]: adapter requires the ai-gateway capability; registers client + upstream presets
 */
export async function activate(ctx) {
  // Validate the plugin's own `config` block: currently just the
  // optional `backfill` policy ({ on_join, window_days }) that drives
  // backfill-on-join. Registered so the kernel runs it via
  // `runPerPluginSectionValidators`; no top-level core schema change.
  // @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]: the source plugin owns and validates its `backfill` config
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: CODEX_CONFIG_SECTION,
    validate: validateCodexConfig,
  })

  /** @type {AiGatewayCapability} */
  const gateway = ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')

  gateway.registerUpstreamPreset({
    name: UPSTREAM_NAME,
    base_url: 'https://api.openai.com',
    path_prefix: '/v1',
    provider: 'openai',
  })
  gateway.registerUpstreamPreset({
    name: CHATGPT_UPSTREAM_NAME,
    base_url: 'https://chatgpt.com',
    path_prefix: '/backend-api/codex',
    provider: 'chatgpt',
  })

  const homeDir = ctx.env.HOME ?? os.homedir()
  const codexHome = resolveCodexHome(ctx)
  // @ref LLP 0103 [implements]: thread the machine-local usage-policy list into
  // the capture-seam resolvers so a `--private` (machine-local `ignore`) dir
  // stops recording at capture, not just at the export seam. Without it the
  // resolvers fall back to a `.hypignore`-dotfile-only view blind to the list.
  // The list lives at the SHARED state root (`readObservabilityEnv(ctx.env).stateDir`),
  // the same path the export seam (activation.js) and query seam (visibility.js)
  // read, NOT the per-plugin `ctx.paths.stateDir` (`<stateRoot>/plugins/<name>`)
  // where the file never exists.
  const localOnlyList = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)

  // @ref LLP 0083 [implements]: give the live projector a rollout-based cwd
  // fallback for the ChatGPT-subscription route (which carries no in-band cwd),
  // reading the SAME session rollouts the backfill scans. Without it,
  // `.hypignore` fails open for that whole traffic class and its rows record
  // cwd = NULL.
  gateway.registerExchangeProjector(createCodexExchangeProjector({
    rolloutCwd: createRolloutCwdResolver({ sessionsDir: path.join(codexHome, 'sessions') }),
    localOnlyListPath: localOnlyList,
  }))

  // Backfill provider: imports the local Codex session rollouts the
  // gateway never saw (history written before HypAware attached, or
  // outside the proxy) into `ai_gateway_messages` via `hyp backfill codex`.
  ctx.backfills.register(
    createCodexBackfillProvider({
      homeDir,
      codexHome,
      clientName: CLIENT_NAME,
      pluginName: PLUGIN_NAME,
      localOnlyListPath: localOnlyList,
    })
  )

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
            const route = port === undefined
              ? undefined
              : providerRouteForAuthMode(await readCodexAuthMode(resolveAuthPath(ctx)), port)
            writeAttachOutput(attachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: true,
              configPath,
              port,
              baseUrl: route?.baseUrl,
              changed: false,
            })
            return
          }
          const port = endpointPort(attachCtx.endpoint)
          try {
            const authMode = await readCodexAuthMode(resolveAuthPath(ctx))
            const route = providerRouteForAuthMode(authMode, port)
            const result = await attach({
              port,
              version: ctx.plugin.version,
              configPath,
              baseUrl: route.baseUrl,
              providerName: route.providerName,
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
              baseUrl: route.baseUrl,
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
  })

  // @ref LLP 0106 [implements]: Codex's degraded classification prompt. Codex
  // has no SessionStart context-injection hook, so the "force" degrades to a
  // firm first-prompt nag this command emits; same decision, copy, and verbs
  // as Claude's blocking prompt.
  ctx.commands.register({
    name: 'codex-hook classify-cwd',
    summary: 'Internal Codex hook: nag to classify an unclassified folder on an enrolled machine',
    usage: 'hyp codex-hook classify-cwd',
    hidden: true,
    run: runCodexClassifyHook,
  })

  const skillsRoot = path.resolve(skillsRootDir(), 'skills')
  for (const skillName of [
    'hypaware-query',
    'hypaware-reference',
    'hypaware-privacy',
    'hypaware-graph',
    'hypaware-sensitive-scan',
    'hypaware-ai-usage-report',
    'hypaware-ai-adoption-report',
    'hypaware-ai-improvement-report',
    'hypaware-ai-security-report',
    'hypaware-ai-spend-report',
    'hypaware-report-to-html',
  ]) {
    ctx.skills.register({
      name: skillName,
      plugin: PLUGIN_NAME,
      clients: ['codex'],
      sourceDir: path.join(skillsRoot, skillName),
    })
  }
}

/**
 * @param {PluginActivationContext} ctx
 */
function resolveConfigPath(ctx) {
  const homeDir = ctx.env.HOME ?? os.homedir()
  return defaultConfigPath(ctx.env, homeDir)
}

/**
 * @param {string | undefined} authMode
 * @param {number} port
 */
// @ref LLP 0099#decision [implements]: only an affirmative chatgpt mode leaves the /v1 default
export function providerRouteForAuthMode(authMode, port) {
  if (authMode === 'chatgpt') {
    return {
      baseUrl: `http://127.0.0.1:${port}/backend-api/codex`,
      providerName: 'HypAware ChatGPT Gateway',
    }
  }
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    providerName: 'HypAware OpenAI Gateway',
  }
}

/**
 * @param {PluginActivationContext} ctx
 */
function resolveAuthPath(ctx) {
  const codexHome = ctx.env.CODEX_HOME
  if (typeof codexHome === 'string' && codexHome.length > 0) {
    return path.join(codexHome, 'auth.json')
  }
  return path.join(ctx.env.HOME ?? os.homedir(), '.codex', 'auth.json')
}

/**
 * Resolve the Codex home directory the backfill provider scans for session
 * rollouts. Honors `CODEX_HOME` like the attach path, falling back to
 * `~/.codex`.
 *
 * @param {PluginActivationContext} ctx
 */
function resolveCodexHome(ctx) {
  const codexHome = ctx.env.CODEX_HOME
  if (typeof codexHome === 'string' && codexHome.length > 0) {
    return codexHome
  }
  return path.join(ctx.env.HOME ?? os.homedir(), '.codex')
}

/**
 * Read the Codex auth mode from auth.json. Newer Codex versions omit the
 * `auth_mode` field, so when it is absent infer 'chatgpt' from the shape:
 * OAuth `tokens` present with no `OPENAI_API_KEY` means a ChatGPT
 * subscription login, which must route to `/backend-api/codex` (the
 * subscription token is not scoped for the OpenAI `/v1` API).
 *
 * @param {string} authPath
 * @returns {Promise<string | undefined>}
 */
// @ref LLP 0099#decision [implements]: infer chatgpt from tokens-without-key; explicit auth_mode wins
export async function readCodexAuthMode(authPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(authPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const mode = Reflect.get(parsed, 'auth_mode')
    if (typeof mode === 'string') return mode
    const tokens = Reflect.get(parsed, 'tokens')
    const apiKey = Reflect.get(parsed, 'OPENAI_API_KEY')
    if (tokens && typeof tokens === 'object' && typeof apiKey !== 'string') {
      return 'chatgpt'
    }
    return undefined
  } catch (err) {
    if (errCode(err) === 'ENOENT') return undefined
    return undefined
  }
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
 *   baseUrl?: string,
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
      payload.base_url = fields.baseUrl ?? `http://127.0.0.1:${fields.port}/v1`
    }
    if (fields.prevValue !== undefined) payload.prev_value = fields.prevValue
    attachCtx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (fields.dryRun) {
    attachCtx.stdout.write(`(dry-run) Would attach Codex via ${fields.configPath}\n`)
    attachCtx.stdout.write('  Would set model_provider = hypaware\n')
    if (fields.baseUrl !== undefined) {
      attachCtx.stdout.write(`  Would set base_url = ${fields.baseUrl}\n`)
    } else {
      attachCtx.stdout.write('  Would set base_url to the local gateway endpoint /v1\n')
    }
    return
  }
  attachCtx.stdout.write(`✓ Codex attached (${fields.configPath})\n`)
  attachCtx.stdout.write('  model_provider = hypaware\n')
  if (fields.baseUrl !== undefined) {
    attachCtx.stdout.write(`  base_url = ${fields.baseUrl}\n`)
  } else if (fields.port !== undefined) {
    attachCtx.stdout.write(`  base_url = http://127.0.0.1:${fields.port}/v1\n`)
  }
  if (fields.prevValue !== undefined) {
    attachCtx.stdout.write(`  (previous model_provider was ${fields.prevValue})\n`)
  }
}

