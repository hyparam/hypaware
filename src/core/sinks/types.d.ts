import type {
  ExportResult,
  HypAwareV2Config,
  QueryRegistry,
} from '../../../collectivus-plugin-kernel-types.d.ts'
import type { ExtendedQueryStorageService } from '../cache/types.d.ts'
import type { ExtendedSinkHandle, ExtendedSinkRegistry } from '../registry/types.d.ts'

export interface DriverOptions {
  sinkRegistry: ExtendedSinkRegistry
  queryRegistry: QueryRegistry
  storage: ExtendedQueryStorageService
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

export interface MaterializeResult {
  handles: ExtendedSinkHandle[]
  errors: MaterializeError[]
}

export interface MaterializeError {
  instance: string
  errorKind: string
  message: string
}
