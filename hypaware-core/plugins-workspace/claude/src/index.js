// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../../src/core/config/schema.js'
import { attach, defaultSettingsPath, detach } from './settings.js'
import { createClaudeTranscriptEnricher } from './enricher.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayCapability} AiGatewayCapability */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayClientAttachContext} AiGatewayClientAttachContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayClientDetachContext} AiGatewayClientDetachContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').CommandRunContext} CommandRunContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').HypAwareV2Config} HypAwareV2Config */

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

  ctx.initPresets.register({
    name: 'claude-and-otel-local',
    plugin: PLUGIN_NAME,
    summary:
      'Capture Claude Code + OTLP locally, export to Parquet under HYP_HOME/exports',
    run: runClaudeAndOtelLocalPreset,
  })
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
