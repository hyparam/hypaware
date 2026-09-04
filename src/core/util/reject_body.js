// @ts-check

// The one capped body drain, shared by the servers that discard a request
// body they are not going to read: the control handler
// (`src/core/control/session_ignore.js`) and the OpenCode listener's reject
// branches (`hypaware-core/plugins-workspace/opencode/src/listener.js`).

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

/**
 * How much of a discarded request body is counted before the read is paused.
 * The socket read already in the parser when the pause lands is delivered
 * too, so the bytes actually read settle at about twice this, not exactly
 * at it.
 *
 * A body the server refuses still has to be read for the answer to reach a
 * caller that is mid-upload, so the read cannot be skipped; left unbounded,
 * its length is the sender's to choose. 64 KiB also matches the control
 * handler's own `MAX_BODY_BYTES`, so a body that route would have accepted
 * is never cut.
 */
const MAX_REJECTED_DRAIN_BYTES = 64 * 1024

/**
 * Discard a request body under a hard byte bound.
 *
 * Past the cap the request is paused, which is what bounds the read, and the
 * connection is closed once the answer is on the wire. Closing as soon as the
 * cap is hit would race the answer out and truncate it for a caller reading
 * the status it needs.
 *
 * Call this BEFORE writing the response head: a request that declares a body
 * is answered `connection: close`, because past the cap the connection is
 * reset and must not be answered as a reusable one. A client that reads a
 * keep-alive header and returns the socket to its pool meets the reset on a
 * request it has already finished, where its own error handler is gone and
 * the throw is nobody's. A request with no body drains nothing and keeps its
 * connection reusable.
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
export function drainRequestBody(req, res) {
  if (!declaresBody(req)) {
    req.resume()
    return
  }
  let drained = 0
  let overCap = false
  function closeIfAnswered() {
    if (overCap && res.writableFinished) req.destroy()
  }
  req.on('data', (chunk) => {
    drained += chunk.length
    if (drained <= MAX_REJECTED_DRAIN_BYTES) return
    overCap = true
    req.pause()
    closeIfAnswered()
  })
  res.on('finish', closeIfAnswered)
  res.setHeader('connection', 'close')
}

/**
 * Does this request carry a body the parser will deliver? HTTP/1.1 frames a
 * body with `transfer-encoding` or a non-zero `content-length`; without
 * either, no `data` event is ever emitted.
 *
 * @param {IncomingMessage} req
 */
function declaresBody(req) {
  if (req.headers['transfer-encoding']) return true
  const length = req.headers['content-length']
  if (typeof length !== 'string') return false
  const value = length.trim()
  return value !== '' && value !== '0'
}
