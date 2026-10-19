// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { createOutbox } from '../../src/core/product_telemetry/outbox.js'
import { productRoot, writePolicy } from '../../src/core/product_telemetry/policy.js'

// A help flag behind a setup preset or flag (`hyp setup <preset> --help`,
// `hyp setup --yes --help`) is routed back through the central help
// interception as a nested dispatch. With product telemetry on, that used to
// record a `setup.step` and an `execution` invocation for a run that only
// printed help (#2470). These run the real CLI and compare what it recorded
// with a fixture captured from `hyp setup --help`, and from a real preset run
// before the fix, which must not move.
// @ref LLP 0009#central-help-interception [tests]: help keeps the command's name and records as help in every form

const BIN = fileURLToPath(new URL('../../bin/hypaware.js', import.meta.url))
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/setup-help-telemetry.json', import.meta.url), 'utf8'))

/**
 * Run the real CLI in a fresh HOME with local product telemetry on, and
 * return its exit code and the records it wrote, without the per-run
 * timestamp and duration.
 *
 * @param {string[]} argv
 * @returns {Promise<{ code: number, records: Record<string, any>[], output: string }>}
 */
async function recordedBy(argv) {
  const home = temporaryDirectory('hyp-setup-help-telemetry-')
  const env = { ...process.env, HOME: home, HYP_HOME: path.join(home, '.hyp') }
  for (const key of ['HYP_CONFIG', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) delete env[key]
  const root = productRoot(env)
  assert.ok(root.startsWith(home + path.sep), `telemetry root ${root} is under the test HOME`)
  writePolicy(root, 'local')
  /** @type {{ code: number, output: string }} */
  const run = await new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...argv], { cwd: home, env, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, output: `exit ${code}\n${stdout}\n${stderr}` })
    })
  })
  const records = createOutbox(root).entries()
    .flatMap((entry) => JSON.parse(entry.wire).records)
    .map(({ name, kind, attributes }) => {
      const { duration_ms: _, ...rest } = attributes
      return { name, kind, attributes: rest }
    })
  return { ...run, records }
}

test('every setup help form records what `hyp setup --help` records', { timeout: 180_000 }, async () => {
  for (const argv of [
    ['setup', '--help'],
    ['setup', 'claude-and-otel-local', '--help'],
    ['setup', '--yes', '--help'],
  ]) {
    const run = await recordedBy(argv)
    const label = argv.join(' ')
    assert.equal(run.code, 0, `${label}: ${run.output}`)
    assert.match(run.output, /usage: hyp setup \[preset\] \[flags\]/, `${label} printed setup's help`)
    assert.deepEqual(run.records, FIXTURE.help, `${label}: no setup.step, invocation_kind help`)
  }
})

test('a real preset run records what it recorded before the fix', { timeout: 60_000 }, async () => {
  const run = await recordedBy(['setup', 'claude-and-otel-local'])
  assert.equal(run.code, 0, run.output)
  assert.deepEqual(run.records, FIXTURE.preset)
})
