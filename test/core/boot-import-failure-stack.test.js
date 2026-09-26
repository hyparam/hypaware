// @ts-check

// A bootstrap import failure is the one error the CLI reports from outside
// dispatch: the outer catch in `bin/hypaware.js` is there so the
// invocation-counting wrapper still records a failed invocation, which is why
// the same catch has to carry the stack a broken install is diagnosed from
// (hyparam/hypaware#1500) and has to flush it before `process.exit`
// (hyparam/hypaware#2193).
//
// The import is broken from outside the tree, by a `node:module` load hook in
// an `--import` bootstrap, so nothing in the checkout is touched and the one
// run can also read the telemetry outbox to prove the accounting.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as nodeModule from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createOutbox } from '../../src/core/product_telemetry/outbox.js'
import { productRoot, writePolicy } from '../../src/core/product_telemetry/policy.js'

/** @import { TestContext } from 'node:test' */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'hypaware.js')

/**
 * `dispatch.js` is the first module the callback pulls in, and the one the
 * issue names. `cause` is set so the chain has a second link to lose. `pad`
 * pads the message, so a caller can put the report either side of the pipe
 * buffer past which an unflushed `process.exit` drops bytes.
 *
 * @param {number} pad
 * @returns {string}
 */
function injectorSource(pad) {
  return `
import { registerHooks } from 'node:module'

registerHooks({
  load (url, context, next) {
    if (url.endsWith('/src/core/cli/dispatch.js')) {
      throw new Error('injected dispatch load failure' + 'X'.repeat(${pad}), {
        cause: new Error('injected root cause')
      })
    }
    return next(url, context)
  }
})
`
}

/**
 * The argv and environment that boot the CLI with that import broken, against a
 * temp `HYP_HOME` whose outbox the caller reads back.
 *
 * @param {TestContext} t
 * @param {number} pad
 */
async function brokenBoot(t, pad) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-import-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const injector = path.join(root, 'injector.mjs')
  await fs.writeFile(injector, injectorSource(pad))

  /** @type {Record<string,string|undefined>} */
  const env = { ...process.env, HYP_HOME: path.join(root, 'home') }
  // Local collection is the footing where the wrapper enters its async boundary
  // and writes the invocation record; the dev-telemetry and OTLP variables are
  // stripped so the child carries no exporter of the parent's.
  delete env.HYP_DEV_TELEMETRY
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.DEV_RUN_ID
  const outbox = productRoot(env)
  writePolicy(outbox, 'local')

  return {
    args: ['--import', pathToFileURL(injector).href, BIN, 'status'],
    env,
    outbox
  }
}

/**
 * One failed invocation, plus the coded startup failure behind it: why the
 * catch cannot simply be removed, and what flushing must not cost.
 *
 * @param {string} outbox
 */
function assertOneFailedInvocation(outbox) {
  const records = createOutbox(outbox)
    .entries()
    .flatMap((entry) => JSON.parse(entry.wire).records)
  const invocations = records.filter((record) => record.name === 'cli.invocation')
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].attributes.outcome, 'failure')
  assert.equal(invocations[0].attributes.exit_class, 'nonzero')
  assert.equal(
    records.some(
      (record) =>
        record.name === 'coded.failure' &&
        record.attributes.error_code === 'startup_failed'
    ),
    true
  )
}

test('a bootstrap import failure reports its stack and cause, and still counts as a failed invocation', async (t) => {
  if (typeof nodeModule.registerHooks !== 'function') {
    // Node's synchronous load hook lands in 22.15 and the package floor is
    // 22.12, so an older supported runtime skips rather than fails.
    return t.skip('node:module registerHooks is unavailable on this runtime')
  }
  const { args, env, outbox } = await brokenBoot(t, 0)
  const run = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env,
    timeout: 60000
  })
  // A spawn that never ran, or one the timeout killed, leaves `status` null and
  // the assertions below would blame the CLI for the harness.
  assert.ifError(run.error)

  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stderr, /hyp: Error: injected dispatch load failure/)
  // The regression: a stack frame, not only the message. `\n at` rather than a
  // bare `at`, because a message can contain the word.
  assert.match(run.stderr, /\n\s+at /, 'the bootstrap failure printed no stack frames')
  assert.match(run.stderr, /\ncaused by: Error: injected root cause\n\s+at /, 'the cause chain was dropped')

  assertOneFailedInvocation(outbox)
})

// Past the pipe buffer, a catch that returned without flushing cost the report
// outright: the reader below saw the first pipeful and nothing after it.
const PAD = 200000

test('a bootstrap import failure larger than the pipe buffer reaches a piped reader whole', async (t) => {
  if (typeof nodeModule.registerHooks !== 'function') {
    return t.skip('node:module registerHooks is unavailable on this runtime')
  }
  const { args, env, outbox } = await brokenBoot(t, PAD)

  const child = spawn(process.execPath, args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const chunks = []
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const closed = new Promise((resolve) => child.once('close', resolve))
  // Nothing is read until the child exits, because a reader that keeps draining
  // makes room in the pipe and hides the loss. An unflushed child exits in
  // milliseconds; a flushing one waits for this reader, so the grace period is
  // only there to keep that from deadlocking, and firing it early would read
  // more rather than fail.
  await Promise.race([exited, delay(1000, null, { ref: false })])
  child.stderr.on('data', (chunk) => chunks.push(chunk))

  assert.equal(await closed, 1)
  const report = Buffer.concat(chunks)
  assert.ok(
    report.length > PAD,
    `stderr stopped at ${report.length} bytes of a report longer than ${PAD}`
  )
  // Truncation falls inside the padding, so the tail of the chain proves the
  // whole report arrived, not only that the byte count grew.
  assert.match(report.toString('utf8'), /\ncaused by: Error: injected root cause\n\s+at /)

  assertOneFailedInvocation(outbox)
})
