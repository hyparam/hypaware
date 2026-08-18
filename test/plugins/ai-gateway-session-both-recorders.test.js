// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createControlHandler } from '../../src/core/control/session_ignore.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { writeStatusFile } from '../../src/core/daemon/status.js'
import {
  runSessionIgnore,
  runSessionStatus,
  runSessionUnignore,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'

/**
 * With the claude telemetry listener recording Claude Code sessions, "don't
 * record this conversation" has to reach BOTH recorders, and only a receipt
 * naming each write can support that claim. These tests pin the discovery
 * (the listener advertises `control_routes` in the live daemon snapshot and
 * is addressed by that advertisement alone), the both-sets outcome, the
 * receipt shape (legacy top-level fields stay the gateway's; every
 * recorder's outcome rides in `recorders`), and the partial-failure rule
 * (an addressed recorder that refuses makes the verb report partial and
 * exit unknown, never read as done).
 *
 * @ref LLP 0256#cli-posts-to-both [tests]: the mutations address every
 * listener that offers the route, report each outcome, and a partial
 * success is reported, not swallowed.
 */

const SESSION = 'sess-both-recorders'

test('ignore lands the id in both recorders and the receipt reports each write', async () => {
  const gatewaySet = /** @type {Set<string>} */ (new Set())
  const listenerSet = /** @type {Set<string>} */ (new Set())
  await withControlServer(gatewaySet, async (gatewayBase) => {
    await withControlServer(listenerSet, async (listenerBase) => {
      const home = daemonHome({ gatewayBase, listenerBase })
      const env = { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION }

      const json = fakeCtx({ env })
      assert.equal(await runSessionIgnore(['--json'], json.ctx), 0)
      assert.ok(gatewaySet.has(SESSION), 'the gateway set holds the id')
      assert.ok(listenerSet.has(SESSION), 'the listener set holds the id too')

      const out = JSON.parse(json.stdout())
      assert.equal(out.status, 'ok')
      assert.equal(out.guarantee, 'set_membership')
      // Legacy top-level fields keep describing the gateway, so existing
      // consumers of the receipt lose nothing.
      assert.equal(out.ignored, true)
      assert.equal(out.endpoint, gatewayBase)
      assert.equal(out.endpoint_source, 'daemon_status')
      assert.equal(out.endpoint_authenticated, false)
      // And the whole write is visible beside them.
      assert.equal(out.recorders.length, 2)
      const [gw, listener] = out.recorders
      assert.deepEqual(gw, {
        recorder: 'gateway',
        endpoint: gatewayBase,
        endpoint_source: 'daemon_status',
        endpoint_authenticated: false,
        status: 'ok',
        ignored: true,
        total: 1,
      })
      assert.deepEqual(listener, {
        recorder: 'claude-telemetry',
        endpoint: listenerBase,
        endpoint_source: 'daemon_status',
        endpoint_authenticated: false,
        status: 'ok',
        ignored: true,
        total: 1,
      })

      // The human receipt names the second write and discloses the trust
      // contract for BOTH endpoints (LLP 0166 is per responder).
      const human = fakeCtx({ env })
      assert.equal(await runSessionIgnore([], human.ctx), 0)
      assert.match(human.stdout(), /session sess-both-recorders: ignored - this id is in the gateway drop set/)
      assert.match(human.stdout(), /also claude-telemetry at .*: ignored - this id is in its drop set/)
      const trustNotes = human.stdout().match(/nothing proves the responder/g) ?? []
      assert.equal(trustNotes.length, 2, 'one trust disclosure per addressed endpoint')
      assert.ok(human.stdout().includes(listenerBase), 'the listener endpoint is named')
    })
  })
})

test('unignore removes the id from both recorders', async () => {
  const gatewaySet = new Set([SESSION])
  const listenerSet = new Set([SESSION])
  await withControlServer(gatewaySet, async (gatewayBase) => {
    await withControlServer(listenerSet, async (listenerBase) => {
      const home = daemonHome({ gatewayBase, listenerBase })
      const ctx = fakeCtx({ env: { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION } })
      assert.equal(await runSessionUnignore(['--json'], ctx.ctx), 0)
      assert.equal(gatewaySet.has(SESSION), false)
      assert.equal(listenerSet.has(SESSION), false)
      const out = JSON.parse(ctx.stdout())
      assert.equal(out.status, 'ok')
      assert.equal(out.recorders.length, 2)
      assert.ok(out.recorders.every((/** @type {any} */ r) => r.status === 'ok' && r.ignored === false))
    })
  })
})

test('status confirms protection only after every advertised recorder reports ignored', async () => {
  const gatewaySet = new Set([SESSION])
  const listenerSet = new Set([SESSION])
  await withControlServer(gatewaySet, async (gatewayBase) => {
    await withControlServer(listenerSet, async (listenerBase) => {
      const home = daemonHome({ gatewayBase, listenerBase })
      const env = { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION }
      const json = fakeCtx({ env })
      assert.equal(await runSessionStatus(['--json'], json.ctx), 0)
      const out = JSON.parse(json.stdout())
      assert.equal(out.status, 'ignored')
      assert.equal(out.ignored, true)
      assert.equal(out.recorders.length, 2)
      assert.deepEqual(out.recorders.map((/** @type {any} */ r) => [r.recorder, r.status]), [
        ['gateway', 'ignored'],
        ['claude-telemetry', 'ignored'],
      ])

      const human = fakeCtx({ env })
      assert.equal(await runSessionStatus([], human.ctx), 0)
      assert.match(human.stdout(), /recorder claude-telemetry at .*: ignored/)
      assert.equal((human.stdout().match(/nothing proves the responder/g) ?? []).length, 2)
    })
  })
})

test('status reports recorded when any advertised recorder does not hold the id', async () => {
  const gatewaySet = new Set([SESSION])
  const listenerSet = /** @type {Set<string>} */ (new Set())
  await withControlServer(gatewaySet, async (gatewayBase) => {
    await withControlServer(listenerSet, async (listenerBase) => {
      const home = daemonHome({ gatewayBase, listenerBase })
      const ctx = fakeCtx({ env: { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION } })
      assert.equal(await runSessionStatus(['--json'], ctx.ctx), 1)
      const out = JSON.parse(ctx.stdout())
      assert.equal(out.status, 'not_ignored')
      assert.equal(out.ignored, false)
      assert.equal(out.recorders[0].status, 'ignored')
      assert.equal(out.recorders[1].status, 'not_ignored')
    })
  })
})

test('status stays unknown when an advertised recorder refuses the read', async () => {
  const gatewaySet = new Set([SESSION])
  await withControlServer(gatewaySet, async (gatewayBase) => {
    await withRefusingServer(async (listenerBase) => {
      const home = daemonHome({ gatewayBase, listenerBase })
      const ctx = fakeCtx({ env: { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION } })
      assert.equal(await runSessionStatus(['--json'], ctx.ctx), 3)
      const out = JSON.parse(ctx.stdout())
      assert.equal(out.status, 'unknown')
      assert.equal(out.ignored, null)
      assert.equal(out.recorders[0].status, 'ignored')
      assert.equal(out.recorders[1].status, 'unknown')
      assert.match(out.reason, /claude-telemetry at .*HTTP 500/)
    })
  })
})

test('an addressed recorder that refuses makes the write partial, reported and exit-unknown', async () => {
  const gatewaySet = /** @type {Set<string>} */ (new Set())
  await withControlServer(gatewaySet, async (gatewayBase) => {
    await withRefusingServer(async (listenerBase) => {
      const home = daemonHome({ gatewayBase, listenerBase })
      const ctx = fakeCtx({ env: { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION } })
      const code = await runSessionIgnore(['--json'], ctx.ctx)

      // The gateway write happened and is reported; the listener's refusal
      // means the session is STILL being recorded there, so the verb must
      // not read as done.
      assert.equal(code, 3, 'partial success exits unknown')
      assert.ok(gatewaySet.has(SESSION), 'the successful write is kept, not rolled back')
      const out = JSON.parse(ctx.stdout())
      assert.equal(out.status, 'partial')
      assert.equal(out.recorders.length, 2)
      assert.equal(out.recorders[0].status, 'ok')
      assert.equal(out.recorders[1].status, 'error')
      assert.match(out.recorders[1].error, /HTTP 500/)
      assert.match(ctx.stderr(), /claude-telemetry at .*: /, 'the failure names the recorder')
    })
  })
})

test('with no advertisement the receipt is the single-recorder one', async () => {
  const gatewaySet = /** @type {Set<string>} */ (new Set())
  await withControlServer(gatewaySet, async (gatewayBase) => {
    const home = daemonHome({ gatewayBase })
    const ctx = fakeCtx({ env: { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION } })
    assert.equal(await runSessionIgnore(['--json'], ctx.ctx), 0)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'ok')
    assert.equal(out.recorders.length, 1)
    assert.equal(out.recorders[0].recorder, 'gateway')
  })
})

