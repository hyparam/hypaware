// @ts-check

import http from 'node:http'

import { Attr, getLogger } from '../observability/index.js'

/**
 * Ephemeral loopback redirect receiver (RFC 8252 §7.3) for the browser
 * authorization-code flow. The client binds a single-shot HTTP listener on
 * `127.0.0.1` at an OS-assigned port, serves one path (`/callback`), and uses
 * `http://127.0.0.1:<port>/callback` as the OAuth `redirect_uri`. The server
 * already restricts `redirect_uri` to loopback hosts, so this matches; a fixed
 * port was rejected (collisions, and the server would have to allowlist it).
 *
 * @import { Server, ServerResponse } from 'node:http'
 */

const CALLBACK_PATH = '/callback'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// The landing page the human sees after the browser redirect. Self-contained
// (inline styles + inline Hyperparam mark, no external fetches) since the only
// thing the browser can reach here is the ephemeral loopback port. `{{title}}`
// and `{{detail}}` are filled from our own literals in respond().
const LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HypAware login</title>
<style>
  :root { color-scheme: light dark }
  html, body { height: 100% }
  body {
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
    text-align: center;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #ffffff;
    color: #1a1a2e;
  }
  .logo { width: 84px; height: 84px; margin-bottom: 2rem }
  h1 { margin: 0 0 0.75rem; font-size: 2rem; font-weight: 600; letter-spacing: -0.01em }
  p { margin: 0; font-size: 1.05rem; line-height: 1.5; color: #6b6b7b }
  @media (prefers-color-scheme: dark) {
    body { background: #14141b; color: #f0f0f5 }
    p { color: #a0a0b0 }
  }
</style>
</head>
<body>
  <svg class="logo" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hyperparam">
    <path d="m48 3.5 38.37 22.25v44.5l-38.37 22.25-38.37-22.25v-44.5z" fill="#4433aa" stroke="#4433aa" stroke-linejoin="round" stroke-width="7"/>
    <g fill="none" stroke="#ffffff" stroke-linejoin="round" stroke-width="8">
      <path d="m48 48-29.14-17 2.81e-4 34 29.14 17z"/>
      <path d="m77.14 31-29.14 17v34l29.14-17z"/>
      <path d="m48 48-29.14-17 29.14-17 29.14 17z"/>
    </g>
  </svg>
  <h1>{{title}}</h1>
  <p>{{detail}}</p>
</body>
</html>`

/**
 * Start the single-shot loopback receiver. Binds `127.0.0.1:0`, then resolves
 * `{ redirectUri, port, waitForCode, close }` so the caller can build the start
 * URL before opening the browser. `waitForCode()` resolves `{ code }` when
 * `/callback` arrives with a matching `state`; it rejects on `error=`, a
 * `state` mismatch, or timeout. The listener serves a styled "you can close
 * this tab" page, then closes after one request.
 *
 * @param {{ state: string, timeoutMs?: number }} args
 * @returns {Promise<{ redirectUri: string, port: number, waitForCode: () => Promise<{ code: string }>, close: () => void }>}
 * @ref LLP 0058#d2 [implements]: ephemeral 127.0.0.1 redirect, single-shot, timed out (RFC 8252)
 */
export function startLoopbackReceiver({ state, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const log = getLogger('remote')

  // One-flow result channel: the request handler (or the timeout) settles it
  // exactly once; waitForCode() adopts these resolvers.
  let settled = false
  let started = false
  /** @type {(value: { code: string }) => void} */
  let resolveCode = () => {}
  /** @type {(err: Error) => void} */
  let rejectCode = () => {}
  /** @type {{ code: string } | { error: Error } | undefined} */
  let pending

  /** @param {{ code: string }} value */
  function deliver(value) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server.close(() => {})
    pending = value
    resolveCode(value)
  }
  /** @param {Error} err @param {string} kind */
  function fail(err, kind) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server.close(() => {})
    pending = { error: err }
    log.warn('remote.loopback_error', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.loopback',
      [Attr.STATUS]: 'failed',
      [Attr.ERROR_KIND]: kind,
      smoke_step: 'loopback_callback',
    })
    rejectCode(err)
  }

  /** @type {Server} */
  const server = http.createServer((req, res) => {
    // A malformed request target (e.g. `GET //` or `http://[`) makes `new URL`
    // throw; an uncaught throw in the request listener would crash the whole
    // `hyp remote login` process. Treat it as a stray request: 400 and ignore,
    // never settle the flow, so the real callback can still arrive.
    // `connection: close` on these stray-request replies for the same reason
    // respond() sets it: a browser favicon/probe over keep-alive would otherwise
    // hold an idle socket open, and server.close() (on the real callback) waits
    // for it to drain, hanging `hyp remote login` at exit for ~5s.
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' })
      res.end('bad request')
      return
    }
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' })
      res.end('not found')
      return
    }
    const params = url.searchParams
    const returnedState = params.get('state')
    const error = params.get('error')
    const code = params.get('code')

    // CSRF guard, applied to every callback before it can settle the login: only
    // a request carrying our exact `state` can have come from the browser we sent
    // to the IdP. Anything else gets a neutral page and is IGNORED, never settling
    // the flow, so it cannot abort an in-flight login - we keep waiting for the
    // genuine redirect or the timeout. This is deliberate: the ephemeral loopback
    // port is reachable by any local process and by any page the user is browsing
    // (a no-cors GET still reaches us), so failing the login on the first stray or
    // hostile `?error=` / wrong-`?state=` hit would be a trivial login DoS. The
    // identity server echoes `state` on both success and error (LLP 0059), so a
    // real provider error still matches here and surfaces below.
    if (returnedState !== state) {
      respond(res, 'Unexpected login callback', 'You can close this tab.')
      return
    }
    if (params.has('error')) {
      // The redirect's `error` is attacker-influenceable (anyone who learns the
      // state, or guesses it, can hit the port). Bound it to a safe token before
      // it reaches the error message, the log ERROR_KIND, and the terminal, so a
      // crafted value can't inject newlines into logs or terminal output.
      const safeError = sanitizeErrorCode(error ?? '')
      respond(res, 'Login failed', 'You can close this tab and return to the terminal.')
      fail(Object.assign(new Error(`login failed: ${safeError}`), { callbackError: safeError }), safeError)
      return
    }
    if (!code) {
      respond(res, 'Login response was missing a code', 'You can close this tab.')
      fail(new Error('loopback callback had neither code nor error'), 'no_code')
      return
    }
    respond(res, 'Login complete', 'You can close this tab and return to the terminal.')
    deliver({ code })
  })

  /** @type {ReturnType<typeof setTimeout>} */
  let timer

  return new Promise((resolveStart, rejectStart) => {
    server.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err))
      // A post-listen error must settle a pending waitForCode() (and close the
      // server), not just no-op against the already-resolved start promise.
      if (started) {
        fail(e, 'server_error')
        return
      }
      if (settled) return
      settled = true
      rejectStart(e)
    })

    server.listen(0, '127.0.0.1', () => {
      started = true
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      const redirectUri = `http://127.0.0.1:${port}/callback`
      log.info('remote.loopback_bind', {
        [Attr.COMPONENT]: 'remote-oidc',
        [Attr.OPERATION]: 'remote.loopback',
        [Attr.STATUS]: 'ok',
        port,
        smoke_step: 'loopback_bind',
      })

      timer = setTimeout(() => {
        fail(new Error('timed out waiting for the browser login to complete'), 'timeout')
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      resolveStart({
        redirectUri,
        port,
        waitForCode() {
          return new Promise((resolve, reject) => {
            // If the callback already arrived (fast browser), settle now.
            if (pending && 'code' in pending) return resolve(pending)
            if (pending && 'error' in pending) return reject(pending.error)
            resolveCode = resolve
            rejectCode = reject
          })
        },
        close() {
          // Closing before a code arrives must reject an in-flight (or future)
          // waitForCode(), or the caller's promise hangs forever.
          if (!settled) {
            settled = true
            clearTimeout(timer)
            const err = new Error('loopback receiver closed before a code arrived')
            pending = { error: err }
            rejectCode(err)
          }
          server.close(() => {})
        },
      })
    })
  })
}

