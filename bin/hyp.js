#!/usr/bin/env node
// @ts-check

// Phase 0 `hyp` CLI stub. Only `hyp smoke <flow>` is wired; real
// subcommand dispatch lives in Phase 3 (registry-driven). Until then,
// this file lets `npm install` link `hyp` into PATH so the smoke
// harness is reachable both as `npm run smoke` and `hyp smoke`.

import process from 'node:process'

const [cmd, ...rest] = process.argv.slice(2)

if (cmd !== 'smoke') {
  process.stderr.write('hyp: only `smoke` is implemented in Phase 0\n')
  process.stderr.write('usage: hyp smoke <flow-name>\n')
  process.exit(2)
}

const name = rest[0]
if (!name) {
  process.stderr.write('usage: hyp smoke <flow-name>\n')
  process.exit(2)
}

const { runFlow } = await import('../hypaware-core/smoke/lib/harness.js')

try {
  const harness = await runFlow(name)
  process.stdout.write(`smoke ${name}: ok (dev_run_id=${harness.devRunId})\n`)
  process.exit(0)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`smoke ${name}: FAIL\n${message}\n`)
  // @ts-ignore — expect attaches a detail line for re-runs
  if (err && err.detail) process.stderr.write(`  ${err.detail}\n`)
  process.exit(1)
}
