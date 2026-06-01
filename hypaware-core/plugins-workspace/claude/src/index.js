// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../../src/core/config/schema.js'
import { attach, defaultSettingsPath, detach } from './settings.js'
import { anthropicUpstreamPreset, createClaudeExchangeProjector } from './projector.js'
import { createClaudeBackfillProvider } from './backfill.js'
import { defaultSessionContextFile } from './session_context.js'
import { runClaudeSessionContextHook } from './hook_command.js'

/**
 * @import { AiGatewayCapability, AiGatewayClientAttachContext, AiGatewayClientDetachContext, CommandRunContext, HypAwareV2Config, PluginActivationContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

const PLUGIN_NAME = '@hypaware/claude'
const CLIENT_NAME = 'claude'
const UPSTREAM_NAME = 'anthropic'
const FALLBACK_BIN_PATH = fileURLToPath(new URL('../../../../bin/hypaware.js', import.meta.url))

/**
 * Resolve the canonical session-context state file the Claude hook
 * appends to and the projector reads from. Centralised so attach()
 * and the projector activation path can never disagree on the path.
 *
 * @param {PluginActivationContext} ctx
 */
export function claudeSessionContextFile(ctx) {
  return defaultSessionContextFile(ctx.paths.stateDir)
}

/**
 * Activate the `@hypaware/claude` adapter plugin.
 *
 * Resolves the `hypaware.ai-gateway@^2.0.0` capability, registers
 * the Anthropic upstream preset (path + header signature match) and
 * the full Anthropic exchange projector, wires attach/detach against
 * `~/.claude/settings.json`, and contributes the three Claude-targeted
 * helper skills. The projector reads
 * `<stateDir>/session-context.jsonl` (written by the managed Claude
 * hook) for `cwd` / `git_branch` and walks the local Claude JSONL
 * transcripts under `<HOME>/.claude/projects` for native DAG identity.
 *
 * Each attach/detach emits a `client.attach`/`client.detach` span
 * tagged with `hyp_plugin`, `client_name`, `status`, and
 * `restored=true|false`.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0016#knows-nothing-about-claude-or-codex [implements] — adapter requires the ai-gateway capability; registers client + upstream preset
 */
