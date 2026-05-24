// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { defaultConfigPath } from '../config/schema.js'
import { readObservabilityEnv } from '../observability/env.js'
import { ensureDurableBinForNpx } from './global_install.js'

/**
 * @import { AiGatewayCapability, CapabilityRegistry, HypAwareV2Config, PluginConfigInstance, PluginName, SinkConfigInstance } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { DaemonInstallOptions } from '../daemon/types.d.ts'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../registry/types.d.ts'
 */

/**
 * @import {
 *   AsyncPickPrompt,
 *   AsyncRetentionPrompt,
 *   PickerSource,
 *   PickerExport,
 *   PickerPicks,
 *   PickerFinaleActions,
 *   PickerWalkthroughResult,
 *   RunPickerWalkthroughOptions,
 *   FinaleSummary,
 *   WalkthroughOption,
 *   WalkthroughOptions,
 *   WalkthroughQuestion,
 *   WalkthroughResult,
 * } from './types.d.ts'
 */

const DEFAULT_RETENTION_DAYS = 30

/**
 * Drive the interactive setup walkthrough.
 *
 * Composes pick categories from the kernel registries:
 *   - sources: every `SourceContribution` registered by source plugins.
 *   - sinks: every `SinkContribution` registered by sink plugins.
 *     A synthetic "Keep local only" pick (value `__none__`) is always
 *     offered so the user can opt out of exporting.
 *   - clients: every client registered with the AI gateway (when the
 *     `hypaware.ai-gateway` capability is available).
 *
 * Emits `walkthrough.start` and `walkthrough.finish` spans (the former
 * before any user input, the latter on completion) with
 * `sources_picked`, `sinks_picked`, `clients_picked`. Each user pick
 * also lands as a `walkthrough.pick` log row with `pick_type` and
 * `pick_value`.
 *
 * Writes the chosen configuration to `<HYP_HOME>/hypaware-config.json`
 * and returns the path plus the resolved picks.
 *
 * @param {WalkthroughOptions} opts
 * @returns {Promise<WalkthroughResult>}
 */
