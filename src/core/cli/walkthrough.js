// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { defaultConfigPath, prepareLocalConfigWrite } from '../config/schema.js'
import { configuredGatewayEndpoint } from '../config/gateway_endpoint.js'
import { readObservabilityEnv } from '../observability/env.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { isWithinDir } from '../runtime/contribution_names.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { ensureDurableBinForNpx } from './global_install.js'
import { detectClientSources } from './detect.js'
import { multiselect, select, text } from './tui/index.js'
import { isPromptCancelledError } from './tui/runtime.js'
import { shouldUseTui } from './tui-router.js'

/**
 * Exit code returned when the user cancels the picker walkthrough
 * (escape / ctrl+c at any TUI prompt). 130 matches the POSIX
 * convention for SIGINT and keeps the dispatcher from reporting the
 * cancel as an unhandled exception.
 */
export const WALKTHROUGH_CANCEL_EXIT_CODE = 130

/**
 * @import { AiGatewayCapability, CapabilityRegistry, HypAwareV2Config, PluginConfigInstance, PluginName, SinkConfigInstance } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ClientDescriptor } from '../plugin_catalog.js'
 * @import { DaemonInstallOptions } from '../daemon/types.d.ts'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../registry/types.d.ts'
 */

/**
 * @import {
 *   AsyncBackfillConsentPrompt,
 *   AsyncPickPrompt,
 *   AsyncRetentionPrompt,
 *   BackfillFinaleResult,
 *   PickerBackfillRunner,
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
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout'>} opts
 * @returns {AsyncPickPrompt}
 */
function legacyNumberedPromptFactory(opts) {
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
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout'>} opts
 * @returns {AsyncRetentionPrompt}
 */
function legacyRetentionPromptFactory(opts) {
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
 * Build the interactive "overwrite existing config?" confirm. Defaults
 * to **no** — a bare Enter keeps the existing config — so a stray
 * keystroke never destroys a working install. On yes the caller backs
 * the file up before replacing it.
 *
 * @param {{ stdin?: NodeJS.ReadableStream, stdout: { write(chunk: string): unknown } }} opts
 * @returns {(targetPath: string) => Promise<boolean>}
 */
function defaultOverwriteConfirmFactory(opts) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (opts.stdout)
  return async function (targetPath) {
    const rl = readline.createInterface({ input, output, terminal: false })
    try {
      const answer = await rl.question(
        `A config already exists at ${targetPath}. Overwrite it (a backup is kept)? [y/N]: `
      )
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      rl.close()
    }
  }
}

/**
 * Render each pick category through the new TUI multiselect prompt.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncPickPrompt}
 */
function tuiPromptFactory(opts) {
  return async function ask(question) {
    const result = await multiselect({
      title: question.title,
      options: question.options.map((o) => ({
        value: o.value,
        label: o.label,
        ...(o.summary && o.summary !== o.label ? { summary: o.summary } : {}),
        ...(o.checked ? { checked: true } : {}),
      })),
      ...(question.bounds ? { bounds: question.bounds } : {}),
      clearOnResolve: true,
      stdin: opts.stdin ?? process.stdin,
      stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (opts.stdout)),
      env: opts.env,
    })
    return /** @type {string[]} */ (result)
  }
}

/**
 * Prompt for the cache retention window through the TUI text input.
 * Empty input falls through to the supplied default to match the legacy
 * behavior.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncRetentionPrompt}
 */
function tuiRetentionPromptFactory(opts) {
  return async function (prompt, defaultDays) {
    const v = await text({
      title: prompt,
      default: String(defaultDays),
      validate: (s) => {
        if (s.trim() === '') return null
        const n = Number.parseInt(s.trim(), 10)
        return Number.isInteger(n) && n >= 0 ? null : 'enter a non-negative integer'
      },
      clearOnResolve: true,
      stdin: opts.stdin ?? process.stdin,
      stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (opts.stdout)),
      env: opts.env,
    })
    const trimmed = v.trim()
    if (trimmed === '') return defaultDays
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isInteger(parsed) || parsed < 0) return defaultDays
    return parsed
  }
}

/**
 * Route between the TUI and legacy prompts. Tests and CI keep getting
 * the legacy numbered list — only real TTYs without `HYP_NO_TUI=1` see
 * the new interactive multiselect.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncPickPrompt}
 */
