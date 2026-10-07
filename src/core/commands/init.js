// @ts-check

import fs from 'node:fs/promises'
import { parseCommandArgv } from '../cli/verb_codec.js'
import path from 'node:path'

import { defaultConfigPath, prepareLocalConfigWrite } from '../config/schema.js'
import { isHelpFlag } from '../cli/group_help.js'
import { runInitWizard } from '../cli/wizard/index.js'
import { enableGithubCollection } from '../cli/wizard/pick.js'
import { DEFAULT_RETENTION_DAYS, LOCAL_INSTALL_RETENTION_DAYS, orderPickerDescriptors, visiblePickerDescriptors } from '../cli/walkthrough.js'
import { detectPickerSources } from '../cli/detect.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { Attr, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { noteInvocation } from '../product_telemetry/client.js'
import { validateConfig } from '../config/validate.js'
import { runBackfillProvider } from './backfill.js'
import { buildKnownPluginsForCtx } from './plugin.js'
import { runStatus } from './status.js'
import { isTty } from '../cli/stdio.js'

/**
 * @import { CommandRunContext, HypAwareV2Config } from '../../../hypaware-plugin-kernel-types.js'
 * @import { InitFlags, PickerBackfillRunner, PickerExport, PickerExportOrigin, PickerSource } from '../../../src/core/cli/types.js'
 * @import { PluginCatalog } from '../../../src/core/types.js'
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
 * @param {boolean} [skipOptional] Skip only the history imports the attended wizard lets the person decline.
 * @returns {PickerBackfillRunner}
 */
export function buildPickerBackfillRunner(ctx, skipOptional = false) {
  // @ref LLP 0462#parity [implements]: declining optional imports never disables scheduled recovery
  const contributions = ctx.backfills.list().filter((p) => !skipOptional || p.sweep !== undefined)
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
 * stdout is not a TTY the command prints the agent setup guide and
 * exits successfully without installing or blocking on stdin).
 *
 * With a `<preset>` argument resolves the preset through the kernel
 * `InitPresetRegistry` and invokes its `run(argv, ctx)`. Unknown
 * presets land on stderr with the list of available names. What follows
 * the preset name is gated before the preset runs: a help flag renders
 * help, and a flag `hyp setup` does not advertise is a usage error, so
 * neither reaches the preset's config write.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runInit(argv, ctx) {
  if (argv.length === 1 && argv[0] === '--guide') return writeSetupGuide(ctx)
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
    const presetArgv = argv.slice(1)
    // The dispatcher intercepts a help flag only when it leads the command's
    // argv, so a preset name in front of one lands here instead. Route it back
    // through that same interception rather than letting a preset speak for the
    // command with help of its own.
    // @ref LLP 0009#central-help-interception [implements]: the preset form renders core's registry-backed help for `setup`
    if (presetArgv.some(isHelpFlag)) return ctx.commands.run('setup', ['--help'])
    // A preset reads its own argv for the handful of flags it honors, so
    // anything else here would be ignored on a path that writes user config.
    // Refuse it as the no-preset form below does.
    const unknownFlag = presetArgv.find((t) => t.startsWith('-') && !isInitFlag(t))
    if (unknownFlag !== undefined) {
      writeUnknownFlag(ctx, unknownFlag)
      return 2
    }
    // A preset writes its own plugin list and runs no picker finale, so these
    // choices would be dropped while setup reports success.
    const pickerOnly = presetArgv.find((t) => /^--(github|no-backfill)(=|$)/.test(t))
    if (pickerOnly !== undefined) {
      ctx.stderr.write(`hyp setup: ${pickerOnly.split('=')[0]} is not supported with a preset; name choices with --source instead\n`)
      return 2
    }
    return preset.run(presetArgv, ctx)
  }

  // Phase 5: non-interactive flags. Detected by the presence of any
  // recognized init flag in argv. When absent, fall through to the
  // legacy preset/walkthrough dispatcher below.
  if (hasInitFlags(argv)) {
    const parsed = parseInitFlags(argv)
    // Routed back for the same reason the preset form above is: dispatch
    // intercepts help only when it leads the command's argv, so a help flag
    // behind an init flag arrives here instead.
    // @ref LLP 0293#one-contract [implements]: a --help further along argv prints the usage line on stdout and exits 0
    if (parsed.help) return ctx.commands.run('setup', ['--help'])
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
          return runStatus(['--verbose'], ctx)
        },
      })
      return result.exitCode
    }
    return writeSetupGuide(ctx)
  }

  // Reached only when argv[0] looks like a flag but is not a recognized
  // init flag: preset names are dispatched above, and empty argv is the
  // interactive path.
  writeUnknownFlag(ctx, argv[0])
  return 2
}

