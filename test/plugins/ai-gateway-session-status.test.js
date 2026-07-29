// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createControlHandler } from '../../hypaware-core/plugins-workspace/ai-gateway/src/control.js'
import {
  resolveSessionIdForCli,
  runSessionIgnore,
  runSessionStatus,
  runSessionUnignore,
  SESSION_EXIT_NOT_IGNORED,
  SESSION_EXIT_UNKNOWN,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

// Regression suite for issue #432: the ephemeral session opt-out fails open
// and cannot be checked.
//
// @ref LLP 0066#readable [tests]: the ignored-session set MUST have a reader,
//   and a read that cannot be completed MUST report `unknown`, never
//   `ignored: false`.
// @ref LLP 0067#status-endpoint [tests]
// @ref LLP 0067#cli [tests]

/* ------------------------------------------------------------------ */
/* 1. The set has a reader, and a gateway restart is DETECTABLE        */
/* ------------------------------------------------------------------ */

test('the ignored-session set is readable: GET reports current membership', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    assert.equal((await postSession(base, 'sess-a')).status, 200)
    const read = await getSession(base, 'sess-a')
    assert.equal(read.status, 200, 'GET on the control route must be served, not 405')
    assert.deepEqual(read.body, { session_id: 'sess-a', ignored: true, total: 1 })
  })
})

test('a gateway restart no longer fails open SILENTLY: the reader reports the resumed recording', async () => {
  // The exact defect in issue #432. LLP 0066 accepts that a gateway restart
  // drops the set (non-goal 2: no persistence), but before this reader existed
  // there was no way for the user, or the privacy skill, to find out. The
  // opt-out silently stopped applying.
  const live = /** @type {Set<string>} */ (new Set())
  await withControlServer(live, async (base) => {
    await postSession(base, 'sess-restart')
    const before = await getSession(base, 'sess-restart')
    assert.equal(before.body.ignored, true)
  })

  // A daemon restart builds a fresh GatewayState, hence a fresh empty set.
  const afterRestart = /** @type {Set<string>} */ (new Set())
  await withControlServer(afterRestart, async (base) => {
    const read = await getSession(base, 'sess-restart')
    assert.equal(read.status, 200)
    assert.equal(read.body.ignored, false, 'recording resumed - and it is now observable')
    assert.equal(read.body.total, 0)
  })
})

test('GET without a session_id is a 400, and an unrelated /_hypaware path is still a 404', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const noId = await rawRequest(base, 'GET', '/_hypaware/ignore/session')
    assert.equal(noId.status, 400)
    const unknown = await rawRequest(base, 'GET', '/_hypaware/nope')
    assert.equal(unknown.status, 404)
  })
})

test('GET round-trips a session id verbatim (R5): no trimming, no normalization', async () => {
  const raw = ' sess pad+plus '
  const set = new Set([raw])
  await withControlServer(set, async (base) => {
    const read = await getSession(base, raw)
    assert.equal(read.status, 200)
    assert.equal(read.body.session_id, raw)
    assert.equal(read.body.ignored, true, 'the reader must look up the RAW token the adapter would resolve')
  })
})

/* ------------------------------------------------------------------ */
/* 2. `hyp session status` fails CLOSED                                */
/* ------------------------------------------------------------------ */

test('hyp session status reports `ignored` against a live gateway', async () => {
  const set = new Set(['sess-live'])
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-live' } })
    const code = await runSessionStatus(['--json'], ctx.ctx)
    assert.equal(code, 0, 'a confirmed opt-out exits 0')
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'ignored')
    assert.equal(out.ignored, true)
    assert.equal(out.session_id, 'sess-live')
  })
})

test('hyp session status reports `not_ignored` distinctly, with a nonzero exit', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-open' } })
    const code = await runSessionStatus(['--json'], ctx.ctx)
    assert.equal(code, SESSION_EXIT_NOT_IGNORED)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'not_ignored')
    assert.equal(out.ignored, false)
  })
})

