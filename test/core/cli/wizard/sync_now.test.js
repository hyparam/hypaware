// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ANSI, colorizeStderr } from '../../../../src/core/cli/style.js'
import { runWizardSyncNow } from '../../../../src/core/cli/wizard/sync_now.js'
import {
  SYNC_HELD_NO_DESTINATIONS_EXIT,
  firstSyncHoldMarkerPath,
  writeFirstSyncHoldMarker,
} from '../../../../src/core/usage-policy/first_sync_hold.js'

// The closing "send now" offer (LLP 0203): setup asks whether to wait out the
// first-sync review window, and hands the user a real `hyp sync` rather than a
// sentence naming it. What it must never do is release anything itself, or
// claim a sync happened that did not.

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

/** A deadline far enough out that no clock skew makes it stale. */
const DEADLINE = Date.now() + 6 * 60 * 60_000

/**
 * @param {{
 *   deadline?: number | null,
 *   interactive?: boolean,
 *   dispatchFn?: any,
 *   readDeadline?: () => Promise<number | null>,
 * }} [over]
 */
function opts(over = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    stdout,
    stderr,
    args: {
      deadline: over.deadline === undefined ? DEADLINE : over.deadline,
      stdout,
      stderr,
      env: /** @type {NodeJS.ProcessEnv} */ ({}),
      interactive: over.interactive ?? true,
      // Default: a dispatch that must not happen. Tests that expect one pass it.
      // (An injected dispatchFn is also what lets the step run without a tty.)
      dispatchFn: over.dispatchFn ?? (() => {
        throw new Error('dispatch must not be called')
      }),
      // Default: the hold is untouched, which is what "wait" means.
      readDeadline: over.readDeadline ?? (async () => DEADLINE),
    },
  }
}

test('no hold means no question: an unenrolled install is never asked to sync', async () => {
  const o = opts({ deadline: null })
  const result = await runWizardSyncNow(o.args)
  assert.deepEqual(result, { asked: false, reason: 'no-hold' })
  assert.equal(o.stdout.text(), '')
})

