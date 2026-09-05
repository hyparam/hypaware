import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { CapabilityRegistry, CommandRunContext, HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.d.ts'
import type { CollectStatusOptions, HypAwareStatusReport } from '../../daemon/types.d.ts'
import type { OverviewQueryRunner } from '../../query/types.d.ts'
import type { LoginOutcomeReason } from '../../remote/types.d.ts'
import type { ClientDescriptor, PickerDescriptor, PluginCatalog } from '../../types.d.ts'
import type { FolderAskMode } from '../../usage-policy/types.d.ts'
import type { SelectSpec } from '../tui/types.d.ts'
import type {
  AsyncBackfillConsentPrompt,
  AsyncConfirmSelectPrompt,
  AsyncPickPrompt,
  FinaleSummary,
  PickerBackfillRunner,
  PickerExport,
  PickerExportOrigin,
  PickerFinaleActions,
  PickerPicks,
  PickerSource,
} from '../types.d.ts'

/**
 * The wizard's top-level pathway choice (LLP 0129 #fork). `quit` is the
 * safe default on a bare enter or a cancelled prompt. `back` (LLP 0191)
 * returns to the returning gate and is only reachable when the fork was
 * asked with `allowBack` (a reconfigure run; a first run has no screen
 * before the fork).
 */
export type WizardForkChoice = 'team' | 'local' | 'quit' | 'back'

/**
 * A pathway the wizard has committed to. Distinct from
 * {@link WizardForkChoice}: `quit` is not a pathway. Every run reaches
 * one of these through the fork, including a managed machine's
 * Reconfigure (LLP 0182); a managed machine is marked by `managed`, not
 * by a pathway of its own.
 */
export type WizardPathway = 'team' | 'local'

/**
 * Which tier produced the pick lane's seed set, most-recent answer first
 * (LLP 0191 #re-entry-seeding, LLP 0183 #seed-from-config). The seed set
 * itself does not record where it came from, and hidden-row carry-through
 * (LLP 0202 #carry-through) reads differently off each tier:
 *
 * - `selection`: a re-entry after stepping back, seeded with the selection
 *   the previous pass confirmed. A hidden row is in it only because that
 *   pass carried it, so it carries again.
 * - `config`: a reconfigure, seeded by reading the config on disk back.
 *   Read-back seeds a hidden row *derivatively* (a client's upstream also
 *   satisfies the raw row that composes the same bytes), so a hidden row
 *   here carries only when the menu can show nothing the config collects.
 * - `detected`: a first run, seeded by probing the machine. Never a
 *   choice, so it never carries.
 */
export type SeedOrigin = 'selection' | 'config' | 'detected'

/**
 * The wizard lanes that count as a step in the position indicator
 * (LLP 0135 #progress). One entry per lane that asks the user something,
 * not one per phase: `configure` and the privacy narration are output, and
 * `first look` is a closing report rather than a decision.
 */
export type WizardStepName = 'join' | 'pick' | 'sync' | 'folders' | 'finale'

/**
 * The sync-scope step (LLP 0188 #never-silent, LLP 0190 #sync-gate): after
 * the picker on every enrolled run, a defaults gate stating what will sync,
 * then - on request - a multiselect over the non-locked picked sources
 * where checked means "syncs" and unchecked keeps a source local-only.
 * Locked (org-configured) sources never appear: they always sync
 * (LLP 0188 #locked).
 */
export interface RunWizardSyncScopeOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * The picked, locked-filtered descriptors (the pick result's
   * `descriptors`), arriving display-filtered like `locked` below: a
   * hidden row (LLP 0202) is off every wizard screen, this one included.
   */
  candidates: PickerDescriptor[]
  /**
   * The org's locked (central-layer) descriptors, already display-filtered
   * (LLP 0276 #sync-gate). Always-sync (LLP 0188 #locked) and never
   * editable here, but listed - on the gate and as checked, disabled menu
   * rows - so "these will sync" states the whole picture, not only the
   * editable slice (LLP 0190 #sync-gate).
   */
  locked?: PickerDescriptor[]
  /**
   * How many locked rows the display filter removed from `locked`. The
   * lane never names them, but it may not tell the user nothing syncs
   * while they stand: a locked row always syncs (LLP 0188 #locked), and
   * on an enrolled machine the whole locked set is usually hidden.
   */
  lockedHidden?: number
  /**
   * The picked rows the display filter removed from `candidates`, by id,
   * read for the same reason as `lockedHidden`: a carried hidden row
   * (LLP 0202 #carry-through) is composed into the config and syncs
   * unless an opt-out entry says otherwise, so the lane may not claim
   * nothing syncs while one stands - even though it may not name it.
   *
   * Ids rather than `lockedHidden`'s count (LLP 0289 #ask-the-store):
   * "unless an opt-out entry says otherwise" is a question only the
   * policy store can answer, and only about a named source. The lane puts
   * them to the store and never to the screen. The locked list needs no
   * such channel: an org row always syncs (LLP 0188 #locked) and the
   * export seam drops opt-out entries for central-classified sources, so
   * its count already decides its sentence.
   */
  candidatesHiddenIds?: string[]
  /** The step's position line, rendered on the prompt like the pick lane's. */
  progress?: string
  /**
   * Offer back-navigation out of the lane (LLP 0191): escape at the menu
   * returns `back: true` to the orchestrator (which re-runs the pick
   * lane).
   */
  allowBack?: boolean
  /** Prompt seam (tests); defaults to the walkthrough prompt factory. */
  prompt?: AsyncPickPrompt
  /**
   * Take the stated default without stopping at it (LLP 0201 #narrate):
   * the express gate already answered this lane, so it narrates the sync
   * split the menu would have shown and proceeds.
   */
  autoAccept?: boolean
}

