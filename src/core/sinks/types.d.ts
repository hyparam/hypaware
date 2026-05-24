import type {
  ExportResult,
  HypAwareV2Config,
  QueryRegistry,
  QueryStorageService,
} from '../../../collectivus-plugin-kernel-types'
import type { ExtendedSinkRegistry } from '../registry/types.d.ts'

export interface DriverOptions {
  sinkRegistry: ExtendedSinkRegistry
  queryRegistry: QueryRegistry
  storage: QueryStorageService
  /** Kernel state root (e.g. `<HYP_HOME>/hypaware`). */
  stateRoot: string
  config?: HypAwareV2Config
}

export interface TickOptions {
  now?: Date
  /** Only fire one sink (test/manual use). */
  sinkInstance?: string
  /** Ignore cron-due check and fire every sink (test use). */
  force?: boolean
  /** Tag the tick metric so daemon vs. manual ticks split cleanly. Default `manual`. */
  source?: 'daemon' | 'manual'
}

export interface TickReport {
  sinks: Array<{
    instance: string
    status: ExportResult['status']
    partitionsExported: number
    bytesWritten: number
    error?: string
  }>
}
