// @ts-check

// The one capped body drain, shared by the servers that discard a request
// body they are not going to read: the control handler
// (`src/core/control/session_ignore.js`), the OpenCode listener's reject
// branches (`hypaware-core/plugins-workspace/opencode/src/listener.js`), and
// the AI gateway's refusals
// (`hypaware-core/plugins-workspace/ai-gateway/src/proxy.js`).

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
 * its length is the sender's to choose, and the shapes refused here (a
 * DNS-rebound page, a remote peer, a caller naming a host or path nobody
 * registered) are the ones that would choose a large one. 64 KiB also matches
 * the control handler's own `MAX_BODY_BYTES`, so a body that route would have
 * accepted is never cut.
 */
const MAX_REJECTED_DRAIN_BYTES = 64 * 1024

/**
 * Discard a request body under a hard byte bound.
 *
 * Past the cap the request is paused, which is what bounds the read, and the
 * connection is closed once the answer is on the wire. Closing as soon as the
 * cap is hit would race the answer out and truncate it for a caller reading
 * the status it needs. The answer is written before a byte is drained, so a
 * caller reading its socket while it uploads has the refusal in hand long
 * before the cut; one that reads nothing until its upload finishes loses the
 * answer to the reset, which is the price of the bound.
 *
 * Call this BEFORE writing the response head: a body that is not known to fit
 * under the cap is answered `connection: close`, because past the cap the
 * connection is reset and must not be answered as a reusable one. A client
 * that reads a keep-alive header and returns the socket to its pool meets the
 * reset on a request it has already finished, where its own error handler is
 * gone and the throw is nobody's.
 *
 * A body the request declares to fit under the cap is the exception: it is
 * drained to its end, the cap is never crossed, and no reset is coming.
 * Closing it would cost a pooling client its socket for nothing, and on the
 * gateway that is the common refusal shape - a bodyless GET, or a small POST,
 * at a path or host nobody registered, on the connection an attached client
 * forwards everything else over. Under a terminated CONNECT that socket is a
 * decrypted tunnel, so the needless close bills the client a fresh handshake
 * too.
 *
 * What the declaration bounds is the read, not the sender. A caller that
 * declares a small body and then stops sending is answered as reusable on a
 * connection that is not reusable yet: the rest of that body is still what
 * the parser reads next, so the server's request timeout, not this header, is
 * what ends it. Answering every declared body `connection: close` would end
 * it sooner, at the cost of the pooled socket above, and the trade is made
 * for the compliant caller, which finishes its body or drops the socket.
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
export function drainRequestBody(req, res) {
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
  // Asked for rather than left to the implicit resume that attaching a `data`
  // listener performs, because that one is skipped on a stream already paused.
  // The control routes and the OpenCode listener reach this not yet started,
  // except the 413 that settles mid-upload (`session_ignore.js`'s `too_large`),
  // which reaches it already flowing behind `readJsonBody`'s own `data`
  // listener. Both of those are a no-op here. The gateway's upstream-failure
  // refusal is neither: it hands over a request the collapsing pipe already
  // paused, because unpiping the last destination pauses the source. There
  // this line is the only thing that drains the body, so it is not removable.
  req.resume()
  res.on('finish', closeIfAnswered)
  if (!fitsUnderCap(req)) res.setHeader('connection', 'close')
}

/**
 * Is this request's body bounded, by its own framing, at or under the cap?
 * Only then is the drain promised to end before the cap, which is what makes
 * the connection safe to answer as a reusable one.
 *
 * HTTP/1.1 frames a body with `transfer-encoding` or `content-length`. With
 * neither there is no body at all and no `data` event is ever emitted, which
 * fits trivially. A chunked body declares no length, so it is never known to
 * fit, even when it turns out to be empty: its length is unknowable until it
 * ends, and the header has to be set before the answer is written.
 *
 * @param {IncomingMessage} req
 */
function fitsUnderCap(req) {
  if (req.headers['transfer-encoding'] !== undefined) return false
  const length = req.headers['content-length']
  if (length === undefined) return true
  // Compared as a number, not as text, so `00` and `0` frame the same absent
  // body. A length the parser let through that is still not digits reads back
  // `NaN`, which fails this comparison and closes, the safe direction.
  return Number(length) <= MAX_REJECTED_DRAIN_BYTES
}
