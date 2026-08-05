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
