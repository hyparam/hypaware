// @ts-check

/** A materialized graph row (node or edge), keyed by column name. */
export type GraphRow = Record<string, unknown>

/**
 * A partition the dedup compaction refused to rewrite, with the reason:
 * `unreadable-cursor` (cursor.json missing/corrupt — never treat as a
 * synthetic default when about to retire a generation), `unexpected-layout`
 * (not the source-table layout graph tables use), or `concurrent-write`
 * (the cursor changed between scan and swap; retiring the old generation
 * would lose rows appended during the rewrite window).
 */
export interface SkippedPartition {
  path: string
  reason: 'unreadable-cursor' | 'unexpected-layout' | 'concurrent-write'
}

/** One T0 contract rule: a read-only SELECT plus a row mapper. */
export interface ContractRule {
  kind: 'node' | 'edge'
  type: string
  sql: string
  toRow(row: Record<string, unknown>): GraphRow | null
}
