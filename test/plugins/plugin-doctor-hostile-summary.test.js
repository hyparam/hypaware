// @ts-check

/**
 * `hyp plugin doctor` carries into `RegisteredSnapshot` only values of the type
 * the snapshot declares (issue #1557).
 *
 * The guards from issue #1538 contain the doctor's plugin-controlled *reads*: a
 * `summary` accessor that throws costs one entry rather than the run. They do
 * not contain the *value* a guarded read captures. `readCommands` stored
 * whatever `record.summary` answered into `commandDetails[].summary`, typed
 * `string` and never checked, and `checkCommandHelp` interpolates it one module
 * downstream, outside every catch the dry run holds. An object whose `toString`
 * throws detonated there and took the whole run down over one plugin; one that
 * renders put a wording no registry holds into the report.
 *
 * These drive the real `diagnosePlugin`, not `dryRunActivate` alone: the defect
 * lives in the seam between the two modules, and a test that stops at the
 * snapshot never reaches the interpolation.
 *
 * Every hostile fixture installs its accessor with
 * `Object.defineProperties(base, Object.getOwnPropertyDescriptors(over))` AFTER
 * `register` has validated the honest string, onto the record the registry
 * stored, so the live getter is the one the snapshot reads. The read counters
 * say the accessor was reached at all: a spread copy would leave the registry's
 * record untouched and `Object.assign` would leave a plain string, and either
 * way the count reads zero and the assertion fails.
 *
 * @ref LLP 0267#consequences [tests]: the snapshot is what the doctor's checks read, so a value in it that is not the type it declares is a finding the report cannot render
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { diagnosePlugin } from '../../src/core/plugin_doctor/diagnose.js'
import { stderrTextFrom } from '../helpers/stderr_lines.js'

/**
 * @import { DoctorReport } from '../../src/core/plugin_doctor/types.js'
 */

const PLUGIN = '@test/hostile-summary'

/** The token the guard's structured report carries. */
const REFUSAL = 'unregistered_contribution_name'

/**
 * Counters the fixtures write and the assertions read. A fixture is imported
 * into this same process, so the probe is shared through the global rather
 * than through a file.
 *
 * @type {{ summaryReads: number }}
 */
const probe = { summaryReads: 0 }
// @ts-ignore - the fixtures reach it by this name
globalThis.__doctorSummaryProbe = probe

/**
 * Diagnose one fixture plugin and return the report beside whatever the guard
 * wrote to stderr.
 *
 * @param {object} args
 * @param {Record<string, unknown>} args.manifest
 * @param {string} args.index Contents of the fixture's `src/index.js`.
 * @returns {Promise<{ report: DoctorReport, stderr: string }>}
 */
async function diagnose({ manifest, index }) {
  probe.summaryReads = 0
  // A fresh directory per fixture: the dry run loads the entrypoint with
  // dynamic `import()`, which caches by resolved URL.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-summary-'))
  await fs.writeFile(path.join(root, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'index.js'), index)
  /** @type {DoctorReport | undefined} */
  let report
  const stderr = await stderrTextFrom(async () => {
    report = await diagnosePlugin(root)
  })
  assert.ok(report, 'diagnosePlugin returned nothing')
  return { report, stderr }
}

/** @param {Record<string, unknown>} [overrides] */
function manifestFor(overrides = {}) {
  return {
    schema_version: 1,
    name: PLUGIN,
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    ...overrides,
  }
}

/**
 * The fixture preamble: a live `summary` getter that counts its reads and
 * answers with whatever `expr` evaluates to, installed onto an
 * already-registered record.
 *
 * @param {string} expr A JavaScript expression, evaluated on every read.
 */
function driftingSummary(expr) {
  return (
    `const probe = globalThis.__doctorSummaryProbe\n` +
    `function drift(record) {\n` +
    `  const over = { get summary() { probe.summaryReads += 1; return ${expr} } }\n` +
    `  Object.defineProperties(record, Object.getOwnPropertyDescriptors(over))\n` +
    `}\n`
  )
}

test('a summary whose toString throws costs the command one entry, not the whole doctor run', async () => {
  // The issue's repro: the value leaves the contained read in `readCommands`
  // and reaches `checkCommandHelp`'s template literal, one module past every
  // catch the dry run holds.
  const { report, stderr } = await diagnose({
    manifest: manifestFor({ contributes: { commands: [{ name: 'hs cmd' }, { name: 'hs honest', summary: 'kept' }] } }),
    index:
      driftingSummary(`{ toString() { throw new Error('boom from summary toString') } }`) +
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'hs honest', plugin: '${PLUGIN}', summary: 'kept', usage: 'u', run })\n` +
      `  ctx.commands.register({ name: 'hs cmd', plugin: '${PLUGIN}', summary: 'honest at register time', usage: 'u', run })\n` +
      `  drift(ctx.commands.get('hs cmd'))\n` +
      `}\n`,
  })
  assert.equal(probe.summaryReads, 1, 'the drifting accessor was never live: the fixture is vacuous')
  // The refused command is reported as unregistered, which is the honest
  // degraded answer: the doctor cannot vouch for what it registered.
  assert.deepEqual(
    report.diagnostics.filter((d) => d.kind === 'contribution_not_registered').map((d) => d.message),
    [`manifest declares command 'hs cmd' but activate() never registered it`]
  )
  // The neighbour is untouched, and its own drift finding still renders.
  assert.deepEqual(report.diagnostics.filter((d) => d.kind === 'command_help_drift'), [])
  assert.equal(report.ok, false)
  assert.match(stderr, new RegExp(REFUSAL))
})

test('a summary that stops being a string is refused too, though it never throws', async () => {
  // `checkCommandHelp` compares `declaredSummary !== command.summary`, so a
  // non-string always mismatches and always reaches the interpolation. Rendering
  // without throwing is the worse half: the report then reads as a well-formed
  // finding quoting a summary no registry holds.
  const { report, stderr } = await diagnose({
    manifest: manifestFor({ contributes: { commands: [{ name: 'hs cmd', summary: 'declared' }] } }),
    index:
      driftingSummary(`42`) +
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'hs cmd', plugin: '${PLUGIN}', summary: 'declared', usage: 'u', run })\n` +
      `  drift(ctx.commands.get('hs cmd'))\n` +
      `}\n`,
  })
  assert.equal(probe.summaryReads, 1, 'the drifting accessor was never live: the fixture is vacuous')
  assert.deepEqual(report.diagnostics.filter((d) => d.kind === 'command_help_drift'), [])
  assert.deepEqual(
    report.diagnostics.filter((d) => d.kind === 'contribution_not_registered').map((d) => d.message),
    [`manifest declares command 'hs cmd' but activate() never registered it`]
  )
  assert.match(stderr, new RegExp(REFUSAL))
})

