export interface BackfillProviderResult {
  provider: string
  plugin: string
  datasets: string[]
  items_seen: number
  rows_written: number
  rows_skipped: number
  sessions_seen: number
  status: 'ok' | 'failed'
  error?: string
}
