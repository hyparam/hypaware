// @ts-check

// A bootstrap import failure is the one error the CLI reports from outside
// dispatch: the outer catch in `bin/hypaware.js` is there so the
// invocation-counting wrapper still records a failed invocation, which is why
// the same catch has to carry the stack a broken install is diagnosed from
// (hyparam/hypaware#1500).
//
// The import is broken from outside the tree, by a `node:module` load hook in
// an `--import` bootstrap, so nothing in the checkout is touched and the one
// run can also read the telemetry outbox to prove the accounting.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as nodeModule from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createOutbox } from '../../src/core/product_telemetry/outbox.js'
import { productRoot, writePolicy } from '../../src/core/product_telemetry/policy.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'hypaware.js')

// `dispatch.js` is the first module the callback pulls in, and the one the
// issue names. `cause` is set so the chain has a second link to lose.
const INJECTOR = `
import { registerHooks } from 'node:module'

registerHooks({
  load (url, context, next) {
    if (url.endsWith('/src/core/cli/dispatch.js')) {
      throw new Error('injected dispatch load failure', {
        cause: new Error('injected root cause')
      })
    }
    return next(url, context)
  }
})
`

test('a bootstrap import failure reports its stack and cause, and still counts as a failed invocation', async (t) => {
  if (typeof nodeModule.registerHooks !== 'function') {
    // Node's synchronous load hook lands in 22.15 and the package floor is
    // 22.12, so an older supported runtime skips rather than fails.
    return t.skip('node:module registerHooks is unavailable on this runtime')
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-import-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const injector = path.join(root, 'injector.mjs')
  await fs.writeFile(injector, INJECTOR)

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

  const run = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(injector).href, BIN, 'status'],
    { encoding: 'utf8', env, timeout: 60000 }
  )
  // A spawn that never ran, or one the timeout killed, leaves `status` null and
  // the assertions below would blame the CLI for the harness.
  assert.ifError(run.error)

  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stderr, /hyp: Error: injected dispatch load failure/)
  // The regression: a stack frame, not only the message. `\n at` rather than a
  // bare `at`, because a message can contain the word.
  assert.match(run.stderr, /\n\s+at /, 'the bootstrap failure printed no stack frames')
  assert.match(run.stderr, /\ncaused by: Error: injected root cause/, 'the cause chain was dropped')

  // And why the catch cannot simply be removed: the invocation is still
  // accounted for, once, as a nonzero failure.
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
})
