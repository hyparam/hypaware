// @ts-check

import http from 'node:http'
import zlib from 'node:zlib'

/**
 * @import { OtlpReceiveHandler, OtlpRequest, OtlpSignal } from './types.d.ts'
 */

const JSON_CT = { 'Content-Type': 'application/json' }

const SIGNAL_ROUTES = /** @type {const} */ ({
  '/v1/logs': 'logs',
  '/v1/traces': 'traces',
  '/v1/metrics': 'metrics',
})

const EMPTY_PARTIAL_SUCCESS = {
  logs: { partialSuccess: { rejectedLogRecords: 0 } },
  traces: { partialSuccess: { rejectedSpans: 0 } },
  metrics: { partialSuccess: { rejectedDataPoints: 0 } },
}

/**
 * Create the OTLP/HTTP listener. The handler is invoked once per
 * decoded request with `{ signal, data, payloadBytes }`. Errors thrown
 * by the handler bubble up as HTTP 500; the caller (the source's
 * `start`) is responsible for wrapping that path in an `otel.receive`
 * span and translating exception types to `error_kind` attributes.
 *
 * Only OTLP/JSON is accepted in this pass — the OTLP/protobuf decoder
 * chain from the donor (`collectivus/src/protobuf.js`,
 * `collectivus/src/otlp/*`) is left out of V1 and can be added later
 * without changing the request handler shape.
 *
 * @param {OtlpReceiveHandler} handler
 * @returns {http.Server}
 */
export function createOtlpServer(handler) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    const route = url.pathname

    if (req.method === 'GET' && route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('hypaware/otel OTLP listener\n')
      return
    }

    if (req.method !== 'POST') {
      respondJsonError(res, 405, 12, 'Method not allowed')
      return
    }

    const signal = /** @type {OtlpSignal | undefined} */ (
      /** @type {Record<string, OtlpSignal>} */ (SIGNAL_ROUTES)[route]
    )
    if (!signal) {
      respondJsonError(res, 404, 5, 'Not found')
      return
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      respondJsonError(
        res,
        415,
        3,
        `Unsupported Content-Type: expected application/json, got '${contentType || 'none'}'`
      )
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
      respondJsonError(res, 415, 3, `Unsupported Content-Encoding: ${encoding}`)
      return
    }

    /** @type {Buffer[]} */
    const chunks = []
    try {
      for await (const chunk of stream) chunks.push(chunk)
    } catch (err) {
      respondJsonError(res, 400, 3, err instanceof Error ? err.message : String(err))
      return
    }

    const body = Buffer.concat(chunks)
    let data
    try {
      data = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
    } catch {
      respondJsonError(res, 400, 3, 'Invalid JSON')
      return
    }

    try {
      await handler.handle({ signal, data, payloadBytes: body.length })
    } catch (err) {
      respondJsonError(res, 500, 13, err instanceof Error ? err.message : String(err))
      return
    }

    res.writeHead(200, JSON_CT)
    res.end(JSON.stringify(EMPTY_PARTIAL_SUCCESS[signal]))
  })
}

/**
 * @param {http.ServerResponse} res
 * @param {number} httpStatus
 * @param {number} code
 * @param {string} message
 */
function respondJsonError(res, httpStatus, code, message) {
  res.writeHead(httpStatus, JSON_CT)
  res.end(JSON.stringify({ code, message }))
}

/**
 * Listen on `host:port` and resolve with the actually bound `{ host, port }`.
 * Wraps the awkward `server.listen` callback / `address()` shape so the
 * source's `start` reads as a straight-line coroutine.
 *
 * @param {http.Server} server
 * @param {string} host
 * @param {number} port
 * @returns {Promise<{ host: string, port: number }>}
 */
export function listenAndResolve(server, host, port) {
  return new Promise((resolve, reject) => {
    /** @param {Error} err */
    function onError(err) {
      server.off('listening', onListening)
      reject(err)
    }
    function onListening() {
      server.off('error', onError)
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        resolve({ host: addr.address, port: addr.port })
      } else {
        reject(new Error('hypaware/otel: server.address() returned no AddressInfo'))
      }
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