export interface WizardSyncScopeResult {
  /** The user cancelled at the prompt; the wizard exits 130. */
  cancelled?: boolean
  /** The user stepped back out of the lane (LLP 0191); nothing written. */
  back?: true
  /** Candidate source ids the user opted out (kept local-only). */
  optedOut: string[]
  /** The step was skipped (corrupt store) rather than answered. */
  skipped?: boolean
  /**
   * The lane reached its outcome without presenting a prompt: everything
   * picked was fleet-locked, or the store was unreadable. It is then a
   * statement rather than a screen, so the lane after it steps back *past*
   * it (LLP 0191 #back-edges: escape reaches the last screen the user could
   * answer, and a lane that asked nothing is not one). Not set on the
   * express path, which asks nothing anywhere and never backs.
   */
  noQuestion?: true
}

/**
 * The new-folder step (LLP 0200 #wizard): one question on every enrolled
 * run, asked after the per-adapter sync lane. It answers a different axis
 * than that lane - not "which adapters ship" but "what happens the next
 * time I work somewhere new" - which is why it is its own step.
 */
export interface RunWizardFolderAskOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /** The step's position line, rendered like the other lanes'. */
  progress?: string
  /**
   * Plain tool names for the question's title ("When opening Claude Code
   * or Codex in a new project,"): the run's picked and locked rows.
   * Empty or absent falls back to the tool-free phrasing.
   */
  names?: string[]
  /**
   * Offer back-navigation out of the lane (LLP 0191): escape returns
   * `back: true` and the orchestrator re-presents the sync lane.
   */
  allowBack?: boolean
  /** Prompt seam (tests); defaults to the confirm-select factory. */
  confirm?: AsyncConfirmSelectPrompt
  /**
   * Take the default answer without asking (LLP 0201): the express gate
   * already answered this lane, so it narrates and records the default.
   */
  autoAccept?: boolean
}

/**
 * The express gate's answer (LLP 0201): `defaults` accepts every lane's
 * stated default without stopping at it, `choose` runs the lanes as they
 * are. `back` returns to the fork; `cancelled` ends the run like any other
 * cancelled prompt.
 */
export type WizardExpressChoice = 'defaults' | 'choose' | 'back' | 'cancelled'

export interface RunWizardExpressGateOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * The plain names of the tools accepting will record (no fleet or
   * setup suffixes), joined into the accept row's summary sentence
   * (LLP 0201 #gate). These are the pick lane's own default rows from
   * `resolvePickSeeding`, so the gate and the lane can never disagree
   * about what "everything" means. Never empty: the orchestrator skips
   * the gate when there is nothing to accept.
   */
  rows: string[]
  /**
   * Whether this run is enrolled. Gates the sync claim the gate can only
   * honestly make on a machine with a server.
   */
  enrolled?: boolean
  /**
   * Does the client-sync store already withhold one of `rows` from the
   * server? The accept row may only promise sync for what would in fact
   * sync (LLP 0201 #gate), and an express accept preserves standing
   * opt-outs verbatim rather than clearing them, so on a reconfigure the
   * unqualified claim is false. Resolution failure passes `true`: a gate
   * that cannot prove everything syncs must not say it does. Ignored on
   * an unenrolled run, which claims no sync at all.
   */
  syncWithheld?: boolean
  /** Offer back-navigation to the fork (LLP 0191). */
  allowBack?: boolean
  /** Prompt seam (tests); defaults to the confirm-select factory. */
  confirm?: AsyncConfirmSelectPrompt
}

