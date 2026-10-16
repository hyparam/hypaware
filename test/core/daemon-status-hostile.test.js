// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { runDaemonStatus } from '../../src/core/commands/daemon.js'

// `hyp daemon status` reads `status.json` and prints it. That file is a
// *file*: core cannot assume the daemon that wrote it was this version, this
// build, or well behaved, and everything read out of it is on its way to a
// terminal. `hyp status` already cleans what it reads back out of the same
// file at the last point before render (LLP 0164); this surface read the same
// bytes and printed them raw, so every field it prints was a way to repaint
// the operator's screen or forge a plausible extra status line.
//
// @ref LLP 0164#status-reads-it-from-the-status-file [tests]: what core reads back out of status.json is cleaned before it reaches a terminal, on every surface that prints it

// Every character that drives or reorders a terminal, minus the newline this
// surface legitimately writes itself.
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/

// An erase-line sequence plus a newline: together enough to forge a plausible
// extra line the operator never chose to trust.
const ERASE_LINE = '\u001b[2K'
const ZERO_WIDTH = '\u200b'

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-daemon-status-hostile-'))
  const runDir = path.join(hypHome, 'hypaware', 'run')
  await fs.mkdir(runDir, { recursive: true })
  return { hypHome, runDir }
}

/**
 * Write `status.json` from arbitrary JSON rather than from a `DaemonStatus`:
 * the whole point of these tests is what a file this build did not write can
 * hold.
 *
 * @param {string} runDir
 * @param {unknown} value
 */
async function writeRawStatus(runDir, value) {
  await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify(value))
}

function makeBuf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * @param {string} hypHome
 * @param {string[]} [argv]
 */
async function run(hypHome, argv = []) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    env: { ...process.env, HYP_HOME: hypHome },
    stdout,
    stderr,
    argv,
  })
  const code = await runDaemonStatus(argv, ctx)
  return { code, out: stdout.text(), err: stderr.text() }
}

test('a hostile state and timestamps cannot drive the terminal from hyp daemon status', async () => {
  const { hypHome, runDir } = await makeHome()
  await writeRawStatus(runDir, {
    state: `healthy${ERASE_LINE}\ndaemon: all good`,
    pid: 4321,
    startedAt: '2026-05-21T00:00:00.000Z\u001b[31m',
    healthyAt: '2026-05-21T00:00:01.000Z',
    stoppedAt: `never${ZERO_WIDTH}${ZERO_WIDTH}`,
    uptimeMs: 1000,
    sources: [],
    sinks: [],
  })

  const { code, out } = await run(hypHome)

  assert.equal(code, 0)
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(out), 'no control byte reaches stdout')
  assert.ok(!out.includes(ZERO_WIDTH), 'and no zero-width run does either')
  assert.match(out, /daemon: healthy/, 'the printable part of the state still names it')
  assert.ok(
    !/^daemon: all good$/m.test(out),
    'the embedded newline cannot forge a second status line',
  )
})

test('a non-numeric pid and uptime from the status file are cleaned, not printed raw', async () => {
  const { hypHome, runDir } = await makeHome()
  await writeRawStatus(runDir, {
    state: 'healthy',
    // Both are typed `number`, and neither is validated on read: a file this
    // build did not write can put anything here.
    pid: `4321${ERASE_LINE}\ndaemon: all good`,
    startedAt: '2026-05-21T00:00:00.000Z',
    uptimeMs: `1000${ERASE_LINE}`,
    sources: [],
    sinks: [],
  })

  const { code, out } = await run(hypHome)

  assert.equal(code, 0)
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(out), 'no control byte reaches stdout')
  assert.match(out, /pid: +4321/, 'the printable part of the pid still shows')
  assert.match(out, /uptime_ms: +1000/, 'and so does the uptime')
})

test('a well-formed pid and uptime still print as the numbers they are', async () => {
  const { hypHome, runDir } = await makeHome()
  await writeRawStatus(runDir, {
    state: 'healthy',
    pid: 4321,
    startedAt: '2026-05-21T00:00:00.000Z',
    uptimeMs: 1000,
    sources: [],
    sinks: [],
  })

  const { code, out } = await run(hypHome)

  assert.equal(code, 0)
  assert.match(out, /pid: +4321\n/, 'a real pid is untouched')
  assert.match(out, /uptime_ms: +1000\n/, 'and so is a real uptime')
})