/**
 * Read-only handoff to an agent; detection suggests choices, never selects them.
 * @param {CommandRunContext} ctx
 * @param {{ catalog?: PluginCatalog, platform?: NodeJS.Platform }} [opts] test seam for presence and platform gates
 * @ref LLP 0462#guide [implements]: a flagless pipe explains choices without installing
 */
export async function writeSetupGuide(ctx, opts = {}) {
  return withSpan('wizard.setup.guide', {
    [Attr.COMPONENT]: 'wizard', [Attr.OPERATION]: 'wizard.setup.guide', status: 'ok',
    hyp_reason: 'guide_only', exit_code: 0,
  }, async () => {
    // Printing the guide installs nothing, so it must not count as a setup run.
    noteInvocation({ kind: 'help' })
    const catalog = opts.catalog ?? await (async () => {
      const bundled = await discoverBundledPlugins()
      return buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
    })()
    const rows = visiblePickerDescriptors([...orderPickerDescriptors(catalog.pickerDescriptors).values()], opts.platform)
      .filter((row) => INIT_SOURCE_CHOICES.includes(/** @type {PickerSource} */ (row.id)))
    const detected = await detectPickerSources(catalog, ctx.env)
    const configPath = ctx.env.HYP_CONFIG ? path.resolve(ctx.env.HYP_CONFIG) : defaultConfigPath(readObservabilityEnv(ctx.env).hypHome)
    let existing = 'none'
    try {
      await fs.access(configPath)
      existing = configPath
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') existing = `${configPath} (cannot read; inspect before proceeding)`
    }
    const suggested = rows.filter((row) => detected.has(row.id) && !row.needsSetup)
      .map((row) => `--source ${row.id}`).join(' ')
    const lines = [
      'HypAware setup guide',
      'Choose the options with the person, then run the setup command below.',
      'Use hyp setup --guide to read this guide even on a terminal.',
      'Offer every applicable setup choice below, including GitHub and the closing offers.',
      'Reuse choices the person already made; do not silently skip optional offers.',
      '',
      'HypAware records AI sessions and telemetry into a local queryable history.',
      `Existing local config: ${existing}`,
      '',
      '1. Ask what to record. Detection is a hint, not consent or proof of a working CLI.',
      ...rows.map((row) => `  ${row.label}${detected.has(row.id) ? ' (detected)' : ''}: --source ${row.id}${row.summary ? `\n    ${row.summary}` : ''}${row.needsSetup && row.configureCommand ? `\n    After selecting this source, run hyp ${row.configureCommand} and finish its human handoffs before continuing.` : ''}`),
      `  Other source IDs: ${INIT_SOURCE_CHOICES.filter((id) => !rows.some((row) => row.id === id)).join(', ') || 'none'}`,
      '  --source is repeatable. --client is an equivalent for client choices.',
      '  --yes alone selects claude + otel, regardless of detection. Name choices explicitly.',
      '  Offer the detected choices together as defaults, or let the person customize them.',
      '  Separately ask: collect GitHub information from AI sessions (repositories, pull requests, and more)?',
      '    Explain before asking: GitHub authorization includes private repos and grants write scope; HypAware only reads.',
      '    If yes, add --github to the setup command. If no, omit it; --yes never opts into GitHub.',
      '',
      '2. Recommend cloud sync. Offer "Cloud sync (recommended)" and "Local only".',
      '  Cloud sync makes recorded history available across machines and to the chosen team.',
      '  Confirm the choice before enrollment; honor an existing local-only preference.',
      '  Setup flags alone do not enroll or disconnect a machine. Complete cloud login in step 5 if chosen.',
      '  Existing enrollment remains; inspect hyp status first.',
      '  To disconnect an enrolled machine, ask first, then run hyp leave.',
      '  For cloud sync, ask which clients/folders may leave the machine before login.',
      '  hyp privacy client <name> local-only keeps that client local (team rules can lock it).',
      '  hyp privacy client <name> sync allows that client to sync.',
      '  hyp privacy set <path> local-only|ignore classifies existing folders.',
      '  hyp privacy folders ask asks once about each new folder; sync is the default.',
      '  hyp privacy folders sync lets unclassified new folders sync without asking.',
      '  Ask whether new folders should sync automatically or be reviewed first, then apply that choice.',
      '',
      '3. Explain local storage and choose overrides only if wanted.',
      '  --export local-parquet: local cache plus scheduled Parquet files (default).',
      '  --export keep-local: local query cache only. configure-later defers export.',
      `  --retention-days <n>: unattended default ${DEFAULT_RETENTION_DAYS} days; interactive local default ${LOCAL_INSTALL_RETENTION_DAYS}.`,
      '  The unattended run imports existing history for chosen clients within the retention window.',
      '  Offer optional history import now or later; add --no-backfill for later.',
      '    To import deferred history later, run hyp backfill <client>.',
      '    This skips only optional one-time imports. Scheduled recovery still imports history for sweep-backed clients.',
      '    For those clients, explain the automatic import instead of offering a choice that cannot stop it.',
      `  Use --retention-days ${LOCAL_INSTALL_RETENTION_DAYS} for local setup or ${DEFAULT_RETENTION_DAYS} for cloud setup unless an override was chosen.`,
      '  It installs a per-user background service, attaches clients, and installs their skills.',
      '',
      '4. Run the agreed choices. First preview the same command with --dry-run.',
      ...(suggested ? [`  Example for detected sources with cloud retention (confirm choices first):`, `  hyp setup ${suggested} --export local-parquet --retention-days ${DEFAULT_RETENTION_DAYS}`] : [
        '  No sources detected. Ask which source to use; do not fall back to --yes.',
        `  Command shape: hyp setup --source <chosen-id> --export local-parquet --retention-days ${DEFAULT_RETENTION_DAYS}`,
      ]),
      '  --force backs up and replaces local config; ask before using it.',
      '    It also allows a temporary CLI if global installation fails.',
      '  To add GitHub to an existing setup without recomposing its sources, use',
      '    hyp setup --from-file <existing-config-path> --github --force (preview with --dry-run first).',
      '    This preserves other settings and only writes config; restart an already-running daemon afterward.',
      '  --no-daemon skips service installation. --bin <path> uses an existing durable hyp binary.',
      '  Without --bin, setup may run npm install -g hypaware to establish a durable CLI.',
      '  Explain agent approval prompts for install/service actions and wait for approval.',
      '  A macOS certificate/password dialog requires the person; report any attach failure.',
      '',
      // @ref LLP 0462#handoffs [implements]: the agent opens selected sign-ins sequentially and waits for each outcome
      '5. Open selected sign-ins one at a time: cloud first, then GitHub if enabled and requested.',
      '  Explain which sign-in is opening. Keep its command running while the person signs in.',
      '  Wait for the command to finish and check its result before starting the next sign-in.',
      '  Never run sign-ins in parallel or leave one running while starting another.',
      '  On failure, cancellation or timeout, resolve it or ask whether to skip before continuing.',
      '  Cloud: when sync was chosen, run hyp remote login --browser to open the sign-in page.',
      '    Keep --browser even with piped stdin so login does not try to read a static token.',
      '    If the browser does not open, give the person the printed URL while this command waits.',
      '    On a headless machine, use hyp remote login --no-browser and share its URL instead.',
      '    If an org choice is required, ask and retry with --org <name>. Do not choose for them.',
      '    Login enables forwarding; follow the printed first-sync privacy review instructions.',
      '  GitHub: after setup with --github, check hyp github status; if already authenticated, do not log in again.',
      '    Otherwise run hyp github login to open its authorization page after cloud sign-in finishes or is skipped.',
      '    Give the person the printed device code and wait for the command to finish.',
      '    If opening fails, share the printed URL; on a headless machine use hyp github login --no-browser.',
      '    Check hyp github status after sign-in. If the daemon was started, run hyp daemon restart to load its credentials.',
      '  Never ask the person to paste passwords or access tokens into chat.',
      '  If the agent cannot keep a login command running, hand that command to the person',
      '    and wait for their result before starting any other sign-in.',
      '',
      '6. Verify with hyp status --json, including after sign-in.',
      '  Check config.valid, daemon.running (unless --no-daemon), sources, and client_attach.',
      '  Check configured clients and attached where attachable; report errors or trust warnings.',
      '  Setup exit 0 alone does not prove daemon installation or healthy capture.',
      '  Start a new client session for newly installed skills/settings, then check capture.',
      '  Run hyp query overview --json and show a short first look at the recorded history; disclose incomplete results.',
      '',
      '7. Offer the same closing steps as interactive setup.',
      '  For cloud sync, offer a privacy review and sending now versus waiting for the first-sync deadline.',
      '    Show hyp sync --dry-run before that choice. To end an active review window early, the person',
      '    must run hyp sync in a terminal and confirm its plan; --yes cannot bypass that review.',
      '    If they wait, state the deadline from status/login output. Do not imply waiting disables sync.',
      '  When history exists and a recorded CLI client can launch, ask: Suggest a new skill?',
      '    Explain that hyp ask scans recent history and starts an AI client in a separate folder.',
      '    If accepted, run hyp ask in an interactive terminal so the person can choose among available clients.',
      '    If the harness cannot host the interactive client, hand the command to the person.',
      '    With no history yet, explain that this becomes available after recording sessions.',
    ]
    const presets = ctx.initPresets.list()
    if (presets.length) {
      lines.push('', 'Named presets (alternative to explicit choices):')
      for (const preset of presets) lines.push(`  ${preset.name}: ${preset.summary}`)
    }
    ctx.stdout.write(lines.join('\n') + '\n')
    return 0
  }, { component: 'wizard' })
}