export interface WizardFolderAskResult {
  /**
   * The mode in force when the lane finished: the answer on a normal run,
   * and the pre-existing mode on a cancel, a back, or a failed write.
   */
  mode: FolderAskMode
  /** The user cancelled at the prompt; the wizard exits 130. */
  cancelled?: boolean
  /** The user stepped back out of the lane (LLP 0191); nothing written. */
  back?: true
  /** The answer could not be written; the previous mode stands. */
  skipped?: boolean
}

export interface RunWizardForkOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * Offer back-navigation (LLP 0191): escape (or `b` on the readline
   * fallback) resolves to `'back'`. Set only when a screen precedes the
   * fork - the returning gate on a reconfigure run.
   */
  allowBack?: boolean
}

/**
 * `first-run` / `reconfigure`: no pathway preset, the caller falls
 * through to `runWizardFork` (LLP 0182: a managed machine included, its
 * org rows arriving as a locked set rather than as a pathway of their
 * own). `status` / `quit`: the gate's own terminal choices.
 */
export type ReturningGateAction = 'first-run' | 'quit' | 'status' | 'reconfigure'

export interface ReturningGateResult {
  action: ReturningGateAction
  /**
   * True when a central layer is on disk (LLP 0031), independently of
   * whether the merged config currently exists or validates: enrollment
   * is a property of the machine, and the org's rows stay locked even on
   * the `first-run` path a broken merge falls to.
   */
  managed: boolean
  report: HypAwareStatusReport
}

export interface EvaluateReturningGateOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /** Optional kernel runtime, forwarded to `collectStatus` unchanged. */
  runtime?: CollectStatusOptions['runtime']
  /**
   * Override status collection (tests inject a fixture report so the
   * gate branches don't depend on a real config file on disk). Defaults
   * to the real `collectHypAwareStatus`.
   */
  collectStatus?: (opts: CollectStatusOptions) => Promise<HypAwareStatusReport>
}

/**
 * The picker result the configure phase reads (LLP 0135 #configure). Only
 * `descriptors` is consumed here; the pick phase (LLP 0135 #pick) owns the
 * full result shape. `runConfigurePhase` loops the subset with
 * `needsSetup: true` and a `configureCommand`.
 */
export interface ConfigurePhasePicked {
  descriptors: PickerDescriptor[]
  /**
   * Picked source ids the existing config already composed before this
   * run. A `needs_setup` row here was consented to when it was first
   * picked, so a reconfigure that keeps it must not re-run its
   * `configure_command` and re-ask (8/13 feedback); the standalone
   * command stays the finish/repair path.
   */
  previouslyConfigured?: string[]
}

/**
 * In-process command dispatch seam (LLP 0130 #configure-command), the same
 * `CommandRunContext.commands` member the dispatcher populates. The
 * configure phase runs each `needs_setup` picker row's `configure_command`
 * through `run(name, argv)` and drops the source on a non-zero exit or a
 * throw (LLP 0131 #drop-on-failure).
 */
export interface ConfigureCommandContext {
  commands: { run(name: string, argv: string[]): Promise<number> }
}

export interface RunConfigurePhaseOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  /** The `ctx.commands.run` seam (LLP 0130). */
  ctx: ConfigureCommandContext
  /**
   * When true, `--print-commands` is threaded onto the invoked command's
   * own argv so its existing no-sudo escape hatch prints the privileged
   * commands instead of running them (LLP 0131 #idempotent-rerun). The
   * wizard adds no separate implementation.
   */
  printCommands?: boolean
  /**
   * Present only on the non-interactive callers (`--yes`, `--dry-run`,
   * presets, `--from-file`). The configure phase is attended-only
   * (LLP 0131 #attended-only): when this is set it runs nothing.
   */
  picks?: unknown
}

/** One picked `needs_setup` descriptor's configure outcome. */
export interface ConfigurePhaseEntryResult {
  /** The picker source id (`PickerDescriptor.id`). */
  id: string
  /** True on a zero exit code; false when dropped from this run. */
  ok: boolean
  /** The command's exit code, when it returned one (drop-on-nonzero). */
  exitCode?: number
  /** Stringified thrown error, when the command threw (drop-on-throw). */
  error?: string
}

