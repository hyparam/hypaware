// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { runWizardPick } from '../../../../src/core/cli/wizard/pick.js'
import { defaultOverwriteConfirmFactory, derivePickedClients } from '../../../../src/core/cli/walkthrough.js'
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
    detect: async () => new Set(['codex']),
  }))
  // The codex row came pre-checked from detection.
  const codexRow = state.question.options.find((/** @type {any} */ o) => o.value === 'codex')
  assert.equal(codexRow.checked, true)
  assert.equal(codexRow.disabled, undefined)
  assert.deepEqual(result.sourcesPicked, ['codex'])
  assert.equal(result.retentionDays, 90)
})

// --- retention defaults (LLP 0137): never asked, pathway-supplied ---
// @ref LLP 0137#pathway-defaults [tests]:

test('runWizardPick: interactive runs take the 90-day default without a retention prompt', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt } = capturingPrompt(['otel'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(),
  }))
  assert.equal(result.retentionDays, 90)
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.equal(written.query.cache.retention.default_days, 90)
})

test('runWizardPick: retentionDefault (the local pathway) lands in the composed config', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt } = capturingPrompt(['otel'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(),
    retentionDefault: 120,
  }))
  assert.equal(result.retentionDays, 120)
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.equal(written.query.cache.retention.default_days, 120)
})

test('runWizardPick: pre-baked picks override retentionDefault', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog,
    retentionDefault: 120,
    picks: { sources: /** @type {PickerSource[]} */ (['otel']), exportChoice: 'local-parquet', retentionDays: 7 },
  }))
  assert.equal(result.retentionDays, 7)
})

test('runWizardPick: options come from catalog.pickerDescriptors, not a hardcoded table', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt([])
  await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
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

// --- managed machines: local additions annotated (LLP 0132) ---
// @ref LLP 0132#never-silent [tests]:

test('runWizardPick: on a managed machine, non-locked rows say "stays on this machine"', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt([])
  await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(['codex']),
    locked: ['claude'],
    managed: true,
  }))
  const rows = state.question.options
  // The locked row keeps the fleet label and never the local-only one.
  const claudeRow = rows.find((/** @type {any} */ o) => o.value === 'claude')
  assert.match(claudeRow.label, /managed by your fleet/)
  assert.doesNotMatch(claudeRow.label, /stays on this machine/)
  // Every non-locked row is annotated, detected or not.
  const codexRow = rows.find((/** @type {any} */ o) => o.value === 'codex')
  assert.match(codexRow.label, /detected · stays on this machine/)
  const otelRow = rows.find((/** @type {any} */ o) => o.value === 'otel')
  assert.match(otelRow.label, /stays on this machine/)
})

test('runWizardPick: an unmanaged (solo) machine never shows the local-only suffix', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt([])
  await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(['claude']),
  }))
  for (const row of state.question.options) {
    assert.doesNotMatch(row.label, /stays on this machine/)
  }
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

// --- clientsPicked derivation (LLP 0180) ---

// @ref LLP 0180#decision [tests]: a picked row is a client pick iff its
// plugin contributes a client; nothing is enumerated per client name.
test('runWizardPick: a picked openclaw reaches clientsPicked; a clientless pick does not', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()

  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog,
    picks: { sources: /** @type {PickerSource[]} */ (['openclaw', 'otel']), exportChoice: 'local-parquet', retentionDays: 30 },
  }))

  assert.equal(result.exitCode, 0)
  // @hypaware/openclaw contributes a client; @hypaware/otel does not.
  assert.deepEqual(result.clientsPicked, ['openclaw'])
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.ok(written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/openclaw'))
})

// The full derived set, pinned against the bundled catalog. This failing is
// the feature: a plugin edit that widens or narrows what picking every row
// attaches must show up here as a deliberate test change, not ride through
// green CI the way claude-desktop's unintended attach entry once did.
// @ref LLP 0180#decision [tests]: the row-to-plugin-to-clients fan-out over
// the whole catalog yields exactly the known client contributions
test('derivePickedClients: the derived set over every bundled picker row is pinned', async () => {
  const catalog = await realCatalog()
  const derived = derivePickedClients(
    [...catalog.pickerDescriptors.keys()],
    catalog.pickerDescriptors,
    catalog.clientDescriptors
  )
  assert.deepEqual([...derived].sort(), ['claude', 'claude-desktop', 'codex', 'openclaw'])
})

