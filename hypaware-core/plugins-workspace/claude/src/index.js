// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { defaultConfigPath } from '../../../../src/core/config/schema.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { removeLaunchdEnv } from '../../../../src/core/daemon/launchd_env.js'
import { CLAUDE_CONFIG_SECTION, validateClaudeConfig } from './config.js'
import { MODE_OTEL, MODE_PROXY, attach, defaultSettingsPath } from './settings.js'
import { resolveClaudeCodeVersion } from './claude_version.js'
import { anthropicUpstreamPreset, createClaudeExchangeProjector } from './projector.js'
import { createClaudeBackfillProvider } from './backfill.js'
import { createClaudeSettlementEnricher } from './settle.js'
import { defaultSessionContextFile } from './session_context.js'
import { runClaudeSessionContextHook } from './hook_command.js'
import { runClaudeClassifyHook } from './classify_hook.js'
import {
  CLAUDE_TELEMETRY_SOURCE,
  createStartClaudeTelemetrySource,
  resolveAttachTelemetryPort,
} from './telemetry/source.js'
import { claudeTelemetryDatasetRegistration } from './telemetry/events_dataset.js'
import { claudeBodySpoolDir, ensureClaudeBodySpool } from './telemetry/spool.js'

/**
 * @import { AiGatewayCapability, AiGatewayClientAttachContext, CommandRunContext, HypAwareV2Config, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/claude'
const CLIENT_NAME = 'claude'
const UPSTREAM_NAME = 'anthropic'
const FALLBACK_BIN_PATH = fileURLToPath(new URL('../../../../bin/hypaware.js', import.meta.url))

/**
 * The plugin's `config_sections` validator, surfaced as a side-effect-free
 * export so the kernel apply path can validate this plugin's `config` block
 * (the `backfill` policy) *before* the plugin is ever activated (e.g. a
 * central config that first introduces `@hypaware/claude`). It is the same
 * registration `activate()` hands `ctx.configRegistry.registerSection`;
 * importing this module never runs `activate()`, so discovery is safe.
 *
 * @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]: the plugin owns + exposes its own `backfill` validator
 * @type {{ section: string, validate: typeof validateClaudeConfig }}
 */
export const configSection = { section: CLAUDE_CONFIG_SECTION, validate: validateClaudeConfig }

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
 * the full Anthropic exchange projector, wires `attach()` against
 * `~/.claude/settings.json`, and contributes the three Claude-targeted
 * helper skills. The projector reads
 * `<stateDir>/session-context.jsonl` (written by the managed Claude
 * hook) for `cwd` / `git_branch` and walks the local Claude JSONL
 * transcripts under `<HOME>/.claude/projects` for native DAG identity.
 *
 * `attach()` emits a `client.attach` span tagged with `hyp_plugin`,
 * `client_name`, `status`, and `restored=true|false`. The reversing
 * detach is the single core disk-driven undo (LLP 0045 §Part 3), not a
 * per-adapter hook.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0016#knows-nothing-about-claude-or-codex [implements]: adapter requires the ai-gateway capability; registers client + upstream preset
 */
