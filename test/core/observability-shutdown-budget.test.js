// @ts-check

// LLP 0339: the non-dev shutdown budget is derived from the OTLP exporter's
// own per-request timeout instead of sitting below it. The caller this repo
// ships calls `process.exit` on the line after `obs.shutdown()`
// (bin/hypaware.js), so the moment shutdown resolves is the moment the
// process disconnects every in-flight export. A confirmation the collector
// delivered before that moment survives any disconnect semantics; one still
// in flight is at the collector's mercy (the reference OTel collector binds
// processing to the request context and cancels it on disconnect). These
// tests pin the three faces of the budget at the `installObservability`
// seam, against a real HTTP listener:
//
// - a collector slower than the old 500ms budget but inside the exporter's
//   1000ms timeout gets to confirm before shutdown resolves, silently
// - a collector that never answers cannot hold the exit hostage: the
//   exporter's own abort settles the shutdown, inside the budget, silently
// - a provider close that hangs on nothing at all is still cut at the
//   budget and still says so (the backstop LLP 0337#budget-report added)
//
// @ref LLP 0339#budget-derived [tests]: an export inside the exporter's own timeout settles before shutdown resolves; only a genuine hang meets the budget.

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { installObservability, readObservabilityEnv, getLogger } from '../../src/core/observability/index.js'
import { OTLP_EXPORT_TIMEOUT_MS } from '../../src/core/observability/otlp_exporters.js'

/**
 * Capture everything written to `process.stderr` while `fn` runs. The
 * shutdown's timed-out report writes to the process stream directly, not to
 * a dispatch-bound stream, so this is the only place to observe it.
 *
 * @param {() => Promise<void>} fn
 * @returns {Promise<string>}
 */
async function captureProcessStderr(fn) {
  const realWrite = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((chunk) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })
  try {
    await fn()
  } finally {
    process.stderr.write = realWrite
  }
  return captured
}

/**
 * Start an HTTP listener on a loopback ephemeral port.
 *
 * @param {http.RequestListener} handler
 * @returns {Promise<{ server: http.Server, url: string }>}
 */
function listen(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address())
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}

/**
 * A non-dev observability install pointed at `endpoint`, with a throwaway
 * HYP_HOME so nothing touches the real state dir.
 *
 * @param {string} endpoint
 */
async function installAgainst(endpoint) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-shutdown-budget-'))
  const env = readObservabilityEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    HYP_HOME: home,
  })
  const handle = installObservability({ env })
  return { handle, home }
}

test('an export confirmed slower than the old budget settles before shutdown resolves, silently', async () => {
  // 700ms sits in the window the old 500ms budget abandoned: above the
  // budget, inside the exporter's own 1000ms timeout.
  const RESPONSE_DELAY_MS = 700
  let responded = 0
  const { server, url } = await listen((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        responded += 1
      }, RESPONSE_DELAY_MS)
    })
  })
  const { handle, home } = await installAgainst(url)
  try {
    const stderr = await captureProcessStderr(async () => {
      getLogger('shutdown-budget-test').warn('one record for a slow collector')
      await handle.shutdown()
    })
    // When shutdown resolves the shipped CLI exits, so anything the
    // collector has not confirmed by now is at its disconnect semantics'
    // mercy. The confirmation must already be in.
    assert.ok(responded >= 1,
      `the export was confirmed before the exit line (responded=${responded})`)
    // A merely slow collector is healthy operation, not a loss to report.
    assert.ok(!stderr.includes('telemetry_shutdown_timed_out'),
      `a confirmation inside the exporter timeout is not a timeout:\n${stderr}`)
  } finally {
    server.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a collector that never answers cannot hold the exit past the exporter timeout', async () => {
  const { server, url } = await listen((req) => {
    req.on('data', () => {})
    // read the body, never respond
  })
  const { handle, home } = await installAgainst(url)
  try {
    const started = Date.now()
    const stderr = await captureProcessStderr(async () => {
      getLogger('shutdown-budget-test').warn('one record for a black hole')
      await handle.shutdown()
    })
    const elapsed = Date.now() - started
    // The exporter's own abort is the bound; the budget above it is only a
    // backstop. The slack over OTLP_EXPORT_TIMEOUT_MS absorbs scheduling
    // jitter, not a second wait.
    assert.ok(elapsed < OTLP_EXPORT_TIMEOUT_MS + 1_000,
      `shutdown settled from the exporter's own abort (elapsed=${elapsed}ms)`)
    // The exporter gave up on its own inside the budget, so the budget has
    // nothing to report. (What the abort abandoned is the export timeout's
    // own story, not the shutdown's.)
    assert.ok(!stderr.includes('telemetry_shutdown_timed_out'),
      `an abort inside the budget is not a shutdown timeout:\n${stderr}`)
  } finally {
    server.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a provider close that hangs on nothing is still cut at the budget, and still says so', async () => {
  const { server, url } = await listen((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200)
      res.end('{}')
    })
  })
  const { handle, home } = await installAgainst(url)
  /** @type {(() => Promise<void>) | null} */
  let releaseHungProvider = null
  try {
    const loggerProvider = handle.logger.provider
    assert.ok(loggerProvider, 'the configured endpoint installed a logger provider')
    // A hang with no timer of its own: the case the budget exists for
    // (LLP 0337#budget-report), which no exporter timeout can settle.
    //
    // The real close is the only thing that clears the global registration
    // (`LoggerProvider.shutdown` nulls it in `runtime.js`), and the patch
    // below is never going to reach that line. Held so the `finally` can run
    // it: without that, this test leaves a provider registered globally whose
    // exporter posts at the listener the same `finally` closes, and that is
    // harmless only while nothing follows it in this file.
    const realShutdown = loggerProvider.shutdown.bind(loggerProvider)
    releaseHungProvider = async () => {
      loggerProvider.shutdown = realShutdown
      await realShutdown()
    }
    loggerProvider.shutdown = () => new Promise(() => {})
    const started = Date.now()
    const stderr = await captureProcessStderr(async () => {
      await handle.shutdown()
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed < OTLP_EXPORT_TIMEOUT_MS + 2_000,
      `the budget cut the hang (elapsed=${elapsed}ms)`)
    assert.match(stderr, /telemetry_shutdown_timed_out/,
      'the cut close is reported, not silently abandoned')
    assert.match(stderr, /"telemetry_source":"logs_provider"/,
      'and the line names the provider that hung')
  } finally {
    if (releaseHungProvider) await releaseHungProvider()
    server.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})

