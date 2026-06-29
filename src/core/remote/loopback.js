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

/**
 * Start the single-shot loopback receiver. Binds `127.0.0.1:0`, then resolves
 * `{ redirectUri, port, waitForCode, close }` so the caller can build the start
 * URL before opening the browser. `waitForCode()` resolves `{ code }` when
 * `/callback` arrives with a matching `state`; it rejects on `error=`, a
 * `state` mismatch, or timeout. The listener serves a minimal "you can close
 * this tab" page, then closes after one request.
 *
 * @param {{ state: string, timeoutMs?: number }} args
 * @returns {Promise<{ redirectUri: string, port: number, waitForCode: () => Promise<{ code: string }>, close: () => void }>}
 * @ref LLP 0046#d2 [implements]: ephemeral 127.0.0.1 redirect, single-shot, timed out (RFC 8252)
 */
export function startLoopbackReceiver({ state, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const log = getLogger('remote')

  // One-flow result channel: the request handler (or the timeout) settles it
  // exactly once; waitForCode() adopts these resolvers.
  let settled = false
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
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const params = url.searchParams
    const returnedState = params.get('state')
    const error = params.get('error')
    const code = params.get('code')

    // A callback whose state does not match is rejected without reading the
    // code (CSRF guard). Serve a neutral page either way.
    if (returnedState !== state) {
      respond(res, 'Login state mismatch. You can close this tab.')
      fail(new Error('loopback received a callback with a mismatched state'), 'state_mismatch')
      return
    }
    if (error) {
      respond(res, 'Login failed. You can close this tab and return to the terminal.')
      fail(Object.assign(new Error(`login failed: ${error}`), { callbackError: error }), error)
      return
    }
    if (!code) {
      respond(res, 'Login response was missing a code. You can close this tab.')
      fail(new Error('loopback callback had neither code nor error'), 'no_code')
      return
    }
    respond(res, 'Login complete. You can close this tab and return to the terminal.')
    deliver({ code })
  })

  /** @type {ReturnType<typeof setTimeout>} */
  let timer

  return new Promise((resolveStart, rejectStart) => {
    server.on('error', (err) => {
      if (settled) return
      settled = true
      rejectStart(err instanceof Error ? err : new Error(String(err)))
    })

    server.listen(0, '127.0.0.1', () => {
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
          if (!settled) {
            settled = true
            clearTimeout(timer)
          }
          server.close(() => {})
        },
      })
    })
  })
}

/** @param {ServerResponse} res @param {string} message */
function respond(res, message) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>HypAware login</title></head><body style="font-family:system-ui;padding:2rem"><p>${message}</p></body></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}
