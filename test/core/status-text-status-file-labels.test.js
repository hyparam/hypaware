// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, statusFilePath, writeStatusFile } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions, HypAwareStatusReport } from '../../src/core/daemon/types.js' */

// `hyp status` reads `status.json` and prints it. The gateway's own details
// (`recent_entrypoints`, the idle warning's upstream names, `listen_fallback_from`)
// are cleaned on the way out, for a reason that is a property of *reading the
// file* and not of any one detail: core cannot assume the daemon that wrote it
// was this version, this build, or well behaved, and everything read there is
// about to reach a terminal.
//
// The same file also carries `state`, `mode`, and - with no runtime attached -
// every `sources[]` and `sinks[]` entry, all of which land in the text surface
// too, and a file that does not parse at all reaches it as `JSON.parse`'s
// message, which quotes an excerpt of the input back verbatim. These pin that
// none of those four routes can drive the terminal either, while `--json`
// keeps carrying the values a consumer pins and escapes for itself.
// @ref LLP 0164#status-reads-it-from-the-status-file [tests]: what core reads back out of status.json is cleaned at the last point before render, whichever field it came from

const ESC = String.fromCharCode(27)
const NL = String.fromCharCode(10)
const ZERO_WIDTH = String.fromCharCode(0x200b)
// C0, DEL and C1 - the whole range `sanitizeLabel` strips, so the assertion
// does not pin only the one sequence each case happens to drive.
const CONTROL_CHARS = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) +
  String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + ']'
)

// An erase-line sequence plus a newline: together they forge a plausible extra
// status line out of a value the operator never chose to trust.
const FORGE = ESC + '[2K' + NL + 'hyp: all good'

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-text-labels-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  // Stub the launch-agent probe so the machine's real daemon install cannot
  // leak in; liveness then comes from the pid file alone.
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/** @param {HypAwareStatusReport} report */
function renderText(report) {
  const buf = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/cache', stdout: buf })
  return buf.text()
}

test('a hostile sources/sinks snapshot cannot drive the terminal from hyp status', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  // No runtime and no configured sinks, so the report takes both lists
  // straight off the status file.
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'running',
    sources: [{ name: 'gw' + FORGE, plugin: 'p' + ESC + '[31m', state: 'started' + ESC + '[0m' }],
    sinks: [{ instance: 'sink' + FORGE, plugin: 'q' + ZERO_WIDTH, kind: 'blob' + ESC + '[0m' }],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const text = renderText(report)
  assert.ok(!CONTROL_CHARS.test(text.replace(/\n/g, '')), 'no control byte reaches the text surface')
  assert.ok(!text.includes(ZERO_WIDTH), 'and no zero-width run does either')
  // The forged newline is the whole point: one snapshot entry must stay one
  // rendered line, whatever the file put in its name.
  const sourcesBlock = text.split('  sources:' + NL)[1].split('  sinks:' + NL)[0]
  assert.equal(sourcesBlock.trimEnd().split(NL).length, 1, 'one source entry stays one line')
  assert.match(sourcesBlock, /gw/, 'and the printable part still names it')
  const sinksBlock = text.split('  sinks:' + NL)[1].split('  clients:' + NL)[0]
  assert.equal(sinksBlock.trimEnd().split(NL).length, 1, 'one sink entry stays one line')
  assert.match(sinksBlock, /sink/)

  // The machine surface is a contract a consumer escapes for itself, and
  // `sources[].name` / `sinks[].instance` are identity keys there: cleaning is
  // a property of the terminal, not of the report.
  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.equal(json.sources[0].name, 'gw' + FORGE, '--json still carries the raw identity key')
  assert.equal(json.sinks[0].instance, 'sink' + FORGE)
})

test('a hostile daemon state and mode cannot drive the terminal from hyp status', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // No pid file: liveness and `mode` then come from the status snapshot, which
  // is the branch where a status-file `mode` reaches the line at all.
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'running' + FORGE,
    mode: 'fore' + ESC + '[31mground',
    sources: [],
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.state, 'running' + FORGE, 'the collector keeps the raw value')
  const text = renderText(report)
  assert.ok(!CONTROL_CHARS.test(text.replace(/\n/g, '')), 'but no control byte reaches the daemon line')
  const lines = text.split(NL)
  const at = lines.findIndex((l) => l.startsWith('  daemon:'))
  assert.ok(at >= 0)
  assert.match(lines[at], /state=running/, 'the printable part still shows the state')
  assert.match(lines[at], /mode=fore/, 'and the mode')
  assert.equal(lines[at + 1], '  active plugins:', 'and the forged line never appears')
})

test('an unbounded daemon state is clamped on the daemon line', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const long = 'a'.repeat(5000)
  writeStatusFile(stateRoot, /** @type {any} */ ({ state: long, sources: [], sinks: [] }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const text = renderText(report)
  assert.ok(!text.includes(long), 'the raw value is not printed whole')
  assert.ok(text.includes('a'.repeat(117) + '...'), 'it is clamped, and marked truncated')
})

test('a status file that is not JSON cannot drive the terminal through the parse error', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  // `JSON.parse` quotes an excerpt of its input back in the message, so the
  // file's own bytes reach `daemon.error` and from there the `error=` field.
  const sp = statusFilePath(stateRoot)
  await fs.mkdir(path.dirname(sp), { recursive: true })
  await fs.writeFile(sp, 'x' + FORGE)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.ok(report.daemon.error, 'the unparseable file surfaces as a daemon error')
  assert.ok(CONTROL_CHARS.test(report.daemon.error), 'whose message quotes the raw bytes back')
  const text = renderText(report)
  assert.ok(!CONTROL_CHARS.test(text.replace(/\n/g, '')), 'and none of them reaches the terminal')
  assert.match(text, /error=Unexpected token/, 'the error is still reported')
})
