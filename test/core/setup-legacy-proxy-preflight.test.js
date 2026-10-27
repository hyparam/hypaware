// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { runWizardPick } from '../../src/core/cli/wizard/pick.js'
import { runInitWizard } from '../../src/core/cli/wizard/index.js'

// A machine set up before LLP 0262 can still have Claude attached through
// the gateway proxy. A setup that replaces its config with one that turns the
// proxy off would strand that client, so every whole-config setup write
// refuses first, the same way in every mode, and writes nothing (#960).
// @ref LLP 0524#check [tests]: the marker is the evidence; a fresh install and an off-proxy marker are not checked or pass
// @ref LLP 0524#refusal [tests]: one message, exit 1, zero writes in every mode, and --force is not consent

const GATEWAY = '@hypaware/ai-gateway'
const EXISTING = { version: 2, plugins: [{ name: '@hypaware/otel' }] }

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A temp HOME holding HYP_HOME at `.hyp`, optionally with an existing local
 * config and a Claude settings file.
 *
 * @param {{ config?: unknown, settings?: string }} [seed]
 */
async function makeHome(seed = {}) {
  const home = await temporaryDirectory('hyp-setup-proxy-preflight-')
  const hypHome = path.join(home, '.hyp')
  await fs.mkdir(hypHome, { recursive: true })
  const configPath = path.join(hypHome, 'hypaware-config.json')
  if (seed.config !== undefined) await fs.writeFile(configPath, JSON.stringify(seed.config) + '\n')
  const settingsPath = path.join(home, '.claude', 'settings.json')
  if (seed.settings !== undefined) {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, seed.settings)
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    home,
    hypHome,
    configPath,
    settingsPath,
    stdout,
    stderr,
    opts: {
      stdout,
      stderr,
      stdin: /** @type {any} */ ({ isTTY: true }),
      env: { ...process.env, HOME: home, HYP_HOME: hypHome, HYP_CONFIG: '' },
    },
  }
}

/** @param {string} mode */
function claudeSettings(mode) {
  return JSON.stringify({
    env: { HTTPS_PROXY: 'http://127.0.0.1:4123' },
    _hypaware: { version: '0.2.0', port: 4123, mode },
  }, null, 2) + '\n'
}

/**
 * Every file under `dir` with its bytes, so a refusal can be shown to have
 * written, renamed, or backed up nothing at all. The `--from-file` input is
 * the test's own, not a setup write.
 *
 * @param {string} dir
 * @returns {Promise<Map<string, string>>}
 */
async function snapshot(dir) {
  /** @type {Map<string, string>} */
  const files = new Map()
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'incoming.json') continue
    const full = path.join(entry.parentPath, entry.name)
    files.set(path.relative(dir, full), await fs.readFile(full, 'utf8'))
  }
  return files
}

/** @param {string} text */
function refusalLine(text) {
  return text.split('\n').find((line) => line.startsWith('hyp setup: ')) ?? ''
}

/** @param {string} hypHome */
async function writeFromFile(hypHome, /** @type {unknown} */ config) {
  const p = path.join(path.dirname(hypHome), 'incoming.json')
  await fs.writeFile(p, JSON.stringify(config) + '\n')
  return p
}

/**
 * The interactive wizard through its orchestrator, every phase but the
 * config commit scripted, so the refusal lands where a real attended run
 * reaches it: after the questions, before the first write.
 *
 * @param {string} home
 * @param {string} configPath
 * @param {unknown} config
 */
function interactiveWizardOpts(home, configPath, config) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  let finaleRan = false
  const opts = /** @type {any} */ ({
    stdout,
    stderr,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_NO_TUI: '1' },
    ctx: { commands: { run: async () => 0 } },
    capabilities: { has: () => false },
    catalog: {
      plugins: new Map(),
      pluginMetadata: new Map(),
      knownDatasets: new Set(),
      clientDescriptors: new Map(),
      pickerDescriptors: new Map(),
    },
    finale: {},
    gate: async () => ({ action: 'reconfigure', managed: false, report: {} }),
    fork: async () => 'local',
    express: async () => 'choose',
    pick: async () => ({
      exitCode: 0,
      configPending: true,
      configPath,
      config,
      sourcesPicked: ['claude'],
      exportPicked: 'local-parquet',
      clientsPicked: ['claude'],
      retentionDays: 30,
      descriptors: [],
      lockedSources: [],
    }),
    syncScope: async () => ({}),
    folderAsk: async () => ({ mode: 'sync' }),
    configure: async () => ({ results: [] }),
    finaleRunner: async () => {
      finaleRan = true
      return {
        daemonInstall: { skipped: true, dryRun: false },
        globalInstall: { skipped: true, installed: false },
        attach: [],
        skillsInstalled: [],
        agentsInstalled: [],
        daemonRestart: { skipped: true, dryRun: false, ok: false },
        backfill: [],
      }
    },
    suggestSkill: { launchable: false },
  })
  return { opts, stdout, stderr, finaleRan: () => finaleRan }
}

