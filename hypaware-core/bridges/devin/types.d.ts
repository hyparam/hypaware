export interface CaptureOptions {
  orgId: string
  sessionId: string
  token: string
  endpoint: string
  statePath: string
  watch?: boolean
}

/** Dependency seams for hermetic tests, not CLI or persisted configuration. */
export interface CaptureRuntime {
  fetch?: typeof fetch
  apiBase?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  limits?: Partial<{
    responseBytes: number
    totalBytes: number
    pages: number
    records: number
    durationMs: number
    timeoutMs: number
  }>
}

export interface CaptureState {
  version: 1
  orgId: string
  sessionId: string
  endpoint: string
  after: string | null
  seen: string[]
  detailHash: string | null
}