export async function runWalkthrough(opts) {
  const { sources, sinks, capabilities, stdout, env } = opts
  const log = getLogger('walkthrough')

  const sourceOpts = buildSourceOptions(sources)
  const sinkOpts = buildSinkOptions(sinks)
  const clientOpts = buildClientOptions(capabilities)

  await withSpan(
    'walkthrough.start',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.start',
      sources_available: sourceOpts.length,
      sinks_available: sinkOpts.length,
      clients_available: clientOpts.length,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  const ask = opts.prompt ?? defaultPromptFactory(opts)

  /** @param {'sources'|'sinks'|'clients'} pickType @param {WalkthroughOption[]} options @param {string} title */
  async function askCategory(pickType, options, title) {
    if (options.length === 0) return []
    const picked = await ask({ pickType, title, options })
    for (const value of picked) {
      log.info('walkthrough.pick', {
        [Attr.COMPONENT]: 'walkthrough',
        pick_type: pickType,
        pick_value: value,
      })
    }
    return picked
  }

  stdout.write('Welcome to HypAware — the local logs+telemetry collector.\n')
  stdout.write('\n')

  const sourcesPicked = await askCategory(
    'sources',
    sourceOpts,
    'What do you want to collect? (space to toggle, enter to confirm)'
  )
  const sinksPicked = await askCategory(
    'sinks',
    sinkOpts,
    'Where should HypAware export captured data?'
  )
  const clientsPicked = await askCategory(
    'clients',
    clientOpts,
    'Wire which AI clients into the local gateway?'
  )

  const retentionPrompt = opts.retentionPrompt ?? defaultRetentionPromptFactory(opts)
  const retentionDays = await retentionPrompt('Cache retention (days)', DEFAULT_RETENTION_DAYS)

  const config = composeConfig({
    sources: sourcesPicked,
    sinks: sinksPicked,
    clients: clientsPicked,
    sourceContributions: sourceOpts,
    sinkContributions: sinkOpts,
    clientContributions: clientOpts,
    retentionDays,
    hypHome: resolveHypHome(env),
  })

  const obsEnv = readObservabilityEnv(env)
  const configPath = env.HYP_CONFIG
    ? path.resolve(env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')

  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      sources_picked: sourcesPicked.length,
      sinks_picked: sinksPicked.length,
      clients_picked: clientsPicked.length,
      retention_days: retentionDays,
      config_path: configPath,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  stdout.write('\n')
  stdout.write(`✓ Wrote ${configPath}\n`)
  if (clientsPicked.length > 0) {
    stdout.write(`  next: hyp attach --client ${clientsPicked[0]}\n`)
  }

  return {
    exitCode: 0,
    configPath,
    config,
    sourcesPicked,
    sinksPicked,
    clientsPicked,
    retentionDays,
  }
}

/**
 * @param {ExtendedSourceRegistry} sources
 * @returns {WalkthroughOption[]}
 */
function buildSourceOptions(sources) {
  return sources.list().map((s) => ({
    value: s.name,
    label: s.summary ?? s.name,
    summary: s.summary,
    plugin: s.plugin,
  }))
}

/**
 * @param {ExtendedSinkRegistry} sinks
 * @returns {WalkthroughOption[]}
 */
function buildSinkOptions(sinks) {
  /** @type {WalkthroughOption[]} */
  const opts = [
    {
      value: '__none__',
      label: 'Keep local only — query the cache for the retention window',
    },
  ]
  for (const { contribution } of sinks.listContributions()) {
    opts.push({
      value: contribution.name,
      label: `${contribution.name} (${contribution.plugin})`,
      plugin: contribution.plugin,
    })
  }
  return opts
}

/**
 * @param {CapabilityRegistry} capabilities
 * @returns {WalkthroughOption[]}
 */
function buildClientOptions(capabilities) {
  if (!capabilities.has('hypaware.ai-gateway')) return []
  /** @type {AiGatewayCapability} */
  const gateway = capabilities.require('hyp-core/walkthrough', 'hypaware.ai-gateway', '^2.0.0')
  return gateway.listClients().map((c) => ({
    value: c.name,
    label: c.name,
  }))
}

/**
 * Build a v2 config from the walkthrough's picks. Plugin entries are
 * emitted in a deterministic order: sources → sinks → format-writers
 * (for blob sinks) → clients. The local-fs blob sink is paired with
 * `@hypaware/format-parquet` by default; future walkthrough variants
 * may surface the writer choice explicitly.
 *
 * @param {{
 *   sources: string[],
 *   sinks: string[],
 *   clients: string[],
 *   sourceContributions: WalkthroughOption[],
 *   sinkContributions: WalkthroughOption[],
 *   clientContributions: WalkthroughOption[],
 *   retentionDays: number,
 *   hypHome: string,
 * }} args
 * @returns {HypAwareV2Config}
 */
function composeConfig(args) {
  /** @type {PluginConfigInstance[]} */
  const plugins = []

  for (const sourceName of args.sources) {
    const opt = args.sourceContributions.find((o) => o.value === sourceName)
    if (!opt?.plugin) continue
    if (opt.plugin === '@hypaware/ai-gateway') {
      plugins.push({
        name: opt.plugin,
        config: {
          listen: '127.0.0.1:8787',
          upstreams: [
            { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
          ],
        },
      })
    } else if (opt.plugin === '@hypaware/otel') {
      plugins.push({
        name: opt.plugin,
        config: { listen_host: '127.0.0.1', listen_port: 4318 },
      })
    } else {
      plugins.push({ name: opt.plugin })
    }
  }

  /** @type {Record<string, SinkConfigInstance>} */
  const sinks = {}
  for (const sinkValue of args.sinks) {
    if (sinkValue === '__none__') continue
    const opt = args.sinkContributions.find((o) => o.value === sinkValue)
    if (!opt?.plugin) continue
    if (opt.plugin === '@hypaware/local-fs') {
      if (!plugins.find((p) => p.name === '@hypaware/local-fs')) {
        plugins.push({ name: '@hypaware/local-fs' })
      }
      if (!plugins.find((p) => p.name === '@hypaware/format-parquet')) {
        plugins.push({ name: '@hypaware/format-parquet' })
      }
      sinks['local'] = {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: {
          dir: path.join(args.hypHome, 'exports'),
          schedule: '*/5 * * * *',
        },
      }
    } else if (opt.plugin === '@hypaware/central') {
      if (!plugins.find((p) => p.name === '@hypaware/central')) {
        plugins.push({ name: '@hypaware/central' })
      }
      sinks['forward'] = {
        plugin: '@hypaware/central',
        config: { schedule: '*/5 * * * *' },
      }
    }
  }

  for (const clientName of args.clients) {
    const opt = args.clientContributions.find((o) => o.value === clientName)
    if (!opt) continue
    const pluginName = `@hypaware/${clientName}`
    if (!plugins.find((p) => p.name === pluginName)) {
      plugins.push({
        name: /** @type {PluginName} */ (pluginName),
        config: { proxy: '@hypaware/ai-gateway' },
      })
    }
  }

  /** @type {HypAwareV2Config} */
  const config = {
    version: 2,
    plugins,
    query: {
      cache: {
        retention: { default_days: args.retentionDays },
      },
    },
  }
  if (Object.keys(sinks).length > 0) config.sinks = sinks
  return config
}

/**
 * Resolve the HYP_HOME root the same way the kernel does (matches
 * `readObservabilityEnv`). Defaults to `$HOME/.hyp` when not set.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function resolveHypHome(env) {
  if (env.HYP_HOME) return env.HYP_HOME
  const home = env.HOME ?? ''
  return path.join(home, '.hyp')
}

/**
 * Build the default interactive prompt. Uses Node's `readline` against
 * the provided stdin/stdout. Accepts comma-separated indices (1-based)
 * or "all" for every option.
 *
 * @param {WalkthroughOptions} opts
 * @returns {AsyncPickPrompt}
 */
function defaultPromptFactory(opts) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (opts.stdout)
  return async function ask(question) {
    const rl = readline.createInterface({ input, output, terminal: false })
    try {
      output.write(`\n${question.title}\n`)
      question.options.forEach((opt, idx) => {
        output.write(`  ${idx + 1}) ${opt.label}\n`)
        if (opt.summary && opt.summary !== opt.label) {
          output.write(`     ${opt.summary}\n`)
        }
      })
      const answer = await rl.question('select (e.g. 1,3 or "all"): ')
      const trimmed = answer.trim().toLowerCase()
      if (!trimmed) return []
      if (trimmed === 'all') return question.options.map((o) => o.value)
      const indices = trimmed
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= question.options.length)
      return indices.map((n) => question.options[n - 1].value)
    } finally {
      rl.close()
    }
  }
}

/**
 * @param {WalkthroughOptions} opts
 * @returns {AsyncRetentionPrompt}
 */
function defaultRetentionPromptFactory(opts) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (opts.stdout)
  return async function (prompt, defaultDays) {
    const rl = readline.createInterface({ input, output, terminal: false })
    try {
      const answer = await rl.question(`${prompt} [${defaultDays}]: `)
      const trimmed = answer.trim()
      if (!trimmed) return defaultDays
      const parsed = Number.parseInt(trimmed, 10)
      if (!Number.isInteger(parsed) || parsed < 0) return defaultDays
      return parsed
    } finally {
      rl.close()
    }
  }
}

