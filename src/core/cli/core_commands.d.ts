import type { createCommandRegistry } from '../registry/commands.js'
import type { QueryFormat, RefreshMode } from '../query/types.d.ts'
import type { InitFlags, PickerExport, PickerExportOrigin } from './types.d.ts'
import type { HypAwareStatusReport } from '../daemon/types.d.ts'

export declare function registerCoreCommands(
  registry: ReturnType<typeof createCommandRegistry>
): void

export declare function resolveInitExportChoice(
  flags: InitFlags
): { exportChoice: PickerExport; origin: PickerExportOrigin }

export declare const DEFAULT_QUERY_MAX_CELL: number
export declare const DEFAULT_QUERY_MAX_BYTES: number

export declare function parseQuerySqlArgv(
  argv: string[]
):
  | {
      ok: true
      sql: string
      refresh: RefreshMode
      format: QueryFormat
      output: string | undefined
      maxCell: number
      maxBytes: number
    }
  | { ok: false; error: string }

export declare function buildQuerySqlOutput(
  full: { columns: string[]; rows: Record<string, unknown>[] },
  opts: { format: QueryFormat; output: string | undefined; maxCell: number; maxBytes: number }
): { stdout: string; stderr: string; file?: { path: string; content: string } }

/** Render the V1 status report as a stable JSON shape. Exported for tests. */
export declare function renderStatusJson(args: {
  report: HypAwareStatusReport
  clientNames: string[]
  datasets: { name: string; plugin: string }[]
  cacheRoot: string
}): any

/** Render the V1 status report as human-friendly text. Exported for tests. */
export declare function renderStatusText(args: {
  report: HypAwareStatusReport
  clientNames: string[]
  datasets: { name: string; plugin: string }[]
  cacheRoot: string
  stdout: { write(chunk: string): unknown }
}): void
