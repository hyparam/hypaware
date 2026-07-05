// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'

import { Attr, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { defaultConfigPath, prepareLocalConfigWrite } from '../config/schema.js'
import { runPickerWalkthrough } from '../cli/walkthrough.js'
import { select } from '../cli/tui/index.js'
import { isPromptCancelledError } from '../cli/tui/runtime.js'
import { shouldUseTui } from '../cli/tui-router.js'
import { validateConfig } from '../config/validate.js'
import { collectHypAwareStatus } from '../daemon/status.js'
import { runBackfillProvider } from './backfill.js'
import { buildKnownPluginsForCtx } from './plugin.js'
import { runStatus } from './status.js'
import { isTty } from '../cli/stdio.js'

/**
 * @import { CommandRunContext } from '../../../collectivus-plugin-kernel-types.js'
 * @import { HypAwareStatusReport } from '../../../src/core/daemon/types.js'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../../../src/core/registry/types.js'
 * @import { InitFlags, PickerBackfillRunner, PickerExport, PickerExportOrigin } from '../../../src/core/cli/types.js'
 */

/**
 * Build the onboarding backfill runner the picker finale uses to import
 * a picked client's local history right after writing config. Wraps the
 * shared `runBackfillProvider` path so finale-imported rows land in the
 * exact same per-source tables as `hyp backfill <provider>` and live
 * capture. `available` lists registered provider names so the finale can
 * intersect them with the picked clients.
 *
 * @param {CommandRunContext} ctx
 * @returns {PickerBackfillRunner}
 */
function buildPickerBackfillRunner(ctx) {
  return {
    available: ctx.backfills.list().map((p) => p.name),
    async run({ provider, dryRun, retentionDays, until }) {
      const result = await runBackfillProvider({ ctx, provider, dryRun, retentionDays, until })
      return {
        provider,
        dryRun,
        ok: result.ok,
        scanned: result.scanned,
        rowsWritten: result.rowsWritten,
        skipped: result.skipped,
      }
    },
  }
}

/**
 * `hyp init [preset]`
 *
 * Without arguments runs the interactive walkthrough (TTY only; when
 * stdout is not a TTY the command prints the available presets and
 * exits non-zero so scripts get a deterministic failure instead of
 * blocking on stdin).
 *
 * With a `<preset>` argument resolves the preset through the kernel
 * `InitPresetRegistry` and invokes its `run(argv, ctx)`. Unknown
 * presets land on stderr with the list of available names.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
/**
 * No-arg / `hyp init` entry gate for an already-configured install.
 *
 * Re-running `hypaware` on a working install used to jump straight into
 * the first-run picker as if starting fresh. Instead, when a valid config
 * is present, print a short friendly summary of what's set up and offer a
 * small menu: reconfigure, see full status, or quit (the default; a bare
 * enter changes nothing).
 *
 * @ref LLP 0011#returning-to-a-configured-install [implements]: the picker
 *   stays the first-run path; this gate only fronts it once a config exists.
 *
 * Returns:
 *  - `'first-run'`: no valid config; caller runs the walkthrough as before
 *  - `'reconfigure'`: user chose to re-run the picker
 *  - `'done'`: user quit or viewed status; caller should exit 0
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<'first-run' | 'reconfigure' | 'done'>}
 */
async function runConfiguredEntry(ctx) {
  const report = await collectHypAwareStatus({
    env: ctx.env,
    runtime: {
      sources: /** @type {ExtendedSourceRegistry} */ (ctx.sources),
      sinks: /** @type {ExtendedSinkRegistry} */ (ctx.sinks),
      capabilities: ctx.capabilities,
      query: ctx.query,
      storage: ctx.storage,
    },
  })

  // No config, or one that won't validate → treat as first run and let
  // the walkthrough own the experience (it can repair a missing file).
  if (!report.configExists || !report.configValid) return 'first-run'

  // A centrally-managed (fleet-joined) config is locked locally, so
  // reconfiguring here would be a no-op: drop that option and say so.
  const locked = !!(report.layered && report.layered.hasCentral)
  renderConfigSummary({ report, locked, stdout: ctx.stdout })

  const options = buildConfiguredMenuOptions(locked)
  const choice = await promptConfiguredAction(ctx, options)
  if (choice === 'reconfigure') return 'reconfigure'
  if (choice === 'status') {
    ctx.stdout.write('\n')
    await runStatus([], ctx)
  }
  return 'done'
}

/**
 * Build the action menu for the configured-install entry. `Quit` is
 * always present and is the default; `Reconfigure` is omitted when the
 * config is centrally managed (locked), since a local re-run is a no-op.
 *
 * @param {boolean} locked
 * @returns {{ value: string, label: string, summary?: string }[]}
 */
export function buildConfiguredMenuOptions(locked) {
  /** @type {{ value: string, label: string, summary?: string }[]} */
  const options = []
  if (!locked) {
    options.push({
      value: 'reconfigure',
      label: 'Reconfigure',
      summary: 'Re-run the setup picker and rewrite the config.',
    })
  }
  options.push({ value: 'status', label: 'See full status', summary: 'Print the detailed status report.' })
  options.push({ value: 'quit', label: 'Quit', summary: 'Leave the current setup untouched.' })
  return options
}

/**
 * Single-select action menu for the configured-install entry. Uses the
 * arrow-navigable TUI on a real TTY (matching the picker's look) and a
 * numbered readline fallback otherwise. A cancel (Ctrl-C / EOF) or an
 * unparseable choice resolves to `'quit'`, so nothing is changed.
 *
 * @param {CommandRunContext} ctx
 * @param {{ value: string, label: string, summary?: string }[]} options
 * @returns {Promise<string>}
 */
async function promptConfiguredAction(ctx, options) {
  if (shouldUseTui({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env })) {
    try {
      const choice = await select({
        title: 'What would you like to do?',
        options,
        default: 'quit',
        clearOnResolve: true,
        stdin: ctx.stdin ?? process.stdin,
        stdout: /** @type {any} */ (ctx.stdout),
        env: ctx.env,
      })
      return String(choice)
    } catch (err) {
      if (isPromptCancelledError(err)) return 'quit'
      throw err
    }
  }
  return legacyConfiguredActionPrompt(ctx, options)
}

/**
 * Numbered readline menu used when the TUI is unavailable (HYP_NO_TUI=1
 * or a non-TTY stdin). Mirrors the legacy walkthrough prompts: an empty
 * answer takes the default (Quit), an out-of-range answer also quits.
 *
 * @param {CommandRunContext} ctx
 * @param {{ value: string, label: string, summary?: string }[]} options
 * @returns {Promise<string>}
 */
export async function legacyConfiguredActionPrompt(ctx, options) {
  const input = /** @type {NodeJS.ReadableStream} */ (ctx.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (/** @type {any} */ (ctx.stdout))
  const defaultIdx = Math.max(0, options.findIndex((o) => o.value === 'quit'))
  const rl = readline.createInterface({ input, output, terminal: false })
  try {
    output.write('What would you like to do?\n')
    options.forEach((opt, i) => output.write(`  ${i + 1}) ${opt.label}\n`))
    const answer = await rl.question(`Choose [1-${options.length}, default ${defaultIdx + 1}]: `)
    const trimmed = answer.trim()
    if (trimmed === '') return options[defaultIdx]?.value ?? 'quit'
    const n = Number.parseInt(trimmed, 10)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
    return 'quit'
  } finally {
    rl.close()
  }
}

/**
 * Compact, friendly one-screen summary of an existing install. The full
 * diagnostic surface stays in `hyp status`; this is just enough to
 * recognise the setup before deciding whether to reconfigure.
 *
 * @param {{ report: HypAwareStatusReport, locked: boolean, stdout: CommandRunContext['stdout'] }} args
 */
export function renderConfigSummary({ report, locked, stdout }) {
  stdout.write(locked ? 'HypAware is set up (managed by your fleet).\n\n' : 'HypAware is set up.\n\n')
  stdout.write(`  Collecting:  ${summariseCollecting(report)}\n`)
  stdout.write(`  Saving to:   ${summariseSinks(report)}\n`)
  stdout.write(`  Daemon:      ${summariseDaemon(report.daemon)}\n`)
  stdout.write(
    `  Cache:       ${formatBytesShort(report.cache.totalBytes)} · ${report.retention.days}-day retention\n`
  )
  if (locked) stdout.write('\n  Settings are locked here and managed centrally.\n')
  stdout.write('\n')
}

/**
 * What's being collected, in human terms: configured AI clients first
 * (Claude, Codex), falling back to raw source names (OTEL, proxies).
 *
 * @param {HypAwareStatusReport} report
 * @returns {string}
 */
function summariseCollecting(report) {
  const clients = report.clients
    .filter((c) => c.configured)
    .map((c) => FRIENDLY_CLIENT_LABELS[c.name] ?? c.name.charAt(0).toUpperCase() + c.name.slice(1))
  if (clients.length > 0) return clients.join(', ')
  const sources = report.sources.map((s) => s.name)
  if (sources.length > 0) return sources.join(', ')
  return 'nothing yet'
}

/**
 * Where captured data lands. Dedupes friendly per-plugin labels; when no
 * sink is configured the local query cache is the only durable store.
 *
 * @param {HypAwareStatusReport} report
 * @returns {string}
 */
function summariseSinks(report) {
  if (report.sinks.length === 0) return 'local query cache only'
  /** @type {string[]} */
  const labels = []
  for (const s of report.sinks) {
    const label = FRIENDLY_SINK_LABELS[s.plugin] ?? s.instance
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.join(' + ')
}

/**
 * One-word daemon state for the summary; `hyp status` carries the detail.
 *
 * @param {HypAwareStatusReport['daemon']} daemon
 * @returns {string}
 */
function summariseDaemon(daemon) {
  if (daemon.running) return 'running'
  if (daemon.installed) return 'installed, not running'
  return 'not installed'
}

/**
 * Short human byte count for the cache line (e.g. `65 MB`). Rounds to
 * whole MB/KB so the summary stays glanceable.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytesShort(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes)} B`
}

export async function runInit(argv, ctx) {
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    const presetName = argv[0]
    const preset = ctx.initPresets.get(presetName)
    if (!preset) {
      const available = ctx.initPresets.list()
      ctx.stderr.write(`hyp init: unknown preset '${presetName}'\n`)
      if (available.length === 0) {
        ctx.stderr.write('  no presets registered - install a plugin that contributes one\n')
      } else {
        ctx.stderr.write('  available:\n')
        for (const p of available) {
          ctx.stderr.write(`    ${p.name}  (${p.plugin})  - ${p.summary}\n`)
        }
      }
      return 1
    }
    return preset.run(argv.slice(1), ctx)
  }

  // Phase 5: non-interactive flags. Detected by the presence of any
  // recognized init flag in argv. When absent, fall through to the
  // legacy preset/walkthrough dispatcher below.
  if (hasInitFlags(argv)) {
    const parsed = parseInitFlags(argv)
    if (parsed.error) {
      ctx.stderr.write(`hyp init: ${parsed.error}\n`)
      return 2
    }
    return runPickerInit(parsed.flags, ctx)
  }

  if (argv.length === 0) {
    if (isTty(ctx.stdout)) {
      // Already configured? Show a short friendly summary + menu rather
      // than dropping straight into the first-run picker as if starting
      // fresh. A bare enter quits, so re-running `hypaware` on a working
      // install never reconfigures by accident. First-run (no/invalid
      // config) returns 'first-run' and falls through unchanged.
      const entry = await runConfiguredEntry(ctx)
      if (entry === 'done') return 0
      const result = await runPickerWalkthrough({
        capabilities: ctx.capabilities,
        sources: /** @type {any} */ (ctx.sources),
        skills: /** @type {any} */ (ctx.skills),
        agents: /** @type {any} */ (ctx.agents),
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        env: ctx.env,
        backfill: buildPickerBackfillRunner(ctx),
        finale: {},
      })
      return result.exitCode
    }
    const available = ctx.initPresets.list()
    ctx.stderr.write('hyp init: stdin is not a TTY - pass a preset name or non-interactive flags.\n')
    ctx.stderr.write('  non-interactive: hyp init --yes [--client claude] [--source otel] [--force] ...\n')
    if (available.length === 0) {
      ctx.stderr.write('  no presets registered\n')
    } else {
      ctx.stderr.write('  presets:\n')
      for (const p of available) {
        ctx.stderr.write(`    ${p.name}  (${p.plugin})  - ${p.summary}\n`)
      }
    }
    return 2
  }

  // Reached only when argv[0] looks like a flag but is not a recognized
  // init flag: preset names are dispatched above, and empty argv is the
  // interactive path.
  ctx.stderr.write(`hyp init: unknown flag '${argv[0]}'\n`)
  ctx.stderr.write('  non-interactive: hyp init --yes [--client claude] [--source otel] [--force] ...\n')
  return 2
}

