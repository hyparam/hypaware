// @ts-check

/**
 * The unparseable-body arm of the Claude telemetry listener, driven through
 * its real transport: a listener on an ephemeral port, a fake gateway behind
 * it, and OTLP/JSON over the wire.
 *
 * A body file that does not parse is deleted immediately (an undeleted body is
 * a raw prompt sitting on disk), and the published `spool_bytes` gauge has to
 * come down with it, exactly as it does for a body that projected.
 *
 * @ref LLP 0257#status-and-health [tests]: S16 - `spool_bytes` is the spool's
 *   current size, so the reader's own deletion has to move it
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
import { createStartClaudeTelemetrySource } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import { claudeBodySpoolDir } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'
import { loadSpooledBodies } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/bodies.js'

const SESSION = 'd41f0b2e-7c8a-4f19-9f61-6a1c2f7d0e33'
const REQUEST_ID = 'req_011Ce8sjpb8Uzvot2JMvFkKe'

/** @param {Record<string, unknown>} attrs */
function kvAttributes(attrs) {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key, value: { intValue: value } }
        : { key, value: { doubleValue: value } }
    }
    return { key, value: { stringValue: String(value) } }
  })
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {string} timestamp
 */
function record(name, attrs, timestamp) {
  return {
    timeUnixNano: String(BigInt(Date.parse(timestamp)) * 1_000_000n),
    body: { stringValue: `claude_code.${name}` },
    attributes: kvAttributes({
      'session.id': SESSION,
      'event.name': name,
      'event.timestamp': timestamp,
      ...attrs,
    }),
  }
}

/** @param {Array<ReturnType<typeof record>>} records */
function envelope(records) {
  return {
    resourceLogs: [
      {
        resource: { attributes: kvAttributes({ 'service.name': 'claude-code' }) },
        scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: records }],
      },
    ],
  }
}

/**
 * Start a real listener on an ephemeral port with a fake gateway behind it.
 *
 * `seed` files are written BEFORE the start-time sweep, which is what primes
 * the published `spool_bytes`: a file dropped in afterwards is invisible to
 * the gauge until the next sweep restates it.
 *
 * @param {{ seed?: Array<{ name: string, content: string }> }} [opts]
 */