/**
 * The one refusal for a flag `hyp setup` does not advertise, so the same typo
 * cannot mean exit 2 without a preset name and a silent config write with one.
 *
 * @param {CommandRunContext} ctx
 * @param {string} token
 */
function writeUnknownFlag(ctx, token) {
  ctx.stderr.write(`hyp setup: unknown flag '${token}'\n`)
  ctx.stderr.write('  non-interactive: hyp setup --yes [--client claude] [--source otel] [--force] ...\n')
}

/**
 * Whether a token names a recognized init flag, in the bare (`--dry-run`) or
 * the inline-value (`--dry-run=true`) spelling the CLI codec accepts
 * everywhere else.
 *
 * @param {string} token
 */
function isInitFlag(token) {
  if (INIT_FLAG_NAMES.has(token)) return true
  for (const name of INIT_FLAG_NAMES) {
    if (token.startsWith(`${name}=`)) return true
  }
  return false
}

/**
 * @param {string[]} argv
 */
function hasInitFlags(argv) {
  return argv.some(isInitFlag)
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
  'claude', 'claude-desktop', 'codex', 'opencode', 'cursor', 'pi', 'openclaw', 'hermes', 'raw-anthropic', 'raw-openai', 'otel',
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
  'claude', 'claude-desktop', 'codex', 'opencode', 'cursor', 'pi',
]))

