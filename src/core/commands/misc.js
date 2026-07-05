// @ts-check

import { createRequire } from 'node:module'
import process from 'node:process'

import { readObservabilityEnv } from '../observability/env.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
export async function runVersion(_argv, ctx) {
  const require = createRequire(import.meta.url)
  const { version } = require('../../../package.json')
  const { hypHome } = readObservabilityEnv(ctx.env)
  ctx.stdout.write(`hypaware ${version}\n`)
  ctx.stdout.write(`  node:     ${process.version}\n`)
  ctx.stdout.write(`  platform: ${process.platform} ${process.arch}\n`)
  ctx.stdout.write(`  hyp_home: ${hypHome}\n`)
  return 0
}

/**
 * `hyp smoke <flow>`: internal developer command.
 *
 * The smoke harness owns a fresh tmp `HYP_HOME` and installs its own
 * observability against that tmpdir. Installing observability in the
 * parent dispatch (which is required to emit `command.run` for this
 * invocation) would lock the tracer to the parent's `HYP_HOME` before
 * the harness can swap it. We resolve that by spawning a subprocess
 * dedicated to the flow: the parent emits its `command.run` span, the
 * child boots a clean observability instance against the harness
 * tmpdir, and the child's exit code is propagated back.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runSmoke(argv, ctx) {
  const flow = argv[0]
  if (!flow) {
    ctx.stderr.write('usage: hyp smoke <flow-name>\n')
    return 2
  }
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const binPath = fileURLToPath(new URL('../../../bin/hypaware.js', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [binPath, '__smoke_internal', flow],
    {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: ctx.env,
      cwd: ctx.cwd,
    }
  )
  if (result.error) {
    ctx.stderr.write(`hyp smoke: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}
