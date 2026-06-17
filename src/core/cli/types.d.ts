import type {
  AiGatewayCapability,
  CapabilityRegistry,
  HypAwareV2Config,
  PluginConfigInstance,
  CommandRegistration,
  CommandRunContext,
} from '../../../collectivus-plugin-kernel-types.d.ts'
import type { ExtendedSourceRegistry } from '../registry/sources.js'
import type { ExtendedSinkRegistry } from '../registry/sinks.js'
import type { createCommandRegistry } from '../registry/commands.js'

export type AsyncPickPrompt = (question: WalkthroughQuestion) => Promise<string[]>
export type AsyncRetentionPrompt = (prompt: string, defaultDays: number) => Promise<number>
export type AsyncBackfillConsentPrompt = (args: {
  providers: string[]
  retentionDays: number
}) => Promise<boolean>

export type PickerSource = 'claude' | 'codex' | 'raw-anthropic' | 'raw-openai' | 'otel'
export type PickerExport = 'keep-local' | 'local-parquet' | 'configure-later'

/**
 * Provenance of a resolved export choice for telemetry. `user` means the
 * operator picked it explicitly (an `--export` flag); `default` means the
 * system supplied it (the interactive wizard or an omitted `--export`).
 */
export type PickerExportOrigin = 'default' | 'user'

export interface WalkthroughOption {
  /** Stable identifier (source name, sink contribution key, client name). */
  value: string
  /** User-visible label. */
  label: string
  summary?: string
  plugin?: string
  /**
   * Initial checkbox state in the TUI multiselect. Used by the picker to
   * pre-select autodetected sources and the default export. Ignored by
   * the legacy numbered prompt, which has no preselection concept.
   */
  checked?: boolean
}

export interface WalkthroughQuestion {
  pickType: 'sources' | 'sinks' | 'clients'
  title: string
  options: WalkthroughOption[]
  bounds?: { min?: number; max?: number }
}

export interface WalkthroughOptions {
  sources: ExtendedSourceRegistry
  sinks: ExtendedSinkRegistry
  capabilities: CapabilityRegistry
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /** Override prompt resolver (tests pre-bake answers). */
  prompt?: AsyncPickPrompt
  retentionPrompt?: AsyncRetentionPrompt
}

export interface WalkthroughResult {
  exitCode: number
  configPath: string
  config: HypAwareV2Config
  sourcesPicked: string[]
  sinksPicked: string[]
  clientsPicked: string[]
  retentionDays: number
}

export interface PickerPicks {
  sources: PickerSource[]
  exportChoice: PickerExport
  retentionDays: number
}

export interface PickerFinaleActions {
  /** When true, skip the daemon install + restart steps (mirrors `--no-daemon`). */
  skipDaemon?: boolean
  /** Pass-through to daemon install / attach / skills install. */
  dryRun?: boolean
  /** Override the resolved binPath the daemon install plan should point at. */
  binPath?: string
  /** When true, run daemon install but skip the restart step. */
  skipDaemonRestart?: boolean
}

export interface RunPickerWalkthroughOptions {
  capabilities: CapabilityRegistry
  sources?: { stopAll?: () => Promise<void> }
  skills?: {
    list(): { name: string; clients: ('claude' | 'codex')[]; sourceDir: string }[]
  }
  agents?: {
    list(): { name: string; clients: ('claude' | 'codex')[]; sourceFile: string }[]
  }
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /** Pre-baked picks; bypass prompts when set. */
  picks?: PickerPicks
  /**
   * Provenance of `picks.exportChoice`, for telemetry only. Consulted
   * solely on the pre-baked path (with `picks`); the interactive wizard
   * always defaults export, so its origin is `default`. Omit to default.
   */
  exportOrigin?: PickerExportOrigin
  prompt?: AsyncPickPrompt
  retentionPrompt?: AsyncRetentionPrompt
  /**
   * Override the system source detector. Defaults to the real
   * filesystem-based {@link detectClientSources}. Only consulted in
   * interactive mode (no pre-baked `picks`); tests inject a stub so the
   * picker's preselected boxes do not depend on the dev's home dir.
   */
  detect?: (opts: { env: NodeJS.ProcessEnv }) => Promise<Set<PickerSource>>
  /**
   * Interactive consent prompt for the onboarding backfill step. Only
   * consulted in interactive mode (no pre-baked `picks`); non-interactive
   * runs (`--yes` / `--dry-run`) backfill automatically. Defaults to a
   * yes/no confirm that defaults to yes.
   */
  backfillConsentPrompt?: AsyncBackfillConsentPrompt
  /**
   * Backfill runner the finale uses to import a picked client's local
   * history right after config is written. Injected by `hyp init` with the
   * kernel registries; omit to skip the backfill step entirely.
   */
  backfill?: PickerBackfillRunner
  /** When set, run daemon install / attach / skills / restart after writing config. */
  finale?: PickerFinaleActions
  /**
   * Overwrite an existing local config (LLP 0031). Non-interactive only
   * (`--force` / `--from-file`); the interactive wizard prompts instead.
   */
  force?: boolean
  /**
   * Interactive overwrite confirm, consulted only in interactive mode
   * (no pre-baked `picks`) when a local config already exists. Tests
   * inject a stub; the default is a readline yes/no prompt defaulting to
   * no.
   */
  confirmOverwrite?: (targetPath: string) => Promise<boolean>
}