/**
 * Phase 5 picker source contributions. These are the user-facing
 * inputs for the V1 npx first-run flow. Each value maps to a plugin
 * composition rule in `composePickerConfig` — they are NOT tied to
 * the source registry (which carries lower-level source contributions
 * like `ai-gateway` and `otlp`).
 *
 * @type {{ value: PickerSource, label: string, summary: string }[]}
 */
const PICKER_SOURCES = [
  {
    value: 'claude',
    label: 'capture Claude Code conversations',
    summary: 'Configures Claude Code, installs Claude helper skills, and enriches rows from local Claude transcripts.',
  },
  {
    value: 'codex',
    label: 'capture Codex conversations',
    summary: 'Configures Codex to use the local gateway and records Codex request/response traffic.',
  },
  {
    value: 'raw-anthropic',
    label: 'capture raw Anthropic API traffic',
    summary: 'Advanced API proxy mode for scripts, SDK apps, or other tools you manually point at HypAware.',
  },
  {
    value: 'raw-openai',
    label: 'capture raw OpenAI API traffic',
    summary: 'Advanced API proxy mode for OpenAI-compatible clients you manually point at HypAware.',
  },
  {
    value: 'otel',
    label: 'receive OTEL logs/traces/metrics',
    summary: 'Starts a local OTLP HTTP receiver for apps that export OpenTelemetry signals.',
  },
]

