// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runWizardPick } from '../../../../src/core/cli/wizard/pick.js'
import { discoverBundledPlugins } from '../../../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../../../src/core/plugin_catalog.js'

/**
 * @import { PickerSource } from '../../../../src/core/cli/types.js'
 * @import { PluginCatalog } from '../../../../src/core/types.js'
 */

// The wizard pick phase (LLP 0135 #pick). Rows come from the manifest-sourced
// picker descriptors (LLP 0130); central-layer-locked rows render disabled and
// are filtered out of the returned picks before composition (LLP 0129
// #join-before-picker). Non-interactive callers set `opts.picks` and skip
// prompting, matching today's `interactive = !opts.picks` split.
// @ref LLP 0129#join-before-picker [tests]:
// @ref LLP 0031#status-provenance [tests]:

/** @returns {Promise<PluginCatalog>} */
async function realCatalog() {
  const bundled = await discoverBundledPlugins()
  return buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
}

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * Record the question the prompt was asked and answer it with a fixed set of
 * ids. Captures the option list so tests can assert on checked/disabled/label.
 * @param {string[]} answer
 */
function capturingPrompt(answer) {
  /** @type {{ question: any }} */
  const state = { question: null }
  /** @type {any} */
  const prompt = async (/** @type {any} */ question) => {
    state.question = question
    return answer
  }
  return { prompt, state }
}

/**
 * @param {string} tmp
 * @returns {NodeJS.ProcessEnv}
 */
function hermeticEnv(tmp) {
  return {
    HOME: tmp,
    HYP_HOME: path.join(tmp, '.hyp'),
    // Force the legacy path off; the injected prompt replaces the TUI anyway.
    HYP_NO_TUI: '1',
  }
}

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-wizard-pick-'))
}

// --- non-interactive (pre-baked picks) ---

test('runWizardPick: pre-baked picks skip prompting and compose the same config', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { prompt, state } = capturingPrompt([])

  const result = await runWizardPick(/** @type {any} */ ({
    stdout, stderr, env: hermeticEnv(tmp), catalog, prompt,
    picks: { sources: /** @type {PickerSource[]} */ (['claude']), exportChoice: 'local-parquet', retentionDays: 30 },
  }))

  // The prompt was never consulted on the non-interactive path.
  assert.equal(state.question, null)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.sourcesPicked, ['claude'])
  assert.deepEqual(result.clientsPicked, ['claude'])
  assert.equal(result.retentionDays, 30)
  // Config landed on disk with the claude adapter + gateway.
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.ok(written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/claude'))
  assert.ok(written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/ai-gateway'))
})

test('runWizardPick: non-interactive path does not run detection', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  let detectCalled = false
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog,
    detect: async () => { detectCalled = true; return new Set(['codex']) },
    picks: { sources: /** @type {PickerSource[]} */ ([]), exportChoice: 'local-parquet', retentionDays: 30 },
  }))
  assert.equal(detectCalled, false)
  assert.deepEqual(result.sourcesPicked, [])
})

// --- interactive prompting + detection ---

test('runWizardPick: interactive prompt options pre-check detected sources', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt(['codex'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    retentionPrompt: async (/** @type {string} */ _p, /** @type {number} */ d) => d,
    detect: async () => new Set(['codex']),
  }))
  // The codex row came pre-checked from detection.
  const codexRow = state.question.options.find((/** @type {any} */ o) => o.value === 'codex')
  assert.equal(codexRow.checked, true)
  assert.equal(codexRow.disabled, undefined)
  assert.deepEqual(result.sourcesPicked, ['codex'])
  assert.equal(result.retentionDays, 30)
})

test('runWizardPick: options come from catalog.pickerDescriptors, not a hardcoded table', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt([])
  await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    retentionPrompt: async (/** @type {string} */ _p, /** @type {number} */ d) => d,
    detect: async () => new Set(),
  }))
  const ids = state.question.options.map((/** @type {any} */ o) => o.value).sort()
  assert.deepEqual(ids, [...catalog.pickerDescriptors.keys()].sort())
})

// --- locked (central-layer) rows ---

test('runWizardPick: a locked row renders checked, disabled, and fleet-labeled', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt(['claude'])
  await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    retentionPrompt: async (/** @type {string} */ _p, /** @type {number} */ d) => d,
    detect: async () => new Set(),
    locked: ['claude'],
  }))
  const claudeRow = state.question.options.find((/** @type {any} */ o) => o.value === 'claude')
  assert.equal(claudeRow.checked, true)
  assert.equal(claudeRow.disabled, true)
  assert.match(claudeRow.label, /managed by your fleet/)
})

