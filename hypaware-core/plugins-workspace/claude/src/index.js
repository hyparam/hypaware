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
import { defaultStateRoot, readLocalCaInfo } from '../../../../src/core/tls/ca.js'
import { installCaTrust, isCaTrusted } from '../../../../src/core/tls/darwin_trust.js'
import { installLaunchdEnv } from '../../../../src/core/daemon/launchd_env.js'
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
          if (attachCtx.dryRun) {
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            const port = safeEndpointPort(attachCtx.endpoint)
            const dryRunCa = await readLocalCaInfo({ stateRoot: defaultStateRoot(ctx.env) })
            writeAttachOutput(attachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: true,
              settingsPath,
              port,
              changed: false,
              prevValue: undefined,
              mode: dryRunCa ? MODE_PROXY : MODE_OTEL,
              caCertPath: dryRunCa?.certPath,
              ...(dryRunCa
                ? {}
                : {
                    telemetryPort: resolveAttachTelemetryPort({
                      stateRoot: obsEnv.stateDir,
                      config: ctx.config,
                    }),
                    spoolDir: claudeBodySpoolDir(obsEnv.hypHome),
                  }),
            })
            return
          }
          const port = endpointPort(attachCtx.endpoint)
          try {
            // Proxy mode is used when the daemon is actually running it, which
            // is exactly when a machine-local CA exists. Reading it here rather
            // than from config keeps attach honest: the mode it writes is the
            // mode the gateway is serving, not the one someone asked for.
            // (A proxy-mode install migrating to `otel` is LLP 0245's ticket
            // #807, not this branch.)
            // @ref LLP 0232#proxy-attach-preflight [implements]
            const ca = await readLocalCaInfo({ stateRoot: defaultStateRoot(ctx.env) })

            // Everything the `otel` env block names, resolved before the
            // settings write so the write is one atomic decision. The floor
            // check itself lives in attach(): it refuses before any I/O, so a
            // too-old Claude Code leaves the settings byte-identical.
            // @ref LLP 0258#version-floor [implements]: the probed version is what attach refuses on; unknown proceeds
            /** @type {string | undefined} */
            let spoolDir
            /** @type {number | undefined} */
            let telemetryPort
            /** @type {string | undefined} */
            let claudeVersion
            if (!ca) {
              claudeVersion = await resolveClaudeCodeVersion(ctx.env)
              telemetryPort = resolveAttachTelemetryPort({
                stateRoot: obsEnv.stateDir,
                config: ctx.config,
              })
              spoolDir = claudeBodySpoolDir(obsEnv.hypHome)
            }

            const result = await attach({
              port,
              version: ctx.plugin.version,
              stateFile,
              settingsPath,
              binPath: resolveHookBinPath(ctx.env),
              // No CA means no proxy-mode gateway to route through, and that is
              // the whole decision: `otel` needs no daemon at all at attach
              // time, so it is the default rather than the fallback. The base
              // URL is never written and no proxy keys appear, which is what
              // keeps Remote Control's first-party predicate true with no
              // override keys.
              // @ref LLP 0258#settings-env [implements]: one settings write is the entire attach
              // @ref LLP 0258#nothing-else [implements]: no keychain, no launchctl setenv, no LaunchAgent on this path
              ...(ca
                ? { mode: MODE_PROXY, caCertPath: ca.certPath }
                : { mode: MODE_OTEL, telemetryPort, spoolDir, claudeVersion }),
            })
            // After the settings write, not before: a floor refusal must leave
            // nothing behind, and Claude Code only starts writing bodies once a
            // session launches with the new settings. Created owner-only here
            // so raw prompts never pass through a default-mode directory.
            // @ref LLP 0253#spool-location [implements]
            if (spoolDir !== undefined) await ensureClaudeBodySpool(spoolDir)
            // Malformed `env` / `hooks` blocks attach rebuilt after backing the
            // displaced value up into the marker (LLP 0163). Reported on the
            // span, in the log, and to the user - the whole point of the
            // decision is that the repair stops being silent.
            const warnings = result.changed && result.warnings !== undefined
              ? [...result.warnings]
              : []

            // The settings keys alone leave Remote Control's inbound channel
            // broken (LLP 0236): its transport trusts only the keychain, and
            // only when NODE_USE_SYSTEM_CA=1 was in the environment at boot.
            // Both halves are macOS-only, both degrade to a warning rather
            // than failing the attach - capture works without them.
            /** @type {'granted' | 'already' | 'refused' | undefined} */
            let trustState
            /** @type {boolean | undefined} */
            let launchdEnvSet
            if (ca && process.platform === 'darwin') {
              const darwin = await ensureDarwinProxyTrust({
                certPath: ca.certPath,
                hosts: ca.hosts,
                stdout: attachCtx.stdout,
              })
              trustState = darwin.trustState
              launchdEnvSet = darwin.launchdEnvSet
              warnings.push(...darwin.warnings)
              span.setAttribute('proxy_trust', darwin.trustState)
              span.setAttribute('launchd_env_set', darwin.launchdEnvSet)
            } else if (ca) {
              // @ref LLP 0237#darwin-only [implements]
              warnings.push(
                'Remote Control inbound is not supported under proxy mode on this platform yet'
              )
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
              mode: ca ? MODE_PROXY : MODE_OTEL,
              caCertPath: ca?.certPath,
              telemetryPort,
              spoolDir,
              trust: trustState,
              launchdEnvSet,
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
 * The two macOS-only halves of a working proxy attach: user-domain keychain
 * trust for the CA, and `NODE_USE_SYSTEM_CA=1` in the launchd user
 * environment. Every failure is a warning, never a throw: capture works
 * without either half, and the attach must say what is degraded rather than
 * refuse to deliver what still works.
 * @ref LLP 0237#attach-anyway-on-refusal [implements]
 *
 * The pre-dialog line is written directly: the macOS password dialog appears
 * mid-attach, and a user who has not been told why gets a scary
 * trust-settings prompt with no context.
 *
 * @param {{ certPath: string, hosts: string[], stdout: { write(s: string): unknown } }} args
 * @returns {Promise<{
 *   trustState: 'granted' | 'already' | 'refused',
 *   launchdEnvSet: boolean,
 *   warnings: string[],
 * }>}
 */
async function ensureDarwinProxyTrust({ certPath, hosts, stdout }) {
  /** @type {string[]} */
  const warnings = []
  /** @type {'granted' | 'already' | 'refused'} */
  let trustState

  if (await isCaTrusted({ certPath })) {
    trustState = 'already'
  } else {
    // Name every host the trust will cover, so the grant is informed - the
    // constraint set is wider than the one provider being attached.
    // @ref LLP 0238#full-provider-constraints [constrained-by]: the dialog context must name all permitted hosts
    stdout.write(
      `  Requesting keychain trust for the HypAware Local CA (limited to: ${hosts.join(', ')}).\n` +
      '  macOS will ask for your login password.\n'
    )
    const install = await installCaTrust({ certPath })
    if (install.installed) {
      trustState = 'granted'
    } else {
      trustState = 'refused'
      warnings.push(
        'keychain trust was not granted' +
        `${install.detail ? ` (${install.detail})` : ''}; ` +
        'capture works, but Remote Control messages sent from other devices will not arrive. ' +
        'Re-run `hyp attach claude` to retry.'
      )
    }
  }

  const env = await installLaunchdEnv({})
  if (!env.set) {
    warnings.push(
      'NODE_USE_SYSTEM_CA could not be set in the launchd environment' +
      `${env.detail ? ` (${env.detail})` : ''}; ` +
      'launch Claude Code with `NODE_USE_SYSTEM_CA=1` in the shell until this is fixed.'
    )
  }

  return { trustState, launchdEnvSet: env.set, warnings }
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
 *   caCertPath?: string,
 *   telemetryPort?: number,
 *   spoolDir?: string,
 *   trust?: 'granted' | 'already' | 'refused',
 *   launchdEnvSet?: boolean,
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
    if (fields.caCertPath !== undefined) payload.ca_cert_path = fields.caCertPath
    if (fields.telemetryPort !== undefined) payload.telemetry_port = fields.telemetryPort
    if (fields.spoolDir !== undefined) payload.spool_dir = fields.spoolDir
    if (fields.trust !== undefined) payload.keychain_trust = fields.trust
    if (fields.launchdEnvSet !== undefined) payload.launchd_env_set = fields.launchdEnvSet
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
  if (fields.mode === MODE_PROXY && fields.caCertPath !== undefined) {
    attachCtx.stdout.write(`  NODE_EXTRA_CA_CERTS = ${fields.caCertPath}\n`)
  }
  if (fields.prevValue !== undefined) {
    attachCtx.stdout.write(`  (previous ${managedKey} was ${fields.prevValue})\n`)
  }
  for (const warning of fields.warnings ?? []) {
    attachCtx.stdout.write(`  ! ${warning}\n`)
  }
  // Last, so it is the line the user acts on. `launchctl setenv` reaches only
  // processes launchd starts afterwards; windows of an already-running
  // terminal app inherit the app's stale environment, so "open a new window"
  // is not enough (proven in the run G acceptance test).
  // @ref LLP 0239#terminals-predating-attach [implements]: already-open terminal apps are told to relaunch, not fixed
  if (fields.mode === MODE_PROXY && fields.launchdEnvSet === true && fields.trust !== 'refused') {
    attachCtx.stdout.write(
      '  One more step for Remote Control: quit your terminal app completely ' +
      '(Cmd-Q) and reopen it.\n' +
      '  A new window or tab is not enough; apps launched from now on pick up ' +
      'the change automatically.\n'
    )
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

