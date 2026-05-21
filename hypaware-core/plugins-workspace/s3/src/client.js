// @ts-check

/**
 * AWS SDK v3 client wiring for `@hypaware/s3`. Two design choices:
 *
 *  1. Credential chain order matches the AWS SDK's default: explicit
 *     `profile` first, then env vars, then web-identity/SSO, then the
 *     EC2/ECS metadata services. Each branch is diagnosable through a
 *     stable `credential_source_kind` token that never carries the
 *     resolved credential material itself.
 *
 *  2. The client is injectable. Production builds a real
 *     `@aws-sdk/client-s3` `S3Client`; tests and the hermetic smoke
 *     inject a fake (a thin object that records `PutObjectCommand`
 *     inputs and returns a synthetic response). The injection seam is
 *     `clientFactory(opts) => { client, credential_source_kind }`.
 *
 * The factory is intentionally async + lazy: importing the AWS SDK is
 * expensive (>30 MB tree) and we don't want to pay that cost in unit
 * tests that never reach `create()`.
 */

/**
 * @typedef {'profile' | 'env' | 'web_identity' | 'sso' | 'process' | 'metadata' | 'injected'} CredentialSourceKind
 */

/**
 * @typedef {Object} S3ClientHandle
 * @property {(input: PutObjectInput) => Promise<PutObjectOutput>} putObject
 * @property {() => void} destroy
 */

/**
 * @typedef {Object} PutObjectInput
 * @property {string} Bucket
 * @property {string} Key
 * @property {Uint8Array | Buffer | string} Body
 * @property {string} [StorageClass]
 * @property {string} [ServerSideEncryption]
 * @property {string} [ContentType]
 * @property {number} [ContentLength]
 */

/**
 * @typedef {Object} PutObjectOutput
 * @property {string} [ETag]
 * @property {string} [VersionId]
 */

/**
 * @typedef {Object} S3ClientOptions
 * @property {string} [region]
 * @property {string} [profile]
 * @property {string} [endpoint_url]
 * @property {boolean} [force_path_style]
 * @property {Record<string, string | undefined>} [env]
 */

/**
 * @typedef {Object} S3ClientFactoryResult
 * @property {S3ClientHandle} client
 * @property {CredentialSourceKind} credential_source_kind
 */

/**
 * @typedef {(opts: S3ClientOptions) => Promise<S3ClientFactoryResult>} S3ClientFactory
 */

/**
 * Resolve which credential branch the SDK will use without actually
 * resolving the credentials themselves. We never log the resolved
 * access key id, session token, or any signed value — only the
 * `kind` token, which is safe to expose.
 *
 * Precedence matches the AWS SDK v3 default chain. We don't sniff the
 * web-identity / sso / process / metadata branches deeply (they require
 * a network request) — `unknown` falls back to `metadata` because that
 * is the last link in the chain.
 *
 * @param {S3ClientOptions} opts
 * @returns {CredentialSourceKind}
 */
export function detectCredentialSourceKind(opts) {
  const env = opts.env ?? {}
  if (opts.profile) return 'profile'
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return 'env'
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE) return 'web_identity'
  if (env.AWS_SSO_START_URL || env.AWS_PROFILE_SSO) return 'sso'
  if (env.AWS_CREDENTIAL_PROCESS) return 'process'
  return 'metadata'
}

/**
 * Build a real `@aws-sdk/client-s3` client. Imported lazily so the SDK
 * dependency only loads when a sink actually instantiates. The shape
 * of the returned `S3ClientHandle` is intentionally narrow: the rest
 * of the plugin never touches the raw SDK surface.
 *
 * @type {S3ClientFactory}
 */
export async function defaultClientFactory(opts) {
  const credential_source_kind = detectCredentialSourceKind(opts)
  /** @type {import('@aws-sdk/client-s3').S3ClientConfig} */
  const clientConfig = {}
  if (opts.region) clientConfig.region = opts.region
  if (opts.endpoint_url) clientConfig.endpoint = opts.endpoint_url
  if (opts.force_path_style) clientConfig.forcePathStyle = true
  if (opts.profile) {
    const { fromIni } = await import('@aws-sdk/credential-provider-ini')
    clientConfig.credentials = fromIni({ profile: opts.profile })
  }

  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
  const client = new S3Client(clientConfig)

  /** @type {S3ClientHandle} */
  const handle = {
    async putObject(input) {
      const result = await client.send(new PutObjectCommand(input))
      return {
        ETag: result.ETag,
        VersionId: result.VersionId,
      }
    },
    destroy() {
      client.destroy()
    },
  }

  return { client: handle, credential_source_kind }
}