export async function activate(ctx) {
  // Validate the plugin's own `config` block: currently just the
  // optional `backfill` policy ({ on_join, window_days }) that drives
  // backfill-on-join. Registered so the kernel runs it via
  // `runPerPluginSectionValidators`; no top-level core schema change.
  // @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]: the source plugin owns and validates its `backfill` config
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: CLAUDE_CONFIG_SECTION,
    validate: validateClaudeConfig,
  })

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
  // @ref LLP 0103 [implements]: thread the machine-local usage-policy list into
  // every capture-seam resolver so a `--private` (machine-local `ignore`) dir
  // stops recording at capture, not just at the export seam. Without this the
  // resolvers below fall back to a `.hypignore`-dotfile-only view blind to the
  // list, and `hyp backfill` would re-import sessions the user asked to drop.
  // The list lives at the SHARED state root (`readObservabilityEnv(ctx.env).stateDir`),
  // the same path the export seam (activation.js) and query seam (visibility.js)
  // read, NOT the per-plugin `ctx.paths.stateDir` (`<stateRoot>/plugins/<name>`)
  // where the file never exists.
  const localOnlyList = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)

  gateway.registerExchangeProjector(
    createClaudeExchangeProjector({
      homeDir,
      stateFile,
      clientName: CLIENT_NAME,
      localOnlyListPath: localOnlyList,
      logger,
    })
  )

  // @ref LLP 0027#decision: flush-time settlement: upgrade fallback rows
  // (transcript line not yet on disk when captured) to native identity
  // once the line has landed, so race duplicates collapse at flush.
  gateway.registerSettlementEnricher(
    createClaudeSettlementEnricher({
      homeDir,
      stateFile,
      clientName: CLIENT_NAME,
      localOnlyListPath: localOnlyList,
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
      localOnlyListPath: localOnlyList,
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
          const obsEnv = readObservabilityEnv(ctx.env)
          // Everything the `otel` env block names, resolved before the
          // settings write so the write is one atomic decision. `otel` is the
          // claude client's only attach mode: a machine still carrying a
          // proxy attach is migrated by this same write (the mode-switch key
          // release plus the residue unwind below), never re-attached by
          // proxy.
          // @ref LLP 0258#version-floor [constrained-by]: one attach mode per client, with no proxy fallback
          const telemetryPort = resolveAttachTelemetryPort({
            stateRoot: obsEnv.stateDir,
            config: ctx.config,
          })
          const spoolDir = claudeBodySpoolDir(obsEnv.hypHome)
          if (attachCtx.dryRun) {
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            writeAttachOutput(attachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: true,
              settingsPath,
              port: safeEndpointPort(attachCtx.endpoint),
              changed: false,
              prevValue: undefined,
              mode: MODE_OTEL,
              telemetryPort,
              spoolDir,
            })
            return
          }
          const port = endpointPort(attachCtx.endpoint)
          try {
            // The floor check itself lives in attach(): it refuses before any
            // I/O, so a too-old Claude Code leaves the settings byte-identical,
            // a proxy attach it would otherwise have migrated included.
            // @ref LLP 0258#version-floor [implements]: the probed version is what attach refuses on; unknown proceeds
            const claudeVersion = await resolveClaudeCodeVersion(ctx.env)

            // The base URL is never written and no proxy keys appear, which is
            // what keeps Remote Control's first-party predicate true with no
            // override keys.
            // @ref LLP 0258#settings-env [implements]: one settings write is the entire attach
            // @ref LLP 0258#nothing-else [implements]: no keychain, no launchctl setenv, no LaunchAgent on this path
            const result = await attach({
              port,
              version: ctx.plugin.version,
              stateFile,
              settingsPath,
              binPath: resolveHookBinPath(ctx.env),
              mode: MODE_OTEL,
              telemetryPort,
              spoolDir,
              claudeVersion,
            })
            // After the settings write, not before: a floor refusal must leave
            // nothing behind, and Claude Code only starts writing bodies once a
            // session launches with the new settings. Created owner-only here
            // so raw prompts never pass through a default-mode directory.
            // @ref LLP 0253#spool-location [implements]
            await ensureClaudeBodySpool(spoolDir)
            // Malformed `env` / `hooks` blocks attach rebuilt after backing the
            // displaced value up into the marker (LLP 0163). Reported on the
            // span, in the log, and to the user - the whole point of the
            // decision is that the repair stops being silent.
            const warnings = result.changed && result.warnings !== undefined
              ? [...result.warnings]
              : []

            // A prior proxy marker makes this attach a migration. The settings
            // write above already released the proxy keys (the LLP 0232
            // mode-switch rule); what is left is the residue outside the
            // settings file. The launchd environment is unwound here; the CA
            // trust is OFFERED, never taken: it carries the once-per-machine
            // password-dialog grant, other clients may still proxy through the
            // gateway, and ending the grant is `hyp detach --purge`'s job.
            // @ref LLP 0245#migration [implements]: release the proxy keys, unwind the launchd env, offer detach --purge, write the OTEL block
            const migratedFrom = result.changed && result.priorMode === MODE_PROXY
              ? MODE_PROXY
              : undefined
            /** @type {boolean | undefined} */
            let launchdEnvRemoved
            /** @type {string[]} */
            const migrationNotes = []
            if (migratedFrom !== undefined) {
              const unwind = await unwindProxyLaunchdEnv({ homeDir })
              launchdEnvRemoved = unwind.launchdEnvRemoved
              warnings.push(...unwind.warnings)
              migrationNotes.push(
                'Migrated from proxy attach: the proxy env keys are released and ' +
                'Claude Code talks to Anthropic directly again.',
                'Sessions started before this keep proxying until they restart; ' +
                'the overlap dedupes into the same rows.'
              )
              if (launchdEnvRemoved === true) {
                migrationNotes.push('Removed NODE_USE_SYSTEM_CA from the launchd environment.')
              }
              // "any trust it was granted" rather than "the trust you granted":
              // a proxy attach whose keychain dialog was refused still ran and
              // still left the CA, so claiming a grant we never verified would
              // be the one false line in the migration's story.
              migrationNotes.push(
                (process.platform === 'darwin'
                  ? 'The HypAware Local CA, and any login-keychain trust it was granted, ' +
                    'is still in place. '
                  : 'The HypAware local CA is still on disk. ') +
                "Run 'hyp detach claude --purge' to remove it (then 'hyp attach claude' " +
                'to keep capturing); it is never removed without you asking.'
              )
              span.setAttribute('migrated_from', migratedFrom)
              if (launchdEnvRemoved !== undefined) {
                span.setAttribute('launchd_env_removed', launchdEnvRemoved)
              }
              logger.info('client.attach.migrated', {
                hyp_plugin: PLUGIN_NAME,
                hyp_client: CLIENT_NAME,
                from_mode: MODE_PROXY,
                to_mode: MODE_OTEL,
                ...(launchdEnvRemoved !== undefined
                  ? { launchd_env_removed: launchdEnvRemoved }
                  : {}),
              })
            }
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            span.setAttribute('malformed_blocks_repaired', warnings.length)
            logger.info('client.attach.write', {
              hyp_plugin: PLUGIN_NAME,
              hyp_client: CLIENT_NAME,
              settings_path: settingsPath,
              port,
              changed: result.changed === true,
              malformed_blocks_repaired: warnings.length,
            })
            for (const warning of warnings) {
              logger.warn('client.attach.malformed_block', {
                hyp_plugin: PLUGIN_NAME,
                hyp_client: CLIENT_NAME,
                settings_path: settingsPath,
                detail: warning,
              })
            }
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
              mode: MODE_OTEL,
              telemetryPort,
              spoolDir,
              migratedFrom,
              launchdEnvRemoved,
              migrationNotes,
              warnings,
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

  // The plugin's first dataset: behavioral events the wire never showed.
  // Registered unconditionally (not gated on the listener below): the
  // rows a past daemon wrote must stay queryable and enumerable even
  // when this boot cannot host the listener.
  // @ref LLP 0255#owned-by-claude [implements]: the payload shapes are Claude
  // Code's, so the plugin that interprets them owns the table
  ctx.query.registerDataset(claudeTelemetryDatasetRegistration())

  // The telemetry listener: Claude Code's own OTLP export, received on
  // loopback and projected into the same `ai_gateway_messages` rows the
  // proxy and transcript backfill produce. Registered, not started:
  // the daemon starts every registered source, so a CLI activation
  // never binds a port.
  //
  // Feature-detected against the gateway capability so a mixed install
  // (an older `@hypaware/ai-gateway` without the record seam) degrades
  // to "no listener" rather than throwing at boot.
  // @ref LLP 0257#registration [implements]: `@hypaware/claude` contributes the
  // listener source through the kernel source registry, with its own config
  // section and its own port
  if (typeof gateway.recordProjectedExchange === 'function') {
    ctx.sources.register({
      name: CLAUDE_TELEMETRY_SOURCE,
      plugin: PLUGIN_NAME,
      summary: 'Claude Code OTLP telemetry receiver: projects its event stream into ai_gateway_messages',
      configSection: CLAUDE_CONFIG_SECTION,
      start: createStartClaudeTelemetrySource({
        gateway,
        clientName: CLIENT_NAME,
        stateFile,
        // The same shared-state-root list every other capture seam above gets.
        // The listener is a capture seam too, and this is the arm of the policy
        // that no `.hypignore` dotfile expresses.
        // @ref LLP 0254#policy-inline [implements]: the machine-local list is in
        //   scope at ingest, not only the committable dotfile
        localOnlyListPath: localOnlyList,
      }),
    })
  } else {
    logger.warn('claude.telemetry.capability_too_old', {
      hyp_plugin: PLUGIN_NAME,
      detail: 'the active @hypaware/ai-gateway has no recordProjectedExchange; the telemetry listener is not registered',
    })
  }

  ctx.commands.register({
    name: 'claude-hook session-context',
    summary: 'Internal Claude Code hook: appends session context to the state file',
    usage: 'hyp claude-hook session-context --state-file <absolute-path>',
    hidden: true,
    run: runClaudeSessionContextHook,
  })

  // @ref LLP 0106 [implements]: the SessionStart classification hook, installed
  // at attach and reversed by hyp leave via the same marker perimeter as the
  // session-context hook.
  ctx.commands.register({
    name: 'claude-hook classify-cwd',
    summary: 'Internal Claude Code hook: prompt to classify an unclassified folder on an enrolled machine',
    usage: 'hyp claude-hook classify-cwd',
    hidden: true,
    run: runClaudeClassifyHook,
  })

  const skillsRoot = path.resolve(skillsRootDir(), 'skills')
  // @ref LLP 0011#interactive-walkthrough [implements]: contributes client skills the first-run walkthrough installs
  for (const skillName of [
    'hypaware-query',
    'hypaware-reference',
    'hypaware-privacy',
  ]) {
    ctx.skills.register({
      name: skillName,
      plugin: PLUGIN_NAME,
      clients: ['claude'],
      sourceDir: path.join(skillsRoot, skillName),
    })
  }

  const agentsRoot = path.resolve(skillsRootDir(), 'agents')
  ctx.agents.register({
    name: 'hypaware-analyst',
    plugin: PLUGIN_NAME,
    clients: ['claude'],
    sourceFile: path.join(agentsRoot, 'hypaware-analyst.md'),
  })

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
 * The preset never overwrites an existing config file silently (pass
 * `--force` to opt into overwrite); otherwise the existing file
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
      // No `listen`: a preset-written address reads as a stated port
      // requirement and forfeits the default-only EADDRINUSE fallback
      // (LLP 0114 #explicit-listen-fails-loudly).
      // @ref LLP 0114#init-writes-no-listen [implements]: the preset leaves listen unset so the default install keeps its fallback
      {
        name: '@hypaware/ai-gateway',
        config: {
          // Literal because this preset writes its config literally: the
          // picker fold writes the same key from `gateway_proxy_mode`.
          // @ref LLP 0243#composed-default [implements]: the preset install defaults to proxy attach too
          proxy_mode: true,
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
      // The graph pair rides the gateway in `hyp init`'s picker fold
      // (`compose_with`). This preset writes its plugin list literally, so
      // it has to name them itself: without this the preset ships a brand
      // new config with no `node` / `edge`, while `hypaware-query` tells the
      // model both datasets are there.
      // @ref LLP 0213#d1 [implements]: a config the gateway reaches carries the graph, whichever path wrote it
      { name: '@hypaware/context-graph' },
      { name: '@hypaware/ai-gateway-graph' },
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
        retention: { default_days: 90 },
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
 * Unwind the launchd-environment half of a proxy attach when `hyp attach
 * claude` migrates the machine to `otel` mode.
 *
 * Mirrors the detach undo's release (`releaseProxyModeLaunchdEnv` in
 * `client_detach_disk.js`): darwin-only, best-effort, and the same by-hand
 * hint on failure, because the attach that just migrated must never fail on
 * residue it can name. The CA and its keychain trust deliberately stay: they
 * carry the user's once-per-machine password-dialog grant, and only `hyp
 * detach --purge` or `hyp daemon uninstall` may end it. The migration OFFERS
 * that step in its output; it never runs it.
 * @ref LLP 0245#migration [implements]: the launchd env is unwound; the CA trust is offered, never forced
 * @ref LLP 0239#launchctl-setenv [implements]: the migration is one more path that reverses a proxy attach, so it releases the env too
 *
 * @param {{
 *   homeDir?: string,
 *   platform?: NodeJS.Platform,
 *   removeEnv?: typeof removeLaunchdEnv,
 * }} [args]
 * @returns {Promise<{ launchdEnvRemoved?: boolean, warnings: string[] }>}
 */
export async function unwindProxyLaunchdEnv({
  homeDir,
  platform = process.platform,
  removeEnv = removeLaunchdEnv,
} = {}) {
  if (platform !== 'darwin') return { warnings: [] }
  try {
    const removal = await removeEnv({ homeDir })
    if (removal.unset) return { launchdEnvRemoved: true, warnings: [] }
    return {
      launchdEnvRemoved: false,
      warnings: [
        'NODE_USE_SYSTEM_CA could not be unset from the launchd environment' +
        `${removal.detail ? ` (${removal.detail})` : ''}; ` +
        'run `launchctl unsetenv NODE_USE_SYSTEM_CA` by hand',
      ],
    }
  } catch (err) {
    return {
      launchdEnvRemoved: false,
      warnings: [
        'the launchd environment could not be released ' +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        'run `launchctl unsetenv NODE_USE_SYSTEM_CA` by hand',
      ],
    }
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
 *   mode?: 'proxy' | 'base_url' | 'otel',
 *   telemetryPort?: number,
 *   spoolDir?: string,
 *   migratedFrom?: 'proxy',
 *   launchdEnvRemoved?: boolean,
 *   migrationNotes?: string[],
 *   warnings?: string[],
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
    if (fields.mode !== undefined) payload.mode = fields.mode
    if (fields.telemetryPort !== undefined) payload.telemetry_port = fields.telemetryPort
    if (fields.spoolDir !== undefined) payload.spool_dir = fields.spoolDir
    // The typed migration facts, so a scripted caller can tell a migrating
    // attach from a routine one without parsing prose; the human notes below
    // stay off this surface.
    if (fields.migratedFrom !== undefined) payload.migrated_from = fields.migratedFrom
    if (fields.launchdEnvRemoved !== undefined) payload.launchd_env_removed = fields.launchdEnvRemoved
    // Named, because `prev_value` alone does not say which key it belonged to
    // and each mode manages different ones.
    if (fields.prevValue !== undefined) {
      payload.prev_value = fields.prevValue
      payload.prev_value_key = takenOverKey(fields.mode)
    }
    // Echoed as an array, not folded into a string: the field exists so a
    // scripted caller can see *which* blocks were moved aside.
    if (fields.warnings !== undefined && fields.warnings.length > 0) payload.warnings = fields.warnings
    attachCtx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  // Name the key actually written. Proxy and otel modes do not set a base URL
  // at all, and reporting one is both wrong and the first thing a user would
  // check when debugging why their own base URL is still in place.
  const managedKey = takenOverKey(fields.mode)
  if (fields.dryRun) {
    attachCtx.stdout.write(`(dry-run) Would attach Claude Code via ${fields.settingsPath}\n`)
    attachCtx.stdout.write(
      fields.mode === MODE_OTEL
        ? `  Would set ${managedKey} to the local telemetry listener\n`
        : `  Would set ${managedKey} to the local gateway endpoint\n`
    )
    return
  }
  attachCtx.stdout.write(`✓ Claude Code attached (${fields.settingsPath})\n`)
  if (fields.mode === MODE_OTEL) {
    // The two values a user would check: where the events go, and where raw
    // bodies land until the listener projects and deletes them.
    if (fields.telemetryPort !== undefined) {
      attachCtx.stdout.write(`  ${managedKey} = http://127.0.0.1:${fields.telemetryPort}\n`)
    }
    if (fields.spoolDir !== undefined) {
      attachCtx.stdout.write(`  OTEL_LOG_RAW_API_BODIES = file:${fields.spoolDir}\n`)
    }
  } else if (fields.port !== undefined) {
    attachCtx.stdout.write(`  ${managedKey} = http://127.0.0.1:${fields.port}\n`)
  }
  if (fields.prevValue !== undefined) {
    attachCtx.stdout.write(`  (previous ${managedKey} was ${fields.prevValue})\n`)
  }
  // The migration story, told where the user is looking: what the switch
  // released, what was unwound, and the one residue that is theirs to end
  // (the CA trust, offered as `hyp detach claude --purge`, never run for
  // them).
  // @ref LLP 0245#migration [implements]: the offer is a printed step, not an action
  for (const note of fields.migrationNotes ?? []) {
    attachCtx.stdout.write(`  ${note}\n`)
  }
  for (const warning of fields.warnings ?? []) {
    attachCtx.stdout.write(`  ! ${warning}\n`)
  }
}

/**
 * The env key each attach mode takes over: the one a displaced `prev_value`
 * belonged to, and the one the human output leads with.
 *
 * @param {'proxy' | 'base_url' | 'otel' | undefined} mode
 * @returns {'HTTPS_PROXY' | 'OTEL_EXPORTER_OTLP_ENDPOINT' | 'ANTHROPIC_BASE_URL'}
 */
function takenOverKey(mode) {
  if (mode === MODE_PROXY) return 'HTTPS_PROXY'
  if (mode === MODE_OTEL) return 'OTEL_EXPORTER_OTLP_ENDPOINT'
  return 'ANTHROPIC_BASE_URL'
}

