// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { renderStatusJson } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { createControlHandler } from '../../src/core/control/session_ignore.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { runDaemonStatus } from '../../src/core/commands/daemon.js'
import { collectHypAwareStatus, statusFilePath, writeStatusFile } from '../../src/core/daemon/status.js'
import { DEFAULT_TELEMETRY_PORT } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
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

      // The headline speaks for the recorder that is still recording, which
      // here is NOT the first entry of the inventory. Every other recorder
      // gets its own line, so the gateway's `ignored` - the fact a user
      // reading "this session IS being recorded" most needs beside it - is
      // printed, and the recorder the headline already covered is not
      // repeated. A blind `slice(1)` did the exact opposite of both.
      const human = fakeCtx({ env: { HYP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION } })
      assert.equal(await runSessionStatus([], human.ctx), 1)
      const text = human.stdout()
      assert.match(text, /recorder gateway at .*: ignored \(1 ignored\)/)
      assert.equal((text.match(/^recorder /gm) ?? []).length, 1, 'only the non-headline recorder gets a line')
      assert.doesNotMatch(text, /recorder claude-telemetry at/)
      // Both endpoints still carry the per-responder trust disclosure.
      assert.equal((text.match(/nothing proves the responder/g) ?? []).length, 2)
      assert.ok(text.includes(listenerBase), 'the headline recorder endpoint is named')
      assert.ok(text.includes(gatewayBase), 'the other recorder endpoint is named')
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

/**
 * Issue #1626: what a single-recorder receipt does NOT establish. A listener
 * missing from `recorders` was not addressed, and that is two different
 * machines - one where nothing is capturing this session, one where something
 * is - which is why the privacy skill's Step 1 cannot stop on the absence
 * alone and reads `hyp status` before it decides.
 *
 * Both worlds are built here and the receipt is required to be the same in
 * each, so the premise is measured rather than asserted; the capture-health
 * cross-check is then required to tell them apart.
 *
 * @ref LLP 0256#cli-posts-to-both [tests]: a listener that is not running is
 * not a failure - it is recording nothing - so only a live one that was
 * skipped is.
 */
test('a gateway-only receipt cannot say whether the listener is down, and capture health can', async () => {
  const gatewaySet = /** @type {Set<string>} */ (new Set())
  await withControlServer(gatewaySet, async (gatewayBase) => {
    // Nothing registered the listener (an `@hypaware/ai-gateway` with no
    // record seam does exactly this), then: the listener running, and still
    // not addressable because it advertises no control route.
    for (const listenerStartedAt of [undefined, new Date(Date.now() - 60_000).toISOString()]) {
      const hypHome = daemonHome({ gatewayBase, listenerStartedAt })
      const homeDir = otelAttachedClaude(hypHome)
      const ctx = fakeCtx({ env: { HYP_HOME: hypHome, CLAUDE_CODE_SESSION_ID: SESSION } })

      assert.equal(await runSessionIgnore(['--json'], ctx.ctx), 0)
      const out = JSON.parse(ctx.stdout())
      assert.equal(out.status, 'ok')
      assert.deepEqual(
        out.recorders.map((/** @type {any} */ r) => r.recorder),
        ['gateway'],
        'the receipt is the single-recorder one either way, so the stop cannot be read off it'
      )

      const { health } = await captureHealth({ hypHome, homeDir })
      assert.equal(health?.client, 'claude')
      assert.equal(
        health?.listener_started_at,
        listenerStartedAt ?? null,
        'and the second observation is what separates them'
      )
    }
  })
})

/**
 * Issue #1626's fix reads `listener_started_at` as the cross-check, but that
 * field and the `control_routes` advertisement the verb resolves recorders by
 * come from one liveness-gated read of one `run/status.json` (`liveStatusSources`
 * / `readStatusFile` in `src/core/daemon/status.js`). When the daemon process is
 * alive - pid file intact, process running - but that file cannot be parsed,
 * `collectHypAwareStatus` swallows the parse failure into `daemon.error` while
 * `daemon.running` stays `true` from the pid check alone, and the claude
 * `capture_health` entry still gets built (it is gated on config and the otel
 * attach marker, not on the status file parsing), with `listener_started_at`
 * forced to `null` because the source snapshot it would have read is gone.
 *
 * So a null `listener_started_at` is not, by itself, proof the listener is
 * down: it is also what a live, still-recording listener looks like the
 * instant its own status snapshot is unreadable. The privacy skill's
 * cross-check has to require the rendered `daemon` object to carry no
 * `"error"` before it reads that null as "not running" - this pins the shape
 * that requirement is written against.
 */
