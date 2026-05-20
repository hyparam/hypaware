// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { defaultConfigPath } from '../config/schema.js'
import { readObservabilityEnv } from '../observability/env.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').AiGatewayCapability} AiGatewayCapability */
/** @typedef {import('../../../collectivus-plugin-kernel-types').CapabilityRegistry} CapabilityRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').HypAwareV2Config} HypAwareV2Config */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginConfigInstance} PluginConfigInstance */
/** @typedef {import('../registry/sources.js').ExtendedSourceRegistry} ExtendedSourceRegistry */
/** @typedef {import('../registry/sinks.js').ExtendedSinkRegistry} ExtendedSinkRegistry */

/**
 * @typedef {Object} WalkthroughOptions
 * @property {ExtendedSourceRegistry} sources
 * @property {ExtendedSinkRegistry}   sinks
 * @property {CapabilityRegistry}     capabilities
 * @property {NodeJS.WritableStream | { write(chunk: string): unknown }} stdout
 * @property {NodeJS.WritableStream | { write(chunk: string): unknown }} stderr
 * @property {NodeJS.ReadableStream} [stdin]
 * @property {NodeJS.ProcessEnv}     env
 * @property {AsyncPickPrompt}       [prompt]   Override prompt resolver (tests pre-bake answers).
 * @property {AsyncRetentionPrompt}  [retentionPrompt]
 */

/**
 * @typedef {(question: WalkthroughQuestion) => Promise<string[]>} AsyncPickPrompt
 * Prompt for one category (sources / sinks / clients). Returns the
 * selected `value` strings in the order the user picked them.
 */

/**
 * @typedef {(prompt: string, defaultDays: number) => Promise<number>} AsyncRetentionPrompt
 */

/**
 * @typedef {Object} WalkthroughQuestion
 * @property {'sources'|'sinks'|'clients'} pickType
 * @property {string} title
 * @property {WalkthroughOption[]} options
 * @property {{ min?: number, max?: number }} [bounds]
 */

/**
 * @typedef {Object} WalkthroughOption
 * @property {string} value     Stable identifier (source name, sink contribution key, client name).
 * @property {string} label     User-visible label.
 * @property {string} [summary]
 * @property {string} [plugin]
 */

/**
 * @typedef {Object} WalkthroughResult
 * @property {number} exitCode
 * @property {string} configPath
 * @property {HypAwareV2Config} config
 * @property {string[]} sourcesPicked
 * @property {string[]} sinksPicked
 * @property {string[]} clientsPicked
 * @property {number} retentionDays
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
  const gateway = capabilities.require('hyp-core/walkthrough', 'hypaware.ai-gateway', '^1.0.0')
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

  /** @type {Record<string, import('../../../collectivus-plugin-kernel-types').SinkConfigInstance>} */
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
        name: /** @type {import('../../../collectivus-plugin-kernel-types').PluginName} */ (pluginName),
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