// The three tests above run inside the node test runner, whose own handles
// hold the event loop open for as long as the suite lasts. The shipped caller
// has no such luxury: `bin/hypaware.js` awaits `obs.shutdown()` at top level
// and the loop is free to drain underneath it. That difference is load
// bearing here, because deriving the budget from the export timeout is
// exactly what removes the last referenced handle before the budget expires
// (the pending OTLP fetch aborts at 1000ms, the budget lands at 1250ms). Run
// the hang in a real child process, where the loop can drain, and either the
// budget holds it open to report or the process leaves through Node's
// unsettled-top-level-await path with no report at all.
//
// @ref LLP 0337#budget-report [tests]: the report has to survive a shutdown whose only remaining handle is the budget itself.
test('a hung close is reported even when nothing but the budget holds the loop open', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-budget-drain-'))
  try {
    const observability = pathToFileURL(
      path.join(import.meta.dirname, '..', '..', 'src', 'core', 'observability', 'index.js')
    ).href
    // `127.0.0.1:1` refuses instantly, so the exports never hold the loop:
    // providers exist (an endpoint is configured) but nothing outlives the
    // budget except the budget. The same address the sibling budget test in
    // `containment-refusal-stderr.test.js` uses, for the same reason.
    const script = [
      `import { installObservability, readObservabilityEnv } from ${JSON.stringify(observability)}`,
      'const env = readObservabilityEnv({',
      `  HYP_HOME: ${JSON.stringify(home)},`,
      "  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',",
      '})',
      'const obs = installObservability({ env })',
      'const provider = obs.tracer.provider',
      'if (!provider) { process.exit(3) }',
      // A close that hangs on nothing at all, the shape LLP 0337#budget-report
      // exists for and the shape no exporter timeout can settle.
      'provider.exporters.push({ exportBatch() {}, shutdown() { return new Promise(() => {}) } })',
      'await obs.shutdown()',
      // Only reachable if the shutdown actually resolved. An exit code Node
      // never picks on its own, so it cannot be confused with a drained loop
      // (0) or an unsettled top-level await (13).
      'process.exit(21)',
    ].join('\n')
    const entry = path.join(home, 'drain.mjs')
    await fs.writeFile(entry, script)
    const child = await runNode(entry)
    assert.equal(child.code, 21,
      `the shutdown resolved and the caller kept its exit code (code=${child.code}, stderr=${child.stderr})`)
    assert.doesNotMatch(child.stderr, /unsettled top-level await/,
      'the process did not leave through the drained-loop path with the shutdown still pending')
    assert.match(child.stderr, /telemetry_shutdown_timed_out/,
      'the hung close is reported on the path that actually ships')
    assert.match(child.stderr, /"telemetry_channel":"traces"/,
      'and the line names the channel that hung')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/**
 * Run one module in a child `node`, and collect how it left.
 *
 * @param {string} entry
 * @returns {Promise<{ code: number|null, stderr: string }>}
 */
function runNode(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}