test('an unreadable status.json nulls the cross-check for a listener that is still running', async () => {
  const gatewaySet = /** @type {Set<string>} */ (new Set())
  await withControlServer(gatewaySet, async (gatewayBase) => {
    const listenerStartedAt = new Date(Date.now() - 60_000).toISOString()
    const hypHome = daemonHome({ gatewayBase, listenerStartedAt })
    const homeDir = otelAttachedClaude(hypHome)
    const stateRoot = path.join(hypHome, 'hypaware')

    // Keep the pid file (the daemon process is genuinely alive) but corrupt
    // the status file it would otherwise read the listener's snapshot from.
    fs.writeFileSync(statusFilePath(stateRoot), 'not json')

    const { health, daemon } = await captureHealth({ hypHome, homeDir })
    assert.equal(daemon.running, true, 'the process is alive, so the daemon still reads as running')
    assert.ok(
      typeof daemon.error === 'string' && daemon.error.length > 0,
      'and the unparseable snapshot must show up as an error, not silently'
    )
    assert.equal(
      health?.listener_started_at,
      null,
      'the listener is genuinely running, but its snapshot could not be read, so the cross-check field nulls anyway'
    )
  })
})

/**
 * Issue #2148: the same two readings on the gateway side, where Codex lives.
 * Codex reaches HypAware through `base_url`, so the gateway is the recorder
 * that captures it, and the gateway is missing from `recorders` exactly when
 * `resolveGatewayEndpointForCli` found no bound port in the live snapshot and
 * no `listen` pinned in the config. With another recorder live the verb still
 * exits 0 with `status: "ok"`, so the receipt alone cannot say whether the
 * gateway was skipped while listening or is simply not listening.
 *
 * The second observation is the gateway's own bound address, the same field
 * `gatewaySourceDetails` resolves recorders by, and `hyp daemon status --json`
 * is where it is readable: `hyp status --json` renders sources without their
 * `details`. Both worlds are built here and the payload is required to tell
 * them apart, so the shapes the codex privacy skill names are measured against
 * the real command rather than asserted.
 *
 * @ref LLP 0256#cli-posts-to-both [tests]: a recorder that is not running is
 * not a failure - it is recording nothing - so only a listening one that was
 * skipped is.
 */
