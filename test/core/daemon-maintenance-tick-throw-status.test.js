// @ts-check

/**
 * The maintenance tick owns its span rather than borrowing `withSpan`'s (the
 * note on `runMaintenance` in `src/core/daemon/runtime.js` says why), which
 * means owning every attribute `withSpan` reconciles on the way out. Its
 * catch did not: it set the ERROR status code and `error_kind` but left the
 * `status` attribute reading the `ok` the opening bag had predicted, so a
 * tick that threw exported `status: "ok"` beside a failed status code and an
 * LDD query filtering on the attribute counted the failure as a success
 * (issue #2363; #2342 is the same defect inside `withSpan`, cured centrally
 * in #2344, which by construction cannot reach this call site).
 *
 * Asserted on the exported span, because the daemon's log line and the span's
 * own status code were already right while the attribute was not.
 *
 * A file of its own rather than a second case in
 * `daemon-maintenance-tick-status.test.js`: `installObservability()` installs
 * the JSONL span exporter once per process against the `HYP_HOME` of the
 * first daemon to boot, so a second live daemon in the same process cannot
 * read its own spans back.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { runDaemon } from '../../src/core/daemon/runtime.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { pollJsonlFor } from '../helpers/poll_jsonl.js'

/**
 * Make `maintainCache` rejectable.
 *
 * @ref LLP 0220#walk-survives-a-partition [constrained-by]: the fail-soft walk that decision settled is why no on-disk fixture can make the tick throw
 *
 * Nothing on disk can do it, and LLP 0220 is the reason: the walk survives
 * the partition that throws, and every step around it (partition discovery,
 * the retired-generation sweep, the journal sweep) fails soft by design, so
 * `maintainCache` resolves with a report even over a torn cache. A rejection
 * is the case the tick's catch exists for and the one case no fixture can
 * stage, so injecting it is the only way to pin what that catch writes.
 *
 * A module customization hook (`node:module`, nothing new on the dependency
 * list) swaps the module for a shim that re-exports the real one and
 * overrides the single function. `runtime.js` imports `maintainCache`
 * dynamically at daemon boot, which is after this runs, and `node --test`
 * gives each test file its own process, so the shim is confined to this file.
 */
const MAINTENANCE_URL = new URL('../../src/core/cache/maintenance.js', import.meta.url).href
// The real module, under a specifier the hook leaves alone.
const REAL_SPECIFIER = JSON.stringify(`${MAINTENANCE_URL}?real=1`)
const SHIM_SOURCE = [
  `export * from ${REAL_SPECIFIER}`,
  `import { maintainCache as real } from ${REAL_SPECIFIER}`,
  'export async function maintainCache(opts) {',
  '  if (globalThis.__hypTickThrow) throw new Error("injected: the maintenance walk failed")',
  '  return real(opts)',
  '}',
].join('\n')
const HOOK_SOURCE = [
  `const TARGET = ${JSON.stringify(MAINTENANCE_URL)}`,
  `const SOURCE = ${JSON.stringify(SHIM_SOURCE)}`,
  'export async function load(url, context, nextLoad) {',
  '  if (url !== TARGET) return nextLoad(url, context)',
  '  return { format: "module", shortCircuit: true, source: SOURCE }',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

/** The flag the shim reads, cast once so no call site needs the annotation. */
const injection = /** @type {{ __hypTickThrow?: boolean }} */ (/** @type {any} */ (globalThis))

test('a maintenance tick that throws exports no status=ok attribute', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-daemon-maint-throw-'))
  const savedHypHome = process.env.HYP_HOME
  const savedDevTelemetry = process.env.HYP_DEV_TELEMETRY
  injection.__hypTickThrow = true
  let handle
  try {
    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      query: { cache: { maintenance: { interval_minutes: 0.001 } } },
    }))

    // `installObservability()` (called inside `runDaemon`) reads real
    // `process.env`, not the `env` option below, so the JSONL span exporter
    // has to be armed here.
    process.env.HYP_HOME = hypHome
    process.env.HYP_DEV_TELEMETRY = '1'

    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'maint-throw-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    const tracesPath = path.join(hypHome, 'hypaware', 'dev-telemetry', `traces-${process.pid}.jsonl`)
    const span = await pollJsonlFor(tracesPath, (r) => r.name === 'maintenance.tick', 15_000)

    assert.ok(span, 'the maintenance.tick span must be exported within the poll window')
    assert.equal(
      span.status, 'failed',
      'fixture invariant: the injected rejection must reach the tick catch'
    )
    assert.equal(
      span.attributes.error_kind, 'unhandled_exception',
      'sanity: the kind the catch already wrote'
    )
    assert.equal(
      span.attributes.status, 'failed',
      'no attribute may claim the failed tick succeeded - the opening bag predicted "ok"'
    )
  } finally {
    delete injection.__hypTickThrow
    if (handle) {
      await handle.stop()
      await handle.done
    }
    if (savedHypHome === undefined) delete process.env.HYP_HOME
    else process.env.HYP_HOME = savedHypHome
    if (savedDevTelemetry === undefined) delete process.env.HYP_DEV_TELEMETRY
    else process.env.HYP_DEV_TELEMETRY = savedDevTelemetry
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