/**
 * @param {string[]} argv
 */
function hasInitFlags(argv) {
  return argv.some((t) => {
    if (INIT_FLAG_NAMES.has(t)) return true
    for (const name of INIT_FLAG_NAMES) {
      if (t.startsWith(`${name}=`)) return true
    }
    return false
  })
}

/**
 * @param {string[]} argv
 * @returns {{ flags: InitFlags, error?: string }}
 */
function parseInitFlags(argv) {
  /** @type {InitFlags} */
  const flags = {
    yes: false,
    noDaemon: false,
    dryRun: false,
    clients: [],
    sources: [],
    exportChoice: undefined,
    retentionDays: 30,
    force: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') { flags.yes = true; continue }
    if (arg === '--no-daemon') { flags.noDaemon = true; continue }
    if (arg === '--dry-run') { flags.dryRun = true; continue }
    if (arg === '--force') { flags.force = true; continue }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (value !== 'claude' && value !== 'codex') {
        return { flags, error: `--client: expected claude or codex (got "${value ?? ''}")` }
      }
      if (!flags.clients.includes(value)) flags.clients.push(value)
      continue
    }
    if (arg === '--source' || arg.startsWith('--source=')) {
      const value = arg === '--source' ? argv[++i] : arg.slice('--source='.length)
      const allowed = ['claude', 'codex', 'raw-anthropic', 'raw-openai', 'otel']
      if (!allowed.includes(value ?? '')) {
        return { flags, error: `--source: expected one of ${allowed.join(', ')} (got "${value ?? ''}")` }
      }
      const typed = /** @type {'claude'|'codex'|'raw-anthropic'|'raw-openai'|'otel'} */ (value)
      if (!flags.sources.includes(typed)) flags.sources.push(typed)
      continue
    }
    if (arg === '--export' || arg.startsWith('--export=')) {
      const value = arg === '--export' ? argv[++i] : arg.slice('--export='.length)
      const allowed = ['keep-local', 'local-parquet', 'configure-later']
      if (!allowed.includes(value ?? '')) {
        return { flags, error: `--export: expected one of ${allowed.join(', ')} (got "${value ?? ''}")` }
      }
      flags.exportChoice = /** @type {'keep-local'|'local-parquet'|'configure-later'} */ (value)
      continue
    }
    if (arg === '--retention-days' || arg.startsWith('--retention-days=')) {
      const value = arg === '--retention-days' ? argv[++i] : arg.slice('--retention-days='.length)
      const parsed = Number.parseInt(value ?? '', 10)
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { flags, error: `--retention-days: expected non-negative integer (got "${value ?? ''}")` }
      }
      flags.retentionDays = parsed
      continue
    }
    if (arg === '--from-file' || arg.startsWith('--from-file=')) {
      const value = arg === '--from-file' ? argv[++i] : arg.slice('--from-file='.length)
      if (!value) return { flags, error: '--from-file: requires a path' }
      flags.fromFile = value
      continue
    }
    if (arg === '--bin' || arg.startsWith('--bin=')) {
      const value = arg === '--bin' ? argv[++i] : arg.slice('--bin='.length)
      if (!value) return { flags, error: '--bin: requires a path' }
      flags.binPath = value
      continue
    }
    return { flags, error: `unknown argument: ${arg}` }
  }
  return { flags }
}