test('the summary refusal is observable, structured, and names the command it cost', async () => {
  const { stderr } = await diagnose({
    manifest: manifestFor({ contributes: { commands: [{ name: 'hs cmd' }] } }),
    index:
      driftingSummary(`{ toString() { throw new Error('boom from summary toString') } }`) +
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'hs cmd', plugin: '${PLUGIN}', summary: 'honest at register time', usage: 'u', run })\n` +
      `  drift(ctx.commands.get('hs cmd'))\n` +
      `}\n`,
  })
  const line = stderr.split('\n').find((l) => l.includes(REFUSAL))
  assert.ok(line, `no refusal on stderr:\n${stderr}`)
  assert.match(line, /\[hypaware:plugin-doctor\] WARN/)
  assert.match(line, /"hyp_operation":"doctor\.snapshot"/)
  assert.match(line, /"status":"degraded"/)
  assert.match(line, /"contribution_kind":"command"/)
  assert.match(line, /"claimed_name":"hs cmd"/)
  // The name read back fine and the accessor never threw. Either of the two
  // clauses already here would be false about this record.
  assert.match(line, /is not the string it registered/)
})

test('a group summary that stops being a string is refused at the same boundary', async () => {
  // `commandGroups[].summary` is captured by the same one guarded read and
  // typed `string` by the same interface. No check reads it today, so it is
  // the identical hole one field over rather than a second live crash.
  const { report, stderr } = await diagnose({
    manifest: manifestFor({ contributes: { commands: [{ name: 'hs cmd', summary: 'declared' }] } }),
    index:
      driftingSummary(`{ toString() { throw new Error('boom from group summary') } }`) +
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'hs cmd', plugin: '${PLUGIN}', summary: 'declared', usage: 'u', run })\n` +
      `  const group = { name: 'hs', plugin: '${PLUGIN}', summary: 'honest at register time' }\n` +
      `  ctx.commands.registerGroup(group)\n` +
      `  drift(group)\n` +
      `}\n`,
  })
  assert.equal(probe.summaryReads, 1, 'the drifting accessor was never live: the fixture is vacuous')
  // The group row is gone, so the group warning does not fire, and the command
  // under it is untouched.
  assert.deepEqual(report.diagnostics, [])
  assert.equal(report.ok, true)
  assert.match(stderr, new RegExp(REFUSAL))
  assert.match(stderr, /"contribution_kind":"command group"/)
})

test('an honest plugin reports exactly what it did before', async () => {
  // The byte-identical half: the refusal may not cost an honest registration
  // anything, and the drift finding still quotes the registered wording.
  const { report, stderr } = await diagnose({
    manifest: manifestFor({ contributes: { commands: [{ name: 'hs cmd' }, { name: 'hs other', summary: 'declared' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'hs cmd', plugin: '${PLUGIN}', summary: 'registered wording', usage: 'u', run })\n` +
      `  ctx.commands.register({ name: 'hs other', plugin: '${PLUGIN}', summary: 'a different wording', usage: 'u', run })\n` +
      `  ctx.commands.registerGroup({ name: 'hs', plugin: '${PLUGIN}', summary: 'the hs group' })\n` +
      `}\n`,
  })
  assert.equal(stderr.includes(REFUSAL), false, `an honest plugin tripped the guard:\n${stderr}`)
  assert.deepEqual(report.diagnostics.map((d) => ({ kind: d.kind, message: d.message })), [
    {
      kind: 'command_help_drift',
      message:
        `command 'hs cmd' has no summary in the manifest, but activate() registers ` +
        `'registered wording': top-level help lists the command with no description`,
    },
    {
      kind: 'command_help_drift',
      message:
        `command 'hs other' has two different summaries: the manifest says ` +
        `'declared' and activate() registers 'a different wording'`,
    },
  ])
  assert.equal(report.ok, false)
})

test('an empty summary is a value, not an absence, and still reports its drift', async () => {
  // `register` accepts the empty string, and `checkCommandHelp`'s blank branch
  // keys off the *manifest* side. A refusal written as a truthiness check
  // would drop this registration and lose the finding.
  const { report, stderr } = await diagnose({
    manifest: manifestFor({ contributes: { commands: [{ name: 'hs cmd', summary: 'declared' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'hs cmd', plugin: '${PLUGIN}', summary: '', usage: 'u', run })\n` +
      `}\n`,
  })
  assert.equal(stderr.includes(REFUSAL), false, `an empty summary tripped the guard:\n${stderr}`)
  assert.deepEqual(
    report.diagnostics.map((d) => d.message),
    [`command 'hs cmd' has two different summaries: the manifest says 'declared' and activate() registers ''`]
  )
})