export async function activate(ctx) {
  /** @type {AiGatewayCapability} */
  const gateway = ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')

  const upstreamPreset = anthropicUpstreamPreset()
  // Keep the upstream name stable across the 1.x → 2.x rewrite so
  // operator TOML configs that hardcoded `name = "anthropic"` keep
  // working. `anthropicUpstreamPreset()` already uses that name, but
  // assert it explicitly so a future rename can't silently break
  // installed configs.
  if (upstreamPreset.name !== UPSTREAM_NAME) {
    throw new Error(`@hypaware/claude: unexpected upstream preset name ${upstreamPreset.name}`)
  }
  gateway.registerUpstreamPreset(upstreamPreset)

  const logger = getLogger('plugin.claude')

  // Session-context state file path is plugin-state-dir scoped, so
  // attach() and the projector resolve the same absolute path without
  // a separate config option. The kernel guarantees `paths.stateDir`
  // is created and writable before activate() runs.
  const stateFile = claudeSessionContextFile(ctx)
  const homeDir = ctx.env.HOME ?? os.homedir()

  gateway.registerExchangeProjector(
    createClaudeExchangeProjector({
      homeDir,
      stateFile,
      clientName: CLIENT_NAME,
      logger,
    })
  )

  // Backfill provider: imports the same local Claude transcripts the
  // projector reads for DAG identity, but as a standalone history
  // import into `ai_gateway_messages` via `hyp backfill claude`.
  ctx.backfills.register(
    createClaudeBackfillProvider({
      homeDir,
      stateFile,
      clientName: CLIENT_NAME,
      pluginName: PLUGIN_NAME,
    })
  )

  gateway.registerClient({
    name: CLIENT_NAME,
    defaultUpstream: UPSTREAM_NAME,
    /** @param {AiGatewayClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const homeDir = ctx.env.HOME ?? os.homedir()
      const settingsPath = defaultSettingsPath(homeDir)

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
              settingsPath,
              port,
              changed: false,
              prevValue: undefined,
            })
            return
          }
          const port = endpointPort(attachCtx.endpoint)
          try {
            const result = await attach({
              port,
              version: ctx.plugin.version,
              stateFile,
              settingsPath,
              binPath: resolveHookBinPath(ctx.env),
            })
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            logger.info('client.attach.write', {
              hyp_plugin: PLUGIN_NAME,
              hyp_client: CLIENT_NAME,
              settings_path: settingsPath,
              port,
              changed: result.changed === true,
            })
            writeAttachOutput(attachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: false,
              settingsPath,
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
              settingsPath,
              changed: false,
            })
            return
          }
          try {
            const result = await detach({ settingsPath })
            const restored = result.changed === true
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', restored)
            if (restored) {
              logger.info('client.detach.write', {
                hyp_plugin: PLUGIN_NAME,
                hyp_client: CLIENT_NAME,
                settings_path: settingsPath,
                changed: true,
              })
            }
            writeDetachOutput(detachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: false,
              settingsPath,
              changed: restored,
              removed: result.changed && result.removed !== undefined
                ? result.removed
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
        { component: 'plugin.claude' }
      )
    },
  })

  ctx.commands.register({
    name: 'claude-hook session-context',
    summary: 'Internal Claude Code hook — appends session context to the state file',
    usage: 'hyp claude-hook session-context --state-file <absolute-path>',
    hidden: true,
    run: runClaudeSessionContextHook,
  })

  const skillsRoot = path.resolve(skillsRootDir(), 'skills')
  // @ref LLP 0011#interactive-walkthrough [implements] — contributes client skills the first-run walkthrough installs
  for (const skillName of ['hypaware-query', 'hypaware-ignore', 'hypaware-unignore']) {
    ctx.skills.register({
      name: skillName,
      plugin: PLUGIN_NAME,
      clients: ['claude'],
      sourceDir: path.join(skillsRoot, skillName),
    })
  }

  ctx.initPresets.register({
    name: 'claude-and-otel-local',
    plugin: PLUGIN_NAME,
    summary:
      'Capture Claude Code + OTLP locally, export to Parquet under HYP_HOME/exports',
    run: runClaudeAndOtelLocalPreset,
  })
}

/**
 * Claude runs hooks from arbitrary working directories, so the managed hook
 * must use a concrete CLI entrypoint instead of assuming `hyp` is on PATH.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function resolveHookBinPath(env) {
  const explicit = firstNonEmpty(env.HYPAWARE_BIN, env.HYP_BIN)
  if (explicit) return path.resolve(explicit)
  if (process.argv[1]) return path.resolve(process.argv[1])
  return FALLBACK_BIN_PATH
}

/**
 * @param {Array<string|undefined>} values
 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * `hyp init claude-and-otel-local`
 *
 * Writes a v2 config that picks: `@hypaware/ai-gateway`,
 * `@hypaware/otel`, `@hypaware/local-fs`+`@hypaware/format-parquet`,
 * and `@hypaware/claude`. This is the Phase 9 V1 milestone preset and
 * exercises every first-party shipping plugin end-to-end.
 *
 * The preset never overwrites an existing config file silently —
 * passing `--force` opts into overwrite; otherwise the existing file
 * stays and the command returns 1.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runClaudeAndOtelLocalPreset(argv, ctx) {
  const force = argv.includes('--force')
  const hypHome = ctx.env.HYP_HOME || path.join(ctx.env.HOME || '', '.hyp')
  const configPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(hypHome)

  if (!force) {
    try {
      await fs.access(configPath)
      ctx.stderr.write(
        `hyp init: config already exists at ${configPath} (pass --force to overwrite)\n`
      )
      return 1
    } catch (err) {
      const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
      if (code !== 'ENOENT') throw err
    }
  }

  /** @type {HypAwareV2Config} */
  const config = {
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:8787',
          upstreams: [
            {
              name: 'anthropic',
              base_url: 'https://api.anthropic.com',
              path_prefix: '/',
            },
          ],
        },
      },
      {
        name: '@hypaware/otel',
        config: { listen_host: '127.0.0.1', listen_port: 4318 },
      },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      {
        name: '@hypaware/claude',
        config: { proxy: '@hypaware/ai-gateway' },
      },
    ],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: {
          dir: path.join(hypHome, 'exports'),
          schedule: '*/5 * * * *',
        },
      },
    },
    query: {
      cache: {
        retention: { default_days: 30 },
      },
    },
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  ctx.stdout.write(`✓ Wrote ${configPath}\n`)
  ctx.stdout.write('  plugins: @hypaware/ai-gateway, @hypaware/otel, @hypaware/local-fs, @hypaware/format-parquet, @hypaware/claude\n')
  ctx.stdout.write('  next: hyp attach --client claude\n')
  return 0
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