/**
 * Resolve the export choice for non-interactive `hyp init`. When
 * `--export` is omitted the default is `local-parquet`, matching the
 * interactive wizard so equivalent source selections produce the same
 * durable-files-out-of-the-box config whether the operator used flags or
 * the TUI. `origin` lets telemetry tell an explicit `--export` pick from a
 * defaulted one. Pass `--export keep-local` for cache-only.
 *
 * @param {InitFlags} flags
 * @returns {{ exportChoice: PickerExport, origin: PickerExportOrigin }}
 * @ref LLP 0011#autodetect-vs-default [implements]: export defaults to local Parquet, a fixed pick not derived from system state
 */
export function resolveInitExportChoice(flags) {
  if (flags.exportChoice) {
    return { exportChoice: flags.exportChoice, origin: 'user' }
  }
  return { exportChoice: 'local-parquet', origin: 'default' }
}

/**
 * Non-interactive Phase 5 init. Composes picks from CLI flags,
 * optionally seeds the config from a file (`--from-file`), and
 * delegates to {@link runPickerWalkthrough}.
 *
 * @param {InitFlags} flags
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 * @ref LLP 0011#non-interactive-entry [implements]: flags / preset / --from-file path that bypasses the interactive TUI
 */
async function runPickerInit(flags, ctx) {
  // --from-file short-circuits the picker entirely. The supplied
  // config is validated and written to the canonical location;
  // walkthrough.start / walkthrough.write_config / walkthrough.finish
  // spans are still emitted so the smoke contract holds.
  if (flags.fromFile) {
    return runInitFromFile(flags, ctx)
  }

  // Default sources when `--yes` is the only signal: capture Claude +
  // OTEL. (Export defaults separately, below.)
  // @ref LLP 0002#v1-acceptance-criteria-summary [implements]: --yes default install captures Claude + OTEL
  const sources = flags.sources.slice()
  if (sources.length === 0) {
    if (flags.yes) {
      sources.push('claude', 'otel')
    } else {
      ctx.stderr.write('hyp init: no sources selected - pass --source <kind> or --yes\n')
      return 2
    }
  }
  // Folding clients into sources, so `--client claude` alone is
  // sufficient even without an explicit `--source claude`.
  for (const c of flags.clients) {
    if (!sources.includes(c)) sources.push(c)
  }

  // Export defaults to local-parquet whenever `--export` is omitted, so
  // flag-driven init matches the interactive wizard rather than diverging
  // to a conservative keep-local default for the same source selection.
  const { exportChoice, origin: exportOrigin } = resolveInitExportChoice(flags)

  const result = await runPickerWalkthrough({
    capabilities: ctx.capabilities,
    sources: /** @type {ExtendedSourceRegistry} */ (ctx.sources),
    skills: /** @type {any} */ (ctx.skills),
    agents: /** @type {any} */ (ctx.agents),
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    env: ctx.env,
    picks: {
      sources,
      exportChoice,
      retentionDays: flags.retentionDays,
    },
    exportOrigin,
    force: flags.force,
    backfill: buildPickerBackfillRunner(ctx),
    finale: {
      skipDaemon: flags.noDaemon,
      dryRun: flags.dryRun,
      ...(flags.binPath ? { binPath: flags.binPath } : {}),
    },
  })
  return result.exitCode
}