export interface ConfigurePhaseResult {
  results: ConfigurePhaseEntryResult[]
}

/**
 * The join phase's verdict (LLP 0135 #join). `ok` is a completed sign-in
 * (with an org config that either converged or timed out).
 * `daemon_incomplete` is also a completed sign-in - authenticated,
 * enrolled, forwarding, first-sync hold armed - whose background service
 * did not install; it carries on into the wizard on the team pathway and
 * only the caveat is narrated, because LLP 0129
 * #failed-join-returns-to-fork governs a join that provisioned nothing and
 * this one provisioned everything. `failed` and `abandoned` are the two
 * ways an incomplete join returns to the fork. `failed` is a definitive org
 * membership/permission rejection (an admin must act); `abandoned` is a
 * transient/other failure the user can simply retry.
 */
export type WizardJoinStatus = 'ok' | 'daemon_incomplete' | 'failed' | 'abandoned'

/**
 * The two-layer config `classifyClientProvenance` reads (LLP 0031): the
 * server-owned central layer and the merged effective config. The join
 * phase resolves it from disk after convergence to compute the locked set.
 */
export interface LayeredProvenance {
  centralConfig?: HypAwareV2Config | null
  effective?: HypAwareV2Config | null
}

/**
 * What the login lane returns to the join wrapper: the `hyp remote login`
 * exit code, the reason behind it, and its captured stderr.
 * `classifyLoginFailure` maps `reason` to `'failed' | 'abandoned'`
 * (LLP 0179#no-prose-control-flow); `stderr` is narration only, echoed back
 * as the failure `detail`, never matched against.
 */
export interface LoginLaneResult {
  exitCode: number
  /**
   * Absent only on a test double that predates the outcome return; the
   * classifier reads that as retriable.
   */
  reason?: LoginOutcomeReason
  stderr: string
}

export interface WizardJoinResult {
  status: WizardJoinStatus
  /**
   * Present on a completed join (`'ok'` or `'daemon_incomplete'`): the
   * picker source ids owned by the central layer,
   * which the pick phase renders locked (LLP 0129 #join-before-picker).
   * Empty on a timeout or the no-org-config 404 steady state - nothing is
   * pinned, so the picker composes freely.
   */
  lockedSources?: string[]
  /**
   * True when the org config converged, i.e. the machine now carries a
   * central layer. Drives the pick phase's `managed` annotation
   * (LLP 0132 #never-silent). Absent on the timeout/404 fall-through:
   * nothing is pinned yet, so the picker renders unmanaged.
   */
  managed?: boolean
  /**
   * On a fork-returning outcome (`'failed' | 'abandoned'`): the login
   * lane's own captured explanation, for narration. The lane already
   * printed it; nothing branches on it (LLP 0179#no-prose-control-flow).
   */
  detail?: string
  /**
   * On a fork-returning outcome: the login lane's reason code, which is
   * what `printJoinFailure` branches on to name the wizard-level
   * consequence.
   */
  reason?: LoginOutcomeReason
}

export interface RunWizardJoinOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * The plugin catalog. Its `pickerDescriptors` key space is the lock
   * candidate set, and both descriptor maps resolve a source id to its
   * owning plugin for `classifyClientProvenance`.
   */
  catalog: PluginCatalog
  /**
   * The command context the login lane runs against (production wiring,
   * supplied by `runInitWizard`). Optional so tests can inject `runLogin`
   * and never touch the real login lane.
   */
  ctx?: CommandRunContext
  /**
   * Override the login lane (tests). Defaults to `remoteLogin` over `ctx`,
   * whose returned `reason` is what `classifyLoginFailure` reads.
   */
  runLogin?: () => Promise<LoginLaneResult>
  /**
   * Override the convergence wait (tests). Defaults to
   * `waitForCentralConverge`.
   */
  waitForConverge?: (
    opts: { env: NodeJS.ProcessEnv },
    waitOpts: { timeoutMs?: number, intervalMs?: number }
  ) => Promise<{ ok: boolean }>
  /**
   * Override layered-config resolution (tests inject a fixture). Defaults
   * to `resolveLayeredConfigFromDisk` over the on-disk local + central
   * layers.
   */
  resolveLayered?: () => Promise<LayeredProvenance>
  /**
   * The lane's position line (LLP 0135 #progress), e.g.
   * `Step 1 of 3 · Join your team`. The join lane owns no prompt spec, so
   * it prints the line itself above its narration. Absent on runs with no
   * committed pathway, which then print nothing.
   */
  progress?: string
}