test('hyp session status FAILS CLOSED when the gateway is unreachable: unknown, never ignored:false', async () => {
  // The specific defect named in issue #432: an unreachable gateway must not
  // be reported as "not ignored". `ignored` is null (cannot confirm), the
  // status word is `unknown`, and the exit code is its own nonzero value so a
  // caller can tell "confirmed recording" from "could not confirm anything".
  const deadPort = await closedPort()
  const ctx = fakeCtx({
    endpoint: `http://127.0.0.1:${deadPort}`,
    env: { CLAUDE_CODE_SESSION_ID: 'sess-unreachable' },
  })
  const code = await runSessionStatus(['--json'], ctx.ctx)
  assert.equal(code, SESSION_EXIT_UNKNOWN, 'an unconfirmable read exits nonzero')
  assert.notEqual(SESSION_EXIT_UNKNOWN, 0)
  assert.notEqual(SESSION_EXIT_UNKNOWN, SESSION_EXIT_NOT_IGNORED)
  const out = JSON.parse(ctx.stdout())
  assert.equal(out.status, 'unknown')
  assert.equal(out.ignored, null, 'MUST NOT be false: the gateway was never reached')
  assert.ok(typeof out.reason === 'string' && out.reason.length > 0)
})

test('hyp session status fails closed when no gateway endpoint can be resolved at all', async () => {
  const ctx = fakeCtx({ endpoint: undefined, env: { CLAUDE_CODE_SESSION_ID: 'sess-nowhere' } })
  const code = await runSessionStatus(['--json'], ctx.ctx)
  assert.equal(code, SESSION_EXIT_UNKNOWN)
  const out = JSON.parse(ctx.stdout())
  assert.equal(out.status, 'unknown')
  assert.equal(out.ignored, null)
})

test('hyp session status names the folder governor rather than omitting it (R7)', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-open' } })
    await runSessionStatus([], ctx.ctx)
    const text = ctx.stdout()
    assert.match(text, /not ignored/)
    assert.match(text, /hyp policy show/, 'the session verb must point at the other, independent governor')
  })
})

/* ------------------------------------------------------------------ */
/* 3. `hyp session ignore` / `unignore` are the single front door      */
/* ------------------------------------------------------------------ */

test('hyp session ignore / unignore round-trip through the control route', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-roundtrip' }
    const on = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionIgnore(['--json'], on.ctx), 0)
    assert.equal(JSON.parse(on.stdout()).ignored, true)
    assert.ok(set.has('sess-roundtrip'))

    const check = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionStatus(['--json'], check.ctx), 0)

    const off = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionUnignore(['--json'], off.ctx), 0)
    assert.equal(JSON.parse(off.stdout()).ignored, false)
    assert.equal(set.has('sess-roundtrip'), false)
  })
})

test('an explicit session id argument beats the environment', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'from-env' } })
    assert.equal(await runSessionIgnore(['explicit-id', '--json'], ctx.ctx), 0)
    assert.ok(set.has('explicit-id'))
    assert.equal(set.has('from-env'), false)
  })
})

/* ------------------------------------------------------------------ */
/* 4. Session-id resolution: Codex rollouts, refusing on ambiguity     */
/* ------------------------------------------------------------------ */

test('resolves a Codex session id from the rollout whose payload.cwd matches the invocation cwd', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/other' },
    { file: 'rollout-2026-01-02-bbb.jsonl', id: 'codex-bbb', cwd: '/repo/here' },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok, true)
  assert.equal(out.ok && out.sessionId, 'codex-bbb')
  assert.equal(out.ok && out.source, 'codex_rollout')
})

test('refuses (never guesses newest) when several Codex rollouts match the cwd', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/here' },
    { file: 'rollout-2026-01-02-bbb.jsonl', id: 'codex-bbb', cwd: '/repo/here' },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok, false)
  assert.match(out.ok ? '' : out.error, /codex-aaa/)
  assert.match(out.ok ? '' : out.error, /codex-bbb/)
})