/**
 * `hyp init --from-file <path>`: read a v2 config from disk, validate
 * it, and write it to the canonical location. Still emits the
 * walkthrough spans so the smoke pipeline observes a consistent
 * lifecycle.
 *
 * @param {InitFlags} flags
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runInitFromFile(flags, ctx) {
  const { withSpan, Attr } = await import('../observability/index.js')
  const { readObservabilityEnv } = await import('../observability/env.js')
  let raw
  try {
    raw = await fs.readFile(/** @type {string} */ (flags.fromFile), 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp init: --from-file: ${message}\n`)
    return 1
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp init: --from-file: invalid JSON: ${message}\n`)
    return 1
  }
  const catalogCtx = await buildKnownPluginsForCtx(ctx)
  const validation = await validateConfig(/** @type {any} */ (parsed), { knownPlugins: catalogCtx.knownPlugins, knownDatasets: catalogCtx.knownDatasets })
  if (!validation.ok) {
    for (const err of validation.errors) {
      ctx.stderr.write(
        `hyp init: --from-file: [${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}\n`
      )
    }
    return 1
  }

  await withSpan(
    'walkthrough.start',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.start',
      sources_available: 0,
      exports_available: 0,
      from_file: true,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  const obsEnv = readObservabilityEnv(ctx.env)
  const targetPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)

  // `init` writes the user-owned local layer, so guard against silently
  // clobbering a working config (the non-destructive half of #111).
  // `--from-file` is non-interactive: refuse unless `--force`, and back
  // up before replacing.
  const guard = await prepareLocalConfigWrite({ targetPath, force: flags.force })
  if (!guard.proceed) {
    ctx.stderr.write(`hyp init: ${guard.message}\n`)
    return 1
  }
  if (guard.backupPath) {
    ctx.stdout.write(`  backed up existing config to ${guard.backupPath}\n`)
  }

  await withSpan(
    'walkthrough.write_config',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.write_config',
      config_path: targetPath,
      from_file: true,
      ...(guard.backupPath ? { config_backed_up: true } : {}),
      status: 'ok',
    },
    async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    },
    { component: 'walkthrough' }
  )

  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      from_file: true,
      config_path: targetPath,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  ctx.stdout.write(`✓ Wrote ${targetPath}\n`)
  return 0
}

const FRIENDLY_CLIENT_LABELS = /** @type {Record<string, string>} */ ({
  claude: 'Claude',
  codex: 'Codex',
})

const FRIENDLY_SINK_LABELS = /** @type {Record<string, string>} */ ({
  '@hypaware/format-parquet': 'local Parquet files',
  '@hypaware/format-jsonl': 'local JSONL files',
  '@hypaware/local-fs': 'local files',
  '@hypaware/central': 'central fleet sink',
})

/**
 * Recognized init flag names (Phase 5). Used as a fast-path detector
 * so legacy preset-name invocations still flow through the existing
 * dispatcher.
 *
 * @type {Set<string>}
 */
const INIT_FLAG_NAMES = new Set([
  '--yes', '-y',
  '--no-daemon',
  '--dry-run',
  '--client', '--source', '--export',
  '--retention-days', '--from-file',
  '--bin', '--force',
])