/**
 * The wizard pick phase (LLP 0135 #pick). Options come from
 * `catalog.pickerDescriptors` (LLP 0130), central-layer-locked rows render
 * checked and disabled (LLP 0031 provenance vocabulary) and are filtered
 * out of the returned picks before composition (LLP 0129
 * #join-before-picker). Non-interactive callers set `picks` and skip
 * prompting, matching today's `interactive = !opts.picks` split.
 */
export interface RunWizardPickOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * The plugin catalog (T2). Picker rows come from
   * `catalog.pickerDescriptors`; when omitted the phase loads the bundled
   * catalog itself, matching `runPickerWalkthrough`'s self-loading shape.
   */
  catalog?: Pick<PluginCatalog, 'pickerDescriptors' | 'clientDescriptors' | 'composeWith'>
  /**
   * Platform the menu gates rows against, defaulting to `process.platform`.
   * The row set is otherwise a function of the host, so a test over it would
   * answer differently on a Mac and on CI.
   */
  platform?: string
  /**
   * Central-layer-locked source ids from the join phase (LLP 0129
   * #join-before-picker). Each renders checked and disabled with the
   * `· managed by your fleet` label suffix, and is filtered out of the
   * returned `sourcesPicked` so composition never re-adds a source the
   * central layer already owns.
   */
  locked?: string[]
  /**
   * True when the machine carries a central layer (a completed join, or a
   * managed machine's re-entry). Every non-locked row then renders with
   * the `· stays on this machine` suffix: an addition beyond the org set
   * is collected but never forwarded (LLP 0132 #never-silent), and the
   * picker says so before the box is ticked. Distinct from `locked` being
   * non-empty - a managed org config may pin zero picker sources.
   */
  managed?: boolean
  /** Pre-baked picks; non-interactive callers set this and skip prompting. */
  picks?: PickerPicks
  /** Provenance of `picks.exportChoice`, for telemetry only. */
  exportOrigin?: PickerExportOrigin
  /** Override the source prompt (tests pre-bake answers). */
  prompt?: AsyncPickPrompt
  /**
   * Take the default rows without asking (LLP 0201 #narrate): the express
   * gate already answered this lane, so it narrates the rows it accepted
   * and proceeds. With nothing detected and nothing locked there is no
   * default to take, so the menu still opens - "defaults where there are
   * defaults".
   */
  autoAccept?: boolean
  /**
   * The lane's position line (LLP 0135 #progress), e.g.
   * `Step 2 of 3 · Choose what to collect`. Threaded onto the picker's
   * prompt spec rather than folded into its title, so the TUI and the
   * legacy numbered fallback render the same text their own way. Absent on
   * non-interactive runs, which then prompt nothing and print nothing.
   */
  progress?: string
  /**
   * The retention window applied without asking (LLP 0137): the
   * orchestrator passes it only for an unmanaged local install (120-day);
   * a team run, and a managed machine on the local pathway, omit it and
   * take the 90-day `DEFAULT_RETENTION_DAYS`.
   */
  retentionDefault?: number
  /**
   * Offer back-navigation out of the lane (LLP 0191): escape (or `b`) at
   * the menu returns `back: true` to the orchestrator, which re-presents
   * the express gate when it was shown, and the fork otherwise.
   */
  allowBack?: boolean
  /**
   * Seed the checked rows with a previous run's confirmed selection
   * (LLP 0191): set when the user steps back into the pick lane from a
   * later step, so their answer is preserved instead of re-derived from
   * detection. Locked rows stay checked either way; detection is skipped
   * entirely when this is present.
   */
  initialSelection?: string[]
  /** Override the system source detector (interactive only). */
  detect?: (opts: { env: NodeJS.ProcessEnv }) => Promise<Set<PickerSource>>
  /** Overwrite an existing local config non-interactively (`--force`). */
  force?: boolean
  /** Interactive overwrite confirm, consulted only when a config exists. */
  confirmOverwrite?: (targetPath: string) => Promise<boolean>
  /**
   * Skip the overwrite guard and the config write, returning the composed
   * config with `configPending` set. The wizard orchestrator sets this and
   * commits via `commitWizardPickedConfig` after the sync lane (LLP 0190
   * #commit-point), so the overwrite confirm is the last question and a
   * cancel at the sync lane leaves the existing config untouched.
   */
  deferWrite?: boolean
}