test('runWizardPick: a locked source is filtered out of the returned picks and composition', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  // The prompt "returns" claude (locked) and codex (a fresh local pick); the
  // locked claude must not survive into sourcesPicked or the written config.
  const { prompt } = capturingPrompt(['claude', 'codex'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    retentionPrompt: async (/** @type {string} */ _p, /** @type {number} */ d) => d,
    detect: async () => new Set(),
    locked: ['claude'],
  }))
  assert.deepEqual(result.sourcesPicked, ['codex'])
  // The locked claude is dropped from local-layer composition, but it is still
  // a picked client for the finale's per-machine local work (attach, skills,
  // agents), so clientsPicked names both (issue #380).
  assert.deepEqual(result.clientsPicked, ['claude', 'codex'])
  assert.deepEqual(result.lockedSources, ['claude'])
  assert.deepEqual(result.descriptors.map((d) => d.id), ['codex'])
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  // The locked claude adapter is NOT re-composed into the local layer.
  assert.ok(!written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/claude'))
  assert.ok(written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/codex'))
})

test('runWizardPick: an unknown locked id is ignored, not surfaced as a row', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt([])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    retentionPrompt: async (/** @type {string} */ _p, /** @type {number} */ d) => d,
    detect: async () => new Set(),
    locked: ['does-not-exist'],
  }))
  assert.deepEqual(result.lockedSources, [])
  assert.ok(!state.question.options.some((/** @type {any} */ o) => o.value === 'does-not-exist'))
})

test('runWizardPick: a fully fleet-managed machine still reports its locked clients as picked so the finale installs skills/agents', async () => {
  // A fleet-managed machine where the org locks BOTH clients. The picker rows
  // render checked+disabled and are dropped from the local-layer composition
  // (they already live in the central layer), so sourcesPicked is empty and no
  // adapter is re-composed. But clientsPicked drives the finale's per-machine
  // local work (attach, skills install, agents install), which is NOT in the
  // central layer, so it must still name both locked clients. Deriving it from
  // the composition-filtered sources made it empty here, silently no-op'ing the
  // finale on every fleet-managed machine (issue #380).
  // @ref LLP 0135#finale [tests]: skills/agents install iterates clientsPicked, which must include org-locked clients
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt } = capturingPrompt(['claude', 'codex'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    retentionPrompt: async (/** @type {string} */ _p, /** @type {number} */ d) => d,
    detect: async () => new Set(),
    locked: ['claude', 'codex'],
  }))
  // Nothing composed into the local layer: both clients are centrally managed.
  assert.deepEqual(result.sourcesPicked, [])
  assert.deepEqual(result.lockedSources, ['claude', 'codex'])
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.ok(!written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/claude'))
  assert.ok(!written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/codex'))
  // ...but the finale must still see both clients to install their local
  // skills/agents and attach settings.
  assert.deepEqual(result.clientsPicked, ['claude', 'codex'])
})

// --- overwrite guard ---

test('runWizardPick: refuses to clobber an existing config without --force (exit 1, not cancelled)', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const env = hermeticEnv(tmp)
  const picks = { sources: /** @type {PickerSource[]} */ (['claude']), exportChoice: 'local-parquet', retentionDays: 30 }

  // First write establishes a config at the resolved path.
  const first = await runWizardPick(/** @type {any} */ ({ stdout: makeBuf(), stderr: makeBuf(), env, catalog, picks }))
  assert.equal(first.exitCode, 0)
  const before = await fs.readFile(first.configPath, 'utf8')

  // Second run without --force must refuse rather than clobber it.
  const stderr = makeBuf()
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env, catalog,
    picks: { sources: /** @type {PickerSource[]} */ (['otel']), exportChoice: 'local-parquet', retentionDays: 30 },
  }))
  assert.equal(result.exitCode, 1)
  assert.notEqual(result.cancelled, true)
  assert.match(stderr.text(), /hyp init:/)
  // The existing config is untouched.
  assert.equal(await fs.readFile(first.configPath, 'utf8'), before)
})

test('runWizardPick: --force overwrites an existing config after backing it up', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const env = hermeticEnv(tmp)
  const configPath = path.join(tmp, '.hyp', 'config.json')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, '{"version":2,"plugins":[]}\n', 'utf8')

  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, catalog, force: true,
    picks: { sources: /** @type {PickerSource[]} */ (['otel']), exportChoice: 'local-parquet', retentionDays: 30 },
  }))
  assert.equal(result.exitCode, 0)
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.ok(written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/otel'))
})

// --- cancel ---

test('runWizardPick: a cancelled prompt returns the deterministic cancel result', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { PromptCancelledError } = await import('../../../../src/core/cli/tui/runtime.js')
  const stderr = makeBuf()
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env: hermeticEnv(tmp), catalog,
    prompt: async () => { throw new PromptCancelledError() },
    detect: async () => new Set(),
  }))
  assert.equal(result.cancelled, true)
  assert.equal(result.exitCode, 130)
  assert.equal(result.configPath, '')
  assert.match(stderr.text(), /hyp init: cancelled/)
})