test('every setup mode refuses the same way and writes nothing when a client is still on the proxy', async () => {
  /** @type {Map<string, string>} */
  const lines = new Map()

  /**
   * @param {string} mode
   * @param {(env: Awaited<ReturnType<typeof makeHome>>) => Promise<number>} run
   */
  async function expectRefused(mode, run) {
    const fx = await makeHome({ config: EXISTING, settings: claudeSettings('proxy') })
    const before = await snapshot(fx.home)
    const code = await run(fx)
    assert.equal(code, 1, `${mode}: ${fx.stdout.text()}${fx.stderr.text()}`)
    assert.deepEqual(await snapshot(fx.home), before, `${mode} wrote nothing`)
    lines.set(mode, refusalLine(fx.stderr.text()))
  }

  await expectRefused('noninteractive', (fx) =>
    dispatch(['setup', '--yes', '--no-daemon', '--source', 'otel', '--force'], fx.opts))
  await expectRefused('dry-run', (fx) =>
    dispatch(['setup', '--yes', '--no-daemon', '--source', 'otel', '--dry-run', '--force'], fx.opts))
  await expectRefused('from-file', async (fx) => {
    const p = await writeFromFile(fx.hypHome, { version: 2, plugins: [{ name: GATEWAY }] })
    return dispatch(['setup', '--from-file', p, '--force'], fx.opts)
  })
  await expectRefused('preset', (fx) =>
    dispatch(['setup', 'claude-and-otel-local', '--force'], fx.opts))
  await expectRefused('interactive pick', async (fx) => {
    const result = await runWizardPick(/** @type {any} */ ({
      stdout: fx.stdout,
      stderr: fx.stderr,
      env: fx.opts.env,
      detect: async () => new Set(),
      prompt: async () => [],
    }))
    return result.exitCode
  })
  await expectRefused('interactive wizard', async (fx) => {
    const wiz = interactiveWizardOpts(fx.home, fx.configPath, EXISTING)
    const result = await runInitWizard(wiz.opts)
    assert.equal(wiz.finaleRan(), false, 'a refused run reaches no finale')
    fx.stderr.write(wiz.stderr.text())
    return result.exitCode
  })

  const expected = "hyp setup: claude is still attached through the HypAware proxy, and this config turns the proxy off, so claude would stop being captured. Nothing was changed. Move claude off the proxy with 'hyp client attach claude', or remove the attach with 'hyp client detach claude', then run setup again."
  for (const [mode, line] of lines) assert.equal(line, expected, mode)
})

test('an explicit proxy_mode: false is refused like an absent key', async () => {
  const fx = await makeHome({ config: EXISTING, settings: claudeSettings('proxy') })
  const p = await writeFromFile(fx.hypHome, {
    version: 2,
    plugins: [{ name: GATEWAY, config: { proxy_mode: false } }],
  })
  const before = await snapshot(fx.hypHome)
  assert.equal(await dispatch(['setup', '--from-file', p, '--force'], fx.opts), 1)
  assert.match(fx.stderr.text(), /claude is still attached through the HypAware proxy/)
  assert.deepEqual(await snapshot(fx.hypHome), before)
})

test('a config that keeps proxy_mode: true is written', async () => {
  const fx = await makeHome({ config: EXISTING, settings: claudeSettings('proxy') })
  const p = await writeFromFile(fx.hypHome, {
    version: 2,
    plugins: [{ name: GATEWAY, config: { proxy_mode: true } }],
  })
  assert.equal(await dispatch(['setup', '--from-file', p, '--force'], fx.opts), 0, fx.stderr.text())
  const written = JSON.parse(await fs.readFile(fx.configPath, 'utf8'))
  assert.equal(written.plugins[0].config.proxy_mode, true)
  assert.equal(await fs.readFile(fx.settingsPath, 'utf8'), claudeSettings('proxy'))
})

