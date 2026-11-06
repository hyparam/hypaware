// @ts-check

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { rmSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { isolatedClientEnv } from './isolation.js'
import { makeExpect } from './expect.js'

/**
 * Run a named smoke flow under a fresh tmp `HYP_HOME`. Implements the
 * Smoke Harness contract from `hypaware-implementation-plan.md`:
 *
 * - Computes `DEV_RUN_ID=smoke-<name>-<utc>-<pid>` and sets the
 *   `HYP_DEV_TELEMETRY=1`, `OTEL_SERVICE_NAME=hypaware-dev`, and
 *   `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=development,dev_run_id=...`
 *   env vars before importing the flow.
 * - Brings up a transient install rooted at the tmpdir so the smoke
 *   never touches `~/.hyp`.
 * - Dynamically imports `hypaware-core/smoke/flows/<name>.js` and
 *   invokes its exported `run({ harness, expect })`.
 *
 * The harness intentionally does not auto-shutdown observability.
 * Each flow flushes via `installObservability().shutdown()` once it
 * has emitted everything it needs to assert against.
 *
 * The smoke owns its temp files: `TMPDIR`/`TMP`/`TEMP` point at a child
 * of the harness root, so plugin boot dirs land there. That child is
 * reclaimed on every exit, a crash included. The harness root goes too
 * on a pass; a failure keeps it, because the failure message points at
 * its dev telemetry.
 *
 * @param {string} name
 */
export async function runFlow(name) {
  const flowsDir = path.resolve(import.meta.dirname, '..', 'flows')
  const flowPath = path.join(flowsDir, `${name}.js`)
  try {
    await fs.stat(flowPath)
  } catch {
    throw new Error(`smoke flow not found: ${flowPath}`)
  }

  const utc = new Date().toISOString().replace(/[:.]/g, '-')
  const runId = `smoke-${name}-${utc}-${process.pid}`
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-smoke-${name}-`))
  const hypHome = path.join(tmpDir, '.hyp')
  await fs.mkdir(hypHome, { recursive: true })

  const homeDir = path.join(tmpDir, 'home')
  await fs.mkdir(homeDir, { recursive: true })
  const tempRoot = path.join(tmpDir, 'tmp')
  await fs.mkdir(tempRoot)
  // Synchronous because it also runs from `exit`, which a crash or a
  // flow's own process.exit reaches without unwinding back to here.
  const reclaimTemp = () => reclaim(tempRoot)
  process.once('exit', reclaimTemp)

  const isolated = { ...isolatedClientEnv(process.env, homeDir), TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot }
  for (const key of Object.keys(process.env)) {
    if (!(key in isolated)) delete process.env[key]
  }
  Object.assign(process.env, isolated)

  process.env.DEV_RUN_ID = runId
  process.env.HYP_DEV_TELEMETRY = '1'
  process.env.OTEL_SERVICE_NAME = 'hypaware-dev'
  process.env.HYP_HOME = hypHome
  process.env.OTEL_RESOURCE_ATTRIBUTES = [
    'deployment.environment=development',
    `dev_run_id=${runId}`,
  ].join(',')

  const telemetryDir = path.join(hypHome, 'hypaware', 'dev-telemetry')
  const expect = makeExpect({ telemetryDir, runId, smokeName: name })

  let passed = false
  try {
    const flowUrl = pathToFileURL(flowPath).href
    const mod = await import(flowUrl)
    if (typeof mod.run !== 'function') {
      throw new Error(`smoke flow ${name}: missing exported run() function`)
    }

    const harness = {
      devRunId: runId,
      smokeName: name,
      hypHome,
      stateDir: path.join(hypHome, 'hypaware'),
      telemetryDir,
      tmpDir,
    }
    await mod.run({ harness, expect })
    passed = true
    return harness
  } finally {
    process.removeListener('exit', reclaimTemp)
    reclaim(passed ? tmpDir : tempRoot)
  }
}

/**
 * Best effort, like the test runner's temp root: a leftover a flow made
 * unremovable is reported, never turned into a smoke failure.
 *
 * @param {string} dir
 */
function reclaim(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch (err) {
    process.stderr.write(`could not remove the smoke temp dir ${dir}: ${/** @type {Error} */ (err).message}\n`)
  }
}