/**
 * Phase 5 export options.
 *
 * @type {{ value: PickerExport, label: string, summary: string }[]}
 */
const PICKER_EXPORTS = [
  {
    value: 'keep-local',
    label: 'keep local query cache only',
    summary: 'Stores recent rows locally for hyp query; nothing is exported elsewhere.',
  },
  {
    value: 'local-parquet',
    label: 'export local Parquet files',
    summary: 'Writes scheduled Parquet exports under HYP_HOME/exports for external tools.',
  },
  {
    value: 'configure-later',
    label: 'configure later',
    summary: 'Writes capture config now and leaves export sinks for a later config edit.',
  },
]


/**
 * Drive the Phase 5 first-run picker walkthrough.
 *
 * Unlike the original {@link runWalkthrough}, the picker offers a
 * fixed set of user-facing source labels (Claude Code / Codex / raw
 * Anthropic / raw OpenAI / OTEL) and a fixed set of export labels
 * (`keep-local` / `local-parquet` / `configure-later`). These are
 * translated into a v2 config via {@link composePickerConfig}.
 *
 * When `opts.finale` is provided, the walkthrough also runs the
 * post-write actions described by the bead:
 *   - daemon install (dry-run or real)
 *   - attach for each picked client
 *   - skill install for each picked client
 *   - daemon restart (skipped in dry-run)
 *
 * Spans: `walkthrough.start`, `walkthrough.pick` (logs),
 * `walkthrough.write_config`, `daemon.install`, `client.attach`,
 * `skills.install`, `walkthrough.finish`.
 *
 * @param {RunPickerWalkthroughOptions} opts
 * @returns {Promise<PickerWalkthroughResult>}
 */
