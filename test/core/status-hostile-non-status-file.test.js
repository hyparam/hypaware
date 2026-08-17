// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

// `status.json` is not the only file whose bytes reach `hyp status`'s text
// surface. Two more do:
//
//   - `config-control/state.json` and the per-slot etag sidecar. An etag is
//     authored by whatever server the install joined, and the state file is
//     read back with no validation beyond "is an object", so a `reason` or a
//     timestamp is this build's own vocabulary only if this build wrote it.
//   - a client's own settings file, by way of the attach probe's `error`: a
//     settings file that is not valid JSON surfaces as `JSON.parse`'s
//     message, which quotes an excerpt of the file verbatim.
//
// Both are display-only on this surface and both were interpolated raw, so
// each was a way for a file the operator never chose to trust to repaint the
// screen or forge a plausible extra status line.
//
// @ref LLP 0225#decision [tests]: the render a person reads is cleaned, whichever file the string came from; --json is not

const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/

// An erase-line sequence plus a newline: together enough to forge a plausible
// extra line the operator never chose to trust.
const ERASE_LINE = '\u001b[2K'
const ZERO_WIDTH = '\u200b'

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-hostile-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

function makeBuf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * Seed the apply engine's on-disk state. Written as raw JSON rather than
 * through the engine because the point is what a file this build did not
 * write can hold.
 *
 * @param {string} hypHome
 * @param {Record<string, unknown>} state
 */
async function writeControlState(hypHome, state) {
  const controlDir = path.join(hypHome, 'hypaware', 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  await fs.writeFile(path.join(controlDir, 'state.json'), JSON.stringify(state))
}

/** @param {string} hypHome */
async function render(hypHome) {
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  const stdout = makeBuf()
  renderStatusText({
    report,
    clientNames: [],
    datasets: [],
    cacheRoot: path.join(hypHome, 'hypaware', 'cache'),
    stdout: /** @type {any} */ (stdout),
  })
  return { report, text: stdout.text() }
}

const HOSTILE_ETAG = `W/"rev-9${ERASE_LINE}\n  running etag:  W/"trusted"`

test('a hostile remote-config etag cannot drive the terminal from hyp status', async () => {
  const hypHome = await makeHome()
  await writeControlState(hypHome, {
    probation: {
      etag: HOSTILE_ETAG,
      applied_at: '2026-05-21T00:00:00.000Z',
      until: `2026-05-21T00:05:00.000Z${ERASE_LINE}`,
      slot: 'a',
      previous_slot: 'b',
    },
    bad_etag: {
      etag: `W/"rev-8${ZERO_WIDTH}${ZERO_WIDTH}"`,
      reason: `probation_expired${ERASE_LINE}`,
      recorded_at: '2026-05-21T00:00:00.000Z',
    },
  })

  const { text } = await render(hypHome)

  assert.match(text, /remote config:/, 'the block is rendered at all')
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(text), 'no control byte reaches the text surface')
  assert.ok(!text.includes(ZERO_WIDTH), 'and no zero-width run does either')
  assert.equal(
    text.split('\n').filter((line) => line.startsWith('    running etag:')).length,
    0,
    'the embedded newline cannot forge a running-etag line the file never had',
  )
})

test('a hostile rollback reason cannot drive the terminal, in the block or the diagnostic', async () => {
  const hypHome = await makeHome()
  await writeControlState(hypHome, {
    last_rollback: {
      etag: `W/"rev-7${ERASE_LINE}`,
      reason: `probation_expired\n  overall: healthy`,
      at: `2026-05-21T00:00:00.000Z${ZERO_WIDTH}`,
    },
  })

  const { report, text } = await render(hypHome)

  const diag = report.diagnostics.find((d) => d.kind === 'remote_config_rolled_back')
  assert.ok(diag, 'the rollback is diagnosed')
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(diag.message), 'no control byte reaches the diagnostic')
  assert.ok(!/\n/.test(diag.message), 'and the message stays one line')
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(text), 'nor the text surface that prints it')
  assert.ok(!text.includes(ZERO_WIDTH), 'and no zero-width run does either')
  assert.equal(
    text.split('\n').filter((line) => line.startsWith('  overall: healthy')).length,
    0,
    'the embedded newline cannot forge an overall line',
  )
  assert.match(text, /last rollback: W\/"rev-7/, 'the printable part still names the revision')
})

test('an unbounded remote-config etag is clamped', async () => {
  const hypHome = await makeHome()
  const long = 'a'.repeat(5000)
  await writeControlState(hypHome, {
    last_rollback: { etag: long, reason: 'probation_expired', at: '2026-05-21T00:00:00.000Z' },
  })

  const { text } = await render(hypHome)

  assert.ok(!text.includes(long), 'the raw etag is not printed whole')
  // `sanitizeLabel`'s 120-character clamp, truncation marker included.
  assert.ok(text.includes('a'.repeat(117) + '...'), 'it is clamped, and marked truncated')
})

// A client's attach probe error is the client's file talking, not this
// build's prose.
test('a hostile client probe error cannot drive the terminal from hyp status', async () => {
  const hypHome = await makeHome()
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  report.clients = report.clients.filter((c) => c.name !== 'codex')
  report.clients.push({
    name: 'codex',
    plugin: '@hypaware/codex',
    configured: false,
    attachable: true,
    attached: false,
    // What `JSON.parse` says about a settings file whose bytes are hostile:
    // the message quotes the input back.
    error: `Unexpected token '${ERASE_LINE}', "${ERASE_LINE}\n    - forged  [configured, attached]" is not valid JSON`,
  })

  const stdout = makeBuf()
  renderStatusText({
    report,
    clientNames: [],
    datasets: [],
    cacheRoot: path.join(hypHome, 'hypaware', 'cache'),
    stdout: /** @type {any} */ (stdout),
  })
  const text = stdout.text()

  assert.match(text, /error: Unexpected token/, 'the error still reaches the surface')
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(text), 'no control byte reaches it')
  assert.equal(
    text.split('\n').filter((line) => line.startsWith('    - forged')).length,
    0,
    'the embedded newline cannot forge an extra client row',
  )
})

