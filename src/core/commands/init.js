// @ts-check

import fs from 'node:fs/promises'
import { parseCommandArgv } from '../cli/verb_codec.js'
import path from 'node:path'

import { defaultConfigPath, prepareLocalConfigWrite } from '../config/schema.js'
import { isHelpFlag } from '../cli/group_help.js'
import { runInitWizard } from '../cli/wizard/index.js'
import { enableGithubCollection } from '../cli/wizard/pick.js'
import { FOLDER_ASK_OPTIONS, folderAskTitle } from '../cli/wizard/folder_ask.js'
import { DEFAULT_RETENTION_DAYS, LOCAL_INSTALL_RETENTION_DAYS, orderPickerDescriptors, preflightLegacyProxyAttach, visiblePickerDescriptors } from '../cli/walkthrough.js'
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
import { collectHypAwareStatus } from '../daemon/status.js'
import { prepareSetupPrivacy } from './policy.js'

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
        ...(result.note ? { note: result.note } : {}),
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
 * neither reaches the preset's config write. Any other setup option and
 * any positional is the preset's own to read or refuse.
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
    if (presetArgv.some(isHelpFlag)) return renderSetupHelp(ctx)
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
    const pickerOnly = presetArgv.find((t) => /^--(github|no-backfill|sync-client|local-only-client|new-folders)(=|$)/.test(t))
    if (pickerOnly !== undefined) {
      ctx.stderr.write(`hyp setup: ${pickerOnly.split('=')[0]} is not supported with a preset; name choices with hyp setup --yes --source instead\n`)
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
    if (parsed.help) return renderSetupHelp(ctx)
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
        ...(ctx.platform ? { platform: ctx.platform } : {}),
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
 * Render `setup`'s help through the dispatcher's central interception, for a
 * help flag that does not lead argv. The outer invocation is a help render,
 * not a setup run, so it is classified as one here, where that is decided: it
 * records what a leading `hyp setup --help` records (issue #2470).
 * @param {CommandRunContext} ctx
 */
function renderSetupHelp(ctx) {
  noteInvocation({ kind: 'help' })
  return ctx.commands.run('setup', ['--help'])
}

/**
 * Read-only handoff to an agent; detection suggests choices, never selects them.
 * @param {CommandRunContext} ctx
 * @param {{ catalog?: PluginCatalog, platform?: NodeJS.Platform, collectStatus?: typeof collectHypAwareStatus }} [opts] test seam for presence, platform gates, and status
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
    const detected = await detectPickerSources(catalog, ctx.env, ctx.cwd)
    const configPath = ctx.env.HYP_CONFIG ? path.resolve(ctx.env.HYP_CONFIG) : defaultConfigPath(readObservabilityEnv(ctx.env).hypHome)
    let configExists = false
    try {
      await fs.access(configPath)
      configExists = true
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
    }
    const report = configExists
      ? await (opts.collectStatus ?? collectHypAwareStatus)({ env: ctx.env, ...(opts.platform ? { platform: opts.platform } : {}) })
      : undefined
    // @ref LLP 0281#returning-gate [implements]: only a valid config with a recorded pick answer is a returning setup
    const configured = !!(report?.configExists && report.configValid && report.configRecordsAnswer)
    // With nothing detected there is no shortlist to offer, so every app is listed.
    const offered = rows.some((row) => detected.has(row.id)) ? rows.filter((row) => detected.has(row.id)) : rows
    const notOffered = rows.filter((row) => !offered.includes(row))
    const lines = [
      'HypAware setup guide',
      '',
      'HypAware records AI sessions and telemetry into a local queryable history.',
      ...(configured ? [
        'HypAware is already configured:',
        JSON.stringify({
          configured,
          config_valid: report.configValid,
          cloud: !!report.layered?.hasCentral,
          clients: report.clients.filter(client => client.configured).map(client => client.name),
          sources: report.sources.map(source => source.name),
          github: report.activePlugins.includes('@hypaware/github'),
          client_sync: report.clientSync,
          folder_ask: report.usagePolicy?.folderAsk ?? null,
        }, null, 2),
        'Summarize the current choices above, then offer:',
        '  Reconfigure / See full status / Quit (default).',
        '  See full status: show the current status, then stop. Quit: change nothing.',
        '  Reconfigure: continue below using existing choices as defaults, changing only requested settings.',
      ] : [report && !report.configValid
        ? 'The existing config is invalid. Run hyp status to see the configuration problem and resolve it before installing.'
        : 'Setup is not complete. Start with question 1.']),
      '',
      'Setup flow',
      'Follow this question tree one question at a time. Wait for the answer before choosing the next branch.',
      'Use your multiple-choice question tool for every choice, including the returning-user menu, except the app list in question 2, which is asked in plain text.',
      'If the tool limits the number of options, split apps into successive groups and retain every answer. If no question tool is available, use numbered choices.',
      'Show app names and short descriptions in questions; keep command flags in the execution step. Elsewhere, do not substitute a table and an open-ended request for changes.',
      'Do not present all questions together. Reuse answers already given and skip questions that do not apply.',
      'Run each chosen step and check its result before asking the next question.',
      // @ref LLP 0462#handoffs [implements]: complete each sign-in before continuing the question tree
      'For sign-ins, explain what is opening, keep the command running, and wait for its result.',
      'If the browser does not open, share the printed URL. Never run sign-ins in parallel.',
      'If you cannot keep the command running, hand it to the person and wait for their result.',
      'Never ask the person to paste passwords or access tokens into chat.',
      '',
      '1. How do you want to collect agent logs?',
      '  Sync to the cloud (default)',
      '    One history that follows you across machines and harnesses, and can be shared with your team. You will be asked to sign in.',
      '  Local only',
      '    Everything stays on this machine. You can switch to sync later by re-running hyp setup.',
      '  Wait for the answer. Do not ask a second confirmation of this choice.',
      '  Sync to the cloud: run hyp remote login --browser and wait for it to finish before question 2.',
      '    Keep --browser with piped stdin. On a headless machine, use hyp remote login --no-browser.',
      '    If an org choice is required, ask and retry with --org <name>.',
      '    Follow the printed first-sync privacy review instructions. Do not repeat a completed login later.',
      '    If sign-in already completed during this setup, say "Already signed in - continuing." and continue to question 2.',
      '    If sign-in fails or is cancelled, report the outcome and ask question 1 again with the same options.',
      '    If enrollment succeeded but daemon installation failed, report the missing background service and continue to question 2.',
      '  Local only, when not enrolled: continue to question 2 without another question.',
      '  Local only, when enrolled: ask "This machine syncs to the cloud. Disconnect and go local-only?"',
      '    Options: "Yes, disconnect" (default) / "No, stay connected".',
      '    Yes, disconnect: run hyp leave, check the result, then continue to question 2.',
      '    No, stay connected: keep enrollment and organization-required sources, then continue to question 2.',
      '    If disconnection fails, report that the machine is still connected and ask question 1 again.',
      '',
      '2. Set up recording',
      '  With detected or configured defaults, offer:',
      '    Record everything (default) / Customize',
      '    If enrolled and sharing is available: Record and sync everything (default) / Customize',
      '    If an existing app is local-only, offer Record everything (default) / Customize instead, naming the local-only apps as staying local.',
      '    Explain: Configures <selected apps> to record through HypAware.',
      '',
      '  Record everything (or Record and sync everything):',
      '    Pass no --sync-client, --local-only-client or --new-folders flags, so existing sharing choices stay as they are.',
      '    For cloud sync, keep the existing folder preference, or Sync it automatically for a new setup. Import optional history.',
      '    Explain these choices, skip the customization questions, and proceed to installation.',
      '',
      '  Customize (or no defaults):',
      '    Do not use the question tool here. List the apps below in one plain message, then ask:',
      ...(notOffered.length
        ? ['    "These apps were detected. Are there any you don\'t want to record?"']
        : ['    "Which of these apps do you want to record?"']),
      '    Wait for the reply. This answer chooses recording only.',
      ...offered.map((row) => `    ${row.label}${detected.has(row.id) ? ' (detected)' : ''}${row.summary ? `\n      ${row.summary}` : ''}`),
      ...(notOffered.length ? [
        `    Not detected, so not offered: ${notOffered.map((row) => row.label).join(', ')}.`,
        '    Name these in one sentence. Record one only if it is already configured or the person asks for it.',
      ] : []),
      '',
      '  Selection rules:',
      '    New setup: record every listed app the person does not exclude; say which ones need separate setup.',
      '    Reconfiguration: mark which listed apps are already recorded and which are newly detected, then ask the same question.',
      '    Organization-required sources stay selected and cannot be changed here.',
      '',
      '  After the collection answer, if enrolled and sharing is available, ask: Sync all selected apps?',
      '    Options: Sync all selected apps / Customize.',
      '    Name the selected apps. Default to Sync all selected apps unless an existing app is local-only; then default to Customize.',
      '    Sync all selected apps: enable syncing for every selected app and skip the individual sync picker.',
      '    Customize: ask: What do you want to sync?',
      '    Use a separate multi-select question containing only the apps chosen for collection.',
      '    Preselect apps that already sync; for newly selected apps, default to syncing. Preserve existing local-only defaults.',
      '    Explain: Selected apps sync to the cloud. Unselected apps are still recorded locally. Selecting none keeps all optional apps local.',
      '    Organization-required sources always sync; name them separately and do not offer them as editable choices.',
      '    Skip this question for local-only setup or when no selected apps have an editable sync choice.',
      '',
      '  After cloud customization, ask about new projects, naming the selected apps:',
      `    ${folderAskTitle([])}`,
      ...FOLDER_ASK_OPTIONS.map((option) => `    ${option.label}: ${option.summary}`),
      '  Default to the existing folder preference, or Sync it automatically if none is set. Skip this question for local-only setup.',
      '',
      '3. On a Customize run, ask: Import the <selected apps> history already on this machine (up to <retention days> days)?',
      '  Yes - import it now (default): Includes your existing conversation history.',
      '  No - skip for now: You can import later.',
      '  Ask only for apps where importing history is optional. Accepting recording defaults already answers yes.',
      '  For apps that import history automatically, explain that existing sessions will be imported automatically.',
      '',
      '4. Configure recording for the selected apps.',
      ...rows.map((row) => `  ${row.label}: --source ${row.id}${row.needsSetup && row.configureCommand ? `\n    If selected, run hyp ${row.configureCommand} and finish its human handoffs before continuing.` : ''}`),
      '  Run hyp setup --source <selected-id> [--source <another-id>] with the complete chosen recording selection.',
      '  Include the agreed privacy choices in the setup command:',
      '    --sync-client <source-id> allows that source to sync; repeat for each selected sharing choice.',
      '    --local-only-client <source-id> keeps that source local; organization-required sources cannot be opted out.',
      '    --new-folders ask or --new-folders sync applies the new-project answer. Omit it to preserve the existing preference.',
      `  For a first setup, use --retention-days ${LOCAL_INSTALL_RETENTION_DAYS} for local setup or ${DEFAULT_RETENTION_DAYS} for cloud setup.`,
      '  For reconfiguration, omit retention and export flags to keep existing choices.',
      '  If a config already exists, including one created by cloud login, add --force. Setup backs it up and preserves enrollment and custom settings.',
      '  If optional history import was deferred, add --no-backfill. Automatic recovery imports still run.',
      '  Setup handles the daemon, client attachment, skills, and history imports. Do not repeat those steps with separate commands.',
      '  The flags listed here are complete. Run the setup command directly; read --help or use --dry-run only if it fails.',
      '  On macOS, setup may open a certificate or password dialog that only the person can answer; say so, wait, and report any attach failure.',
      '  Verify the result in step 6 before reporting setup complete.',
      '',
      '5. If GitHub collection is not already configured, ask: Connect GitHub?',
      '  Yes, connect GitHub (default) / Not now.',
      '  Pulls issues, pull requests, reviews, and commits for each repo you run an AI session in. HypAware only needs read access, but GitHub has no read-only option, so it will ask for read and write access to all your repos.',
      '  If accepted, rerun the setup command from step 4 with --github --force --no-backfill.',
      '  Check hyp github status. Skip login if already authenticated.',
      '  Otherwise run hyp github login to open its authorization page; share the printed device code.',
      '  On a headless machine, use hyp github login --no-browser.',
      '  Check hyp github status afterward and run hyp daemon restart to load the configuration and credentials.',
      '  If Not now was chosen, continue to step 6 without changing GitHub settings.',
      '',
      '6. Verify the completed setup with hyp status --json.',
      '  Check config.valid, daemon.running (unless --no-daemon), sources, and client_attach.',
      '  Check configured clients and attached where attachable; report errors or trust warnings.',
      '  Setup exit 0 alone does not prove daemon installation or healthy capture.',
      '  Start a new client session for newly installed skills/settings, then check capture.',
      '  Run hyp query overview --json and show a short first look at the recorded history; disclose incomplete results.',
      '',
      '7. For cloud sync, finish by asking: When would you like to upload?',
      '  Show hyp sync --dry-run, then offer these choices and wait for the answer:',
      '    Upload now (recommended): this answer is the person\'s permission to upload. Run hyp sync --yes; it ends the review window and uploads.',
      '    Wait until <deadline>: leave the scheduled first upload in place.',
      '    Wait until <deadline> and run a security review now: review the recorded history for sensitive content, keeping the scheduled upload.',
      '  Use the actual first-sync deadline from status as <deadline>. A review does not pause or extend it.',
      '  Never run hyp sync --yes unless the person chose Upload now.',
      '  If no first-sync hold is active, still ask, offering Upload now (recommended) / Wait for the next scheduled sync.',
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
  'ollama', 'langgraph', 'codex-cloud', 'chatgpt-work',
  'claude', 'claude-desktop', 'codex', 'opencode', 'antigravity', 'antigravity-desktop', 'cursor', 'copilot', 'pi', 'droid', 'grok', 'openclaw', 'hermes', 'goose', 'crush', 'mastracode', 'raw-anthropic', 'raw-openai', 'otel',
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
  'ollama', 'langgraph',
  'claude', 'claude-desktop', 'codex', 'opencode', 'antigravity', 'antigravity-desktop', 'cursor', 'copilot', 'pi', 'droid', 'grok',
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
      'sync-client': { type: 'array', items: { type: 'string', enum: [...INIT_SOURCE_CHOICES] } },
      'local-only-client': { type: 'array', items: { type: 'string', enum: [...INIT_SOURCE_CHOICES] } },
      'new-folders': { type: 'string', enum: ['ask', 'sync'] },
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
  flags.syncClients = /** @type {string[] | undefined} */ (parsed.params['sync-client'])
  flags.localOnlyClients = /** @type {string[] | undefined} */ (parsed.params['local-only-client'])
  flags.newFolders = /** @type {'ask' | 'sync' | undefined} */ (parsed.params['new-folders'])
  const localOnly = new Set(flags.localOnlyClients)
  const both = flags.syncClients?.find(name => localOnly.has(name))
  if (both) return { flags, error: `${both} is in both --sync-client and --local-only-client; pick one` }
  flags.force = p.force
  flags.clients = /** @type {InitFlags['clients']} */ ([...new Set(p.client ?? [])])
  flags.sources = /** @type {InitFlags['sources']} */ ([...new Set(p.source ?? [])])
  flags.exportChoice = p.export
  flags.retentionDays = p['retention-days']
  if (argv.some(arg => arg === '--retention-days' || arg.startsWith('--retention-days='))) flags.retentionExplicit = true
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
  const hasPrivacy = flags.newFolders !== undefined || !!flags.syncClients?.length || !!flags.localOnlyClients?.length
  const applyPrivacy = hasPrivacy ? await prepareSetupPrivacy(ctx, flags) : undefined
  if (applyPrivacy === null) return 1
  // --from-file short-circuits the picker entirely. The supplied
  // config is validated and written to the canonical location;
  // wizard.pick.start / wizard.pick.write_config / wizard.pick.finish
  // spans are still emitted so the smoke contract holds.
  if (flags.fromFile) {
    return runInitFromFile(flags, ctx, applyPrivacy)
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
    ...(ctx.platform ? { platform: ctx.platform } : {}),
    env: ctx.env,
    capabilities: ctx.capabilities,
    sources: /** @type {any} */ (ctx.sources),
    skills: /** @type {any} */ (ctx.skills),
    agents: /** @type {any} */ (ctx.agents),
    picks: {
      sources,
      exportChoice,
      retentionDays: flags.retentionDays,
      ...(flags.retentionExplicit ? { retentionExplicit: true } : {}),
      github: flags.github,
    },
    exportOrigin,
    force: flags.force,
    ...(applyPrivacy ? { applyPrivacy } : {}),
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
 * @param {((dryRun: boolean) => Promise<number>) | undefined} applyPrivacy
 * @returns {Promise<number>}
 */
async function runInitFromFile(flags, ctx, applyPrivacy) {
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
  // @ref LLP 0524#refusal [implements]: --force replaces the file, not the transport a still-proxying client depends on
  if (!(await preflightLegacyProxyAttach({
    config: /** @type {HypAwareV2Config} */ (parsed),
    configPath: targetPath,
    env: ctx.env,
    stderr: ctx.stderr,
  }))) {
    return 1
  }
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
  if (applyPrivacy) {
    const code = await applyPrivacy(dryRun)
    if (code !== 0) return code
  }
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
  '--sync-client', '--local-only-client', '--new-folders',
  '--client', '--source', '--export',
  '--retention-days', '--from-file',
  '--bin', '--force',
])
