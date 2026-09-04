// @ts-check

import fs from 'node:fs/promises'
import { parseCommandArgv } from '../cli/verb_codec.js'
import path from 'node:path'

import { defaultConfigPath, prepareLocalConfigWrite } from '../config/schema.js'
import { runInitWizard } from '../cli/wizard/index.js'
import { DEFAULT_RETENTION_DAYS } from '../cli/walkthrough.js'
import { validateConfig } from '../config/validate.js'
import { runBackfillProvider } from './backfill.js'
import { buildKnownPluginsForCtx } from './plugin.js'
import { runStatus } from './status.js'
import { isTty } from '../cli/stdio.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { InitFlags, PickerBackfillRunner, PickerExport, PickerExportOrigin, PickerSource } from '../../../src/core/cli/types.js'
 */

/**
 * Build the onboarding backfill runner the picker finale uses to import
 * a picked client's local history right after writing config. Wraps the
 * shared `runBackfillProvider` path so finale-imported rows land in the
 * exact same per-source tables as `hyp backfill <provider>` and live
 * capture. `available` lists registered provider names so the finale can
 * intersect them with the picked clients.
 *
 * Exported for the wiring test that pins `available`/`sweeping` against
 * the real provider contributions; production callers are in this file.
 *
 * @param {CommandRunContext} ctx
 * @returns {PickerBackfillRunner}
 */