export async function runPickerWalkthrough(opts) {
  const { capabilities, stdout, env } = opts
  const log = getLogger('walkthrough')

  await withSpan(
    'walkthrough.start',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.start',
      sources_available: PICKER_SOURCES.length,
      exports_available: PICKER_EXPORTS.length,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  /** @type {PickerPicks} */
  let picks
  if (opts.picks) {
    picks = opts.picks
  } else {
    const ask = opts.prompt ?? defaultPromptFactory(opts)
    const retentionAsk = opts.retentionPrompt ?? defaultRetentionPromptFactory(opts)

    stdout.write('Welcome to HypAware — the local logs+telemetry collector.\n\n')

    const sourceRaw = await ask({
      pickType: 'sources',
      title: 'What do you want to collect? (space to toggle, enter to confirm)',
      options: PICKER_SOURCES.map((s) => ({ value: s.value, label: s.label, summary: s.summary })),
    })
    const sources = /** @type {PickerSource[]} */ (
      sourceRaw.filter((v) => PICKER_SOURCES.some((s) => s.value === v))
    )

    const exportRaw = await ask({
      pickType: 'sinks',
      title: 'Where should HypAware export captured data?',
      options: PICKER_EXPORTS.map((e) => ({ value: e.value, label: e.label, summary: e.summary })),
    })
    const exportChoice = /** @type {PickerExport} */ (
      PICKER_EXPORTS.find((e) => exportRaw.includes(e.value))?.value ?? 'keep-local'
    )

    const retentionDays = await retentionAsk('Cache retention (days)', DEFAULT_RETENTION_DAYS)
    picks = { sources, exportChoice, retentionDays }
  }

  for (const value of picks.sources) {
    log.info('walkthrough.pick', {
      [Attr.COMPONENT]: 'walkthrough',
      pick_type: 'sources',
      pick_value: value,
    })
  }
  log.info('walkthrough.pick', {
    [Attr.COMPONENT]: 'walkthrough',
    pick_type: 'exports',
    pick_value: picks.exportChoice,
  })

  const hypHome = resolveHypHome(env)
  const config = composePickerConfig({
    sources: picks.sources,
    exportChoice: picks.exportChoice,
    retentionDays: picks.retentionDays,
    hypHome,
  })

  const obsEnv = readObservabilityEnv(env)
  const configPath = env.HYP_CONFIG
    ? path.resolve(env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)

  await withSpan(
    'walkthrough.write_config',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.write_config',
      config_path: configPath,
      plugin_count: config.plugins.length,
      status: 'ok',
    },
    async () => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
    },
    { component: 'walkthrough' }
  )

  /** @type {('claude'|'codex')[]} */
  const clientsPicked = []
  if (picks.sources.includes('claude')) clientsPicked.push('claude')
  if (picks.sources.includes('codex')) clientsPicked.push('codex')

  /** @type {FinaleSummary | undefined} */
  let finaleSummary
  if (opts.finale) {
    finaleSummary = await runPickerFinale({
      finale: opts.finale,
      clientsPicked,
      capabilities,
      sources: opts.sources,
      skills: opts.skills,
      config,
      configPath,
      env,
      stdout,
      stderr: opts.stderr,
    })
  }

  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      sources_picked: picks.sources.length,
      export_picked: picks.exportChoice,
      clients_picked: clientsPicked.length,
      retention_days: picks.retentionDays,
      config_path: configPath,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  stdout.write('\n')
  stdout.write(`✓ Wrote ${configPath}\n`)
  if (finaleSummary?.daemonInstall && !finaleSummary.daemonInstall.skipped) {
    const tag = finaleSummary.daemonInstall.dryRun ? '(dry-run) ' : ''
    if (finaleSummary.daemonInstall.targetPath) {
      stdout.write(`${tag}daemon target: ${finaleSummary.daemonInstall.targetPath}\n`)
    }
    const plan = finaleSummary.daemonInstall.plan
    const planBin = plan && typeof plan === 'object' ? /** @type {Record<string, unknown>} */ (plan).binPath : undefined
    if (typeof planBin === 'string' && planBin.length > 0) {
      stdout.write(`${tag}daemon bin: ${planBin}\n`)
    }
  }
  for (const a of finaleSummary?.attach ?? []) {
    const tag = a.dryRun ? '(dry-run) ' : ''
    stdout.write(`${tag}attach: ${a.client} ${a.ok ? 'ok' : 'failed'}\n`)
  }
  if (finaleSummary?.skillsInstalled && finaleSummary.skillsInstalled.length > 0) {
    const tag = finaleSummary.skillsInstalled[0].dryRun ? '(dry-run) ' : ''
    stdout.write(`${tag}skills: ${finaleSummary.skillsInstalled.length} copied\n`)
  }
  stdout.write(`next: hyp query sql 'select count(*) from logs'\n`)

  return {
    exitCode: 0,
    configPath,
    config,
    sourcesPicked: picks.sources,
    exportPicked: picks.exportChoice,
    clientsPicked,
    retentionDays: picks.retentionDays,
    ...(finaleSummary ? { finale: finaleSummary } : {}),
  }
}