test('the interactive lane passes when it carries proxy_mode: true forward', async () => {
  const fx = await makeHome({ config: EXISTING, settings: claudeSettings('proxy') })
  const carried = { version: 2, plugins: [{ name: GATEWAY, enabled: true, config: { proxy_mode: true } }] }
  const wiz = interactiveWizardOpts(fx.home, fx.configPath, carried)
  const result = await runInitWizard(wiz.opts)
  assert.equal(result.exitCode, 0, wiz.stderr.text())
  assert.equal(refusalLine(wiz.stderr.text()), '')
  assert.equal(wiz.finaleRan(), true)
  assert.equal(await fs.readFile(fx.settingsPath, 'utf8'), claudeSettings('proxy'))
})

test('a fresh install is not checked, even with a proxy marker on disk', async () => {
  const fx = await makeHome({ settings: claudeSettings('proxy') })
  const p = await writeFromFile(fx.hypHome, { version: 2, plugins: [{ name: GATEWAY }] })
  assert.equal(await dispatch(['setup', '--from-file', p], fx.opts), 0, fx.stderr.text())
  await fs.access(fx.configPath)
  assert.equal(await fs.readFile(fx.settingsPath, 'utf8'), claudeSettings('proxy'))
})

test('an already-migrated install proceeds and its settings are left alone', async () => {
  for (const mode of ['otel', 'base_url']) {
    const fx = await makeHome({ config: EXISTING, settings: claudeSettings(mode) })
    const p = await writeFromFile(fx.hypHome, { version: 2, plugins: [{ name: GATEWAY }] })
    assert.equal(await dispatch(['setup', '--from-file', p, '--force'], fx.opts), 0, `${mode}: ${fx.stderr.text()}`)
    assert.equal(await fs.readFile(fx.settingsPath, 'utf8'), claudeSettings(mode))

    const dry = await makeHome({ config: EXISTING, settings: claudeSettings(mode) })
    const before = await snapshot(dry.home)
    const code = await dispatch(['setup', '--yes', '--no-daemon', '--source', 'otel', '--dry-run', '--force'], dry.opts)
    assert.equal(code, 0, `${mode} dry-run: ${dry.stderr.text()}`)
    assert.deepEqual(await snapshot(dry.home), before)
  }
})

// @ref LLP 0524#unreadable [tests]: refused, named, and no file content in the message
test('an unreadable settings file is refused without quoting it', async () => {
  const secret = 'sk-ant-do-not-echo-0000'
  const fx = await makeHome({
    config: EXISTING,
    settings: `{"env":{"ANTHROPIC_API_KEY":"${secret}"},"_hypaware":{"mode":"proxy"`,
  })
  const p = await writeFromFile(fx.hypHome, { version: 2, plugins: [{ name: GATEWAY }] })
  const before = await snapshot(fx.home)
  assert.equal(await dispatch(['setup', '--from-file', p, '--force'], fx.opts), 1)
  const line = refusalLine(fx.stderr.text())
  assert.match(line, /cannot read claude's settings/)
  assert.ok(line.includes(fx.settingsPath), line)
  assert.ok(!fx.stderr.text().includes(secret), 'the settings content is never echoed')
  assert.ok(!fx.stdout.text().includes(secret))
  assert.deepEqual(await snapshot(fx.home), before)
})

// @ref LLP 0524#central [tests]: a central layer that names the gateway governs the proxy, so the local write is not checked
test('a central layer that names the gateway lets the write through', async () => {
  const fx = await makeHome({ config: EXISTING, settings: claudeSettings('proxy') })
  const control = path.join(fx.hypHome, 'hypaware', 'state')
  await fs.mkdir(control, { recursive: true })
  await fs.writeFile(path.join(control, 'managed-config.seed.json'), JSON.stringify({
    version: 2,
    plugins: [{ name: GATEWAY, enabled: true, config: { proxy_mode: true } }],
  }))
  const p = await writeFromFile(fx.hypHome, { version: 2, plugins: [{ name: GATEWAY }] })
  assert.equal(await dispatch(['setup', '--from-file', p, '--force'], fx.opts), 0, fx.stderr.text())
  assert.equal(await fs.readFile(fx.settingsPath, 'utf8'), claudeSettings('proxy'))
})
