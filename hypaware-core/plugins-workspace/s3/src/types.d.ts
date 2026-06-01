import type { ColumnSpec } from '../../../../collectivus-plugin-kernel-types.d.ts'

export type CredentialSourceKind =
  | 'profile'
  | 'env'
  | 'web_identity'
  | 'sso'
  | 'process'
  | 'metadata'
  | 'injected'

/**
 * One queryable S3-backed dataset, declared under the `@hypaware/s3`
 * plugin config as `query_sources[]`. `prefix` is the path to the data
 * (a directory of `.parquet` objects for `format: 'parquet'`, or an
 * Iceberg table root for `format: 'iceberg'`) relative to the BlobStore
 * root — the plugin-level `prefix` when reading the plugin's own bucket,
 * matching where the sink writes; the full in-bucket path when `bucket`
 * is overridden. Connection fields default to plugin-level config.
 */
export interface S3QuerySourceConfig {
  /** SQL table / dataset name. Must be unique across query sources. */
  name: string
  format: 'parquet' | 'iceberg'
  /** Dataset path relative to the BlobStore root (no leading/trailing slash). */
  prefix: string
  /** Source bucket. Defaults to the plugin-level `bucket`. */
  bucket?: string
  /** AWS region. Defaults to the plugin-level `region`. */
  region?: string
  /** Named AWS profile. Defaults to the plugin-level `profile`. */
  profile?: string
  /** S3-compatible custom endpoint. Defaults to the plugin-level value. */
  endpoint_url?: string
  /** Path-style addressing. Defaults to the plugin-level value. */
  force_path_style?: boolean
  /** Optional declared schema; resolved from the data at query time when omitted. */
  schema?: ColumnSpec[]
}

export interface S3QuerySourceValidationError {
  /** JSON pointer into the `query_sources` array. */
  pointer: string
  message: string
  errorKind: 's3_query_source_invalid'
}

export type S3QuerySourcesValidationResult =
  | { ok: true; sources: S3QuerySourceConfig[] }
  | { ok: false; errors: S3QuerySourceValidationError[] }

export interface S3PutObjectInput {
  Bucket: string
  Key: string
  Body: Uint8Array | Buffer | string
  StorageClass?: string
  ServerSideEncryption?: string
  ContentType?: string
  ContentLength?: number
}

export interface S3PutObjectOutput {
  ETag?: string
  VersionId?: string
}

export interface S3ClientHandle {
  putObject(input: S3PutObjectInput): Promise<S3PutObjectOutput>
  destroy(): void
}

export interface S3ClientOptions {
  region?: string
  profile?: string
  endpoint_url?: string
  force_path_style?: boolean
  env?: Record<string, string | undefined>
}

export interface S3ClientFactoryResult {
  client: S3ClientHandle
  credential_source_kind: CredentialSourceKind
}

export type S3ClientFactory = (opts: S3ClientOptions) => Promise<S3ClientFactoryResult>

export interface S3SinkConfig {
  /** Destination bucket (required). */
  bucket: string
  /** Key prefix under the bucket. Trailing slashes are stripped; default `""`. */
  prefix: string
  /** AWS region (e.g. `us-east-1`). Optional — falls through to the SDK chain. */
  region?: string
  /** Named AWS shared-config profile. */
  profile?: string
  /** S3 storage class (e.g. `STANDARD`, `STANDARD_IA`). */
  storage_class?: string
  /** Object SSE setting (e.g. `AES256`, `aws:kms`). */
  server_side_encryption?: string
  /** S3-compatible custom endpoint (e.g. MinIO). */
  endpoint_url?: string
  /** Force path-style addressing (required for MinIO with custom endpoint). */
  force_path_style?: boolean
}

export interface S3ConfigValidationError {
  /** JSON pointer into the sink config. */
  pointer: string
  message: string
  errorKind: 's3_config_invalid'
}

export type S3ConfigValidationResult =
  | { ok: true; config: S3SinkConfig }
  | { ok: false; errors: S3ConfigValidationError[] }

export interface S3CommandsHandle {
  putObject(input: {
    Bucket: string
    Key: string
    Body: Uint8Array | Buffer
    ContentType?: string
    ContentLength?: number
    Metadata?: Record<string, string>
    IfNoneMatch?: string
  }): Promise<{ ETag?: string; VersionId?: string }>
  getObject(input: { Bucket: string; Key: string }): Promise<{
    Body: NodeJS.ReadableStream | Uint8Array | string | null | undefined
    ContentLength?: number
    ETag?: string
  }>
  listObjects(input: {
    Bucket: string
    Prefix?: string
    ContinuationToken?: string
  }): Promise<{
    Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>
    NextContinuationToken?: string
  }>
  deleteObject(input: { Bucket: string; Key: string }): Promise<void>
}

export type S3BlobStoreClientFactory = (opts: {
  region?: string
  profile?: string
  endpoint_url?: string
  force_path_style?: boolean
  env?: NodeJS.ProcessEnv
}) => Promise<S3CommandsHandle>

export type S3ErrorKind =
  | 's3_config_invalid'
  | 's3_credentials_missing'
  | 's3_access_denied'
  | 's3_bucket_missing'
  | 's3_region_mismatch'
  | 's3_put_failed'
  | 's3_throttled'
  | 'encoder_failed'