test('a non-interactive run is never asked, and never sends', async () => {
  const o = opts({ interactive: false })
  const result = await runWizardSyncNow(o.args)
  assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
  // The narration upstream goes quiet whenever this step is expected to
  // run, so the skip has to state the deadline, the way out, and the review
  // hint itself or the run ends without ever naming them.
  // @ref LLP 0188#never-silent [tests]: the un-askable path still names the release verb
  assert.match(o.stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
  assert.match(o.stdout.text(), /includes your imported history/)
  assert.match(o.stdout.text(), /`hyp status` shows the countdown/)
  assert.match(o.stdout.text(), /To send it sooner, run `hyp sync`/)
  assert.match(o.stdout.text(), /hypaware-privacy/)
})

// `dispatchFn` is what lets every other test here run headless, and it is also
// what bypasses the terminal gate, so the gate is only reachable with no seam
// injected at all. Both halves of it matter: sync prompts on the
// supplied terminal, so both ends have to be one. `hyp init` gates the
// wizard on stdout alone, so the stdin half is a real attended run
// (`hyp init < file`), not a hypothetical.
// @ref LLP 0203#offer [tests]: attended-only means a terminal on both ends, and the un-askable attended run gets the full statement
for (const surfaces of [
  { name: 'a stdin that is not a terminal', stdin: false, stdout: true },
  { name: 'a stdout that is not a terminal', stdin: true, stdout: false },
]) {
  test(`${surfaces.name} is never asked, and states the whole hold instead`, async () => {
    const stdout = makeBuf()
    const result = await runWizardSyncNow({
      deadline: DEADLINE,
      stdout,
      stderr: makeBuf(),
      env: /** @type {NodeJS.ProcessEnv} */ ({}),
      interactive: true,
      stdin: /** @type {any} */ ({ isTTY: surfaces.stdin }),
      stdoutStream: /** @type {any} */ ({ isTTY: surfaces.stdout, write: () => true }),
      readDeadline: async () => DEADLINE,
    })
    assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
    // Everything the privacy narration would have said, because it stood
    // down for a question this run cannot be asked.
    assert.match(stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
    assert.match(stdout.text(), /includes your imported history/)
    assert.match(stdout.text(), /`hyp status` shows the countdown/)
    assert.match(stdout.text(), /To send it sooner, run `hyp sync`/)
    assert.match(stdout.text(), /hypaware-privacy/)
  })
}

// The narration stood down for this step, so a step that throws and says
// nothing is the one remaining way an enrolled run ends with the deadline
// nowhere on screen.
// @ref LLP 0188#never-silent [tests]: even the unforeseen exit states the hold
test('an unforeseen throw states the hold rather than ending on nothing', async () => {
  const stdout = makeBuf()
  let firstWrite = true
  const result = await runWizardSyncNow({
    deadline: DEADLINE,
    stdout: {
      write(/** @type {string} */ chunk) {
        if (firstWrite) {
          firstWrite = false
          throw new Error('EPIPE')
        }
        return stdout.write(chunk)
      },
    },
    stderr: makeBuf(),
    env: /** @type {NodeJS.ProcessEnv} */ ({}),
    interactive: true,
    dispatchFn: /** @type {any} */ (() => {
      throw new Error('dispatch must not be reached')
    }),
    readDeadline: async () => DEADLINE,
  })
  assert.deepEqual(result, { asked: false, reason: 'error' })
  assert.match(stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
})

// @ref LLP 0203#child-process [tests]: reload through dispatch without the wizard's kernel
test('sync dispatch receives the live streams and environment, without a stale kernel', async () => {
  const o = opts({ readDeadline: async () => null })
  const input = new PassThrough()
  let calls = 0
  const result = await runWizardSyncNow({
    ...o.args,
    stdin: input,
    dispatchFn: async (argv, options) => {
      calls++
      assert.deepEqual(argv, ['sync'])
      assert.equal(options?.env, o.args.env)
      assert.equal(options?.stdin, input)
      assert.equal(options?.stdout, o.stdout)
      assert.equal(options?.kernel, undefined)
      assert.equal(options?.registry, undefined)
      options?.stderr?.write('sync diagnostic\n')
      return 0
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { asked: true, released: true })
  assert.equal(o.stderr.text(), 'sync diagnostic\n')
})

test('diagnostics keep their color after the terminal echoes a sync answer', async () => {
  const sink = Object.assign(makeBuf(), { isTTY: true })
  const o = opts({ dispatchFn: async (_argv, options) => {
    options.stderr.write('Send now and end the review window? [Y/n] ')
    options.stderr.write('hyp sync: export failed\n')
    return 1
  } })
  await runWizardSyncNow({ ...o.args, stderr: colorizeStderr(sink, {}) })
  assert.equal(sink.text(),
    `Send now and end the review window? [Y/n] ${ANSI.red}hyp sync:${ANSI.reset} export failed\n`)
})

for (const scenario of [
  { code: 0, hold: DEADLINE, reason: 'sync-declined' },
  { code: 1, hold: DEADLINE, reason: 'sync-failed' },
  { code: 0, hold: null, reason: undefined },
  { code: 1, hold: null, reason: undefined },
  { code: SYNC_HELD_NO_DESTINATIONS_EXIT, hold: DEADLINE, reason: 'no-destinations' },
  { code: SYNC_HELD_NO_DESTINATIONS_EXIT, hold: null, reason: 'no-destinations' },
]) {
  test(`sync return ${scenario.code}, hold ${scenario.hold}: ${scenario.reason ?? 'released'}`, async () => {
    const o = opts({ dispatchFn: async () => scenario.code, readDeadline: async () => scenario.hold })
    const result = await runWizardSyncNow(o.args)
    assert.deepEqual(result, scenario.reason
      ? { asked: true, released: false, reason: scenario.reason }
      : { asked: true, released: true })
    if (scenario.reason === 'no-destinations') assert.match(o.stdout.text(), /no destinations are configured/)
    if (scenario.reason === 'sync-failed') assert.match(o.stdout.text(), /Nothing has been uploaded yet/)
    if (scenario.reason === 'sync-declined') assert.match(o.stdout.text(), /Nothing was sent/)
  })
}

test('an unreadable hold is never reported as released', async () => {
  const o = opts({ dispatchFn: async () => 0, readDeadline: async () => { throw new Error('EACCES') } })
  assert.deepEqual(await runWizardSyncNow(o.args), { asked: true, released: false, reason: 'sync-declined' })
})

test('a boot failure preserves the completed install and narrates the hold', async () => {
  const o = opts({ dispatchFn: async () => { throw new Error('invalid config') } })
  assert.deepEqual(await runWizardSyncNow(o.args), { asked: false, reason: 'error' })
  assert.match(o.stderr.text(), /Could not run hyp sync: invalid config/)
  assert.match(o.stdout.text(), /Nothing has been uploaded yet/)
})

for (const release of [false, true]) {
  test(`reads the actual hold marker after sync (release=${release})`, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-sync-now-'))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const stateDir = path.join(home, 'hypaware')
    await fs.mkdir(stateDir, { recursive: true })
    const deadline = await writeFirstSyncHoldMarker({ stateDir })
    const o = opts({ deadline })
    const result = await runWizardSyncNow({
      ...o.args,
      env: { HYP_HOME: home },
      readDeadline: undefined,
      dispatchFn: async () => {
        if (release) await fs.rm(firstSyncHoldMarkerPath(stateDir))
        return 0
      },
    })
    assert.deepEqual(result, release
      ? { asked: true, released: true }
      : { asked: true, released: false, reason: 'sync-declined' })
  })
}

// @ref LLP 0203#child-process [tests]: the production path reads newly written config and runs sync's actual confirmation
for (const answer of ['n', 'y']) {
  test(`loads changed configuration in-process and honors the real ${answer} answer`, { timeout: 15000 }, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-sync-config-'))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const stateDir = path.join(home, 'hypaware')
    await fs.mkdir(stateDir, { recursive: true })
    const deadline = await writeFirstSyncHoldMarker({ stateDir })
    const configPath = path.join(home, 'hypaware-config.json')
    const env = { HYP_HOME: home, HYP_CONFIG: configPath, HYP_DEV_TELEMETRY: '1', NO_COLOR: '1' }
    const rawModes = []
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode(/** @type {boolean} */ enabled) { rawModes.push(enabled) },
    })
    t.after(() => stdin.destroy())
    const stdout = Object.assign(makeBuf(), { isTTY: true })
    const stderr = makeBuf()
    let questions = 0
    const args = {
      deadline, env, stdin, stdout,
      stderr: Object.assign(new Writable({
        write(chunk, _encoding, done) {
          const text = String(chunk)
          stderr.write(text)
          if (text.includes('Send now and end the review window?')) {
            questions++
            setImmediate(() => stdin.write(`${answer}\n`))
          }
          done()
        },
      }), { isTTY: true }),
    }
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }))
    assert.deepEqual(await runWizardSyncNow(args), { asked: true, released: false, reason: 'no-destinations' })
    assert.equal(questions, 0)
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/local-fs' }, { name: '@hypaware/format-jsonl' }],
      sinks: { fresh_archive: { writer: '@hypaware/format-jsonl', destination: '@hypaware/local-fs', config: { dir: path.join(home, 'exports') } } },
    }))
    const result = await runWizardSyncNow(args)
    assert.doesNotMatch(stderr.text(), /not materialized/, stderr.text())
    assert.deepEqual(result, answer === 'y'
      ? { asked: true, released: true }
      : { asked: true, released: false, reason: 'sync-declined' })
    // A terminal-mode readline consumes Ctrl+C as a declined answer. The
    // previous piped prompt kept canonical mode, so the OS delivered SIGINT.
    assert.deepEqual(rawModes, [], 'onboarding sync must leave terminal signal handling intact')
    assert.equal(questions, 1, stderr.text())
    assert.match(stdout.text(), /fresh_archive/)
    assert.doesNotMatch(stderr.text(), /not materialized/)
  })
}
