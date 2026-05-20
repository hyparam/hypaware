#!/usr/bin/env node
// @ts-check

import process from 'node:process'

import { runFlow } from './lib/harness.js'

const flowName = process.argv[2]
if (!flowName) {
  process.stderr.write('usage: hyp smoke <flow-name>\n')
  process.exit(2)
}

try {
  const harness = await runFlow(flowName)
  process.stdout.write(`smoke ${flowName}: ok (dev_run_id=${harness.devRunId})\n`)
  process.exit(0)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`smoke ${flowName}: FAIL\n${message}\n`)
  // @ts-ignore — `expect` errors attach a `detail` line
  if (err && err.detail) process.stderr.write(`  ${err.detail}\n`)
  process.exit(1)
}