// --- reconfigure: the existing config, not detection, is the starting state ---
// @ref LLP 0183#seed-from-config [tests]:

/**
 * Write a local config at the path `runWizardPick` resolves for `env`, so
 * the next run is a reconfigure rather than a first run.
 *
 * @param {string} tmp
 * @param {Record<string, unknown>} config
 * @returns {Promise<string>}
 */
async function seedLocalConfig(tmp, config) {
  const configPath = path.join(tmp, '.hyp', 'hypaware-config.json')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return configPath
}

test('runWizardPick: a reconfigure pre-checks the undetectable otel row it already collects', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  // @hypaware/otel declares no `detect` rule, so detection can never re-seed
  // this row. Before the fix it came back unchecked and confirming the picker
  // silently dropped OTEL collection.
  await seedLocalConfig(tmp, {
    version: 2,
    plugins: [{ name: '@hypaware/otel', config: { listen_host: '127.0.0.1', listen_port: 4318 } }],
    query: { cache: { retention: { default_days: 90 } } },
  })
  const { prompt, state } = capturingPrompt(['otel'])
  await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(),
    confirmOverwrite: async () => true,
  }))
  const otelRow = state.question.options.find((/** @type {any} */ o) => o.value === 'otel')
  assert.equal(otelRow.checked, true)
})

test('runWizardPick: a reconfigure leaves a deliberately excluded client unchecked even when it is detected', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  // Claude is installed on this machine (detection finds it) but the user
  // deliberately left it out last time. Re-checking it would re-include it on
  // a blind confirm, which is a capture-consent regression.
  await seedLocalConfig(tmp, {
    version: 2,
    plugins: [{ name: '@hypaware/otel' }],
    query: { cache: { retention: { default_days: 90 } } },
  })
  const { prompt, state } = capturingPrompt(['otel'])
  await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(['claude']),
    confirmOverwrite: async () => true,
  }))
  const claudeRow = state.question.options.find((/** @type {any} */ o) => o.value === 'claude')
  assert.notEqual(claudeRow.checked, true)
  // The row still says it was detected, so the suggestion is visible; it is
  // just not ticked on the user's behalf.
  assert.match(claudeRow.label, /detected/)
})

test('runWizardPick: a 120-day retention survives a team-path reconfigure', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  // A solo 120-day install walking down the team path. Resetting to the
  // pathway default would hand the next retention sweep days 90-120 of
  // history to purge, with no question asked.
  await seedLocalConfig(tmp, {
    version: 2,
    plugins: [{ name: '@hypaware/otel' }],
    query: { cache: { retention: { default_days: 120 } } },
  })
  const { prompt } = capturingPrompt(['otel'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(),
    confirmOverwrite: async () => true,
  }))
  assert.equal(result.retentionDays, 120)
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.equal(written.query.cache.retention.default_days, 120)
})

test('runWizardPick: a first run still seeds from detection and takes the pathway retention default', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt(['claude'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(['claude']),
    retentionDefault: 120,
  }))
  const claudeRow = state.question.options.find((/** @type {any} */ o) => o.value === 'claude')
  assert.equal(claudeRow.checked, true)
  assert.equal(result.retentionDays, 120)
})

