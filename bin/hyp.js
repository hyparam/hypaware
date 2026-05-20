#!/usr/bin/env node
// @ts-check

import process from 'node:process'

const argv = process.argv.slice(2)

// `hyp smoke <flow>` runs the smoke harness directly. It bypasses the
// command dispatcher because each smoke owns its own observability
// lifecycle (DEV_RUN_ID, HYP_HOME, and exporters set up by the harness
// against a fresh tmpdir). Routing it through the dispatcher would lock
// the tracer to the parent process's HYP_HOME before the harness can
// change it.
if (argv[0] === 'smoke') {
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

process.exit(exitCode)