test('a receipt with no gateway entry cannot say whether the gateway is listening, and the daemon snapshot can', async () => {
  await withControlServer(/** @type {Set<string>} */ (new Set()), async (listenerBase) => {
    // The gateway bound nothing; the claude telemetry listener is live and
    // advertises the route, which is what keeps the receipt an `ok` instead
    // of the no-recorder-at-all refusal.
    const hypHome = daemonHome({ listenerBase })
    const ctx = fakeCtx({ env: { HYP_HOME: hypHome } })

    assert.equal(await runSessionIgnore([SESSION, '--json'], ctx.ctx), 0)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'ok', 'a gateway that is not listening is not addressed, and that is not a failure')
    assert.deepEqual(
      out.recorders.map((/** @type {any} */ r) => r.recorder),
      ['claude-telemetry'],
      'so the receipt carries no gateway entry, on the machine that is capturing nothing over base_url'
    )
    assert.match(ctx.stderr(), /gateway not addressed:/)

    const down = await daemonStatusJson(hypHome)
    assert.equal(down.running, true, 'the daemon is up - it is the gateway that is not')
    const downGateway = gatewaySource(down)
    assert.equal(downGateway?.details?.listening, false)
    assert.equal(downGateway?.details?.port, undefined, 'and no port, which is exactly what the recorder resolution reads')

    // The other direction: a gateway that did bind says so in the same place.
    await withControlServer(/** @type {Set<string>} */ (new Set()), async (gatewayBase) => {
      const up = await daemonStatusJson(daemonHome({ gatewayBase, listenerBase }))
      assert.equal(up.running, true)
      assert.equal(typeof gatewaySource(up)?.details?.port, 'number', 'a listening gateway carries its bound port')
    })

    // And an unreadable snapshot is not an observation at all: the command
    // exits nonzero rather than reporting a gateway that is not listening.
    fs.writeFileSync(statusFilePath(path.join(hypHome, 'hypaware')), 'not json')
    const broken = fakeCtx({ env: { HYP_HOME: hypHome } })
    assert.equal(await runDaemonStatus(['--json'], broken.ctx), 1)
    assert.equal(broken.stdout(), '', 'and prints no payload a reader could mistake for one')
  })
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
 * `listenerStartedAt` is the other half of that source, the one `hyp status`
 * reads: a listener the running daemon started. The two are split into
 * separate parameters here only to isolate the field the cross-check reads
 * in each test - the shipped listener co-emits them: `control_routes` and
 * `listener_started_at` ride the same unconditional `details` literal in
 * `hypaware-core/plugins-workspace/claude/src/telemetry/source.js`, so a
 * live listener never actually carries one without the other. What can
 * separate them for a caller of `hyp status` is not the listener but the
 * read of its snapshot: see the unreadable-status-file case below, where a
 * listener that is genuinely running still reports a null
 * `listener_started_at` because the file that would have said so could not
 * be parsed.
 *
 * Omitting `gatewayBase` writes what a gateway that bound nothing writes for
 * itself: `listening: false` and no address, which is the shape
 * `gatewaySourceDetails` already reads as "no reachable gateway here".
 *
 * @param {{ gatewayBase?: string, listenerBase?: string, listenerStartedAt?: string }} args
 * @returns {string}
 */
function daemonHome({ gatewayBase, listenerBase, listenerStartedAt }) {
  const gatewayUrl = gatewayBase ? new URL(gatewayBase) : undefined
  const hypHome = temporaryDirectory('hyp-session-both-')
  const stateRoot = path.join(hypHome, 'hypaware')
  fs.mkdirSync(path.join(stateRoot, 'run'), { recursive: true })
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))
  const sources = [
    {
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      state: 'ready',
      details: gatewayUrl
        ? { host: gatewayUrl.hostname, port: Number(gatewayUrl.port) }
        : { listening: false },
    },
  ]
  if (listenerBase || listenerStartedAt) {
    const listenerUrl = listenerBase ? new URL(listenerBase) : undefined
    sources.push({
      name: 'claude-telemetry',
      plugin: '@hypaware/claude',
      state: 'ready',
      details: /** @type {any} */ ({
        listen_host: listenerUrl?.hostname ?? '127.0.0.1',
        listen_port: listenerUrl ? Number(listenerUrl.port) : DEFAULT_TELEMETRY_PORT,
        ...(listenerBase ? { control_routes: ['ignore/session'] } : {}),
        ...(listenerStartedAt ? { last_event_at: null, listener_started_at: listenerStartedAt } : {}),
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
  const hypHome = args.env?.HYP_HOME ?? temporaryDirectory('hyp-session-home-')
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

/**
 * A `$HOME` whose Claude Code settings carry an otel attach marker, beside a
 * config enabling both plugins in `hypHome`: what `hyp status` requires
 * before it reports capture health for a client at all.
 *
 * @param {string} hypHome
 * @returns {string}
 */
function otelAttachedClaude(hypHome) {
  fs.writeFileSync(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:8787',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' }],
        },
      },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
  }) + '\n')
  const homeDir = temporaryDirectory('hyp-session-client-')
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
    _hypaware: {
      attached_at: new Date(Date.now() - 3_600_000).toISOString(),
      version: '2.0.0',
      port: DEFAULT_TELEMETRY_PORT,
      mode: 'otel',
      managed: { env: {}, hooks: [] },
    },
    env: {},
  }) + '\n')
  return homeDir
}

/**
 * The claude entry of the `capture_health` array `hyp status --json` prints,
 * alongside the rendered `daemon` block, through the real collector and
 * renderer - so the keys the privacy skill names, on both sides of its
 * cross-check, are the ones the command actually carries.
 *
 * @param {{ hypHome: string, homeDir: string }} args
 */
async function captureHealth({ hypHome, homeDir }) {
  const report = await collectHypAwareStatus({
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    homeDir,
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  })
  const json = renderStatusJson({
    report,
    clientNames: [],
    datasets: [],
    cacheRoot: path.join(hypHome, 'hypaware', 'cache'),
  })
  return {
    health: json.capture_health.find((/** @type {any} */ entry) => entry.client === 'claude'),
    daemon: json.daemon,
  }
}

/**
 * `hyp daemon status --json` over a `HYP_HOME`, parsed: the daemon's own
 * snapshot, which is the only surface carrying a source's `details`.
 *
 * @param {string} hypHome
 */
async function daemonStatusJson(hypHome) {
  const ctx = fakeCtx({ env: { HYP_HOME: hypHome } })
  assert.equal(await runDaemonStatus(['--json'], ctx.ctx), 0)
  return JSON.parse(ctx.stdout())
}

/**
 * The gateway's entry in that snapshot, found the way core finds it.
 *
 * @param {any} payload
 */
function gatewaySource(payload) {
  return payload.sources.find((/** @type {any} */ s) => s.plugin === '@hypaware/ai-gateway')
}