/**
 * What the first look decided. `shown: false` is a normal outcome, not a
 * failure: `no-dataset` when no gateway source was picked, `error` when the
 * query itself failed, `slow` when summarizing the cache would have
 * outlasted the step's budget (setup had already succeeded in every case).
 */
export type FirstLookOutcome =
  | { shown: true; providerRows: number; dayRows: number; partial?: true }
  | { shown: false; reason: 'no-dataset' | 'error' | 'slow' }

/**
 * The outcome plus whether the step wrote anything to stdout, which is a
 * different question and is measured rather than derived from `shown`: the
 * `slow` skip renders no block and still writes two lines saying so, while
 * `no-dataset` and `error` write nothing. A caller asking "did this push
 * earlier output out of view" reads `wrote`; a caller asking "does the user
 * now have their numbers" reads `shown` (LLP 0230 #when).
 */
export type FirstLookResult = FirstLookOutcome & { wrote: boolean }

/**
 * A client this run can actually start on a question: picked by the
 * user, and with its `contributes.client.launch` binary resolved on
 * `$PATH` (LLP 0198#path-probe). `args` still carries the `{prompt}`
 * placeholder; substitution happens at spawn.
 */
export interface FirstAskLauncher {
  client: string
  label: string
  bin: string
  binPath: string
  args: string[]
}

/**
 * What the explicit first ask did. Every `launched: false` value is a
 * contained command outcome (LLP 0198#real-launch): `no-launcher`
 * when no attached client resolves on `$PATH`, `not-interactive` on a piped
 * stream, `declined` on "Not now" or a cancelled prompt, `spawn-failed`
 * when the binary resolved but would not start, `no-rows` when the cache
 * has nothing for the questions to be about (LLP 0198#empty-cache),
 * `error` for anything unforeseen. All six print the question list instead.
 */
export type FirstAskResult =
  | { launched: true; client: string; promptId: string; exitCode?: number }
  | { launched: false; reason: 'no-launcher' | 'not-interactive' | 'declined' | 'spawn-failed' | 'no-rows' | 'error' }

/**
 * The closing "send now" offer's outcome (LLP 0203).
 *
 * `released` is read back from the hold marker, never inferred from the
 * child's exit code: `hyp sync` exits 0 both when it sends and when the
 * user reads its destination list and answers no. `sync-declined` is that
 * second case, and it is the only decline there is: the wizard puts no
 * question of its own ahead of the child's (LLP 0203 #no-new-consent).
 */
export type WizardSyncNowResult =
  | { asked: true; released: true }
  | { asked: true; released: false; reason: 'sync-declined' | 'spawn-failed' }
  | { asked: false; reason: 'no-hold' | 'not-interactive' | 'error' }

/** Options for `runWizardSyncNow`. */
export interface RunWizardSyncNowOptions {
  /**
   * The live first-sync deadline (epoch ms), as the privacy narration read
   * it. Anything else means no hold applies and the step does not run: the
   * offer only exists because the wait does.
   */
  deadline: number | null
  stdout: { write(chunk: string): unknown }
  stderr?: { write(chunk: string): unknown }
  env: NodeJS.ProcessEnv
  /** False on a piped or scripted run: never prompt, never send. */
  interactive?: boolean
  stdin?: NodeJS.ReadableStream
  /** Real stream for the TUI, when `stdout` above is a buffer. */
  stdoutStream?: NodeJS.WritableStream
  /** Test seams; production callers pass none of these. */
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  readDeadline?: () => Promise<number | null>
}

/** Options for `runWizardFirstAsk`. */
export interface RunWizardFirstAskOptions {
  /** Attached client names eligible for an explicit `hyp ask` launch. */
  clients: string[]
  descriptors: Map<string, ClientDescriptor>
  stdout: { write(chunk: string): unknown }
  stderr?: { write(chunk: string): unknown }
  env: NodeJS.ProcessEnv
  /** False on a piped run: print the list, never prompt. */
  interactive?: boolean
  /**
   * Whether the cache holds anything the suggested questions could be
   * answered from. `false` suppresses the launch entirely
   * (LLP 0198#empty-cache); `undefined` means the caller could not tell,
   * which never withholds the offer.
   */
  hasRows?: boolean
  /** Working directory the client is started in; defaults to the caller's. */
  stdin?: NodeJS.ReadableStream
  /** Real stream for the TUI, when `stdout` above is a buffer. */
  stdoutStream?: NodeJS.WritableStream
  /** Test seams; production callers pass none of these. */
  platform?: string
  resolve?: (bin: string, env: NodeJS.ProcessEnv, platform?: string) => Promise<string | undefined>
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  select?: (spec: SelectSpec) => Promise<string | number>
}

