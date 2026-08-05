#!/usr/bin/env node
// @ts-check

import process from 'node:process'

import { runFlow } from './lib/harness.js'
// @ref LLP 0189#choke-point [implements]: the standalone smoke entry colours like the CLI does
import { ANSI, colorizeStderr, paint } from '../../src/core/cli/style.js'
import { useColor } from '../../src/core/cli/stdio.js'

const stderr = colorizeStderr(process.stderr, process.env)
const color = useColor(process.stderr, process.env)

const flowName = process.argv[2]
if (!flowName) {
  stderr.write('usage: hyp smoke <flow-name>\n')
  process.exit(2)
}

try {
  const harness = await runFlow(flowName)
  process.stdout.write(`smoke ${flowName}: ok (dev_run_id=${harness.devRunId})\n`)
  process.exit(0)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  stderr.write(`smoke ${flowName}: ${paint('FAIL', ANSI.red, color)}\n${message}\n`)
  // @ts-ignore: `expect` errors attach a `detail` line
  if (err && err.detail) stderr.write(`  ${err.detail}\n`)
  process.exit(1)
}
