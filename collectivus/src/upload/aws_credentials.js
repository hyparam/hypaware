import fs from 'node:fs'

/**
 * @import { AwsCredentials, AwsCredentialProvider } from './upload.d.ts'
 */

const ECS_CREDENTIALS_HOST = '169.254.170.2'
const EXPIRATION_SKEW_MS = 5 * 60 * 1000

/**
 * Returns true when the environment advertises a supported AWS credential
 * source. Static env keys keep local/dev behavior; ECS task roles expose a
 * container credentials URI.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function hasAwsCredentialSource(env = process.env) {
  return hasStaticCredentials(env) || hasContainerCredentials(env)
}

/**
 * Build a provider for either static environment credentials or ECS task-role
 * container credentials.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fetch?: typeof fetch }} [opts]
 * @returns {AwsCredentialProvider}
 */
export function awsCredentialProviderFromEnv(env = process.env, opts = {}) {
  if (hasStaticCredentials(env)) {
    const accessKeyId = env.AWS_ACCESS_KEY_ID
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must both be set')
    }
    return () => ({
      accessKeyId,
      secretAccessKey,
      sessionToken: env.AWS_SESSION_TOKEN,
    })
  }

  const endpoint = containerCredentialsEndpoint(env)
  if (endpoint) {
    return containerCredentialProvider(endpoint, {
      fetchFn: opts.fetch ?? globalThis.fetch,
      authToken: containerAuthorizationToken(env),
    })
  }

  throw new Error(
    'AWS credentials are required for S3 upload: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or run with an ECS task role'
  )
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function hasStaticCredentials(env) {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function hasContainerCredentials(env) {
  return Boolean(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI)
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function containerCredentialsEndpoint(env) {
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
    const rel = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
    if (!rel.startsWith('/')) {
      throw new Error('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must start with "/"')
    }
    return `http://${ECS_CREDENTIALS_HOST}${rel}`
  }
  if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
    const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    if (!/^https?:\/\//i.test(full)) {
      throw new Error('AWS_CONTAINER_CREDENTIALS_FULL_URI must be an http(s) URL')
    }
    return full
  }
  return undefined
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function containerAuthorizationToken(env) {
  if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN) return env.AWS_CONTAINER_AUTHORIZATION_TOKEN
  if (!env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) return undefined
  try {
    return fs.readFileSync(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8').trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to read AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: ${msg}`)
  }
}

/**
 * @param {string} endpoint
 * @param {{ fetchFn?: typeof fetch, authToken?: string }} opts
 * @returns {AwsCredentialProvider}
 */
function containerCredentialProvider(endpoint, opts) {
  if (typeof opts.fetchFn !== 'function') {
    throw new Error('fetch is not available; cannot load ECS task credentials')
  }

  /** @type {AwsCredentials | undefined} */
  let cached
  let expiresAtMs = 0

  return async () => {
    const now = Date.now()
    if (cached && expiresAtMs > 0 && now < expiresAtMs - EXPIRATION_SKEW_MS) {
      return cached
    }

    const headers = opts.authToken ? { Authorization: opts.authToken } : undefined
    const response = await opts.fetchFn(endpoint, headers ? { headers } : undefined)
    if (!response.ok) {
      throw new Error(`failed to fetch ECS task credentials: HTTP ${response.status} ${response.statusText}`)
    }

    const raw = await response.json()
    const next = normalizeContainerCredentials(raw)
    cached = next.credentials
    expiresAtMs = next.expiresAtMs
    return next.credentials
  }
}

/**
 * @param {unknown} raw
 * @returns {{ credentials: AwsCredentials, expiresAtMs: number }}
 */
function normalizeContainerCredentials(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('ECS task credentials response must be a JSON object')
  }
  const obj = /** @type {Record<string, unknown>} */ (raw)
  if (typeof obj.AccessKeyId !== 'string' || obj.AccessKeyId.length === 0) {
    throw new Error('ECS task credentials response missing AccessKeyId')
  }
  if (typeof obj.SecretAccessKey !== 'string' || obj.SecretAccessKey.length === 0) {
    throw new Error('ECS task credentials response missing SecretAccessKey')
  }

  let expiresAtMs = 0
  if (typeof obj.Expiration === 'string' && obj.Expiration.length > 0) {
    const parsed = Date.parse(obj.Expiration)
    if (Number.isNaN(parsed)) throw new Error('ECS task credentials response has invalid Expiration')
    expiresAtMs = parsed
  }

  return {
    credentials: {
      accessKeyId: obj.AccessKeyId,
      secretAccessKey: obj.SecretAccessKey,
      sessionToken: typeof obj.Token === 'string' ? obj.Token : undefined,
    },
    expiresAtMs,
  }
}
