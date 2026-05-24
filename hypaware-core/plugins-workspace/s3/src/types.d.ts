export type CredentialSourceKind =
  | 'profile'
  | 'env'
  | 'web_identity'
  | 'sso'
  | 'process'
  | 'metadata'
  | 'injected'

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
