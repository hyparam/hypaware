import http from 'node:http'
import zlib from 'node:zlib'
import { BANNER, BANNER_HEADERS } from './banner.js'
import { decodeExportLogsServiceRequest } from './otlp/logs.js'
import { decodeExportMetricsServiceRequest } from './otlp/metrics.js'
import { decodeExportTraceServiceRequest } from './otlp/traces.js'

/**
 * @import { Server } from 'node:http'
 */

const JSON_CT = { 'Content-Type': 'application/json' }
const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf'
const PROTOBUF_CT = { 'Content-Type': PROTOBUF_CONTENT_TYPE }
const EMPTY_EXPORT_RESPONSE = new Uint8Array(0)

const emptyResponse = {
  traces: { partialSuccess: { rejectedSpans: 0 } },
  metrics: { partialSuccess: { rejectedDataPoints: 0 } },
  logs: { partialSuccess: { rejectedLogRecords: 0 } },
}

/**
 * @param {string} signal
 * @param {Buffer} body
 * @returns {unknown}
 */
function decodeProtobufRequest(signal, body) {
  if (body.length === 0) return {}
  if (signal === 'logs') return decodeExportLogsServiceRequest(body)
  if (signal === 'traces') return decodeExportTraceServiceRequest(body)
  return decodeExportMetricsServiceRequest(body)
}

/**
 * @param {(signal: string, data: unknown) => void | Promise<void>} handler
 * @returns {Server}
 */
function createServer(handler) {
  const server = http.createServer(async function(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, BANNER_HEADERS)
      res.end(BANNER)
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, JSON_CT)
      res.end(JSON.stringify({ code: 12, message: 'Method not allowed' }))
      return
    }

    const validRoutes = ['/v1/traces', '/v1/metrics', '/v1/logs']
    if (!validRoutes.includes(path)) {
      res.writeHead(404, JSON_CT)
      res.end(JSON.stringify({ code: 5, message: 'Not found' }))
      return
    }

    const signal = path.slice('/v1/'.length)
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    const acceptJson = contentType === 'application/json'
    const acceptProtobuf = contentType === PROTOBUF_CONTENT_TYPE
    if (!acceptJson && !acceptProtobuf) {
      res.writeHead(415, JSON_CT)
      res.end(JSON.stringify({
        code: 3,
        message: 'Unsupported Content-Type: expected application/json or application/x-protobuf',
      }))
      return
    }

    const encoding = (req.headers['content-encoding'] || '').toLowerCase()
    /** @type {AsyncIterable<Buffer>} */
    let stream = req
    if (encoding === 'gzip') {
      stream = req.pipe(zlib.createGunzip())
    } else if (encoding === 'deflate') {
      stream = req.pipe(zlib.createInflate())
    } else if (encoding && encoding !== 'identity') {
      res.writeHead(415, JSON_CT)
      res.end(JSON.stringify({ code: 3, message: `Unsupported Content-Encoding: ${encoding}` }))
      return
    }

    /** @type {Buffer[]} */
    const chunks = []
    try {
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
    } catch (err) {
      res.writeHead(400, JSON_CT)
      res.end(JSON.stringify({ code: 3, message: err instanceof Error ? err.message : String(err) }))
      return
    }

    let data
    try {
      const body = Buffer.concat(chunks)
      if (acceptJson) {
        data = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
      } else {
        data = decodeProtobufRequest(signal, body)
      }
    } catch {
      res.writeHead(400, JSON_CT)
      const message = acceptJson ? 'Invalid JSON' : 'Invalid protobuf'
      res.end(JSON.stringify({ code: 3, message }))
      return
    }

    try {
      await handler(signal, data)
    } catch (err) {
      res.writeHead(500, JSON_CT)
      res.end(JSON.stringify({
        code: 13,
        message: err instanceof Error ? err.message : String(err),
      }))
      return
    }

    if (acceptProtobuf) {
      res.writeHead(200, PROTOBUF_CT)
      res.end(EMPTY_EXPORT_RESPONSE)
      return
    }

    res.writeHead(200, JSON_CT)
    const response = signal === 'traces' ? emptyResponse.traces
      : signal === 'metrics' ? emptyResponse.metrics
        : emptyResponse.logs
    res.end(JSON.stringify(response))
  })

  return server
}

export { createServer }