/**
 * One of the wizard's two output streams, as the stream guard (LLP 0341)
 * accepts and returns it: the same union every lane option declares,
 * with the two read-only properties the prompt runtime consults.
 */
export type WizardOutputSink = NodeJS.WritableStream | {
  write(chunk: string): unknown
  readonly isTTY?: boolean | undefined
  readonly columns?: number | undefined
}

/**
 * The wizard's stream guard (LLP 0341 #absorb): wrapped sinks whose
 * writes never throw, plus the orchestrator's boundary check.
 */
export interface WizardOutputGuard {
  /** The wrapped consent surface; hand this to every lane. */
  stdout: WizardOutputSink
  /** The wrapped qualifier stream; hand this to every lane. */
  stderr: WizardOutputSink
  /** Whether stdout is already known dead, without settling. */
  outputDead(): boolean
  /**
   * The boundary check: settle stdout's pending writes (bounded), then
   * report whether the consent surface is still alive. False means the
   * run must end as a cancel (LLP 0341 #dead-surface).
   */
  checkpoint(): Promise<boolean>
  /**
   * Remove the guard's `error` listeners from the caller's streams. The
   * run owns them only while it is running; call this when it ends,
   * however it ends.
   */
  detach(): void
}

/**
 * Options for `runInitWizard`, the fork -> join -> pick -> configure ->
 * privacy -> finale orchestrator (LLP 0135 #orchestration). Non-interactive
 * callers (`--yes`, `--dry-run`, presets, `--from-file`) set `picks` and the
 * orchestrator short-circuits straight to the pick phase + finale, matching
 * the walkthrough's `interactive = !opts.picks` split.
 *
 * The phase overrides (`gate`, `fork`, `join`, `pick`, `configure`,
 * `finaleRunner`) exist for tests, which drive the state machine with
 * scripted phases; production callers pass none of them.
 */
