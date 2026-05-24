import type { AiGatewayExchangeInput } from '../../../../collectivus-plugin-kernel-types'

export interface CodexLogReader {
  /** Identifier used in telemetry and de-dup. */
  name: string
  /**
   * Pure function that may augment the projection with locally-collected
   * Codex state (e.g. parsed SQLite turn rows). Returning `undefined`
   * means "no augmentation"; the projector still proceeds.
   */
  read(input: AiGatewayExchangeInput): Record<string, unknown> | undefined
}

export interface CodexAttachOptions {
  port: number
  version: string
  configPath?: string
  baseUrl?: string
  providerName?: string
}

export type CodexAttachResult = { changed: true; prevValue?: string }

export interface CodexDetachOptions {
  configPath?: string
}

export type CodexDetachResult =
  | { changed: true; removed?: string; restoredValue?: string; warning?: string }
  | { changed: false }