test('an unbounded client probe error is clamped', async () => {
  const hypHome = await makeHome()
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  const long = 'b'.repeat(5000)
  report.clients = report.clients.filter((c) => c.name !== 'codex')
  report.clients.push({ name: 'codex', plugin: '@hypaware/codex', configured: false, attachable: true, attached: false, error: long })

  const stdout = makeBuf()
  renderStatusText({
    report,
    clientNames: [],
    datasets: [],
    cacheRoot: path.join(hypHome, 'hypaware', 'cache'),
    stdout: /** @type {any} */ (stdout),
  })
  const text = stdout.text()

  assert.ok(!text.includes(long), 'the raw error is not printed whole')
  // Wider than a label's 120: an error message typically names a full path,
  // and cutting that short is the one way this cleaning costs a reader.
  assert.ok(text.includes('b'.repeat(397) + '...'), 'it is clamped at the error width')
})

// The cleaning is for the surface a person reads. `--json` is the machine
// copy, and a consumer that escapes for itself must receive what was
// recorded, not a version already edited on its behalf (LLP 0225).
test('hyp status --json still reports the etag and probe error the files hold', async () => {
  const hypHome = await makeHome()
  await writeControlState(hypHome, {
    probation: {
      etag: HOSTILE_ETAG,
      applied_at: '2026-05-21T00:00:00.000Z',
      until: '2026-05-21T00:05:00.000Z',
      slot: 'a',
      previous_slot: 'b',
    },
  })
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  const probeError = `Unexpected token '${ERASE_LINE}'`
  report.clients = report.clients.filter((c) => c.name !== 'codex')
  report.clients.push({ name: 'codex', plugin: '@hypaware/codex', configured: false, attachable: true, attached: false, error: probeError })

  const payload = renderStatusJson({
    report,
    clientNames: [],
    datasets: [],
    cacheRoot: path.join(hypHome, 'hypaware', 'cache'),
  })

  assert.equal(payload.remote_config?.probation?.etag, HOSTILE_ETAG)
  assert.equal(payload.client_attach.find((c) => c.name === 'codex')?.error, probeError)
})

// The guard above seeds `probation`, which only ever reaches the text render,
// so on its own it would let you believe `--json` is untouched everywhere. It
// is not, and this pins the one place it is not. `remote_config_rolled_back`'s
// message is assembled once, in the collector, out of cleaned components, so
// the machine render receives that same cleaned prose. The split that actually
// holds is prose-versus-values, not text-versus-json: the assembled sentence is
// cleaned wherever it is read, and the values it was assembled from stay
// byte-exact one key away at `remote_config.last_rollback`.
test('hyp status --json carries the cleaned rollback prose, and the raw values beside it', async () => {
  const hypHome = await makeHome()
  const rollback = {
    etag: `W/"rev-7${ERASE_LINE}`,
    reason: 'probation_expired\nFORGED',
    at: `2026-05-21T00:00:00.000Z${ZERO_WIDTH}`,
  }
  await writeControlState(hypHome, { last_rollback: rollback })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  const payload = renderStatusJson({
    report,
    clientNames: [],
    datasets: [],
    cacheRoot: path.join(hypHome, 'hypaware', 'cache'),
  })

  const diag = payload.diagnostics.find((d) => d.kind === 'remote_config_rolled_back')
  assert.ok(diag, 'the rollback is diagnosed under --json too')
  assert.ok(!CONTROL_EXCEPT_NEWLINE.test(diag.message), 'the --json message carries no control byte')
  assert.ok(!diag.message.includes(ZERO_WIDTH), 'nor a zero-width run')
  assert.ok(!diag.message.includes('\n'), 'and it is still one line under --json')
  // The strip is a strip, not an escape (LLP 0225 #escape-not-strip applies to
  // the query plane; this is the label plane), so the newline closes up and a
  // consumer of this string cannot tell the two spellings apart. That is the
  // cost of assembling the sentence once, and it is why the values below and
  // not this sentence are what a program should read.
  assert.ok(diag.message.includes('probation_expiredFORGED'), 'the stripped reason closes up')

  assert.deepEqual(
    payload.remote_config?.last_rollback,
    rollback,
    'the values the file holds are reported byte-exact under --json',
  )
})

test('a long rollback etag is clamped in the --json message but whole in the --json values', async () => {
  const hypHome = await makeHome()
  const long = 'a'.repeat(5000)
  await writeControlState(hypHome, {
    last_rollback: { etag: long, reason: 'probation_expired', at: '2026-05-21T00:00:00.000Z' },
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  const payload = renderStatusJson({
    report,
    clientNames: [],
    datasets: [],
    cacheRoot: path.join(hypHome, 'hypaware', 'cache'),
  })

  const diag = payload.diagnostics.find((d) => d.kind === 'remote_config_rolled_back')
  assert.ok(diag, 'the rollback is diagnosed')
  assert.ok(!diag.message.includes(long), 'the assembled sentence does not carry the whole etag')
  assert.ok(diag.message.includes('a'.repeat(117) + '...'), 'it is clamped at a label width, and marked truncated')
  assert.equal(payload.remote_config?.last_rollback?.etag, long, 'the values beside it are not clamped')
})