export interface RunInitWizardOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * The command context: the join phase's login lane runs against it and
   * the configure phase invokes `ctx.commands.run` through it. Its
   * registries also back the returning gate's status collection.
   */
  ctx: CommandRunContext
  /** Finale registries, identical to the walkthrough's. */
  capabilities: CapabilityRegistry
  sources?: { stopAll?: () => Promise<void> }
  skills?: { list(): { name: string; clients: ('claude' | 'codex')[]; sourceDir: string }[] }
  agents?: { list(): { name: string; clients: ('claude' | 'codex')[]; sourceFile: string }[] }
  backfill?: PickerBackfillRunner
  finale?: PickerFinaleActions
  /** Pre-baked picks: the non-interactive short-circuit. */
  picks?: PickerPicks
  exportOrigin?: PickerExportOrigin
  force?: boolean
  /** Threaded to the configure phase's `--print-commands` passthrough. */
  printCommands?: boolean
  /**
   * Runs the full `hyp status` report when the returning gate's
   * "See full status" is chosen. Supplied by `runInit` so the wizard
   * module does not import command modules.
   */
  runStatus?: () => Promise<number>
  /** Pre-built catalog (tests); defaults to the bundled-plugin catalog. */
  catalog?: PluginCatalog
  /**
   * Platform every screen gates its rows against, defaulting to
   * `process.platform`. Threaded to the pick lane and to the row sets the
   * orchestrator computes itself (the express gate, the sync-scope lists),
   * so one run cannot gate two of its screens on different platforms.
   */
  platform?: string
  /**
   * Override the first look's query seam (tests). Defaults to a runner
   * built from `ctx`; the step is skipped when neither is available.
   */
  firstLook?: OverviewQueryRunner
  /**
   * Override the first look's deadline (tests). Defaults to the step's own
   * budget; a test driving the slow-skip branch through the orchestrator
   * would otherwise have to wait out the real one.
   */
  firstLookBudgetMs?: number
  /**
   * Overrides for the closing sync offer (tests): the confirm seam, the
   * spawn seam, the hold re-read. Production callers pass none, and the
   * step runs only on an enrolled run with a live hold.
   */
  syncNow?: Partial<RunWizardSyncNowOptions>
  /** Phase overrides (tests). */
  gate?: (opts: EvaluateReturningGateOptions) => Promise<ReturningGateResult>
  fork?: (opts: RunWizardForkOptions) => Promise<WizardForkChoice>
  join?: (opts: RunWizardJoinOptions) => Promise<WizardJoinResult>
  pick?: (opts: RunWizardPickOptions) => Promise<WizardPickResult>
  syncScope?: (opts: RunWizardSyncScopeOptions) => Promise<WizardSyncScopeResult>
  folderAsk?: (opts: RunWizardFolderAskOptions) => Promise<WizardFolderAskResult>
  express?: (opts: RunWizardExpressGateOptions) => Promise<WizardExpressChoice>
  configure?: (picked: ConfigurePhasePicked, opts: RunConfigurePhaseOptions) => Promise<ConfigurePhaseResult>
  finaleRunner?: (args: Record<string, unknown>) => Promise<FinaleSummary>
  /**
   * Multiselect seam, threaded unchanged to both menu lanes - pick and
   * sync (tests). They are told apart by `pickType`.
   */
  prompt?: AsyncPickPrompt
  /**
   * Confirm-select seam, threaded to the express gate and the new-folder
   * question and used for the managed-local disconnect question (tests).
   * The pick and sync lanes no longer take one: their defaults gates are
   * retired (LLP 0201 #decline) and they ask through `prompt` alone.
   */
  confirm?: AsyncConfirmSelectPrompt
  /**
   * Override the fleet teardown the managed-local disconnect confirm
   * invokes (tests). Defaults to `ctx.commands.run('leave', [])`, the real
   * `hyp leave` (LLP 0190 #fork-disconnect).
   */
  leave?: () => Promise<number>
  detect?: (opts: { env: NodeJS.ProcessEnv }) => Promise<Set<PickerSource>>
  confirmOverwrite?: (targetPath: string) => Promise<boolean>
  backfillConsentPrompt?: AsyncBackfillConsentPrompt
}

/**
 * The wizard's overall outcome. `exitCode` is what `hyp init` returns:
 * 0 on success or a deliberate quit, 1 on an overwrite refusal, 130 on a
 * cancelled prompt. The remaining fields mirror the pick result for
 * callers that want them; absent when the run ended before the pick
 * phase (gate quit, fork quit).
 */
export interface InitWizardResult {
  exitCode: number
  /** The pathway the run took; absent when it ended at the gate/fork. */
  pathway?: WizardPathway
  cancelled?: boolean
  configPath?: string
  config?: HypAwareV2Config
  sourcesPicked?: PickerSource[]
  clientsPicked?: string[]
  lockedSources?: string[]
  configureResults?: ConfigurePhaseEntryResult[]
  finale?: FinaleSummary
}

/**
 * The pick phase result. A superset of the fields the configure phase
 * (`descriptors`) and the finale (`config`, `configPath`, `sourcesPicked`,
 * ...) read. `cancelled` short-circuits the orchestrator; `exitCode` is 130
 * on a cancel, 1 on an overwrite refusal, else 0.
 */
export interface WizardPickResult {
  exitCode: number
  /** True when the user cancelled at a prompt (exitCode 130). */
  cancelled?: boolean
  /**
   * The user stepped back out of the lane (LLP 0191). Nothing was
   * composed or written; the orchestrator re-presents the previous step.
   */
  back?: true
  configPath: string
  config: HypAwareV2Config
  /** Picked source ids, with locked (central-layer) ids removed. */
  sourcesPicked: PickerSource[]
  exportPicked: PickerExport
  clientsPicked: string[]
  retentionDays: number
  /** The picked, locked-filtered descriptors, for the configure phase. */
  descriptors: PickerDescriptor[]
  /**
   * Picked ids the existing config already composed (a reconfigure's
   * carried answers). The configure phase skips `needs_setup` rows in
   * this set: their setup question was asked when they were first picked.
   */
  previouslyConfigured: string[]
  /** Source ids rendered locked in this run (central-layer, LLP 0031). */
  lockedSources: string[]
  /**
   * Set on a `deferWrite` run: `config` is composed but not on disk yet;
   * the caller owns the commit (guard + write) before anything reads the
   * config file (LLP 0190 #commit-point).
   */
  configPending?: true
}