export function buildPickerBackfillRunner(ctx) {
  const contributions = ctx.backfills.list()
  return {
    available: contributions.map((p) => p.name),
    // @ref LLP 0180#decision [implements]: the finale discloses instead of
    // asking for a provider whose sweep imports history regardless of the answer
    sweeping: contributions.filter((p) => p.sweep !== undefined).map((p) => p.name),
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
 * Without arguments runs the guided init wizard (TTY only; when
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
export async function runInit(argv, ctx) {
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    const presetName = argv[0]
    const preset = ctx.initPresets.get(presetName)
    if (!preset) {
      const available = ctx.initPresets.list()
      ctx.stderr.write(`hyp setup: unknown preset '${presetName}'\n`)
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
      ctx.stderr.write(`hyp setup: ${parsed.error}\n`)
      return 2
    }
    return runPickerInit(parsed.flags, ctx)
  }

  if (argv.length === 0) {
    if (isTty(ctx.stdout)) {
      // The guided wizard (LLP 0135 #orchestration): returning gate,
      // then fork -> join -> pick -> configure -> finale. The gate keeps
      // the never-reconfigure-by-accident rule; first-run (no/invalid
      // config) falls straight through to the fork.
      const result = await runInitWizard({
        ctx,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        ...(ctx.stdin ? { stdin: ctx.stdin } : {}),
        env: ctx.env,
        capabilities: ctx.capabilities,
        sources: /** @type {any} */ (ctx.sources),
        skills: /** @type {any} */ (ctx.skills),
        agents: /** @type {any} */ (ctx.agents),
        backfill: buildPickerBackfillRunner(ctx),
        finale: {},
        runStatus: async () => {
          ctx.stdout.write('\n')
          return runStatus([], ctx)
        },
      })
      return result.exitCode
    }
    const available = ctx.initPresets.list()
    ctx.stderr.write('hyp setup: stdin is not a TTY - pass a preset name or non-interactive flags.\n')
    ctx.stderr.write('  non-interactive: hyp setup --yes [--client claude] [--source otel] [--force] ...\n')
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
  ctx.stderr.write(`hyp setup: unknown flag '${argv[0]}'\n`)
  ctx.stderr.write('  non-interactive: hyp setup --yes [--client claude] [--source otel] [--force] ...\n')
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
 * The picker source ids `hyp setup --source` accepts: every row the bundled
 * picker catalog contributes, hidden and platform-gated rows included. A
 * platform gate filters the interactive menu and nothing else, so a gated
 * row keeps its `--source` identity (LLP 0368 #display-only), and a hidden
 * row is reachable only here. Exported so a test can hold this list against
 * the real catalog: the list is a second copy of the manifest data, and the
 * copy is what let `claude-desktop` join the picker without joining this
 * flag (#1301).
 *
 * @type {readonly PickerSource[]}
 * @ref LLP 0368#display-only [constrained-by]: a platform-gated row keeps its `--source` identity
 */
export const INIT_SOURCE_CHOICES = Object.freeze(/** @type {PickerSource[]} */ ([
  'claude', 'claude-desktop', 'codex', 'opencode', 'openclaw', 'hermes', 'raw-anthropic', 'raw-openai', 'otel',
]))

/**
 * The names `hyp setup --client` accepts. Each is a picker row whose owning
 * plugin contributes a client, so `--client <name>` folds into the same
 * source pick the interactive row makes (`resolveInitSources`). Claude
 * Desktop composes `@hypaware/claude` + `@hypaware/claude-desktop` exactly
 * as its picker row does.
 *
 * @type {readonly InitFlags['clients'][number][]}
 */
export const INIT_CLIENT_CHOICES = Object.freeze(/** @type {InitFlags['clients'][number][]} */ ([
  'claude', 'claude-desktop', 'codex', 'opencode',
]))

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
    retentionDays: DEFAULT_RETENTION_DAYS,
    force: false,
  }
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      yes: { type: 'boolean', default: false },
      'no-daemon': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      client: { type: 'array', items: { type: 'string', enum: [...INIT_CLIENT_CHOICES] } },
      source: { type: 'array', items: { type: 'string', enum: [...INIT_SOURCE_CHOICES] } },
      export: { type: 'string', enum: ['keep-local', 'local-parquet', 'configure-later'] },
      'retention-days': { type: 'integer', minimum: 0, default: DEFAULT_RETENTION_DAYS },
      'from-file': { type: 'string' },
      bin: { type: 'string' },
    },
  }, { aliases: { '-y': '--yes' } })
  if ('help' in parsed) {
    return { flags, error: 'usage: hyp setup [--yes] [--client <name>] [--source <name>] [--export <choice>] [--retention-days <n>] [--from-file <path>] [--no-daemon] [--dry-run] [--force] [--bin <path>]' }
  }
  if (!parsed.ok) return { flags, error: parsed.error }
  const p = /** @type {{ yes: boolean, 'no-daemon': boolean, 'dry-run': boolean, force: boolean, client?: string[], source?: string[], export?: InitFlags['exportChoice'], 'retention-days': number, 'from-file'?: string, bin?: string }} */ (parsed.params)
  flags.yes = p.yes
  flags.noDaemon = p['no-daemon']
  flags.dryRun = p['dry-run']
  flags.force = p.force
  flags.clients = /** @type {InitFlags['clients']} */ ([...new Set(p.client ?? [])])
  flags.sources = /** @type {InitFlags['sources']} */ ([...new Set(p.source ?? [])])
  flags.exportChoice = p.export
  flags.retentionDays = p['retention-days']
  if (p['from-file'] !== undefined) flags.fromFile = p['from-file']
  if (p.bin !== undefined) flags.binPath = p.bin
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
 * Resolve the sources a non-interactive `hyp setup` captures, from
 * `--source`, `--client`, and the `--yes` default. An empty result is the
 * run that named nothing and did not accept the defaults either; the
 * caller turns that into the usage error.
 *
 * A named client *is* a source pick: the fold below is what makes
 * `--client codex` sufficient without a matching `--source codex`. So the
 * `--yes` default belongs only to the run that expressed no preference at
 * all, and testing `flags.sources` alone was not that test. It let
 * `--yes --client opencode` compose Claude capture and rewrite the real
 * `~/.claude/settings.json` for a client the operator never named, which
 * is a capture surface opened without anyone asking for it.
 *
 * @param {InitFlags} flags
 * @returns {InitFlags['sources']}
 * @ref LLP 0002#v1-acceptance-criteria-summary [implements]: --yes default install captures Claude + OTEL
 * @ref LLP 0011#autodetect-vs-default [constrained-by]: a default fills a silence, it never overrides a pick
 */
export function resolveInitSources(flags) {
  const sources = flags.sources.slice()
  if (sources.length === 0 && flags.clients.length === 0 && flags.yes) {
    sources.push('claude', 'otel')
  }
  for (const c of flags.clients) {
    if (!sources.includes(c)) sources.push(c)
  }
  return sources
}

/**
 * Non-interactive Phase 5 init. Composes picks from CLI flags,
 * optionally seeds the config from a file (`--from-file`), and
 * delegates to {@link runInitWizard}, which short-circuits to its pick
 * phase and finale on the pre-baked-picks path.
 *
 * @param {InitFlags} flags
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 * @ref LLP 0011#non-interactive-entry [implements]: flags / preset / --from-file path that bypasses the interactive TUI
 */
async function runPickerInit(flags, ctx) {
  // --from-file short-circuits the picker entirely. The supplied
  // config is validated and written to the canonical location;
  // wizard.pick.start / wizard.pick.write_config / wizard.pick.finish
  // spans are still emitted so the smoke contract holds.
  if (flags.fromFile) {
    return runInitFromFile(flags, ctx)
  }

  // `--source`, `--client`, and the `--yes` default, in one place so the
  // rule that keeps a default from overriding a pick is testable.
  // (Export defaults separately, below.)
  const sources = resolveInitSources(flags)
  if (sources.length === 0) {
    ctx.stderr.write('hyp setup: no sources selected - pass --source <kind>, --client <name>, or --yes\n')
    return 2
  }

  // Export defaults to local-parquet whenever `--export` is omitted, so
  // flag-driven init matches the interactive wizard rather than diverging
  // to a conservative keep-local default for the same source selection.
  const { exportChoice, origin: exportOrigin } = resolveInitExportChoice(flags)

  const result = await runInitWizard({
    ctx,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    env: ctx.env,
    capabilities: ctx.capabilities,
    sources: /** @type {any} */ (ctx.sources),
    skills: /** @type {any} */ (ctx.skills),
    agents: /** @type {any} */ (ctx.agents),
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
 * it, and write it to the canonical location. Still emits the wizard
 * pick-phase spans so the smoke pipeline observes a consistent
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
    ctx.stderr.write(`hyp setup: --from-file: ${message}\n`)
    return 1
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp setup: --from-file: invalid JSON: ${message}\n`)
    return 1
  }
  const catalogCtx = await buildKnownPluginsForCtx(ctx)
  const validation = await validateConfig(/** @type {any} */ (parsed), { knownPlugins: catalogCtx.knownPlugins, knownDatasets: catalogCtx.knownDatasets })
  if (!validation.ok) {
    for (const err of validation.errors) {
      ctx.stderr.write(
        `hyp setup: --from-file: [${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}\n`
      )
    }
    return 1
  }

  await withSpan(
    'wizard.pick.start',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.start',
      sources_available: 0,
      from_file: true,
      status: 'ok',
    },
    async () => {},
    { component: 'wizard' }
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
    ctx.stderr.write(`hyp setup: ${guard.message}\n`)
    return 1
  }
  if (guard.backupPath) {
    ctx.stdout.write(`  backed up existing config to ${guard.backupPath}\n`)
  }

  await withSpan(
    'wizard.pick.write_config',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.write_config',
      config_path: targetPath,
      from_file: true,
      ...(guard.backupPath ? { config_backed_up: true } : {}),
      status: 'ok',
    },
    async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    },
    { component: 'wizard' }
  )

  await withSpan(
    'wizard.pick.finish',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.finish',
      from_file: true,
      config_path: targetPath,
      status: 'ok',
    },
    async () => {},
    { component: 'wizard' }
  )

  ctx.stdout.write(`✓ Wrote ${targetPath}\n`)
  return 0
}

/**
 * Recognized init flag names (Phase 5). Used as a fast-path detector
 * so legacy preset-name invocations still flow through the existing
 * dispatcher.
 *
 * @type {Set<string>}
 */
export const INIT_FLAG_NAMES = new Set([
  '--yes', '-y',
  '--no-daemon',
  '--dry-run',
  '--client', '--source', '--export',
  '--retention-days', '--from-file',
  '--bin', '--force',
])