/**
 * Like `endpointPort`, but tolerates the placeholder dry-run endpoint
 * (`http://127.0.0.1:0`) the dispatcher uses when the gateway source
 * is not yet started. Returns `undefined` when no usable port is
 * present so the caller can still report a coherent dry-run plan.
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
 * Render attach output: machine-readable JSON when `json` is set on
 * the attach context, otherwise the human prose the V0 adapter
 * emitted. Keeps the JSON shape stable so callers can grep it.
 *
 * @param {AiGatewayClientAttachContext} attachCtx
 * @param {{
 *   status: 'ok' | 'failed',
 *   client: string,
 *   dryRun: boolean,
 *   settingsPath: string,
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
      settings_path: fields.settingsPath,
      changed: fields.changed,
    }
    if (fields.port !== undefined) payload.port = fields.port
    if (fields.prevValue !== undefined) payload.prev_value = fields.prevValue
    attachCtx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (fields.dryRun) {
    attachCtx.stdout.write(`(dry-run) Would attach Claude Code via ${fields.settingsPath}\n`)
    attachCtx.stdout.write(`  Would set ANTHROPIC_BASE_URL to the local gateway endpoint\n`)
    return
  }
  attachCtx.stdout.write(`✓ Claude Code attached (${fields.settingsPath})\n`)
  if (fields.port !== undefined) {
    attachCtx.stdout.write(`  ANTHROPIC_BASE_URL = http://127.0.0.1:${fields.port}\n`)
  }
  if (fields.prevValue !== undefined) {
    attachCtx.stdout.write(`  (previous ANTHROPIC_BASE_URL was ${fields.prevValue})\n`)
  }
}

/**
 * Render detach output: machine-readable JSON when `json` is set,
 * otherwise the human prose. Keeps the JSON shape stable so callers
 * can grep it.
 *
 * @param {AiGatewayClientDetachContext} detachCtx
 * @param {{
 *   status: 'ok' | 'failed',
 *   client: string,
 *   dryRun: boolean,
 *   settingsPath: string,
 *   changed: boolean,
 *   removed?: string,
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
      settings_path: fields.settingsPath,
      changed: fields.changed,
    }
    if (fields.removed !== undefined) payload.removed = fields.removed
    if (fields.warning !== undefined) payload.warning = fields.warning
    detachCtx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (fields.dryRun) {
    detachCtx.stdout.write(`(dry-run) Would detach Claude Code from ${fields.settingsPath}\n`)
    return
  }
  if (fields.changed) {
    detachCtx.stdout.write(`✓ Claude Code reverted (${fields.settingsPath})\n`)
    if (fields.removed !== undefined) {
      detachCtx.stdout.write(`  Removed ANTHROPIC_BASE_URL=${fields.removed}\n`)
    }
    if (fields.warning !== undefined) {
      detachCtx.stdout.write(`  warning: ${fields.warning}\n`)
    }
  } else {
    detachCtx.stdout.write(`No HypAware marker found in ${fields.settingsPath}; nothing to do.\n`)
  }
}
