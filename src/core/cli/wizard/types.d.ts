import type { CollectStatusOptions, HypAwareStatusReport } from '../../daemon/types.d.ts'

/**
 * The wizard's top-level pathway choice (LLP 0129 #fork). `quit` is the
 * safe default on a bare enter or a cancelled prompt.
 */
export type WizardForkChoice = 'team' | 'local' | 'quit'

export interface RunWizardForkOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
}

/**
 * `first-run` / `reconfigure`: no pathway preset, the caller falls
 * through to `runWizardFork`. `scoped-reconfigure`: a managed machine's
 * amended re-entry (LLP 0129 #returning-gate) - no fork, pathway presets
 * to `'scoped'`. `status` / `quit`: the gate's own terminal choices.
 */
export type ReturningGateAction = 'first-run' | 'quit' | 'status' | 'reconfigure' | 'scoped-reconfigure'

export interface ReturningGateResult {
  action: ReturningGateAction
  /** True when the merged config carries a central layer (LLP 0031). */
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