/**
 * @param {string[]} argv
 * @returns {{ flags: InitFlags, help?: true, error?: string }}
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
      github: { type: 'boolean', default: false },
      'no-backfill': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      client: { type: 'array', items: { type: 'string', enum: [...INIT_CLIENT_CHOICES] } },
      source: { type: 'array', items: { type: 'string', enum: [...INIT_SOURCE_CHOICES] } },
      export: { type: 'string', enum: ['keep-local', 'local-parquet', 'configure-later'] },
      'retention-days': { type: 'integer', minimum: 0, default: DEFAULT_RETENTION_DAYS },
      'from-file': { type: 'string' },
      bin: { type: 'string' },
    },
  }, { aliases: { '-y': '--yes' } })
  if ('help' in parsed) return { flags, help: true }
  if (!parsed.ok) return { flags, error: parsed.error }
  const p = /** @type {{ yes: boolean, 'no-daemon': boolean, 'dry-run': boolean, github: boolean, 'no-backfill': boolean, force: boolean, client?: string[], source?: string[], export?: InitFlags['exportChoice'], 'retention-days': number, 'from-file'?: string, bin?: string }} */ (parsed.params)
  flags.yes = p.yes
  flags.noDaemon = p['no-daemon']
  flags.dryRun = p['dry-run']
  flags.github = p.github
  flags.noBackfill = p['no-backfill']
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
      github: flags.github,
    },
    exportOrigin,
    force: flags.force,
    backfill: buildPickerBackfillRunner(ctx, flags.noBackfill),
    finale: {
      skipDaemon: flags.noDaemon,
      dryRun: flags.dryRun,
      ...(flags.binPath ? { binPath: flags.binPath } : {}),
    },
  })
  if (result.exitCode === 0 && flags.github) writeGithubNextStep(ctx, flags.dryRun)
  return result.exitCode
}

