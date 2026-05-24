// @ts-check

/** @import { S3ErrorKind } from './types.d.ts' */

/**
 * AWS SDK error → stable `error_kind` mapping for `@hypaware/s3`.
 *
 * Stable tokens are what the rest of HypAware reads. AWS SDK error
 * objects carry a few different shapes depending on which layer
 * raised them:
 *
 *  - `error.name` is the service exception class (e.g.
 *    `'NoSuchBucket'`, `'AccessDenied'`, `'PermanentRedirect'`).
 *  - `error.Code` mirrors `error.name` for some service errors.
 *  - `error.$metadata?.httpStatusCode` is the HTTP status.
 *  - `error.name === 'CredentialsProviderError'` for missing creds.
 *
 * We map deterministically against these so the test suite can rely
 * on exact tokens without depending on AWS SDK internals.
 */

/**
 * Normalize an AWS SDK error (or any thrown value from `client.putObject`)
 * to a stable `S3ErrorKind`. Unknown errors fall through to
 * `s3_put_failed` so the kernel still gets a typed token instead of
 * leaking raw error names into logs.
 *
 * @param {unknown} err
 * @returns {S3ErrorKind}
 */
export function classifyAwsError(err) {
  if (err === null || err === undefined || typeof err !== 'object') {
    return 's3_put_failed'
  }
  const e = /** @type {Record<string, unknown> & { name?: string, Code?: string, $metadata?: { httpStatusCode?: number } }} */ (err)
  const name = typeof e.name === 'string' ? e.name : ''
  const code = typeof e.Code === 'string' ? e.Code : ''
  const status = typeof e.$metadata?.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : 0

  if (name === 'CredentialsProviderError' || /credentials/i.test(name)) {
    return 's3_credentials_missing'
  }
  if (name === 'AccessDenied' || code === 'AccessDenied' || status === 403) {
    return 's3_access_denied'
  }
  if (name === 'NoSuchBucket' || code === 'NoSuchBucket') {
    return 's3_bucket_missing'
  }
  if (
    name === 'PermanentRedirect' ||
    code === 'PermanentRedirect' ||
    name === 'AuthorizationHeaderMalformed' ||
    code === 'AuthorizationHeaderMalformed'
  ) {
    return 's3_region_mismatch'
  }
  if (
    name === 'SlowDown' ||
    code === 'SlowDown' ||
    name === 'ThrottlingException' ||
    code === 'RequestLimitExceeded' ||
    status === 429 ||
    status === 503
  ) {
    return 's3_throttled'
  }
  return 's3_put_failed'
}

/**
 * Render a safe, non-credential-bearing diagnostic message for an
 * error_kind. The original `err.message` can carry signed URLs,
 * access key ids, or session tokens in some AWS SDK error paths, so
 * we never log it directly — only the classified kind plus a short
 * human description.
 *
 * @param {S3ErrorKind} errorKind
 * @returns {string}
 */
export function describeS3ErrorKind(errorKind) {
  switch (errorKind) {
    case 's3_config_invalid':
      return 'S3 sink configuration is invalid'
    case 's3_credentials_missing':
      return 'S3 credentials are missing or could not be resolved'
    case 's3_access_denied':
      return 'S3 access denied (check IAM policy or bucket policy)'
    case 's3_bucket_missing':
      return 'S3 bucket does not exist'
    case 's3_region_mismatch':
      return 'S3 region does not match the bucket (PermanentRedirect)'
    case 's3_put_failed':
      return 'S3 PutObject failed'
    case 's3_throttled':
      return 'S3 throttled (SlowDown / 503)'
    case 'encoder_failed':
      return 'Encoder failed to produce blob bytes'
    default:
      return 'unknown S3 error'
  }
}
