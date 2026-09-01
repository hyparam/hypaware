// @ts-check

/**
 * A stand-in central server for the HypAware sandbox.
 *
 * `hyp join` enrolls against a central server and the daemon then pulls its
 * fleet config from it, so any test of join → leave → rejoin needs one. This
 * speaks the four endpoints the `@hypaware/central` plugin calls:
 *
 * - `POST /v1/identity/bootstrap`  token → `{ jwt, expires_at }`
 * - `POST /v1/identity/refresh`    bearer → a fresh `{ jwt, expires_at }`
 * - `GET  /v1/config`              the fleet config, with an ETag (304 aware)
 * - `POST /v1/ingest/<signal>`     accepts and counts NDJSON rows
 *
 * The gateway never verifies the JWT signature (it does not share the issuer
 * secret, see `identity_client.js#decodeJwtSub`), so an unsigned token with a
 * `sub` claim is enough to be accepted the way a real one would be.
 *
 * The fleet config is read from disk on every request, so you can edit it
 * mid-run (flip `proxy_mode`, change the port) and the daemon picks the new
 * revision up on its next poll - the ETag is the config's own content hash.
 *
 * Usage: `node fake_central.js --port <n> --config <file> --log <file>`
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))
const port = Number(args.port ?? 18700)
const configPath = args.config
const logPath = args.log

if (!configPath) {
  process.stderr.write('fake_central: --config <file> is required\n')
  process.exit(64)
}

const counts = {
  bootstrap: 0,
  refresh: 0,
  config200: 0,
  config304: 0,
  ingest: 0,
  rows: 0,
  login: 0,
  sessionRefresh: 0,
}

/** The org every sign-in resolves to. */
const ORG = 'sandbox-org'

/** Live authorization codes, minted at /login/start and spent at /token. */
const codes = new Map()
let codeSeq = 0

/**
 * Login outcomes parked by client `state` at /login/start and picked up once
 * at /login/poll: the poll lane the client speaks (LLP 0342 D3). The redirect
 * lane below is kept for released clients that still send a `redirect_uri`.
 * @type {Map<string, { code: string }>}
 */
const outcomes = new Map()

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  readBody(req).then((body) => {
    const handled = route(req, res, url, body)
    log(`${req.method} ${url.pathname} -> ${res.statusCode} ${handled}`)
  })
})

server.listen(port, '127.0.0.1', () => {
  log(`fake central listening on http://127.0.0.1:${port} serving ${configPath}`)
  process.stdout.write(`fake central listening on http://127.0.0.1:${port}\n`)
})

process.on('SIGTERM', () => {
  log(`shutting down; counts=${JSON.stringify(counts)}`)
  server.close(() => process.exit(0))
})

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @param {string} body
 * @returns {string}
 */