function defaultPromptFactory(opts) {
  if (shouldUseTui(opts)) return tuiPromptFactory(opts)
  return legacyNumberedPromptFactory(opts)
}

/**
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncRetentionPrompt}
 */
function defaultRetentionPromptFactory(opts) {
  if (shouldUseTui(opts)) return tuiRetentionPromptFactory(opts)
  return legacyRetentionPromptFactory(opts)
}

/**
 * Build the interactive backfill-consent prompt. Routes to the TUI
 * arrow-navigable yes/no select on a real TTY, else a legacy readline
 * yes/no. Both default to yes so a bare enter opts in — the bead's
 * "default backfill to enabled, but let the user choose no".
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncBackfillConsentPrompt}
 */
function defaultBackfillConsentPromptFactory(opts) {
  if (shouldUseTui(opts)) return tuiBackfillConsentPromptFactory(opts)
  return legacyBackfillConsentPromptFactory(opts)
}

/**
 * Render the backfill consent as a `select` so it matches the look and
 * feel of the source picker (arrow keys + pointer) rather than a plain
 * y/n confirm. Cursor defaults to "Yes" so a bare enter opts in.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncBackfillConsentPrompt}
 */
function tuiBackfillConsentPromptFactory(opts) {
  return async function ({ providers, retentionDays }) {
    const choice = await select({
      title: backfillConsentTitle(providers, retentionDays),
      options: [
        { value: 'yes', label: 'Yes — import it now', summary: 'Reads local transcripts into the query cache.' },
        { value: 'no', label: 'No — skip for now', summary: 'You can import later with hyp backfill.' },
      ],
      default: 'yes',
      clearOnResolve: true,
      stdin: opts.stdin ?? process.stdin,
      stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (opts.stdout)),
      env: opts.env,
    })
    return choice === 'yes'
  }
}

/**
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout'>} opts
 * @returns {AsyncBackfillConsentPrompt}
 */
function legacyBackfillConsentPromptFactory(opts) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (opts.stdout)
  return async function ({ providers, retentionDays }) {
    const rl = readline.createInterface({ input, output, terminal: false })
    try {
      const answer = await rl.question(`${backfillConsentTitle(providers, retentionDays)} [Y/n]: `)
      const trimmed = answer.trim().toLowerCase()
      // Default yes: only an explicit no opts out.
      return !(trimmed === 'n' || trimmed === 'no')
    } finally {
      rl.close()
    }
  }
}

/**
 * @param {string[]} providers
 * @param {number} retentionDays
 * @returns {string}
 */