/**
 * One provider's onboarding backfill outcome, surfaced in the finale
 * summary (one entry per picked client that has a registered backfill
 * provider). `scanned` counts source items the provider yielded;
 * `rowsWritten` / `skipped` count materialized rows. In `dryRun` the
 * provider scans but writes nothing, so `rowsWritten` is 0.
 */
export interface BackfillFinaleResult {
  provider: string
  dryRun: boolean
  ok: boolean
  scanned: number
  rowsWritten: number
  skipped: number
}

/**
 * Backfill runner injected into the picker finale. `available` lists the
 * registered provider names so the finale can intersect them with the
 * picked clients; `run` executes one provider end-to-end and returns its
 * finale summary entry.
 */
export interface PickerBackfillRunner {
  available: string[]
  run(args: {
    provider: string
    dryRun: boolean
    retentionDays: number
    until: string
  }): Promise<BackfillFinaleResult>
}

export interface FinaleSummary {
  /**
   * True when a finale prompt is cancelled after config/finale work has
   * started. The caller returns the standard cancel exit code while
   * preserving this real summary instead of replacing it with an empty
   * initial-prompt cancel result.
   */
  cancelled?: boolean
  daemonInstall: {
    skipped: boolean
    dryRun: boolean
    plan?: Record<string, unknown>
    targetPath?: string
  }
  globalInstall: {
    skipped: boolean
    installed: boolean
    binPath?: string
    packageSpec?: string
  }
  attach: { client: 'claude' | 'codex'; dryRun: boolean; ok: boolean }[]
  skillsInstalled: { name: string; client: 'claude' | 'codex'; dest: string; dryRun: boolean }[]
  agentsInstalled: { name: string; client: 'claude' | 'codex'; dest: string; dryRun: boolean }[]
  daemonRestart: { skipped: boolean; dryRun: boolean; ok: boolean }
  /** Per-provider onboarding backfill outcomes (empty when none ran). */
  backfill: BackfillFinaleResult[]
}

export interface PickerWalkthroughResult {
  exitCode: number
  configPath: string
  config: HypAwareV2Config
  sourcesPicked: PickerSource[]
  exportPicked: PickerExport
  clientsPicked: ('claude' | 'codex')[]
  retentionDays: number
  finale?: FinaleSummary
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string },
) => Promise<CommandResult>

export interface DurableBinResult {
  binPath: string
  installed: boolean
  skipped: boolean
  packageSpec?: string
  globalPrefix?: string
}

export type CommandRegistryExtended = ReturnType<typeof createCommandRegistry>

export interface InitFlags {
  yes: boolean
  noDaemon: boolean
  dryRun: boolean
  clients: ('claude' | 'codex')[]
  sources: ('claude' | 'codex' | 'raw-anthropic' | 'raw-openai' | 'otel')[]
  exportChoice: ('keep-local' | 'local-parquet' | 'configure-later') | undefined
  retentionDays: number
  fromFile?: string
  binPath?: string
  /** Overwrite an existing local config (backs it up first). */
  force: boolean
}
