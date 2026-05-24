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

export type PickerSource = 'claude' | 'codex' | 'raw-anthropic' | 'raw-openai' | 'otel'
export type PickerExport = 'keep-local' | 'local-parquet' | 'configure-later'

export interface WalkthroughOption {
  /** Stable identifier (source name, sink contribution key, client name). */
  value: string
  /** User-visible label. */
  label: string
  summary?: string
  plugin?: string
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
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /** Pre-baked picks; bypass prompts when set. */
  picks?: PickerPicks
  prompt?: AsyncPickPrompt
  retentionPrompt?: AsyncRetentionPrompt
  /** When set, run daemon install / attach / skills / restart after writing config. */
  finale?: PickerFinaleActions
}

export interface FinaleSummary {
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
  daemonRestart: { skipped: boolean; dryRun: boolean; ok: boolean }
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
}
