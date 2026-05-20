import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import { s3Connector } from '../../src/upload/connectors/s3.js'

/** @type {http.Server} */
let server
/** @type {string} */
let endpoint
/** @type {Array<{ method: string, url: string, headers: http.IncomingHttpHeaders, body: Buffer }>} */
let captured

beforeEach(async () => {
  captured = []
  server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      })
      if (req.method === 'HEAD' && req.url?.includes('missing')) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 200
      if (req.method === 'HEAD') res.setHeader('content-length', '42')
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no addr')
  endpoint = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await new Promise((r) => server.close(() => r(undefined)))
})

describe('s3Connector', () => {
  it('signs PUT requests with SigV4 and sends the body to /<bucket>/<key>', async () => {
    const connector = s3Connector({
      bucket: 'mybucket',
      region: 'us-east-1',
      accessKeyId: 'AKIAFAKE',
      secretAccessKey: 'fake-secret',
      endpoint,
    })
    const body = new Uint8Array([1, 2, 3, 4, 5])
    await connector.putObject('a/b/c.parquet', body, 'application/octet-stream')

    expect(captured).toHaveLength(1)
    const req = captured[0]
    expect(req.method).toBe('PUT')
    expect(req.url).toBe('/mybucket/a/b/c.parquet')
    expect(req.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
    expect(req.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(req.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKE\//)
    expect(req.headers.authorization).toContain('SignedHeaders=')
    expect(req.headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/)
    expect(req.headers['content-type']).toBe('application/octet-stream')
    expect(req.headers['content-length']).toBe(String(body.byteLength))
    expect(Array.from(req.body)).toEqual([1, 2, 3, 4, 5])
  })

  it('returns undefined on HEAD 404 and { size } on HEAD 200', async () => {
    const connector = s3Connector({
      bucket: 'mybucket',
      region: 'us-east-1',
      accessKeyId: 'AKIAFAKE',
      secretAccessKey: 'fake-secret',
      endpoint,
    })

    const missing = await connector.headObject('missing/key.parquet')
    expect(missing).toBeUndefined()

    const present = await connector.headObject('present/key.parquet')
    expect(present).toEqual({ size: 42 })
  })

  it('includes x-amz-security-token when sessionToken is provided', async () => {
    const connector = s3Connector({
      bucket: 'mybucket',
      region: 'us-east-1',
      accessKeyId: 'AKIAFAKE',
      secretAccessKey: 'fake-secret',
      sessionToken: 'session-token-value',
      endpoint,
    })
    await connector.putObject('k', new Uint8Array([0]))
    expect(captured[0].headers['x-amz-security-token']).toBe('session-token-value')
    expect(captured[0].headers.authorization).toContain('x-amz-security-token')
  })

  it('signs requests with async credential providers', async () => {
    const provider = vi.fn(() => Promise.resolve({
      accessKeyId: 'AKIAPROVIDER',
      secretAccessKey: 'provider-secret',
      sessionToken: 'provider-token',
    }))
    const connector = s3Connector({
      bucket: 'mybucket',
      region: 'us-east-1',
      credentials: provider,
      endpoint,
    })

    await connector.putObject('k', new Uint8Array([0]))

    expect(provider).toHaveBeenCalledTimes(1)
    expect(captured[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAPROVIDER\//)
    expect(captured[0].headers['x-amz-security-token']).toBe('provider-token')
  })

  it('uses AWS path-style requests for dotted buckets when endpoint is omitted', async () => {
    /** @type {http.RequestOptions | undefined} */
    let options
    const spy = vi.spyOn(https, 'request').mockImplementation(/** @type {typeof https.request} */ ((reqOptions, callback) => {
      options = /** @type {http.RequestOptions} */ (reqOptions)
      const res = Object.assign(new EventEmitter(), {
        statusCode: 404,
        headers: {},
      })
      const req = Object.assign(new EventEmitter(), {
        end() {
          if (typeof callback === 'function') callback(/** @type {http.IncomingMessage} */ (res))
          res.emit('end')
        },
        write: vi.fn(),
      })
      return /** @type {http.ClientRequest} */ (/** @type {unknown} */ (req))
    }))
    try {
      const connector = s3Connector({
        bucket: 'logs.example.com',
        region: 'us-west-2',
        accessKeyId: 'AKIAFAKE',
        secretAccessKey: 'fake-secret',
      })

      await connector.headObject('a/b/c.parquet')

      expect(options?.host).toBe('s3.us-west-2.amazonaws.com')
      expect(options?.path).toBe('/logs.example.com/a/b/c.parquet')
      expect(options?.headers).toEqual(expect.objectContaining({
        Host: 's3.us-west-2.amazonaws.com',
      }))
    } finally {
      spy.mockRestore()
    }
  })
})