/**
 * Reduce an OAuth `error` redirect param to a bounded, log-safe token. RFC 6749
 * error codes are `%x20-21 / %x23-5B / %x5D-7E`; we keep that printable range,
 * drop control chars (newlines especially), and cap the length so a hostile
 * callback can't inject lines into logs or the terminal.
 *
 * @param {string} error
 * @returns {string}
 */
function sanitizeErrorCode(error) {
  const cleaned = error.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim().slice(0, 80)
  return cleaned || 'unknown_error'
}

/**
 * Serve the single loopback landing page the human sees after the browser
 * redirect. `title`/`detail` are always our own literals (never callback input),
 * so they go into the markup unescaped; the Hyperparam mark is inlined so the
 * page renders with no network fetch on a host that only reached a loopback port.
 *
 * @param {ServerResponse} res
 * @param {string} title
 * @param {string} detail
 */
function respond(res, title, detail) {
  const body = LANDING_PAGE.replace('{{title}}', title).replace('{{detail}}', detail)
  // Browsers open the callback over a keep-alive connection. `server.close()`
  // waits for in-flight sockets to drain, so without `Connection: close` the
  // idle keep-alive socket would hold the event loop until Node's
  // keepAliveTimeout (~5s) and `hyp remote login` would hang that long at exit.
  // Asking the browser to close after this single response lets close() finish
  // promptly while the user still sees the page.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
  res.end(body)
}