test('an advertisement naming the gateway\'s own endpoint is not addressed twice', async () => {
  // Belt for a future recorder riding the gateway's listener: the gateway is
  // already a target through its own resolution, so the same endpoint must
  // not receive the mutation twice.
  const gatewaySet = /** @type {Set<string>} */ (new Set())
  let hits = 0
  await withControlServer(gatewaySet, async (gatewayBase) => {
    const home = daemonHome({ gatewayBase, listenerBase: gatewayBase })
    const ctx = fakeCtx({ env: { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION } })
    assert.equal(await runSessionIgnore(['--json'], ctx.ctx), 0)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.recorders.length, 1)
  }, () => { hits += 1 })
  assert.equal(hits, 1, 'one POST reached the shared endpoint')
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The genuine control route over a shared set, exactly as both recorders
 * host it.
 *
 * @param {Set<string>} set
 * @param {(base: string) => Promise<void>} fn
 * @param {() => void} [onRequest]
 */
async function withControlServer(set, fn, onRequest) {
  const handler = createControlHandler({ ignoredSessions: set })
  const server = http.createServer((req, res) => {
    onRequest?.()
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
 * A recorder that is RUNNING and refuses: bound, answering, and unable to
 * take the write. Distinct from not-running (which is never addressed).
 *
 * @param {(base: string) => Promise<void>} fn
 */
async function withRefusingServer(fn) {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'wedged' }))
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
 * A `HYP_HOME` whose live daemon snapshot names the gateway's bound port
 * and, when `listenerBase` is given, a claude-telemetry source advertising
 * the session-ignore control route at its own bound listener - the exact
 * shape the daemon writes.
 *
 * @param {{ gatewayBase: string, listenerBase?: string }} args
 * @returns {string}
 */
function daemonHome({ gatewayBase, listenerBase }) {
  const gatewayUrl = new URL(gatewayBase)
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-session-both-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  fs.mkdirSync(path.join(stateRoot, 'run'), { recursive: true })
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))
  const sources = [
    {
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      state: 'ready',
      details: { host: gatewayUrl.hostname, port: Number(gatewayUrl.port) },
    },
  ]
  if (listenerBase) {
    const listenerUrl = new URL(listenerBase)
    sources.push({
      name: 'claude-telemetry',
      plugin: '@hypaware/claude',
      state: 'ready',
      details: /** @type {any} */ ({
        listen_host: listenerUrl.hostname,
        listen_port: Number(listenerUrl.port),
        control_routes: ['ignore/session'],
      }),
    })
  }
  writeStatusFile(stateRoot, /** @type {any} */ ({ state: 'running', sources, sinks: [] }))
  return hypHome
}

/**
 * @param {{ env?: Record<string, string> }} args
 */
function fakeCtx(args) {
  let out = ''
  let err = ''
  const hypHome = args.env?.HYP_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-session-home-'))
  const ctx = {
    stdout: { write: (/** @type {string} */ s) => { out += s; return true } },
    stderr: { write: (/** @type {string} */ s) => { err += s; return true } },
    env: { HYP_HOME: hypHome, ...(args.env ?? {}) },
    cwd: '/repo/here',
    config: {
      version: 2,
      plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
    },
  }
  return { ctx: /** @type {any} */ (ctx), stdout: () => out, stderr: () => err }
}