test('refuses when no Codex rollout matches the cwd', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/elsewhere' },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok, false)
})

test('CLAUDE_CODE_SESSION_ID wins over any Codex rollout scan', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/here' },
  ])
  const out = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CLAUDE_CODE_SESSION_ID: 'claude-1' },
    cwd: '/repo/here',
  })
  assert.equal(out.ok && out.sessionId, 'claude-1')
  assert.equal(out.ok && out.source, 'claude_env')
})

test('an unresolvable session id fails closed, it does not report not-ignored', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CODEX_HOME: tempCodexHome([]) } })
    const code = await runSessionStatus(['--json'], ctx.ctx)
    assert.equal(code, SESSION_EXIT_UNKNOWN)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'unknown')
    assert.equal(out.ignored, null)
  })
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {Set<string>} set
 * @param {(base: string) => Promise<void>} fn
 */
async function withControlServer(set, fn) {
  const handler = createControlHandler({ ignoredSessions: set })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    handler(/** @type {IncomingMessage} */ (req), /** @type {ServerResponse} */ (res), url)
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

/** @param {string} base @param {string} sessionId */
function postSession(base, sessionId) {
  return rawRequest(base, 'POST', '/_hypaware/ignore/session', JSON.stringify({ session_id: sessionId }))
}

/** @param {string} base @param {string} sessionId */
function getSession(base, sessionId) {
  const qs = new URLSearchParams({ session_id: sessionId }).toString()
  return rawRequest(base, 'GET', `/_hypaware/ignore/session?${qs}`)
}

/**
 * @param {string} base
 * @param {string} method
 * @param {string} pathname
 * @param {string} [body]
 * @returns {Promise<{ status: number, body: any }>}
 */
function rawRequest(base, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base)
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'content-type': 'application/json' } },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          let parsed
          try { parsed = JSON.parse(raw) } catch { parsed = raw }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Bind then release a port so nothing is listening on it. */
async function closedPort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise((resolve) => server.close(() => resolve(undefined)))
  return port
}

/**
 * Minimal `CommandRunContext` stand-in. `endpoint` is threaded through the
 * gateway plugin's configured `listen`, which is exactly how the CLI resolves
 * it when no live daemon status file is present.
 *
 * @param {{ endpoint?: string, env?: Record<string, string>, cwd?: string }} args
 */
function fakeCtx(args) {
  let out = ''
  let err = ''
  const listen = args.endpoint ? args.endpoint.replace(/^https?:\/\//, '') : undefined
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-session-home-'))
  const ctx = {
    stdout: { write: (/** @type {string} */ s) => { out += s; return true } },
    stderr: { write: (/** @type {string} */ s) => { err += s; return true } },
    env: { HYP_HOME: hypHome, ...(args.env ?? {}) },
    cwd: args.cwd ?? '/repo/here',
    config: {
      version: 2,
      plugins: listen
        ? [{ name: '@hypaware/ai-gateway', config: { listen } }]
        : [{ name: '@hypaware/ai-gateway' }],
    },
  }
  return { ctx: /** @type {any} */ (ctx), stdout: () => out, stderr: () => err }
}

/**
 * Build a throwaway `CODEX_HOME` holding `sessions/**\/rollout-*.jsonl` files
 * whose first line is a `session_meta` record.
 *
 * @param {{ file: string, id: string, cwd: string }[]} rollouts
 */
function tempCodexHome(rollouts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-codex-home-'))
  const dir = path.join(home, 'sessions', '2026', '01')
  fs.mkdirSync(dir, { recursive: true })
  for (const r of rollouts) {
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: r.id, cwd: r.cwd } })
    fs.writeFileSync(path.join(dir, r.file), `${meta}\n{"type":"event"}\n`)
  }
  return home
}
