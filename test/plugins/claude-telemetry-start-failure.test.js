// @ts-check

/**
 * A listener start that cannot bind must leave nothing running.
 *
 * The spool sweep is on a repeating timer, and `stop()` is the only thing that
 * clears it - but a `start()` that throws never returns a handle to call
 * `stop()` on. Arming the timer before the bind therefore left it scanning the
 * spool once a minute, for the life of the daemon, on behalf of a source that
 * does not exist. `unref()` keeps that from holding the process open, which is
 * exactly why it would never have been noticed.
 *
 * @ref LLP 0114#explicit-listen-fails-loudly [tests]: a configured port that is
 *   taken is a loud source-start failure, and a failed start owns nothing
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createStartClaudeTelemetrySource } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'

/**
 * Count `setInterval` calls for the duration of `fn`. An `unref`'d timer does
 * not show up in `process.getActiveResourcesInfo()`, which is precisely why an
 * orphaned one would never be noticed at runtime, so the arming itself is what
 * the test observes.
 *
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ armed: number, error: unknown }>}
 */
async function countIntervals(fn) {
  const original = globalThis.setInterval
  let armed = 0
  /** @type {unknown} */
  let error
  globalThis.setInterval = /** @type {typeof globalThis.setInterval} */ (
    /** @type {unknown} */ ((/** @type {any[]} */ ...args) => {
      armed += 1
      return /** @type {any} */ (original)(...args)
    })
  )
  try {
    await fn()
  } catch (err) {
    error = err
  } finally {
    globalThis.setInterval = original
  }
  return { armed, error }
}

/** A listener holding a port so the configured bind below cannot have it. */
function occupy() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ port, close: () => new Promise((r) => server.close(() => r(undefined))) })
    })
  })
}

test('a listener that cannot bind its configured port leaves no sweep timer behind', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-start-fail-'))
  const taken = /** @type {{ port: number, close: () => Promise<unknown> }} */ (await occupy())
  try {
    const start = createStartClaudeTelemetrySource({
      gateway: /** @type {any} */ ({ recordProjectedExchange: async () => ({ written: 0 }) }),
      clientName: 'claude',
      stateFile: path.join(hypHome, 'claude-sessions.json'),
    })
    const noop = () => {}
    const ctx = /** @type {any} */ ({
      // An EXPLICIT port, so `bindWithFallback` refuses to fall back and the
      // start really does throw (LLP 0114 §explicit-listen-fails-loudly).
      config: { telemetry: { listen_host: '127.0.0.1', listen_port: taken.port } },
      env: { HYP_HOME: hypHome },
      log: { info: noop, warn: noop, error: noop, debug: noop },
      storage: {},
    })

    const { armed, error } = await countIntervals(() => start(ctx))
    assert.ok(error, 'the configured port was taken, so the start must fail')
    assert.equal(
      armed,
      0,
      'the failed start armed a repeating timer with no stop() left to clear it'
    )
  } finally {
    await taken.close()
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