function backfillConsentTitle(providers, retentionDays) {
  return `Import local ${providers.join(', ')} history now (last ${retentionDays} days)?`
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
 * @ref LLP 0011#interactive-walkthrough [implements] — canonical npx first-run; composes plugin-contributed what/where picks
 */
export async function runPickerWalkthrough(opts) {
  const { capabilities, stdout, env } = opts
  const log = getLogger('walkthrough')

  // Autodetect installed client tools so the picker can pre-check them.
  // Interactive only: when `picks` are supplied (`--yes` / `--dry-run` /
  // presets) the selection is explicit and must stay deterministic, so
  // detection is skipped entirely. Best-effort — a detector failure
  // leaves the set empty rather than blocking onboarding.
  // @ref LLP 0011#autodetect-vs-default [implements] — detection only seeds the initial checkbox; never forces a source on
  const interactive = !opts.picks
  /** @type {Set<PickerSource>} */
  let detected = new Set()
  if (interactive) {
    const detect = opts.detect ?? detectClientSources
    try {
      detected = await detect({ env })
    } catch {
      detected = new Set()
    }
  }

  await withSpan(
    'walkthrough.start',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.start',
      sources_available: PICKER_SOURCES.length,
      exports_available: PICKER_EXPORTS.length,
      sources_detected: detected.size,
      detected_sources: [...detected].join(','),
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  /** @type {PickerPicks} */
  let picks
  // Provenance of the export choice, for telemetry. Export is no longer
  // asked interactively — local-parquet is the out-of-the-box default —
  // so the origin is `user` only when an explicit `--export` flag was
  // threaded in on the pre-baked path; otherwise the pick was defaulted.
  let exportOrigin = 'default'
  if (opts.picks) {
    picks = opts.picks
    exportOrigin = opts.exportOrigin ?? 'default'
  } else {
    const ask = opts.prompt ?? defaultPromptFactory(opts)
    const retentionAsk = opts.retentionPrompt ?? defaultRetentionPromptFactory(opts)

    stdout.write('Welcome to HypAware — the local logs+telemetry collector.\n\n')

    try {
      const sourceRaw = await ask({
        pickType: 'sources',
        title: 'What do you want to collect? (space to toggle, enter to confirm)',
        options: PICKER_SOURCES.map((s) => ({
          value: s.value,
          label: detected.has(s.value) ? `${s.label} · detected` : s.label,
          summary: s.summary,
          ...(detected.has(s.value) ? { checked: true } : {}),
        })),
      })
      const sources = /** @type {PickerSource[]} */ (
        sourceRaw.filter((v) => PICKER_SOURCES.some((s) => s.value === v))
      )

      // Export destination is not asked interactively. A local query
      // cache is always kept; on top of it we default to scheduled local
      // Parquet exports so `npx hypaware` produces durable files out of
      // the box. Other destinations (keep-local only, configure-later,
      // S3, …) remain available via `hyp init --export <choice>` and by
      // editing the written config later.
      const exportChoice = /** @type {PickerExport} */ ('local-parquet')

      const retentionDays = await retentionAsk('Cache retention (days)', DEFAULT_RETENTION_DAYS)
      picks = { sources, exportChoice, retentionDays }
    } catch (err) {
      if (isPromptCancelledError(err)) {
        return await cancelledResult(opts)
      }
      throw err
    }
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
    pick_origin: exportOrigin,
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

  // Guard against clobbering an existing local config (the non-destructive
  // half of #111). Interactive runs prompt for confirmation;
  // non-interactive runs require `--force`. Either path backs up the
  // existing file before replacing it.
  // @ref LLP 0031#local-layer-writers [implements] — init overwrite safety on the walkthrough write path
  const overwriteConfirm = interactive
    ? (opts.confirmOverwrite ?? defaultOverwriteConfirmFactory({ stdin: opts.stdin, stdout }))
    : undefined
  const guard = await prepareLocalConfigWrite({
    targetPath: configPath,
    force: opts.force,
    ...(overwriteConfirm ? { confirmOverwrite: overwriteConfirm } : {}),
  })
  if (!guard.proceed) {
    opts.stderr.write(`hyp init: ${guard.message}\n`)
    return overwriteAbortedResult({ opts, configPath, config, picks })
  }
  if (guard.backupPath) {
    stdout.write(`Backed up existing config to ${guard.backupPath}\n`)
  }

  await withSpan(
    'walkthrough.write_config',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.write_config',
      config_path: configPath,
      plugin_count: config.plugins?.length ?? 0,
      ...(guard.backupPath ? { config_backed_up: true } : {}),
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
      agents: opts.agents,
      config,
      configPath,
      env,
      stdout,
      stderr: opts.stderr,
      retentionDays: picks.retentionDays,
      // Interactive mode is the absence of pre-baked picks: only then do
      // we prompt for backfill consent. `--yes` / `--dry-run` carry picks
      // and backfill runs automatically.
      interactive: !opts.picks,
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.backfill ? { backfill: opts.backfill } : {}),
      ...(opts.backfillConsentPrompt ? { backfillConsentPrompt: opts.backfillConsentPrompt } : {}),
    })
  }

  const cancelled = finaleSummary?.cancelled === true
  const exitCode = cancelled ? WALKTHROUGH_CANCEL_EXIT_CODE : 0

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
      ...(cancelled ? { exit_code: WALKTHROUGH_CANCEL_EXIT_CODE } : {}),
      status: cancelled ? 'cancelled' : 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  if (cancelled) writeCancelledNotice(opts.stderr)

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
  if (finaleSummary?.agentsInstalled && finaleSummary.agentsInstalled.length > 0) {
    const tag = finaleSummary.agentsInstalled[0].dryRun ? '(dry-run) ' : ''
    stdout.write(`${tag}agents: ${finaleSummary.agentsInstalled.length} copied\n`)
  }
  stdout.write(`next: hyp query sql 'select count(*) from logs'\n`)

  return {
    exitCode,
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
 * @ref LLP 0011#no-architectural-names [implements] — user picks what/where; HypAware derives the explicit plugin set, no role labels
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
 * agents install, daemon restart. Each step emits its own span
 * (`daemon.install`, `client.attach` (via the adapter),
 * `skills.install`, `agents.install`).
 *
 * @param {{
 *   finale: PickerFinaleActions,
 *   clientsPicked: ('claude'|'codex')[],
 *   capabilities: CapabilityRegistry,
 *   sources?: { stopAll?: () => Promise<void> },
 *   skills?: { list(): { name: string, clients: ('claude'|'codex')[], sourceDir: string }[] },
 *   agents?: { list(): { name: string, clients: ('claude'|'codex')[], sourceFile: string }[] },
 *   config: HypAwareV2Config,
 *   configPath: string,
 *   env: NodeJS.ProcessEnv,
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   stderr: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   retentionDays: number,
 *   interactive: boolean,
 *   stdin?: NodeJS.ReadableStream,
 *   backfill?: PickerBackfillRunner,
 *   backfillConsentPrompt?: AsyncBackfillConsentPrompt,
 * }} args
 * @returns {Promise<FinaleSummary>}
 */
async function runPickerFinale(args) {
  const { finale, clientsPicked, capabilities, sources, skills, agents, config, configPath, env, stdout, stderr } = args
  const dryRun = finale.dryRun === true
  const homeDir = env.HOME ?? ''

  // The attach/start cutoff: backfill imports history strictly before
  // this instant so it never overlaps with live gateway capture, which
  // takes over once clients are attached and the daemon (re)starts below.
  const backfillUntil = new Date().toISOString()

  /** @type {FinaleSummary} */
  const summary = {
    daemonInstall: { skipped: !!finale.skipDaemon, dryRun },
    globalInstall: { skipped: true, installed: false },
    attach: [],
    skillsInstalled: [],
    agentsInstalled: [],
    daemonRestart: { skipped: true, dryRun, ok: false },
    backfill: [],
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

  const descriptorMap = clientsPicked.length > 0 && (skills || agents)
    ? await buildWalkthroughClientDescriptorMap()
    : new Map()

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
        let printedAny = false
        for (const skill of skills.list()) {
          for (const targetClient of skill.clients) {
            if (!clientsPicked.includes(targetClient)) continue
            const skillDir = descriptorMap.get(targetClient)?.skillDir
            if (!skillDir) continue
            const baseDir = path.join(homeDir, skillDir)
            const dest = path.join(baseDir, skill.name)
            // Defense in depth: registration rejects traversal names, but the
            // skill dir comes from a plugin manifest, so re-check containment.
            if (!isWithinDir(dest, baseDir)) {
              stderr.write(`warning: skill '${skill.name}' for ${targetClient} resolves outside ${baseDir}; skipped\n`)
              continue
            }
            // Separate the skills block from the preceding attach output.
            if (!printedAny) stdout.write('\n')
            printedAny = true
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
        // Trailing blank line so the next step (backfill prompt) stands apart.
        if (printedAny) stdout.write('\n')
        if (span && typeof span.setAttribute === 'function') {
          span.setAttribute('installed_count', summary.skillsInstalled.length)
        }
      },
      { component: 'walkthrough' }
    )
  }

  if (clientsPicked.length > 0 && agents) {
    await withSpan(
      'agents.install',
      {
        [Attr.COMPONENT]: 'walkthrough',
        [Attr.OPERATION]: 'agents.install',
        dry_run: dryRun,
        client_count: clientsPicked.length,
        status: 'ok',
      },
      async (span) => {
        let printedAny = false
        for (const agent of agents.list()) {
          for (const targetClient of agent.clients) {
            if (!clientsPicked.includes(targetClient)) continue
            const agentDir = descriptorMap.get(targetClient)?.agentDir
            if (!agentDir) continue
            const baseDir = path.join(homeDir, agentDir)
            const dest = path.join(baseDir, `${agent.name}.md`)
            // Defense in depth: registration rejects traversal names, but the
            // agent dir comes from a plugin manifest, so re-check containment.
            if (!isWithinDir(dest, baseDir)) {
              stderr.write(`warning: agent '${agent.name}' for ${targetClient} resolves outside ${baseDir}; skipped\n`)
              continue
            }
            if (!printedAny) stdout.write('\n')
            printedAny = true
            if (dryRun) {
              stdout.write(`(dry-run) Would install agent '${agent.name}' → ${dest}\n`)
            } else {
              await fs.mkdir(path.dirname(dest), { recursive: true })
              await fs.copyFile(agent.sourceFile, dest)
              stdout.write(`installed agent '${agent.name}' → ${dest}\n`)
            }
            summary.agentsInstalled.push({ name: agent.name, client: targetClient, dest, dryRun })
          }
        }
        if (printedAny) stdout.write('\n')
        if (span && typeof span.setAttribute === 'function') {
          span.setAttribute('installed_count', summary.agentsInstalled.length)
        }
      },
      { component: 'walkthrough' }
    )
  }

  // Backfill: import each picked client's local history after the config
  // write and before the daemon (re)start that resumes live capture.
  // Runs independent of the daemon — `--no-daemon` still backfills, since
  // it is a local file import — and is bounded by the retention window and
  // the `backfillUntil` cutoff so it never double-counts live rows.
  await runFinaleBackfill({
    ...(args.backfill ? { backfill: args.backfill } : {}),
    ...(args.backfillConsentPrompt ? { backfillConsentPrompt: args.backfillConsentPrompt } : {}),
    clientsPicked,
    interactive: args.interactive,
    dryRun,
    retentionDays: args.retentionDays,
    until: backfillUntil,
    ...(args.stdin ? { stdin: args.stdin } : {}),
    stdout,
    stderr,
    env,
    summary,
  })

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
 * Run the onboarding backfill step. For each picked client that has a
 * registered backfill provider (intersection of `clientsPicked` and
 * `backfill.available`), import its local history into the query cache.
 *
 * Consent rules mirror the bead contract:
 *   - interactive (no pre-baked picks): prompt, defaulting to yes;
 *   - `--yes` / `--dry-run` (picks supplied): run automatically;
 *   - `--dry-run`: scan and report a plan but write nothing;
 *   - `--no-daemon`: still backfill — it is a local file import.
 *
 * Each provider's outcome is pushed onto `summary.backfill` and a
 * one-line status is written to stdout. Wrapped in a `walkthrough.backfill`
 * span so the step is observable even when no provider runs.
 *
 * @param {{
 *   backfill?: PickerBackfillRunner,
 *   backfillConsentPrompt?: AsyncBackfillConsentPrompt,
 *   clientsPicked: ('claude'|'codex')[],
 *   interactive: boolean,
 *   dryRun: boolean,
 *   retentionDays: number,
 *   until: string,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   stderr: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   env: NodeJS.ProcessEnv,
 *   summary: FinaleSummary,
 * }} args
 * @returns {Promise<void>}
 */
async function runFinaleBackfill(args) {
  const { backfill, clientsPicked, interactive, dryRun, retentionDays, until, stdout, stderr, env, summary } = args
  if (!backfill) return
  const available = new Set(backfill.available)
  const providers = clientsPicked.filter((c) => available.has(c))
  if (providers.length === 0) return

  let consent = true
  let cancelled = false
  if (interactive) {
    const ask = args.backfillConsentPrompt ?? defaultBackfillConsentPromptFactory({
      ...(args.stdin ? { stdin: args.stdin } : {}),
      stdout,
      env,
    })
    try {
      consent = await ask({ providers, retentionDays })
    } catch (err) {
      if (!isPromptCancelledError(err)) throw err
      cancelled = true
      consent = false
      summary.cancelled = true
    }
  }

  await withSpan(
    'walkthrough.backfill',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.backfill',
      provider_count: providers.length,
      providers: providers.join(','),
      dry_run: dryRun,
      interactive,
      consent,
      consent_cancelled: cancelled,
      retention_days: retentionDays,
      until,
      ...(cancelled ? { exit_code: WALKTHROUGH_CANCEL_EXIT_CODE } : {}),
      status: cancelled ? 'cancelled' : 'ok',
    },
    async (span) => {
      if (!consent) {
        stdout.write(cancelled ? 'backfill: skipped (cancelled)\n' : 'backfill: skipped (declined)\n')
        return
      }
      // Guard each provider so one failure neither aborts sibling
      // providers nor the daemon (re)start that resumes live capture —
      // matching the attach/restart resilience above.
      for (const provider of providers) {
        try {
          // Importing local history reads and writes potentially
          // thousands of rows with no other output. Without this line
          // the resolved consent frame is the last thing on screen, so a
          // multi-second import looks like the prompt is stuck. Announce
          // the work before it starts so the wizard visibly moves on.
          const startTag = dryRun ? '(dry-run) ' : ''
          stdout.write(`${startTag}backfill ${provider}: importing local history…\n`)
          const entry = await backfill.run({ provider, dryRun, retentionDays, until })
          summary.backfill.push(entry)
          const tag = entry.dryRun ? '(dry-run) ' : ''
          stdout.write(
            `${tag}backfill ${entry.provider}: ${entry.ok ? 'ok' : 'failed'} ` +
            `(scanned ${entry.scanned}, wrote ${entry.rowsWritten}, skipped ${entry.skipped})\n`
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          stderr.write(`backfill ${provider} failed: ${message}\n`)
          summary.backfill.push({ provider, dryRun, ok: false, scanned: 0, rowsWritten: 0, skipped: 0 })
        }
      }
      if (span && typeof span.setAttribute === 'function') {
        span.setAttribute('providers_run', summary.backfill.length)
        span.setAttribute(
          'rows_written',
          summary.backfill.reduce((acc, r) => acc + r.rowsWritten, 0)
        )
      }
    },
    { component: 'walkthrough' }
  )
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
 * @returns {Promise<Map<string, ClientDescriptor>>}
 */
async function buildWalkthroughClientDescriptorMap() {
  /** @type {Map<string, ClientDescriptor>} */
  const map = new Map()
  try {
    const bundled = await discoverBundledPlugins()
    const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
    for (const [clientName, descriptor] of catalog.clientDescriptors) {
      map.set(clientName, descriptor)
    }
  } catch { /* discovery failure → empty map */ }
  return map
}

/**
 * Result returned when the overwrite guard refuses (non-interactive,
 * `--force` absent) or the user declines the interactive prompt. No
 * config is written; exit code 1 surfaces the refusal to the caller.
 *
 * @param {{
 *   opts: RunPickerWalkthroughOptions,
 *   configPath: string,
 *   config: HypAwareV2Config,
 *   picks: PickerPicks,
 * }} args
 * @returns {Promise<PickerWalkthroughResult>}
 */
async function overwriteAbortedResult({ opts, configPath, config, picks }) {
  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      config_path: configPath,
      exit_code: 1,
      status: 'aborted',
      hyp_reason: 'config_exists',
    },
    async () => {},
    { component: 'walkthrough' }
  )
  return {
    exitCode: 1,
    configPath,
    config,
    sourcesPicked: picks.sources,
    exportPicked: picks.exportChoice,
    clientsPicked: [],
    retentionDays: picks.retentionDays,
  }
}

/**
 * Build the canonical cancel result returned by {@link runPickerWalkthrough}
 * when the user cancels via escape / ctrl+c. Writes a one-line cancel
 * notice to stderr so the dispatcher does not eat it silently, and
 * surfaces {@link WALKTHROUGH_CANCEL_EXIT_CODE} (130, matching SIGINT
 * convention) as the exit code. The returned object satisfies the
 * required shape of {@link PickerWalkthroughResult} but contains no
 * config — callers that key off `exitCode` already short-circuit on
 * non-zero values.
 *
 * @param {RunPickerWalkthroughOptions} opts
 * @returns {Promise<PickerWalkthroughResult>}
 */
async function cancelledResult(opts) {
  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      sources_picked: 0,
      export_picked: '',
      clients_picked: 0,
      retention_days: DEFAULT_RETENTION_DAYS,
      config_path: '',
      exit_code: WALKTHROUGH_CANCEL_EXIT_CODE,
      status: 'cancelled',
    },
    async () => {},
    { component: 'walkthrough' }
  )
  writeCancelledNotice(opts.stderr)
  return {
    exitCode: WALKTHROUGH_CANCEL_EXIT_CODE,
    configPath: '',
    config: /** @type {HypAwareV2Config} */ ({
      version: 2,
      plugins: [],
      query: { cache: { retention: { default_days: DEFAULT_RETENTION_DAYS } } },
    }),
    sourcesPicked: [],
    exportPicked: 'keep-local',
    clientsPicked: [],
    retentionDays: DEFAULT_RETENTION_DAYS,
  }
}

/**
 * @param {NodeJS.WritableStream | { write(chunk: string): unknown }} stderr
 */
function writeCancelledNotice(stderr) {
  try {
    stderr.write('hyp init: cancelled\n')
  } catch {
    // best-effort: stderr might be closed during cleanup
  }
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
