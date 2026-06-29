// @ts-check

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

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
  return harness
}
