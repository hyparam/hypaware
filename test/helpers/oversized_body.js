// @ts-check

/**
 * The oversized-body sender the capped-drain suites share.
 *
 * A server that answers before reading a body still has to discard that body
 * for its answer to reach a caller mid-upload, and every suite pinning the
 * bound on that discard needs the same sender: one that announces more than
 * any cap and keeps pushing until the far side stops reading.
 *
 * What it reports is not the measurement. How far the sender got is only a
 * proxy, because a socket buffer can swallow a write the server never read,
 * so the suites assert on the accepted socket's `bytesRead`; this helper's
 * job is to keep the write going long enough for that number to mean
 * something.
 */

import net from 'node:net'

/**
 * Announce a body far larger than any cap and push it at a request the server
 * refuses before reading, until the server stops reading. Resolves when the
 * connection closes (the bounded outcome) or when the whole body went out
 * (the unbounded one, which the caller asserts against).
 *
 * @param {number} port
 * @param {{ requestLine: string, host?: string }} options the request line
 *   without its HTTP version (`'POST /v1/logs'`), and the `Host` to send,
 *   which defaults to the loopback address the connection is made on
 * @returns {Promise<{ sent: number, total: number, received: string }>}
 */
export function streamOversizedBody(port, options) {
  // Larger than any socket buffer either side could swallow whole, so a
  // server that stops reading stalls the write rather than absorbing it.
  const body = Buffer.alloc(8 * 1024 * 1024, 'x')
  let received = ''
  let sent = 0
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`the server read ${sent} bytes and left the connection open`))
    }, 10000)
    function pump() {
      while (sent < body.length && !socket.destroyed) {
        const end = Math.min(sent + 64 * 1024, body.length)
        const chunk = body.subarray(sent, end)
        sent = end
        if (!socket.write(chunk)) {
          socket.once('drain', pump)
          return
        }
      }
      // Everything went out, so nothing bounded the read. Close rather than
      // wait for one a keep-alive answer will never send.
      if (sent >= body.length) setTimeout(() => socket.destroy(), 50)
    }
    socket.on('connect', () => {
      socket.write(
        `${options.requestLine} HTTP/1.1\r\nHost: ${options.host ?? '127.0.0.1'}\r\n` +
          `content-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n`
      )
      pump()
    })
    socket.on('data', (chunk) => { received += chunk.toString('utf8') })
    // The close is the point of the test, so a reset counts as one rather
    // than as a failure.
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timer)
      resolve({ sent, total: body.length, received })
    })
  })
}