test('runWizardPick: a reconfigure carries forward plugins and sink edits the picker does not own', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  await seedLocalConfig(tmp, {
    version: 2,
    plugins: [
      { name: '@hypaware/otel', config: { listen_host: '0.0.0.0', listen_port: 4319 } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/gascity', config: { room: 'wallaby' } },
    ],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: { dir: '/srv/exports', schedule: '0 * * * *' },
      },
    },
    query: { cache: { retention: { default_days: 120 } } },
  })
  const { prompt } = capturingPrompt(['otel'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(),
    confirmOverwrite: async () => true,
  }))
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  // A plugin no picker row and no export choice contributes is not the
  // composer's to drop.
  const gascity = written.plugins.find((/** @type {any} */ p) => p.name === '@hypaware/gascity')
  assert.deepEqual(gascity, { name: '@hypaware/gascity', config: { room: 'wallaby' } })
  // Hand-edited plugin config wins over the manifest's composed defaults.
  const otel = written.plugins.find((/** @type {any} */ p) => p.name === '@hypaware/otel')
  assert.equal(otel.config.listen_host, '0.0.0.0')
  assert.equal(otel.config.listen_port, 4319)
  // As does a hand-edited sink schedule and destination directory.
  assert.equal(written.sinks.local.config.schedule, '0 * * * *')
  assert.equal(written.sinks.local.config.dir, '/srv/exports')
})

test('runWizardPick: a reconfigure of a cache-only install does not silently add an export sink', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  // `hyp init --export keep-local` wrote this config. The wizard no longer
  // asks about export, so it must not re-decide it either.
  await seedLocalConfig(tmp, {
    version: 2,
    plugins: [{ name: '@hypaware/otel' }],
    query: { cache: { retention: { default_days: 90 } } },
  })
  const { prompt } = capturingPrompt(['otel'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(),
    confirmOverwrite: async () => true,
  }))
  assert.equal(result.exportPicked, 'keep-local')
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.equal(written.sinks, undefined)
})

test('runWizardPick: unchecking a row still removes its plugin and its gateway upstream', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  // Carrying config forward must not resurrect a source the user just
  // unchecked: codex's adapter and its two upstreams have to go.
  await seedLocalConfig(tmp, {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { upstreams: [
        { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages', provider: 'anthropic' },
        { name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/v1', provider: 'openai' },
        { name: 'chatgpt', base_url: 'https://chatgpt.com', path_prefix: '/backend-api/codex', provider: 'chatgpt' },
      ] } },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
      { name: '@hypaware/codex', config: { proxy: '@hypaware/ai-gateway' } },
    ],
    query: { cache: { retention: { default_days: 90 } } },
  })
  const { prompt } = capturingPrompt(['claude'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(),
    confirmOverwrite: async () => true,
  }))
  assert.deepEqual(result.sourcesPicked, ['claude'])
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  assert.ok(!written.plugins.some((/** @type {any} */ p) => p.name === '@hypaware/codex'))
  const gateway = written.plugins.find((/** @type {any} */ p) => p.name === '@hypaware/ai-gateway')
  assert.deepEqual(gateway.config.upstreams.map((/** @type {any} */ u) => u.name), ['anthropic'])
})

test('runWizardPick: a disabled plugin reads as an off row, and re-picking it turns it back on', async () => {
  const tmp = await mkTmp()
  const catalog = await realCatalog()
  await seedLocalConfig(tmp, {
    version: 2,
    plugins: [{ name: '@hypaware/otel', enabled: false }],
    query: { cache: { retention: { default_days: 90 } } },
  })
  const { prompt, state } = capturingPrompt(['otel'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env: hermeticEnv(tmp), catalog, prompt,
    detect: async () => new Set(),
    confirmOverwrite: async () => true,
  }))
  const otelRow = state.question.options.find((/** @type {any} */ o) => o.value === 'otel')
  assert.notEqual(otelRow.checked, true)
  // Picking the row is what "on" means, so the stale disable does not survive.
  const written = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
  const otel = written.plugins.find((/** @type {any} */ p) => p.name === '@hypaware/otel')
  assert.equal(otel.enabled, undefined)
})

test('defaultOverwriteConfirmFactory: the prompt says the config is regenerated from the picks', async () => {
  const asked = makeBuf()
  const confirm = defaultOverwriteConfirmFactory({
    stdin: /** @type {any} */ (Readable.from(['n\n'])),
    stdout: /** @type {any} */ (asked),
  })
  await confirm('/home/tester/.hyp/hypaware-config.json')
  // "Overwrite it?" reads as "keep adjusting my picks"; the file is rewritten
  // from the picks, and the prompt has to say so before the y/N.
  assert.match(asked.text(), /rewritten from your picks/i)
  assert.match(asked.text(), /carried over/i)
})