async function startListener(opts = {}) {
  const hypHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-'))
  const spoolDir = claudeBodySpoolDir(hypHome)
  await fsp.mkdir(spoolDir, { recursive: true })
  for (const file of opts.seed ?? []) {
    await fsp.writeFile(path.join(spoolDir, file.name), file.content, 'utf8')
  }
  const stateFile = path.join(hypHome, 'claude-sessions.json')
  const noop = () => {}
  const start = createStartClaudeTelemetrySource({
    gateway: /** @type {any} */ ({
      recordProjectedExchange: async () => ({ rowsWritten: 0, rowsSkipped: 0 }),
    }),
    clientName: 'claude',
    stateFile,
  })
  const ctx = /** @type {any} */ ({
    config: { telemetry: { listen_host: '127.0.0.1', listen_port: 0 } },
    env: { HYP_HOME: hypHome },
    log: { info: noop, warn: noop, error: noop, debug: noop },
    storage: {
      cacheTablePath: () => path.join(hypHome, 'cache', 'claude_telemetry_events'),
      appendRows: async () => {},
    },
  })
  // `status` and `stop` are optional on the kernel's StartedSource; this one
  // publishes both, and this test reads them.
  const source = /** @type {any} */ (await start(ctx))
  const first = /** @type {any} */ ((await source.status()).details)
  const port = /** @type {number} */ (first.listen_port)

  return {
    hypHome,
    spoolDir,
    stateFile,
    /** @param {ReturnType<typeof envelope>} body */
    async post(body) {
      return fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    async details() {
      return /** @type {Record<string, unknown>} */ ((await source.status()).details ?? {})
    },
    async cleanup() {
      await source.stop()
      await fsp.rm(hypHome, { recursive: true, force: true })
    },
  }
}

// The reader deletes an unparseable body and counts it, but before this fix it
// never told the caller how many bytes went with it, so `spool_bytes` stayed
// at its pre-batch value until the next sweep restated it (up to a minute) and
// `hyp status` reported bytes for a file that was already off the disk.
test('an unparseable body brings the published spool_bytes down with it', async () => {
  const content = 'not json at all'
  const listener = await startListener({ seed: [{ name: 'broken.request.json', content }] })
  try {
    // A recorded cwd, so the usage-policy gate resolves rather than withholds:
    // this has to reach the READ path, not the drop path.
    await appendSessionContext(listener.stateFile, {
      session_id: SESSION,
      transcript_path: undefined,
      git_branch: undefined,
      cwd: listener.hypHome,
      ts: '2026-08-17T19:30:00.000Z',
    })
    const body = path.join(listener.spoolDir, 'broken.request.json')
    // The start-time sweep is what primes the gauge, so the file has to be on
    // disk before it runs.
    assert.equal(
      (await listener.details()).spool_bytes,
      content.length,
      'the start sweep publishes what is already spooled'
    )

    const res = await listener.post(envelope([
      record('api_request_body', { body_ref: body, request_id: REQUEST_ID }, '2026-08-17T19:31:00.000Z'),
    ]))
    assert.equal(res.status, 200)

    await assert.rejects(fsp.stat(body), 'an unparseable body is deleted, not left on disk')
    const details = await listener.details()
    assert.equal(details.spool_bytes, 0, 'the gauge has to come down by what the read arm removed')
  } finally {
    await listener.cleanup()
  }
})

// The reader half on its own: the byte total is what lets the call site
// subtract, so it has to be reported even when nothing projects.
test('loadSpooledBodies reports the bytes an unparseable body took with it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-unit-'))
  try {
    const content = 'not json at all'
    const file = path.join(dir, 'broken.request.json')
    await fsp.writeFile(file, content, 'utf8')
    const events = [{
      name: 'api_request_body',
      timestamp: '2026-08-17T19:31:00.000Z',
      attributes: { body_ref: file, request_id: REQUEST_ID },
    }]
    const loaded = await loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir })
    assert.equal(loaded.unparseable, 1)
    assert.equal(loaded.consumedBytes, 0, 'nothing projected, so nothing was consumed')
    assert.equal(loaded.unparseableBytes, content.length)
    await assert.rejects(fsp.stat(file))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// Two reads of the same `body_ref` overlapping in the handler: both are issued
