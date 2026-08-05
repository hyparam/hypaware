// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifests } from '../../src/core/manifest.js'

// Picking a row changes the machine, and the picker summary is the one
// disclosure of that the wizard makes (PR #629 review, finding 2). This
// copy was shortened once and the disclosures silently vanished with it -
// nothing asserted them. Each assertion here names the side effect a
// summary must keep admitting to, not its exact wording, so the copy can
// be re-tuned without losing the admission.

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace'
)

/**
 * @param {string} plugin workspace directory name
 * @param {string} row picker row name
 * @returns {Promise<string>}
 */
async function pickerSummary(plugin, row) {
  const { loaded, failed } = await loadManifests([path.join(WORKSPACE, plugin)])
  assert.equal(failed.length, 0, failed.map((f) => f.message).join('; '))
  const picker = /** @type {any} */ (loaded[0].manifest).contributes?.picker ?? []
  const match = picker.find((/** @type {any} */ r) => r.name === row)
  assert.ok(match, `picker row '${row}' exists in ${plugin}`)
  return match.summary ?? ''
}

test('claude picker summary discloses the attach and the skill install', async () => {
  const summary = await pickerSummary('claude', 'claude')
  assert.match(summary, /attaches/i)
  assert.match(summary, /skills/i)
})

test('codex picker summary discloses the gateway config write and the skill install', async () => {
  const summary = await pickerSummary('codex', 'codex')
  assert.match(summary, /local gateway/i)
  assert.match(summary, /skills/i)
})

test('otel picker summary discloses that a local receiver is started', async () => {
  const summary = await pickerSummary('otel', 'otel')
  assert.match(summary, /starts a local receiver/i)
})

test('openclaw picker summary discloses the gateway-config rewrite', async () => {
  const summary = await pickerSummary('openclaw', 'openclaw')
  assert.match(summary, /rewrites OpenClaw's gateway config/i)
})

// A running OpenClaw gateway keeps routing at the old baseUrl until it is
// restarted, so attach's write is inert without it (`openclaw/src/attach.js`
// RESTART_COMMAND / RESTART_INSTRUCTION, LLP 0167#verify-results item 4).
// attach.js prints that only after the rewrite has happened; the picker row
// is the one place the user can read it before choosing.
test('openclaw picker summary names the manual gateway restart attach requires', async () => {
  const summary = await pickerSummary('openclaw', 'openclaw')
  assert.match(summary, /openclaw gateway restart/i)
})

// `requires_gateway` composes `@hypaware/ai-gateway`, whose source binds an
// HTTP listener on 127.0.0.1 (default `127.0.0.1:18521`, `ai-gateway/src/
// config.js` DEFAULT_LISTEN, bound by `proxy.js` startProxy). That is the
// same class of side effect the otel row already names, and these two rows
// carry no adapter to disclose it anywhere else.
for (const row of ['raw-anthropic', 'raw-openai']) {
  test(`${row} picker summary discloses that a local gateway listener is started`, async () => {
    const summary = await pickerSummary('ai-gateway', row)
    assert.match(summary, /starts a local gateway listener/i)
  })
}

// The real machine change (managed plist, helper write, residue clear) sits
// behind `needs_setup: true` + `configure_command: "claude-desktop install"`,
// and that command explains and asks, defaulting to no, before touching
// anything (`claude-desktop/src/install.js` runInstall consent gate,
// @ref LLP 0139#informed-consent). The reassurance is load-bearing on a row
// whose other clause ("admin approval") reads as a sudo ambush without it.
test('claude-desktop picker summary keeps the asks-before-changing reassurance', async () => {
  const summary = await pickerSummary('claude-desktop', 'claude-desktop')
  assert.match(summary, /asks before changing anything/i)
})
