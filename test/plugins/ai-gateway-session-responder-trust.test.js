// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createControlHandler } from '../../hypaware-core/plugins-workspace/ai-gateway/src/control.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { writeStatusFile } from '../../src/core/daemon/status.js'
import {
  runSessionIgnore,
  runSessionStatus,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

// Regression suite for issue #451: `hyp session` cannot prove the control
// responder is the real gateway.
//
// The impostor below is the exact responder the issue names: it does not have
// to guess anything, it just ECHOES the token it was sent. That defeats
// `validateControlResponse` (LLP 0067 §cli-response-check) by construction,
// because every check that function makes is a check the echo satisfies.
//
// The decision on #451 is accept-and-document, so these tests do NOT assert
// that the impostor is rejected - it cannot be, at this layer. They assert the
// contract that replaces the rejection: every confirmed answer states that the
// responder was never authenticated, in human output and in `--json`, on both
// endpoint-discovery paths.
//
// @ref LLP 0164#stated-not-proved [tests]: an unauthenticated responder is
//   disclosed, on every confirmed answer, rather than silently trusted.

/* ------------------------------------------------------------------ */
/* The impostor: a listener that echoes the token back                 */
/* ------------------------------------------------------------------ */

test('an impostor that echoes the token is believed - and every answer discloses that it was never authenticated', async () => {
  await withImpostorServer(async (base) => {
    const home = daemonHome(base)
    const env = { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-spoofed' }

    const json = fakeCtx({ env })
    const code = await runSessionStatus(['--json'], json.ctx)

    // The accepted residual, pinned so it cannot change by accident: the
    // impostor's answer IS believed. Nothing at this layer separates it from
    // the gateway, and pretending otherwise is what the disclosure replaces.
    assert.equal(code, 0, 'the echoing impostor still yields a confident answer')
    const out = JSON.parse(json.stdout())
    assert.equal(out.status, 'ignored')
    assert.equal(out.ignored, true)
    assert.equal(out.endpoint_source, 'daemon_status', 'a live daemon named this port; another process owns it')

    // The contract: a machine reader can see the answer is unauthenticated
    // without parsing prose.
    assert.equal(
      out.endpoint_authenticated,
      false,
      'the JSON must state that the responder was not authenticated'
    )

    // And a human reader is told the same thing next to the answer, on the
    // daemon_status path, which said nothing at all before.
    const human = fakeCtx({ env })
    assert.equal(await runSessionStatus([], human.ctx), 0)
    assert.match(human.stdout(), /session sess-spoofed: ignored/)
    assert.match(
      human.stdout(),
      /nothing proves the responder .* is the HypAware gateway/,
      'the human answer must say the responder is unauthenticated'
    )
    assert.match(
      human.stdout(),
      /only as trustworthy as this machine/,
      'the disclosure must name the trust root: this machine'
    )
    assert.ok(
      human.stdout().includes(base),
      'and it must name the endpoint it trusted - on this path no other line does'
    )
  })
})

test('`hyp session ignore` carries the disclosure too, where a spoofed success reads as done', async () => {
  // The louder half of the harm in #451: `ignore` against an impostor prints
  // "the gateway will drop this session" while nothing recorded the decision.
  await withImpostorServer(async (base) => {
    const home = daemonHome(base)
    const env = { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-spoofed-write' }

    const human = fakeCtx({ env })
    assert.equal(await runSessionIgnore([], human.ctx), 0)
    assert.match(human.stdout(), /ignored - the gateway will drop this session/)
    assert.match(human.stdout(), /nothing proves the responder .* is the HypAware gateway/)

    const json = fakeCtx({ env })
    assert.equal(await runSessionIgnore(['--json'], json.ctx), 0)
    assert.equal(JSON.parse(json.stdout()).endpoint_authenticated, false)
  })
})

test('the disclosure is unconditional: a real gateway answer carries it too', async () => {
  // It has to be. The CLI cannot tell the real gateway from the impostor, so a
  // disclosure printed only "when spoofed" would be a claim it cannot make -
  // and its absence would read as proof of authenticity.
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-real' } })
    // `not_ignored` from the genuine route: still unauthenticated, still said.
    assert.equal(await runSessionStatus([], ctx.ctx), 1)
    assert.match(ctx.stdout(), /not ignored - this session IS being recorded/)
    assert.match(ctx.stdout(), /nothing proves the responder .* is the HypAware gateway/)

    const json = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-real' } })
    await runSessionStatus(['--json'], json.ctx)
    const out = JSON.parse(json.stdout())
    assert.equal(out.endpoint_authenticated, false)
    assert.equal(out.endpoint_source, 'config_listen', 'the pinned-listen path discloses it as well')
  })
})

test('an UNKNOWN answer reports the field too, so a reader never has to infer it from absence', async () => {
  const ctx = fakeCtx({ endpoint: `http://127.0.0.1:${await closedPort()}`, env: { CLAUDE_CODE_SESSION_ID: 'sess-gone' } })
  assert.equal(await runSessionStatus(['--json'], ctx.ctx), 3)
  const out = JSON.parse(ctx.stdout())
  assert.equal(out.status, 'unknown')
  assert.equal(out.endpoint_authenticated, false)
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * A listener that is not the gateway and does not need to be: it reads the
 * session id off the query string or the body and echoes it back with
 * `ignored: true`. Shape-valid, token-matching, and completely fabricated.
 *
 * @param {(base: string) => Promise<void>} fn
 */
async function withImpostorServer(fn) {
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let sessionId = url.searchParams.get('session_id')
      if (sessionId === null) {
        try {
          sessionId = JSON.parse(Buffer.concat(chunks).toString('utf8')).session_id
        } catch {
          sessionId = null
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ session_id: sessionId, ignored: true, total: 1 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

/** The genuine control route, for the unconditional-disclosure test.
 * @param {Set<string>} set
 * @param {(base: string) => Promise<void>} fn
 */
async function withControlServer(set, fn) {
  const handler = createControlHandler({
    ignoredSessions: set,
    log: /** @type {any} */ ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    handler(req, res, url)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

/**
 * A `HYP_HOME` whose live daemon snapshot names the given endpoint's port. This
 * is the strongest evidence the endpoint resolver has - a running daemon that
 * reported the port it bound - and it is still not evidence about who answers
 * on that port now.
 *
 * @param {string} base
 * @returns {string}
 */
function daemonHome(base) {
  const url = new URL(base)
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-session-impostor-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  fs.mkdirSync(path.join(stateRoot, 'run'), { recursive: true })
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'running',
    sources: [
      {
        name: 'ai-gateway',
        plugin: '@hypaware/ai-gateway',
        state: 'ready',
        details: { host: url.hostname, port: Number(url.port) },
      },
    ],
    sinks: [],
  }))
  return hypHome
}

/**
 * @param {{ endpoint?: string, env?: Record<string, string> }} args
 */
function fakeCtx(args) {
  let out = ''
  let err = ''
  const listen = args.endpoint ? args.endpoint.replace(/^https?:\/\//, '') : undefined
  const hypHome = args.env?.HYP_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-session-home-'))
  const ctx = {
    stdout: { write: (/** @type {string} */ s) => { out += s; return true } },
    stderr: { write: (/** @type {string} */ s) => { err += s; return true } },
    env: { HYP_HOME: hypHome, ...(args.env ?? {}) },
    cwd: '/repo/here',
    config: {
      version: 2,
      plugins: listen
        ? [{ name: '@hypaware/ai-gateway', config: { listen } }]
        : [{ name: '@hypaware/ai-gateway' }],
    },
  }
  return { ctx: /** @type {any} */ (ctx), stdout: () => out, stderr: () => err }
}

/** A port that was bound and released, so nothing answers on it. */
async function closedPort() {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise((resolve) => server.close(() => resolve(undefined)))
  return port
}
