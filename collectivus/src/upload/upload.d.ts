export type Signal = 'logs' | 'traces' | 'metrics'
export type UploadSignal = Signal | 'proxy'

export interface StorageConnector {
  /** Scheme this connector handles, e.g. "s3". */
  readonly scheme: string
  /** PUT a single object. Idempotent: overwriting is fine. */
  putObject(key: string, body: Uint8Array, contentType?: string): Promise<void>
  /** HEAD an object to check existence. Returns undefined if absent. */
  headObject(key: string): Promise<{ size: number } | undefined>
  close?(): Promise<void>
}

export interface UploadOptions {
  bucket: string
  prefix?: string
  time?: string
  signals?: ReadonlyArray<UploadSignal>
  catchupDays?: number
  region?: string
  endpoint?: string
  /**
   * Directory partition levels under `outputDir`, in order. Defaults to
   * `['gateway_id', 'signal']`, which walks the unified layout that
   * standalone and server modes share:
   * `<outputDir>/<gateway_id>/<signal>/<date>.jsonl`. Each row read from
   * a partitioned file gains a `_partition` field whose keys mirror the
   * configured dimensions.
   */
  partitionDimensions?: ReadonlyArray<string>
}

export interface ResolvedUploadOptions {
  bucket: string
  prefix: string
  time: string
  signals: ReadonlyArray<UploadSignal>
  catchupDays: number
  region: string
  endpoint?: string
  /**
   * Optional on the resolved type so existing tests that build options
   * inline (skipping `createUploader.resolve()`) keep typechecking.
   * `discoverJobs` treats an absent value as the unified default
   * `['gateway_id', 'signal']` layout, the same default `resolve()`
   * applies for the public surface.
   */
  partitionDimensions?: ReadonlyArray<string>
}

export interface LedgerEntry {
  service: string
  signal: UploadSignal
  date: string
  status: 'committed'
  key: string
  size: number
  rows: number
  committedAt: string
}

export interface UploadJob {
  /**
   * First partition value for this job: the `gateway_id` under the
   * unified standalone+server layout. Kept under the `service` field
   * name so the ledger key, object key, and log lines built from
   * `(service, signal, date)` triples continue to identify a job
   * uniquely without a structural change.
   */
  service: string
  signal: UploadSignal
  date: string
  jsonlPath: string
  /**
   * Full partition map, keyed by dimension name. Always includes the
   * dimensions configured on `ResolvedUploadOptions.partitionDimensions`
   * (e.g. `{ service, signal }` for standalone or
   * `{ gateway_id, signal }` for server). Tagged onto every row read
   * from this job's JSONL file as `_partition`.
   */
  partition: Readonly<Record<string, string>>
}

/** A single partitioned JSONL file discovered during a directory walk. */
export interface PartitionFile {
  /** Absolute path to the file. */
  filePath: string
  /** Dimension to value for each level walked under `outputDir`. */
  partition: Readonly<Record<string, string>>
  /**
   * Convenience copy of `partition.signal`. Always set because
   * `walkPartitionFiles` requires `signal` in `partitionDimensions`.
   */
  signal: UploadSignal
  /** YYYY-MM-DD UTC parsed from the filename. */
  date: string
}

export interface UploadResult {
  job: UploadJob
  uploaded: boolean
  key: string
  rows: number
  size: number
  error?: Error
  retryable?: boolean
}

export interface UploadDeps {
  /** Max attempts per connector call (HEAD/PUT). Default 3. */
  maxAttempts?: number
  /** Backoff before the second attempt; later attempts back off 4x. Default 1000ms. */
  initialBackoffMs?: number
  /** Sleep override. Tests pass `() => Promise.resolve()` to skip the wait. */
  sleep?: (ms: number) => Promise<void>
}

import type { BasicType } from 'hyparquet-writer'

export interface ColumnSpec {
  name: string
  type: BasicType
  nullable: boolean
}

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export type AwsCredentialProvider = () => AwsCredentials | Promise<AwsCredentials>

export interface S3ConnectorOptions {
  bucket: string
  region: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  credentials?: AwsCredentialProvider
  /** Override base URL for S3-compatible servers (MinIO, etc.) */
  endpoint?: string
}

export interface S3RequestOptions extends S3ConnectorOptions {
  method: 'PUT' | 'HEAD' | 'GET'
  key: string
  body?: Uint8Array
  contentType?: string
}
