import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

/**
 * @import { IncomingHttpHeaders, RequestOptions } from 'node:http'
 * @import { AwsCredentials, StorageConnector, S3ConnectorOptions, S3RequestOptions } from '../upload.js'
 */

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex')

/**
 * Build an S3 connector that PUTs and HEADs objects with SigV4 signing.
 * Uses path-style URLs for both AWS S3 and endpoint overrides so valid
 * dotted bucket names do not fail TLS wildcard validation.
 *
 * @param {S3ConnectorOptions} options
 * @returns {StorageConnector}
 */
export function s3Connector(options) {
  return {
    scheme: 's3',
    async putObject(key, body, contentType) {
      await s3Request({
        ...options,
        method: 'PUT',
        key,
        body,
        contentType: contentType ?? 'application/octet-stream',
      })
    },
    async headObject(key) {
      const res = await s3Request({
        ...options,
        method: 'HEAD',
        key,
      })
      if (res.statusCode === 404) return undefined
      if (res.statusCode === 200) {
        const contentLength = res.headers['content-length']
        return { size: contentLength ? Number(contentLength) : 0 }
      }
      throw s3Error(`s3 HEAD ${options.bucket}/${key} returned ${res.statusCode}`, res.statusCode)
    },
  }
}

/**
 * Issue one signed S3 request and resolve with the response (status,
 * headers, and any body bytes for GET). Throws on non-2xx for PUT/GET;
 * HEAD passes 404 through to the caller via the resolved result.
 *
 * @param {S3RequestOptions} options
 * @returns {Promise<{ statusCode: number, headers: IncomingHttpHeaders, body: Buffer }>}
 */
async function s3Request(options) {
  const { bucket, region, endpoint, method, key, body, contentType } = options
  const { accessKeyId, secretAccessKey, sessionToken } = await resolveCredentials(options)

  const useEndpoint = endpoint && endpoint.length > 0
  const base = useEndpoint
    ? new URL(endpoint)
    : new URL(`https://s3.${region}.amazonaws.com`)
  const { host, protocol } = base
  const requestPath = joinPath(base.pathname, encodeKey(`/${bucket}/${key}`))

  const now = new Date()
  const amzDate = isoBasic(now)
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = body && body.byteLength > 0
    ? crypto.createHash('sha256').update(body).digest('hex')
    : EMPTY_SHA256

  /** @type {Record<string, string>} */
  const headers = {
    Host: host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (sessionToken) headers['x-amz-security-token'] = sessionToken
  if (method === 'PUT' && body) {
    headers['Content-Length'] = String(body.byteLength)
    headers['Content-Type'] = contentType ?? 'application/octet-stream'
  }

  const signedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort()
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${headers[headerKey(headers, h)].trim()}\n`)
    .join('')
  const signedHeaders = signedHeaderNames.join(';')

  const canonicalRequest = [
    method,
    requestPath,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, region)
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  headers.Authorization = `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const transport = protocol === 'https:' ? https : http
  /** @type {RequestOptions} */
  const reqOptions = {
    method,
    host: base.hostname,
    port: base.port || (protocol === 'https:' ? 443 : 80),
    path: requestPath,
    headers,
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(reqOptions, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const statusCode = res.statusCode ?? 0
        if (method !== 'HEAD' && (statusCode < 200 || statusCode >= 300)) {
          reject(s3Error(`s3 ${method} ${bucket}/${key} returned ${statusCode}: ${buf.toString('utf8')}`, statusCode))
          return
        }
        resolve({ statusCode, headers: res.headers, body: buf })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (method === 'PUT' && body) {
      req.write(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
    }
    req.end()
  })
}

/**
 * @param {S3ConnectorOptions} options
 * @returns {Promise<AwsCredentials>}
 */
function resolveCredentials(options) {
  if (options.credentials) return Promise.resolve(options.credentials())
  if (options.accessKeyId && options.secretAccessKey) {
    return Promise.resolve({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
    })
  }
  throw new Error('S3 connector requires AWS credentials')
}

/**
 * Build an Error tagged with the HTTP statusCode so the upload retry
 * helper can distinguish transient (5xx, 429) from permanent (4xx).
 *
 * @param {string} message
 * @param {number | undefined} statusCode
 * @returns {Error}
 */
function s3Error(message, statusCode) {
  const err = new Error(message)
  if (typeof statusCode === 'number') {
    /** @type {Error & { statusCode?: number }} */ (err).statusCode = statusCode
  }
  return err
}

/**
 * @param {string} secret
 * @param {string} dateStamp
 * @param {string} region
 * @returns {Buffer}
 */
function deriveSigningKey(secret, dateStamp, region) {
  const kDate = crypto.createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest()
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest()
  const kService = crypto.createHmac('sha256', kRegion).update(SERVICE).digest()
  return crypto.createHmac('sha256', kService).update('aws4_request').digest()
}

/**
 * Encode an S3 object key path while preserving '/' separators, per
 * SigV4 canonical URI rules.
 *
 * @param {string} path
 * @returns {string}
 */
function encodeKey(path) {
  return path.split('/').map((seg) => seg ? encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) : '').join('/')
}

/**
 * @param {Record<string, string>} headers
 * @param {string} lower
 * @returns {string}
 */
function headerKey(headers, lower) {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return k
  }
  return lower
}

/**
 * Concatenate two URL path segments. Always starts with one slash; never
 * doubles internal slashes.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function joinPath(a, b) {
  const trimmed = a.endsWith('/') ? a.slice(0, -1) : a
  const next = b.startsWith('/') ? b : `/${b}`
  return trimmed + next || '/'
}

/**
 * Format a Date as the SigV4 amzDate string (YYYYMMDDTHHMMSSZ).
 *
 * @param {Date} d
 * @returns {string}
 */
function isoBasic(d) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '')
}
