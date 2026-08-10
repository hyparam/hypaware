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
  /** The picked, locked-filtered descriptors (the pick result's `descriptors`). */
  candidates: PickerDescriptor[]
  /**
   * The org's locked (central-layer) descriptors. Always-sync (LLP 0188
   * #locked) and never editable here, but listed - on the gate and as
   * checked, disabled menu rows - so "these will sync" states the whole
   * picture, not only the editable slice (LLP 0190 #sync-gate).
   */
  locked?: PickerDescriptor[]
  /** The step's position line, rendered on the prompt like the pick lane's. */
  progress?: string
  /**
   * Offer back-navigation out of the lane (LLP 0191): escape at the gate
   * returns `back: true` to the orchestrator (which re-runs the pick
   * lane). The menu's own back always returns to the gate regardless.
   */
  allowBack?: boolean
  /** Prompt seam (tests); defaults to the walkthrough prompt factory. */
  prompt?: AsyncPickPrompt
  /** Defaults-gate seam (tests); defaults to the confirm-select factory. */
  confirm?: AsyncConfirmSelectPrompt
  /**
   * Take the gate's stated default without stopping at it (LLP 0201): the
   * express gate already answered this lane, so it narrates the statement
   * its gate would have shown and proceeds. Has no effect on a lane with
   * no default to state, which still asks.
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
   * The rows accepting will record, already labelled (locked rows
   * fleet-suffixed) by `defaultRowLabels`. These are the pick gate's own
   * rows, so the two screens can never disagree about what "all of these"
   * means. Never empty: the orchestrator skips the gate when there is
   * nothing to accept.
   */
  rows: string[]
  /**
   * Whether this run is enrolled. Gates the two claims the gate can only
   * honestly make on a machine with a server: that everything syncs, and
   * that new folders sync without a question.
   */
  enrolled?: boolean
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
 * (with an org config that either converged or timed out); `failed` and
 * `abandoned` are the two ways an incomplete join returns to the fork
 * (LLP 0129 #failed-join-returns-to-fork). `failed` is a definitive org
 * membership/permission rejection (an admin must act); `abandoned` is a
 * transient/other failure the user can simply retry.
 */
export type WizardJoinStatus = 'ok' | 'failed' | 'abandoned'

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
   * Present on `'ok'`: the picker source ids owned by the central layer,
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
   * On a failure (`'failed' | 'abandoned'`): the login lane's own captured
   * explanation, for narration. The lane already printed it; nothing
   * branches on it (LLP 0179#no-prose-control-flow).
   */
  detail?: string
  /**
   * On a failure: the login lane's reason code, which is what
   * `printJoinFailure` branches on to name the wizard-level consequence.
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
  ) => Promise<{ ok: boolean, attached: string[] }>
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
  catalog?: Pick<PluginCatalog, 'pickerDescriptors' | 'clientDescriptors'>
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
   * Override the defaults gate (LLP 0190 #pick-gate) shown before the
   * source menu when detection or the locked set yields a default;
   * defaults to the confirm-select factory (tests pre-bake the choice).
   */
  confirm?: AsyncConfirmSelectPrompt
  /**
   * Take the defaults gate's stated rows without stopping at it
   * (LLP 0201): the express gate already answered this lane, so it
   * narrates what the gate would have shown and proceeds. With nothing
   * detected and nothing locked there is no gate and no default to take,
   * so the menu still opens - "defaults where there are defaults".
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
   * the lane's first screen returns `back: true` to the orchestrator,
   * which re-presents the fork. The menu's back returns to the defaults
   * gate whenever the gate was shown, regardless of this flag.
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
 * What the first look did. `shown: false` is a normal outcome, not a
 * failure: `no-dataset` when no gateway source was picked, `error` when the
 * query itself failed, `slow` when summarizing the cache would have
 * outlasted the step's budget (setup had already succeeded in every case).
 */
export type FirstLookResult =
  | { shown: true; providerRows: number; dayRows: number; partial?: true }
  | { shown: false; reason: 'no-dataset' | 'error' | 'slow' }

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
 * What the first ask did. Every `launched: false` value is a normal
 * outcome, never a failed install (LLP 0198#real-launch): `no-launcher`
 * when nothing picked resolves on `$PATH`, `not-interactive` on a piped
 * stream, `declined` on "Not now" or a cancelled prompt, `spawn-failed`
 * when the binary resolved but would not start, `no-rows` when the cache
 * has nothing for the questions to be about (LLP 0198#empty-cache),
 * `error` for anything unforeseen. All six print the question list
 * instead.
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
 * second case, and it is deliberately distinct from `declined` (the wizard's
 * own question) - the two say different things about how far the user got.
 */
export type WizardSyncNowResult =
  | { asked: true; released: true }
  | { asked: true; released: false; reason: 'declined' | 'sync-declined' | 'spawn-failed' }
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
  confirm?: AsyncConfirmSelectPrompt
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  readDeadline?: () => Promise<number | null>
}

/** Options for `runWizardFirstAsk`. */
export interface RunWizardFirstAskOptions {
  /** Picked client names, from the pick phase (LLP 0180 derivation). */
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
  cwd?: string
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
   * Override the first look's query seam (tests). Defaults to a runner
   * built from `ctx`; the step is skipped when neither is available.
   */
  firstLook?: OverviewQueryRunner
  /**
   * Overrides for the closing first ask (tests): the PATH resolver, the
   * spawn seam, the select seam. Production callers pass none, and the
   * step is attended-only like the first look.
   */
  firstAsk?: Partial<RunWizardFirstAskOptions>
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
  /** Pick-phase prompt seams, threaded through unchanged (tests). */
  prompt?: AsyncPickPrompt
  /**
   * Defaults-gate seam, threaded to the pick and sync lanes and used for
   * the managed-local disconnect question (tests).
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
  /** Source ids rendered locked in this run (central-layer, LLP 0031). */
  lockedSources: string[]
  /**
   * Set on a `deferWrite` run: `config` is composed but not on disk yet;
   * the caller owns the commit (guard + write) before anything reads the
   * config file (LLP 0190 #commit-point).
   */
  configPending?: true
}
