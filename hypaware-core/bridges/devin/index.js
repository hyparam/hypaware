#!/usr/bin/env node
// @ts-check

import { parseArgs } from 'node:util'
import { captureSession } from './capture.js'
import { installObservability } from '../../../src/core/observability/index.js'

const obs = installObservability()
try {
  const { values } = parseArgs({ options: {
    org: { type: 'string' }, session: { type: 'string' }, state: { type: 'string' },
    endpoint: { type: 'string', default: 'http://127.0.0.1:4318/v1/logs' },
    watch: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } })
  if (values.help) {
    process.stdout.write('Usage: DEVIN_API_KEY=<local env> node hypaware-core/bridges/devin/index.js --org org-... --session devin-... --state /private/path/checkpoint.json [--endpoint http://127.0.0.1:4318/v1/logs] [--watch]\n')
  } else {
    if (!values.org || !values.session || !values.state) throw new Error('required: --org --session --state')
    const result = await captureSession({ orgId: values.org, sessionId: values.session,
      token: process.env.DEVIN_API_KEY ?? '', statePath: values.state, endpoint: values.endpoint, watch: values.watch })
    process.stdout.write(JSON.stringify(result) + '\n')
  }
} catch (error) {
  // Only our fixed diagnostic codes are safe to print; parseArgs and filesystem
  // messages may quote arguments, paths or content supplied by an operator.
  const message = error instanceof Error ? error.message : ''
  const safe = /^[a-zA-Z0-9_ :.-]+$/.test(message) && message.length < 160 ? message : 'bridge_failed'
  process.stderr.write(`devin bridge: ${safe}\n`)
  process.exitCode = 1
} finally { await obs.shutdown() }