// before either resolves, so both find the file and both call it unparseable,
// but only one of them can be the call that removed it. `fs.rm(..., { force:
// true })` resolves for a path that is already gone, so it reported the bytes
// twice and brought `spool_bytes` down by 2x one deletion.
test('two overlapping reads of one unparseable body report its bytes once', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-race-'))
  try {
    const content = 'not json at all'
    const file = path.join(dir, 'broken.request.json')
    await fsp.writeFile(file, content, 'utf8')
    const events = [{
      name: 'api_request_body',
      timestamp: '2026-08-17T19:31:00.000Z',
      attributes: { body_ref: file, request_id: REQUEST_ID },
    }]
    const both = await Promise.all([
      loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir }),
      loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir }),
    ])
    assert.equal(both[0].unparseable + both[1].unparseable, 2, 'both reads saw it')
    assert.equal(
      both[0].unparseableBytes + both[1].unparseableBytes,
      content.length,
      'one file left the disk, so its bytes are reported once'
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// Nothing the callers return can tell the shared read from its absence: reads
// issued in one tick all resolve before any `unlink`, so the counts and the
// bytes agree either way. Counting `readFile` is what distinguishes them, and
// it is the assertion that fails both when the dedup is deleted and when its
// `reading.set` moves behind an `await` (which narrows the window instead of
// closing it: the next caller then arrives before the read has been claimed).
test('overlapping loadSpooledBodies calls for one body_ref issue exactly one readFile', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-dedup-'))
  const realReadFile = fsp.readFile
  try {
    const file = path.join(dir, 'broken.request.json')
    await fsp.writeFile(file, 'not json at all', 'utf8')
    const events = [{
      name: 'api_request_body',
      timestamp: '2026-08-17T19:31:00.000Z',
      attributes: { body_ref: file, request_id: REQUEST_ID },
    }]
    let reads = 0
    // The reader and this test hold the same `node:fs/promises` module object,
    // and the reader looks `readFile` up at call time, so counting its calls
    // needs no hook in the production path.
    fsp.readFile = /** @type {any} */ ((/** @type {string} */ target) => {
      if (target === file) reads += 1
      return realReadFile(target)
    })
    // Started in one tick, so all three overlap: each runs synchronously as far
    // as its first `await`, which is where the shared read has to be claimed.
    await Promise.all([
      loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir }),
      loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir }),
      loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir }),
    ])
    assert.equal(reads, 1, 'three overlapping callers share one read of the file')
  } finally {
    fsp.readFile = realReadFile
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// A shared read dropped the moment it settles leaves the window between the
// read and the `unlink` uncovered: a caller arriving inside it finds no entry,
// reads the file for itself, sees ENOENT for a body that was never legitimately
// missing, and counts `missing` where every other caller counts `unparseable`
// (#2053). The window is real but short, so it is pinned by holding the removal
// open rather than by racing it.
test('a caller arriving while an unparseable body is being removed still calls it unparseable', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-window-'))
  const realUnlink = fsp.unlink
  try {
    const content = 'not json at all'
    const file = path.join(dir, 'broken.request.json')
    await fsp.writeFile(file, content, 'utf8')
    const events = [{
      name: 'api_request_body',
      timestamp: '2026-08-17T19:31:00.000Z',
      attributes: { body_ref: file, request_id: REQUEST_ID },
    }]
    /** @type {(value?: unknown) => void} */
    let removed = () => {}
    const fileIsGone = new Promise((resolve) => { removed = resolve })
    /** @type {(value?: unknown) => void} */
    let release = () => {}
    const finishRemoval = new Promise((resolve) => { release = resolve })
    // The real removal happens, then the arm is held open: the file is off the
    // disk while the first call is still inside it.
    fsp.unlink = /** @type {any} */ (async (/** @type {string} */ target) => {
      if (target !== file) return realUnlink(target)
      await realUnlink(target)
      removed()
      await finishRemoval
    })
    const first = loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir })
    await fileIsGone
    const second = loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir })
    // One tick, so the second call reaches its classification while the first
    // still owns the removal.
    await new Promise((resolve) => setImmediate(resolve))
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.unparseable + b.unparseable, 2, 'both callers classified the same body the same way')
    assert.equal(a.missing + b.missing, 0, 'a body being removed is not a body that was missing')
    assert.equal(
      a.unparseableBytes + b.unparseableBytes,
      content.length,
      'one file left the disk, so its bytes are reported once'
    )
  } finally {
    fsp.unlink = realUnlink
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// The same defect measured the way it was found: a second call separated from
// the first by whole macrotasks, so it lands wherever the first call's read and
// removal happen to be. A trial only counts when the second call was issued
// before the first returned - a second call that starts after the first has
// fully finished overlaps nothing and proves nothing - so the overlapping count
// is asserted too, or a slow machine could pass this vacuously.
test('macrotask-separated overlapping callers never miscount one unparseable body', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-sep-'))
  try {
    const content = 'not json at all'
    const separations = [0, 5, 10, 20]
    const perSeparation = 75
    let overlapping = 0
    let miscounts = 0
    let badBytes = 0
    for (const separation of separations) {
      for (let trial = 0; trial < perSeparation; trial++) {
        const file = path.join(root, `broken.${separation}.${trial}.request.json`)
        await fsp.writeFile(file, content, 'utf8')
        const events = [{
          name: 'api_request_body',
          timestamp: '2026-08-17T19:31:00.000Z',
          attributes: { body_ref: file, request_id: REQUEST_ID },
        }]
        let firstReturned = false
        const first = loadSpooledBodies(/** @type {any} */ (events), { spoolDir: root })
          .then((result) => { firstReturned = true; return result })
        for (let tick = 0; tick < separation; tick++) {
          await new Promise((resolve) => setImmediate(resolve))
        }
        // Sampled and used in one synchronous run, after the tick loop drained
        // the microtask queue, so it is exact at the instant the second call
        // claims (or fails to claim) the shared read.
        const overlapped = !firstReturned
        const second = loadSpooledBodies(/** @type {any} */ (events), { spoolDir: root })
        const [a, b] = await Promise.all([first, second])
        if (!overlapped) continue
        overlapping += 1
        if (a.unparseable + b.unparseable !== 2 || a.missing + b.missing !== 0) miscounts += 1
        if (a.unparseableBytes + b.unparseableBytes !== content.length) badBytes += 1
      }
    }
    assert.ok(
      overlapping >= separations.length * perSeparation / 2,
      `too few genuinely-overlapping trials to prove anything (${overlapping})`
    )
    assert.equal(miscounts, 0, `${miscounts} of ${overlapping} overlapping trials miscounted`)
    assert.equal(badBytes, 0, `${badBytes} of ${overlapping} overlapping trials misreported bytes`)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

// Holding the shared read past its own settlement is what closes that window,
// so the entry now has to be released by whichever arm classified the bytes,
// on every exit path. A leaked entry is directly observable: a later caller
// naming the same ref would be handed the stale promise and would issue no
// `readFile` of its own, so counting reads on a probe call is a residency
// assertion on the map.
test('the shared read is released on every exit path of loadSpooledBodies', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-residency-'))
  const realReadFile = fsp.readFile
  const realUnlink = fsp.unlink
  /** @param {string} file */
  const eventsFor = (file) => /** @type {any} */ ([{
    name: 'api_request_body',
    timestamp: '2026-08-17T19:31:00.000Z',
    attributes: { body_ref: file, request_id: REQUEST_ID },
  }])
  /**
   * Drive one exit path, then probe whether the map still holds its read.
   * @param {string} name
   * @param {(file: string) => Promise<void>} drive
   */
  const probeAfter = async (name, drive) => {
    const file = path.join(root, `${name}.request.json`)
    await drive(file)
    let reads = 0
    fsp.readFile = /** @type {any} */ ((/** @type {string} */ target) => {
      if (target === file) reads += 1
      return realReadFile(target)
    })
    try {
      await loadSpooledBodies(eventsFor(file), { spoolDir: root })
    } finally {
      fsp.readFile = realReadFile
    }
    assert.equal(reads, 1, `${name} left its read in the map`)
  }
  try {
    // The read rejected: nothing was read, so nothing will be removed.
    await probeAfter('missing', async (file) => {
      await loadSpooledBodies(eventsFor(file), { spoolDir: root })
    })
    // Unparseable, and this call owned the removal.
    await probeAfter('removed', async (file) => {
      await fsp.writeFile(file, 'not json at all', 'utf8')
      await loadSpooledBodies(eventsFor(file), { spoolDir: root })
    })
    // Unparseable, and the removal itself failed: the `finally` still runs.
    await probeAfter('unremovable', async (file) => {
      await fsp.writeFile(file, 'not json at all', 'utf8')
      fsp.unlink = /** @type {any} */ (async (/** @type {string} */ target) => {
        if (target === file) throw new Error('EPERM')
        return realUnlink(target)
      })
      try {
        await loadSpooledBodies(eventsFor(file), { spoolDir: root })
      } finally {
        fsp.unlink = realUnlink
      }
    })
    // Unparseable, on the `removing.has(file)` early continue: the two callers
    // that are not the removal's owner take that branch and release nothing,
    // and the owner's `finally` still clears the entry.
    await probeAfter('conceded', async (file) => {
      await fsp.writeFile(file, 'not json at all', 'utf8')
      await Promise.all([
        loadSpooledBodies(eventsFor(file), { spoolDir: root }),
        loadSpooledBodies(eventsFor(file), { spoolDir: root }),
        loadSpooledBodies(eventsFor(file), { spoolDir: root }),
      ])
    })
    // Projected: the file outlives the read, and `deleteSpooledBodies` removes
    // it once the batch is written, so there is no removal to outlive.
    await probeAfter('projected', async (file) => {
      await fsp.writeFile(file, JSON.stringify({ model: 'claude-x', messages: [] }), 'utf8')
      await loadSpooledBodies(eventsFor(file), { spoolDir: root })
    })
  } finally {
    fsp.readFile = realReadFile
    fsp.unlink = realUnlink
    await fsp.rm(root, { recursive: true, force: true })
  }
})
