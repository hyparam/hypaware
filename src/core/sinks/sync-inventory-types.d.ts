export interface InventoryRequest {
  buckets: string[]
  revision?: string
  bucket?: string
  offset?: number
}

export interface InventoryResponse {
  version: number
  dataset: string
  org?: string
  revision: string
  summaries: Array<{ bucket: string, count: number, fingerprint: string }>
  keys?: string[]
  next: number | null
}
