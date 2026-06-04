#!/usr/bin/env node
// @ts-check

import process from 'node:process'

const argv = process.argv.slice(2)

// `__smoke_internal <flow>` is the in-process entry the registered
// `smoke` command re-execs us with. It bypasses the dispatcher because
// each smoke owns its own observability lifecycle (DEV_RUN_ID,
// HYP_HOME, and exporters set up by the harness against a fresh
// tmpdir). Routing it through the dispatcher would lock the tracer to
// the parent process's HYP_HOME before the harness can change it.
//
// Users never type `__smoke_internal` directly — they run
// `hyp smoke <flow>`, which goes through the dispatcher and spawns us
// here with a clean process state.
if (argv[0] === '__smoke_internal') {
  const flow = argv[1]
  if (!flow) {
    process.stderr.write('usage: hyp smoke <flow-name>\n')
    process.exit(2)
  }
  try {
    const { runFlow } = await import('../hypaware-core/smoke/lib/harness.js')
    const harness = await runFlow(flow)
    process.stdout.write(`smoke ${flow}: ok (dev_run_id=${harness.devRunId})\n`)
    process.exit(0)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`smoke ${flow}: FAIL\n${message}\n`)
    const detail = err && /** @type {{ detail?: string }} */ (err).detail
    if (typeof detail === 'string') process.stderr.write(`  ${detail}\n`)
    process.exit(1)
  }
}

const { dispatch } = await import('../src/core/cli/dispatch.js')
const { installObservability } = await import('../src/core/observability/index.js')

const obs = installObservability()
let exitCode = 1
try {
  exitCode = await dispatch(argv)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`hyp: ${message}\n`)
  exitCode = 1
} finally {
  await obs.shutdown()
}

// `process.exit()` terminates synchronously and drops whatever is still
// buffered in stdout/stderr — for a pipe that means output past the
// ~64KiB pipe buffer is silently truncated (large `query sql` results,
// JSON dumps). Flush both streams before exiting so every byte reaches
// the OS first. (Writing to a file never hit this because file writes
// complete synchronously.)
await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
process.exit(exitCode)

/**
 * Resolve once a writable stream has drained its buffered output. Resolves
 * immediately when nothing is pending, and on `error` (e.g. EPIPE when the
 * reader has gone away) so exit is never blocked.
 *
 * @param {import('node:stream').Writable} stream
 * @returns {Promise<void>}
 */
function flushStream(stream) {
  return new Promise((resolve) => {
    if (stream.writableLength === 0) {
      resolve()
      return
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    stream.once('error', finish)
    // The write callback fires after this (empty) chunk and all preceding
    // buffered writes have been handed to the OS.
    stream.write('', finish)
  })
}