/**
 * Compose a v2 config from Phase 5 picker selections.
 *
 * Composition rules (per bead hy-5oz4 §Compose explicit config):
 *   - `@hypaware/ai-gateway` is included when any AI-traffic source is
 *     picked (claude, codex, raw-anthropic, raw-openai).
 *   - The Anthropic upstream is included when claude or raw-anthropic
 *     is picked. OpenAI API and ChatGPT subscription upstreams are
 *     included when codex is picked; raw-openai only adds the OpenAI
 *     API upstream. Provider-specific prefixes let the gateway route
 *     both Codex auth modes.
 *   - `@hypaware/otel` is included when `otel` is picked.
 *   - `@hypaware/claude` and `@hypaware/codex` adapter plugins are
 *     included for their respective high-level sources.
 *   - `@hypaware/local-fs` + `@hypaware/format-parquet` are included
 *     when `exportChoice === 'local-parquet'`, along with a `local`
 *     sink wired to write parquet files under `<HYP_HOME>/exports`.
 *
 * @param {{
 *   sources: PickerSource[],
 *   exportChoice: PickerExport,
 *   retentionDays: number,
 *   hypHome: string,
 * }} args
 * @returns {HypAwareV2Config}
 */
export function composePickerConfig(args) {
  const wantsAnthropic = args.sources.includes('claude') || args.sources.includes('raw-anthropic')
  const wantsCodex = args.sources.includes('codex')
  const wantsOpenai = wantsCodex || args.sources.includes('raw-openai')
  const wantsGateway = wantsAnthropic || wantsOpenai
  const wantsOtel = args.sources.includes('otel')

  /** @type {PluginConfigInstance[]} */
  const plugins = []

  if (wantsGateway) {
    /** @type {{ name: string, base_url: string, path_prefix: string, provider?: string }[]} */
    const upstreams = []
    if (wantsAnthropic) {
      upstreams.push({ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages', provider: 'anthropic' })
    }
    if (wantsOpenai) {
      upstreams.push({ name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/v1', provider: 'openai' })
    }
    if (wantsCodex) {
      upstreams.push({ name: 'chatgpt', base_url: 'https://chatgpt.com', path_prefix: '/backend-api/codex', provider: 'chatgpt' })
    }
    plugins.push({
      name: '@hypaware/ai-gateway',
      config: { listen: '127.0.0.1:8787', upstreams },
    })
  }

  if (wantsOtel) {
    plugins.push({
      name: '@hypaware/otel',
      config: { listen_host: '127.0.0.1', listen_port: 4318 },
    })
  }

  /** @type {Record<string, SinkConfigInstance>} */
  const sinks = {}
  if (args.exportChoice === 'local-parquet') {
    plugins.push({ name: '@hypaware/local-fs' })
    plugins.push({ name: '@hypaware/format-parquet' })
    sinks['local'] = {
      writer: '@hypaware/format-parquet',
      destination: '@hypaware/local-fs',
      config: {
        dir: path.join(args.hypHome, 'exports'),
        schedule: '*/5 * * * *',
      },
    }
  }

  if (args.sources.includes('claude')) {
    plugins.push({
      name: /** @type {PluginName} */ ('@hypaware/claude'),
      config: { proxy: '@hypaware/ai-gateway' },
    })
  }
  if (args.sources.includes('codex')) {
    plugins.push({
      name: /** @type {PluginName} */ ('@hypaware/codex'),
      config: { proxy: '@hypaware/ai-gateway' },
    })
  }

  /** @type {HypAwareV2Config} */
  const config = {
    version: 2,
    plugins,
    query: {
      cache: {
        retention: { default_days: args.retentionDays },
      },
    },
  }
  if (Object.keys(sinks).length > 0) config.sinks = sinks
  return config
}

/**
 * Run the picker finale: daemon install, attach, skills install,
 * daemon restart. Each step emits its own span (`daemon.install`,
 * `client.attach` (via the adapter), `skills.install`).
 *
 * @param {{
 *   finale: PickerFinaleActions,
 *   clientsPicked: ('claude'|'codex')[],
 *   capabilities: CapabilityRegistry,
 *   sources?: { stopAll?: () => Promise<void> },
 *   skills?: { list(): { name: string, clients: ('claude'|'codex')[], sourceDir: string }[] },
 *   config: HypAwareV2Config,
 *   configPath: string,
 *   env: NodeJS.ProcessEnv,
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   stderr: NodeJS.WritableStream | { write(chunk: string): unknown },
 * }} args
 * @returns {Promise<FinaleSummary>}
 */
async function runPickerFinale(args) {
  const { finale, clientsPicked, capabilities, sources, skills, config, configPath, env, stdout, stderr } = args
  const dryRun = finale.dryRun === true
  const homeDir = env.HOME ?? ''

  /** @type {FinaleSummary} */
  const summary = {
    daemonInstall: { skipped: !!finale.skipDaemon, dryRun },
    globalInstall: { skipped: true, installed: false },
    attach: [],
    skillsInstalled: [],
    daemonRestart: { skipped: true, dryRun, ok: false },
  }

  if (!finale.skipDaemon) {
    if (!dryRun) await stopFinaleStartedSources(sources)
    await withSpan(
      'daemon.install',
      {
        [Attr.COMPONENT]: 'walkthrough',
        [Attr.OPERATION]: 'daemon.install',
        dry_run: dryRun,
        config_path: configPath,
        status: 'ok',
      },
      async (span) => {
        const installMod = await import('../daemon/install.js')
        let binPath = finale.binPath ?? (process.argv[1] ?? '')
        if (!dryRun && !finale.binPath && binPath) {
          const durable = await ensureDurableBinForNpx({ binPath, env, stdout, stderr })
          binPath = durable.binPath
          summary.globalInstall = {
            skipped: durable.skipped,
            installed: durable.installed,
            binPath: durable.binPath,
            ...(durable.packageSpec ? { packageSpec: durable.packageSpec } : {}),
          }
          if (span && typeof span.setAttribute === 'function') {
            span.setAttribute('global_install_skipped', durable.skipped)
            span.setAttribute('global_install_installed', durable.installed)
          }
        }
        /** @type {DaemonInstallOptions} */
        const options = {
          binPath,
          configPath,
          ...(homeDir ? { homeDir } : {}),
        }
        if (dryRun) {
          const plan = installMod.renderDaemonInstall(options)
          summary.daemonInstall = {
            skipped: false,
            dryRun: true,
            targetPath: plan.targetPath,
            plan: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (plan)),
          }
          if (span && typeof span.setAttribute === 'function') {
            span.setAttribute('target_path', plan.targetPath)
            span.setAttribute('bin_path', plan.binPath)
            span.setAttribute('platform', plan.platform)
          }
        } else {
          const plan = await installMod.installDaemon(options)
          summary.daemonInstall = {
            skipped: false,
            dryRun: false,
            targetPath: plan.targetPath,
          }
          if (span && typeof span.setAttribute === 'function') {
            span.setAttribute('target_path', plan.targetPath)
            span.setAttribute('bin_path', plan.binPath)
            span.setAttribute('platform', plan.platform)
          }
        }
      },
      { component: 'walkthrough' }
    )
  }

  if (clientsPicked.length > 0 && capabilities.has('hypaware.ai-gateway')) {
    /** @type {AiGatewayCapability} */
    const gateway = capabilities.require('hyp-core/walkthrough', 'hypaware.ai-gateway', '^2.0.0')
    for (const client of clientsPicked) {
      const adapter = gateway.getClient(client)
      if (!adapter) {
        summary.attach.push({ client, dryRun, ok: false })
        continue
      }
      let endpoint = configuredGatewayEndpoint(config) ?? 'http://127.0.0.1:0'
      try {
        endpoint = gateway.localEndpoint()
      } catch {}
      try {
        await adapter.attach({
          endpoint,
          config: {},
          stdout,
          stderr,
          dryRun,
        })
        summary.attach.push({ client, dryRun, ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        stderr.write(`attach ${client} failed: ${message}\n`)
        summary.attach.push({ client, dryRun, ok: false })
      }
    }
  }

  if (clientsPicked.length > 0 && skills) {
    await withSpan(
      'skills.install',
      {
        [Attr.COMPONENT]: 'walkthrough',
        [Attr.OPERATION]: 'skills.install',
        dry_run: dryRun,
        client_count: clientsPicked.length,
        status: 'ok',
      },
      async (span) => {
        for (const skill of skills.list()) {
          for (const targetClient of skill.clients) {
            if (!clientsPicked.includes(targetClient)) continue
            const dest = path.join(homeDir, clientSkillDir(targetClient), skill.name)
            if (dryRun) {
              stdout.write(`(dry-run) Would install skill '${skill.name}' → ${dest}\n`)
            } else {
              await fs.rm(dest, { recursive: true, force: true })
              await copyDir(skill.sourceDir, dest)
              stdout.write(`installed skill '${skill.name}' → ${dest}\n`)
            }
            summary.skillsInstalled.push({ name: skill.name, client: targetClient, dest, dryRun })
          }
        }
        if (span && typeof span.setAttribute === 'function') {
          span.setAttribute('installed_count', summary.skillsInstalled.length)
        }
      },
      { component: 'walkthrough' }
    )
  }

  if (!finale.skipDaemon && !finale.skipDaemonRestart && !dryRun) {
    try {
      const { restartServiceDaemon } = await import('../daemon/install.js')
      await restartServiceDaemon({ ...(homeDir ? { homeDir } : {}) })
      summary.daemonRestart = { skipped: false, dryRun: false, ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      stderr.write(`daemon restart failed: ${message}\n`)
      summary.daemonRestart = { skipped: false, dryRun: false, ok: false }
    }
  } else if (dryRun && !finale.skipDaemon) {
    summary.daemonRestart = { skipped: false, dryRun: true, ok: true }
    stdout.write(`(dry-run) Would restart the daemon\n`)
  }

  return summary
}

/**
 * Init boots bundled plugins so it can discover clients and presets.
 * Some plugins bind listeners during activation; release those before
 * launchd starts the freshly installed daemon or the daemon can race
 * the init process for the same configured ports.
 *
 * @param {{ stopAll?: () => Promise<void> } | undefined} sources
 */
async function stopFinaleStartedSources(sources) {
  if (typeof sources?.stopAll !== 'function') return
  try {
    await sources.stopAll()
  } catch {
    // Best-effort. The dispatcher cleanup will make the same call on
    // command exit; this early stop is only to avoid daemon port races.
  }
}

/**
 * Resolve the gateway endpoint from the just-written config. Init
 * attaches clients before the daemon's gateway source is live in this
 * process, so `localEndpoint()` cannot be the only source of truth.
 *
 * @param {HypAwareV2Config} config
 * @returns {string | undefined}
 */
function configuredGatewayEndpoint(config) {
  const entry = config.plugins?.find((p) => p.name === '@hypaware/ai-gateway')
  const cfg = entry?.config
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined
  const listen = /** @type {Record<string, unknown>} */ (cfg).listen
  if (typeof listen !== 'string') return undefined
  return endpointFromListen(listen)
}

/**
 * @param {string} listen
 * @returns {string | undefined}
 */
function endpointFromListen(listen) {
  const idx = listen.lastIndexOf(':')
  if (idx === -1) return undefined
  const rawHost = listen.slice(0, idx)
  const rawPort = listen.slice(idx + 1)
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) {
    return undefined
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) return undefined
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${formattedHost}:${port}`
}

/** @param {'claude'|'codex'} client */
function clientSkillDir(client) {
  if (client === 'claude') return '.claude/skills'
  return '.codex/skills'
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 */
async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(from, to)
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
    }
  }
}
