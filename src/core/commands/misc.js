// @ts-check

import { createRequire } from 'node:module'
import process from 'node:process'

import { parseCoreCommandArgv } from '../cli/command_args.js'
import { readObservabilityEnv } from '../observability/env.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runVersion(argv, ctx) {
  const parsed = parseCoreCommandArgv('version', argv, ctx)
  if (!parsed.ok) return parsed.code
  const info = versionInfo(ctx.env)
  ctx.stdout.write(`hypaware ${info.version}\n`)
  ctx.stdout.write(`  node:     ${info.node}\n`)
  ctx.stdout.write(`  platform: ${info.platform} ${info.arch}\n`)
  ctx.stdout.write(`  hyp_home: ${info.hypHome}\n`)
  return 0
}

/**
 * The environment `hyp version` reports, shared with `hyp status` so the two
 * never disagree about which install answered.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ version: string, node: string, platform: string, arch: string, hypHome: string }}
 */
export function versionInfo(env) {
  const require = createRequire(import.meta.url)
  const { version } = require('../../../package.json')
  const { hypHome } = readObservabilityEnv(env)
  return { version, node: process.version, platform: process.platform, arch: process.arch, hypHome }
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