test('hostile source and sink fields cannot drive the terminal from hyp daemon status', async () => {
  const { hypHome, runDir } = await makeHome()
  await writeRawStatus(runDir, {
    state: 'healthy',
    pid: 4321,
    startedAt: '2026-05-21T00:00:00.000Z',
    uptimeMs: 1000,
    sources: [
      {
        name: `gate${ERASE_LINE}way`,
        plugin: `@hypaware/ai-${ZERO_WIDTH}${ZERO_WIDTH}gateway`,
        state: 'failed\n    - forged (x): started',
        error: 'EADDRINUSE\u001b[31m',
      },
    ],
    sinks: [
      {
        instance: `loc${ERASE_LINE}al`,
        plugin: `@hypaware/local-${ZERO_WIDTH}fs`,
        kind: 'blob\n    - forged (y, z)',
      },
    ],
  })

  const { code, out } = await run(hypHome)

  assert.equal(code, 0)
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(out), 'no control byte reaches stdout')
  assert.ok(!out.includes(ZERO_WIDTH), 'and no zero-width run does either')
  assert.equal(
    out.split('\n').filter((line) => line.startsWith('    - forged')).length,
    0,
    'an embedded newline cannot forge an extra source or sink row',
  )
  // The ESC is dropped and the rest of the sequence stays as the ordinary
  // text it is: cleaning bounds what a value *does*, not what it looks like.
  assert.match(out, /- gate\[2Kway \(@hypaware\/ai-gateway\): failed/, 'the printable parts still read')
  assert.match(out, /- loc\[2Kal \(@hypaware\/local-fs, blob/, 'on the sink line too')
})

test('an unbounded field from the status file is clamped', async () => {
  const { hypHome, runDir } = await makeHome()
  const long = 'a'.repeat(5000)
  await writeRawStatus(runDir, {
    state: long,
    pid: 4321,
    startedAt: '2026-05-21T00:00:00.000Z',
    uptimeMs: 1000,
    sources: [{ name: long, plugin: 'p', state: 's' }],
    sinks: [],
  })

  const { code, out } = await run(hypHome)

  assert.equal(code, 0)
  assert.ok(!out.includes(long), 'the raw value is not printed whole')
  // `sanitizeLabel`'s 120-character clamp, truncation marker included.
  assert.ok(out.includes('a'.repeat(117) + '...'), 'it is clamped, and marked truncated')
})

// A `status.json` that is not valid JSON reaches `JSON.parse`, whose message
// echoes an excerpt of the input verbatim. Uncaught, that surfaced as a raw
// stack trace with the file's own bytes in it: both useless to an operator and
// a way for the file to reach the terminal entirely unfiltered.
test('a malformed status file reports a clean error rather than a raw stack', async () => {
  const { hypHome, runDir } = await makeHome()
  await fs.writeFile(path.join(runDir, 'status.json'), `not json at all ${ERASE_LINE}`)

  const { code, out, err } = await run(hypHome)

  assert.equal(code, 1, 'a status file that cannot be read is a failure, not a healthy report')
  assert.match(err, /^hyp daemon status: /, 'and it reads like every other daemon failure')
  assert.ok(!/\n\s+at /.test(err), 'no stack frame reaches the operator')
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(err), 'and no control byte from the file does either')
  assert.equal(out, '', 'nothing is printed as if it were a status')
})

test('a status file holding the wrong shape does not crash the command', async () => {
  const { hypHome, runDir } = await makeHome()
  // Well-formed JSON, an object, and nothing else the reader expects: the
  // `sources` / `sinks` walks used to throw straight out through the CLI.
  await writeRawStatus(runDir, { state: 'healthy' })

  const { code, out } = await run(hypHome)

  assert.equal(code, 0)
  assert.match(out, /daemon: healthy/)
  assert.match(out, /sources:\n {4}\(none\)/)
  assert.match(out, /sinks:\n {4}\(none\)/)
})

// The cleaning is for the surface a person reads. `--json` is the machine
// copy and stays byte-exact, or a consumer that escapes for itself is handed
// something that no longer matches the file it is reporting on (LLP 0225).
test('hyp daemon status --json stays byte-exact', async () => {
  const { hypHome, runDir } = await makeHome()
  const hostile = `healthy${ERASE_LINE}\ndaemon: all good`
  await writeRawStatus(runDir, {
    state: hostile,
    pid: 4321,
    startedAt: '2026-05-21T00:00:00.000Z',
    uptimeMs: 1000,
    sources: [],
    sinks: [],
  })

  const { code, out } = await run(hypHome, ['--json'])

  assert.equal(code, 0)
  assert.equal(JSON.parse(out).state, hostile, 'the machine surface reports what the file holds')
})