function route(req, res, url, body) {
  if (req.method === 'POST' && url.pathname === '/v1/identity/bootstrap') {
    /** @type {any} */
    let parsed = {}
    try { parsed = JSON.parse(body || '{}') } catch { /* reported below */ }
    const token = parsed.bootstrap_token
    if (typeof token !== 'string' || token.length === 0) {
      return json(res, 400, { error: 'bootstrap_token is required' }, 'missing token')
    }
    counts.bootstrap += 1
    return json(res, 200, mintIdentity(), `token=${token.slice(0, 8)}...`)
  }

  if (req.method === 'POST' && url.pathname === '/v1/identity/refresh') {
    if (!bearer(req)) return json(res, 401, { error: 'missing bearer' }, 'no bearer')
    counts.refresh += 1
    return json(res, 200, mintIdentity(), 'refreshed')
  }

  if (req.method === 'GET' && url.pathname === '/v1/config') {
    if (!bearer(req)) return json(res, 401, { error: 'missing bearer' }, 'no bearer')
    let document
    try {
      document = fs.readFileSync(configPath, 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return json(res, 500, { error: message }, 'config unreadable')
    }
    const etag = `"${crypto.createHash('sha256').update(document).digest('hex').slice(0, 32)}"`
    if (req.headers['if-none-match'] === etag) {
      counts.config304 += 1
      res.writeHead(304, { etag })
      res.end()
      return `304 ${etag}`
    }
    counts.config200 += 1
    res.writeHead(200, { 'content-type': 'application/json', etag })
    res.end(document)
    return `200 ${etag}`
  }

  if (req.method === 'POST' && url.pathname.startsWith('/v1/ingest/')) {
    if (!bearer(req)) return json(res, 401, { error: 'missing bearer' }, 'no bearer')
    const rows = body.split('\n').filter(Boolean).length
    counts.ingest += 1
    counts.rows += rows
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end('{}')
    return `202 rows=${rows} total=${counts.rows}`
  }

  // The attended `hyp remote login` flow (LLP 0058/0059, poll delivery per
  // LLP 0342). The browser is whatever fetches the start URL. Absence of
  // `redirect_uri` selects the poll lane, which is what current clients send:
  // the outcome is parked by `state` and the client's poller collects it, so a
  // plain `curl <start-url>` completes a sign-in. A `redirect_uri` still gets
  // the 302, for released clients that predate the poll lane.
  if (req.method === 'GET' && url.pathname === '/v1/identity/login/start') {
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    if (!state) {
      return json(res, 400, { error: 'invalid_request' }, 'missing state')
    }
    const code = `code_${codeSeq += 1}`
    codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '' })
    if (!redirectUri) {
      outcomes.set(state, { code })
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<p>Login complete. You can close this tab and return to the terminal.</p>\n')
      return `200 parked ${code}`
    }
    // Built through `URL` rather than string concatenation: a loopback
    // receiver that already carries a query would otherwise get two `?`.
    let location
    try {
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', state)
      location = target.toString()
    } catch {
      return json(res, 400, { error: 'invalid_request' }, `unparseable redirect_uri ${redirectUri}`)
    }
    res.writeHead(302, { location })
    res.end()
    return `302 → ${redirectUri}`
  }

  // Poll delivery: single pickup, then the state is gone. `unknown_state` (not
  // the catch-all 404 below) is what a poll-capable server answers before the
  // browser has landed, and the client keeps polling through it.
  if (req.method === 'GET' && url.pathname === '/v1/identity/login/poll') {
    const state = url.searchParams.get('state') ?? ''
    const outcome = outcomes.get(state)
    if (!outcome) return json(res, 404, { error: 'unknown_state' }, 'no flight yet')
    outcomes.delete(state)
    return json(res, 200, { status: 'complete', code: outcome.code }, `delivered ${outcome.code}`)
  }

  if (req.method === 'POST' && url.pathname === '/v1/identity/token') {
    /** @type {any} */
    let parsed = {}
    try { parsed = JSON.parse(body || '{}') } catch { /* reported below */ }

    if (parsed.grant_type === 'refresh_token') {
      counts.sessionRefresh += 1
      const access = mintIdentity()
      return json(res, 200, {
        access_jwt: access.jwt,
        expires_at: access.expires_at,
        org: ORG,
      }, 'session refreshed')
    }

    if (parsed.grant_type === 'authorization_code') {
      if (!codes.delete(parsed.code)) {
        return json(res, 401, { error: 'invalid_grant', detail: 'unknown or spent code' }, 'bad code')
      }
      counts.login += 1
      const access = mintIdentity()
      const gateway = mintIdentity()
      // The gateway_* triple is what makes a login enroll the machine without a
      // bootstrap token; a partial set is a contract violation the client
      // rejects loudly, so send all three or none.
      return json(res, 200, {
        session_id: `sid_sandbox_${counts.login}`,
        refresh_token: `refresh_sandbox_${counts.login}`,
        access_jwt: access.jwt,
        expires_at: access.expires_at,
        org: ORG,
        gateway_jwt: gateway.jwt,
        gateway_expires_at: gateway.expires_at,
        gateway_id: 'gw_sandbox_0001',
      }, `login ok, org ${ORG}`)
    }

    return json(res, 400, { error: 'unsupported_grant_type' }, `grant ${parsed.grant_type}`)
  }

  if (req.method === 'GET' && url.pathname === '/_sandbox/counts') {
    return json(res, 200, counts, 'counts')
  }

  return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` }, 'UNROUTED')
}

/**
 * An unsigned JWT carrying the `sub` the gateway reads for its identity.
 * @returns {{ jwt: string, expires_at: number }}
 */
function mintIdentity() {
  const expiresAt = Math.floor(Date.now() / 1000) + 86400
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    sub: 'gw_sandbox_0001',
    org: 'sandbox',
    exp: expiresAt,
  }))
  return { jwt: `${header}.${payload}.sandbox`, expires_at: expiresAt }
}

/**
 * @param {string} value
 */
function b64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * @param {http.IncomingMessage} req
 */
function bearer(req) {
  const header = req.headers.authorization
  return typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} payload
 * @param {string} note
 */
function json(res, status, payload, note) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
  return note
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    // Buffer the chunks and decode once. Decoding per chunk turns any
    // multi-byte character that straddles a chunk boundary into replacement
    // characters, and ingest bodies are NDJSON of captured prompts and model
    // output, so that is reachable on any non-ASCII body over a chunk.
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/**
 * @param {string} message
 */
function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`
  if (logPath) fs.appendFileSync(logPath, line)
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1]
      i += 1
    }
  }
  return out
}