/**
 * Setup enables GitHub collection but never signs in, so say what remains.
 *
 * @param {CommandRunContext} ctx
 * @param {boolean} dryRun
 */
function writeGithubNextStep(ctx, dryRun) {
  ctx.stdout.write(dryRun
    ? '(dry-run) Would enable GitHub collection; then run hyp github login\n'
    : 'GitHub collection enabled. Next: run hyp github login, then hyp daemon restart if the daemon is running.\n')
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
  // Before validation, so the config actually written is the one validated.
  if (flags.github && parsed && typeof parsed === 'object') enableGithubCollection(/** @type {HypAwareV2Config} */ (parsed))
  const catalogCtx = await buildKnownPluginsForCtx(ctx)
  const validation = await validateConfig(/** @type {any} */ (parsed), { knownPlugins: catalogCtx.knownPlugins, knownDatasets: catalogCtx.knownDatasets, unloadablePlugins: catalogCtx.unloadablePlugins })
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
  // up before replacing. `--dry-run` gets the same answer and refusal
  // with no backup and no write.
  const dryRun = flags.dryRun
  const guard = await prepareLocalConfigWrite({ targetPath, force: flags.force, dryRun })
  if (!guard.proceed) {
    ctx.stderr.write(`hyp setup: ${guard.message}\n`)
    return 1
  }
  if (guard.backupPath) {
    ctx.stdout.write(dryRun
      ? `(dry-run) would back up existing config to ${guard.backupPath}\n`
      : `  backed up existing config to ${guard.backupPath}\n`)
  }

  await withSpan(
    'wizard.pick.write_config',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.write_config',
      config_path: targetPath,
      from_file: true,
      ...(dryRun ? { dry_run: true } : {}),
      ...(guard.backupPath && !dryRun ? { config_backed_up: true } : {}),
      status: 'ok',
    },
    async () => {
      if (dryRun) return
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

  ctx.stdout.write(dryRun ? `(dry-run) Would write ${targetPath}\n` : `✓ Wrote ${targetPath}\n`)
  if (flags.github) writeGithubNextStep(ctx, dryRun)
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
  '--github', '--no-backfill',
  '--client', '--source', '--export',
  '--retention-days', '--from-file',
  '--bin', '--force',
])
