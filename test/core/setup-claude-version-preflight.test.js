// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { activate as activateClaude } from '../../hypaware-core/plugins-workspace/claude/src/index.js'
import { preflightPickedClients } from '../../src/core/cli/walkthrough.js'
import { runInitWizard } from '../../src/core/cli/wizard/index.js'
import { wizardItinerary } from '../../src/core/cli/wizard/steps.js'

// Issue #975 part 2. Setup asks the picked Claude Code adapter for its version
// verdict once the selection is final and before anything is written: below
// the attach floor it says so and skips Claude's attach, between the floors it
// notes the missing detail and proceeds, and at or above the floor, or when
// the version cannot be read, it says nothing. The Claude adapter here is the
// real plugin's registration, so the verdict and the attach are the shipped
// ones; only the gateway around it and a second client are stand-ins.
// @ref LLP 0532#boundary [tests]: the verdict lands before the config, configure, or any settings write
// @ref LLP 0532#refusal [tests]: a refusal skips only Claude's attach; the other clients are byte-identical

const SETTINGS_SEED = '{\n  "theme": "dark"\n}\n'

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A temp home with a seeded Claude settings file, the real Claude adapter
 * registered on a stand-in gateway, and a stand-in `codex` adapter that
 * records its calls and writes its own file. `version` becomes the
 * `HYP_CLAUDE_CODE_VERSION` override, the seam the hermetic smokes use; the
 * preflight is wrapped only to count calls.
 *
 * @param {string} label
 * @param {string} version
 */
async function rig(label, version) {
  const home = temporaryDirectory(`hyp-975-${label}-`)
  const hypHome = path.join(home, '.hyp')
  const env = { HOME: home, HYP_HOME: hypHome, HYP_NO_TUI: '1', HYP_CLAUDE_CODE_VERSION: version }
  const settingsPath = path.join(home, '.claude', 'settings.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, SETTINGS_SEED)

  /** @type {any} */
  let registered
  const pluginGateway = {
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    registerClient(/** @type {any} */ client) { registered = client },
  }
  await activateClaude(/** @type {any} */ ({
    env,
    paths: { stateDir: path.join(hypHome, 'plugins', 'claude') },
    plugin: { version: '0.0.0-test' },
    configRegistry: { registerSection() {} },
    requireCapability: () => pluginGateway,
    backfills: { register() {} },
    commands: { register() {} },
    skills: { register() {} },
    agents: { register() {} },
    initPresets: { register() {} },
    query: { registerDataset() {} },
  }))

  let preflights = 0
  /** @type {{ client: string, endpoint: string | undefined, dryRun: boolean }[]} */
  const codexCalls = []
  const codexFile = path.join(home, '.codex', 'attached')
  const adapters = /** @type {Record<string, any>} */ ({
    claude: {
      ...registered,
      async preflight() {
        preflights += 1
        return registered.preflight()
      },
    },
    codex: {
      name: 'codex',
      async attach(/** @type {any} */ attachCtx) {
        codexCalls.push({ client: 'codex', endpoint: attachCtx.endpoint, dryRun: attachCtx.dryRun === true })
        if (attachCtx.dryRun) return
        await fs.mkdir(path.dirname(codexFile), { recursive: true })
        await fs.writeFile(codexFile, 'codex attached\n')
      },
    },
  })
  const capabilities = /** @type {any} */ ({
    has: (/** @type {string} */ name) => name === 'hypaware.ai-gateway',
    require: () => ({
      getClient: (/** @type {string} */ name) => adapters[name],
      localEndpoint: () => 'http://127.0.0.1:4388',
    }),
  })
  return {
    home,
    hypHome,
    env,
    settingsPath,
    codexFile,
    codexCalls,
    capabilities,
    registered,
    preflightCalls: () => preflights,
    configPath: path.join(hypHome, 'hypaware-config.json'),
  }
}

/**
 * The picker's result for a non-interactive run over `clients`. The config
 * is pending so the wizard's own commit writes it, which is what lets a test
 * see whether the preflight spoke before that write.
 *
 * @param {Awaited<ReturnType<typeof rig>>} r
 * @param {string[]} clients
 */
function picked(r, clients) {
  return {
    exitCode: 0,
    configPath: r.configPath,
    config: { version: 2, plugins: [] },
    configPending: true,
    sourcesPicked: clients,
    exportPicked: 'local-parquet',
    clientsPicked: clients,
    retentionDays: 30,
    descriptors: [],
    lockedSources: [],
  }
}

/**
 * Run the real wizard, non-interactive unless `interactive` is set, with the
 * real finale (daemon skipped). The stderr buffer records, for every chunk
 * that names Claude Code, whether the config had landed by then.
 *
 * @param {Awaited<ReturnType<typeof rig>>} r
 * @param {string[]} clients
 * @param {{ dryRun?: boolean, interactive?: boolean }} [opts]
 */
async function wizard(r, clients, opts = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {boolean[]} */
  const configLandedAtClaudeLine = []
  const recordingStderr = {
    /** @param {string} chunk */
    write(chunk) {
      if (/Claude Code \d/.test(String(chunk))) configLandedAtClaudeLine.push(fsSync.existsSync(r.configPath))
      return stderr.write(chunk)
    },
  }
  /** @type {string | undefined} */
  let stderrAtConfigure
  /** @type {string | undefined} */
  let pickProgress
  /** @type {any} */
  let finaleArgs
  const result = await runInitWizard(/** @type {any} */ ({
    stdout,
    stderr: recordingStderr,
    env: r.env,
    ctx: { commands: { run: async () => 0 } },
    capabilities: r.capabilities,
    catalog: {
      plugins: new Map(),
      pluginMetadata: new Map(),
      knownDatasets: new Set(),
      clientDescriptors: new Map(),
      pickerDescriptors: new Map(),
    },
    finale: { skipDaemon: true, ...(opts.dryRun ? { dryRun: true } : {}) },
    ...(opts.interactive
      ? {
        fork: async () => 'local',
        express: async () => 'choose',
        folderAsk: async () => ({ mode: 'sync' }),
        // The attended finale asks about the history import; this test is
        // about the attach lane, so the finale is recorded rather than run.
        finaleRunner: async (/** @type {any} */ args) => {
          finaleArgs = args
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
      }
      : { picks: { sources: clients, exportChoice: 'keep-local', retentionDays: 30 } }),
    gate: async () => ({ action: 'first-run', managed: false, report: {} }),
    pick: async (/** @type {any} */ o) => {
      pickProgress = o?.progress
      return picked(r, clients)
    },
    configure: async () => {
      stderrAtConfigure = stderr.text()
      return { results: [] }
    },
    suggestSkill: { launchable: false },
  }))
  return {
    result,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stderrAtConfigure,
    configLandedAtClaudeLine,
    finaleArgs: () => finaleArgs,
    pickProgress,
  }
}

const REFUSAL =
  "Claude Code 2.1.100 is older than 2.1.193, the first release HypAware can record. Setup will not attach Claude Code; your other choices continue. Run 'claude update', then 'hyp client attach claude'.\n"

/** The lines of `text` that mention codex, which must not move with Claude's verdict. @param {string} text */
const codexLines = (text) => text.split('\n').filter((line) => line.includes('codex')).join('\n')

test('below the attach floor: Claude is refused before any write, its settings untouched, codex attaches as before', async () => {
  const old = await rig('below', '2.1.100')
  const run = await wizard(old, ['claude', 'codex'])

  assert.equal(run.result.exitCode, 0, 'a refused attach keeps the warn-and-continue exit')
  assert.equal(run.stderr, REFUSAL, 'said once, with the update and retry actions')
  assert.deepEqual(run.configLandedAtClaudeLine, [false], 'said before the config was written')
  assert.equal(run.stderrAtConfigure, REFUSAL, 'and before configure acted')
  assert.equal(await fs.readFile(old.settingsPath, 'utf8'), SETTINGS_SEED, 'Claude settings byte-identical')
  assert.deepEqual(
    run.result.finale?.attach.map((/** @type {any} */ a) => [a.client, a.ok]),
    [['claude', false], ['codex', true]]
  )
  assert.match(run.stdout, /^attach: claude failed$/m)
  assert.doesNotMatch(run.stdout, /claude attached/)

  // The same pick with a current Claude: codex's call, file and output lines
  // are the same, so the refusal touched nothing but Claude.
  const current = await rig('below-control', '2.1.233')
  const control = await wizard(current, ['claude', 'codex'])
  assert.deepEqual(old.codexCalls, current.codexCalls)
  assert.equal(await fs.readFile(old.codexFile, 'utf8'), await fs.readFile(current.codexFile, 'utf8'))
  assert.equal(codexLines(run.stdout), codexLines(control.stdout))
  assert.equal(codexLines(run.stderr), codexLines(control.stderr))
  assert.equal(control.result.exitCode, 0)
})

test('between the floors: one note, and Claude attaches', async () => {
  const r = await rig('between', '2.1.200')
  const run = await wizard(r, ['claude', 'codex'])

  assert.equal(run.result.exitCode, 0)
  assert.equal(
    run.stderr,
    "note: Claude Code 2.1.200 is recorded, but tool-decision detail needs 2.1.214 or newer. Run 'claude update' to get it.\n"
  )
  assert.deepEqual(run.configLandedAtClaudeLine, [false])
  assert.deepEqual(
    run.result.finale?.attach.map((/** @type {any} */ a) => [a.client, a.ok]),
    [['claude', true], ['codex', true]]
  )
  const settings = JSON.parse(await fs.readFile(r.settingsPath, 'utf8'))
  assert.equal(settings.theme, 'dark')
  assert.equal(settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY, '1', 'the real attach wrote its env block')
})

for (const version of ['2.1.214', '2.1.233']) {
  test(`at or above the floors (${version}): nothing said, Claude attaches`, async () => {
    const r = await rig(`at-${version}`, version)
    const run = await wizard(r, ['claude', 'codex'])
    assert.equal(run.result.exitCode, 0)
    assert.equal(run.stderr, '')
    assert.equal(r.preflightCalls(), 1)
    assert.deepEqual(
      run.result.finale?.attach.map((/** @type {any} */ a) => [a.client, a.ok]),
      [['claude', true], ['codex', true]]
    )
    assert.notEqual(await fs.readFile(r.settingsPath, 'utf8'), SETTINGS_SEED)
  })
}

test('an unknown or unparseable version proceeds silently', async () => {
  // The registration's verdict for each reading the resolver can return
  // when it cannot tell. The probe itself is not run here: the seam it
  // goes through is covered in test/plugins/claude-version.test.js.
  const r = await rig('unknown', '2.1.233')
  const { claudeVersionPreflight } = await import('../../hypaware-core/plugins-workspace/claude/src/claude_version.js')
  for (const reading of [undefined, '', 'Claude Code (dev build)', 'v2']) {
    assert.deepEqual(claudeVersionPreflight(reading), {}, String(reading))
  }
  // And through setup, with an adapter whose resolver could not tell.
  const unknownAdapter = { ...r.registered, preflight: async () => claudeVersionPreflight(undefined) }
  const stderr = makeBuf()
  const refused = await preflightPickedClients({
    clientsPicked: ['claude'],
    config: { version: 2, plugins: [] },
    capabilities: /** @type {any} */ ({
      has: () => true,
      require: () => ({ getClient: () => unknownAdapter }),
    }),
    stderr,
  })
  assert.equal(refused.size, 0)
  assert.equal(stderr.text(), '')
})

test('claude not picked: an old Claude installed runs no check, and codex output is byte-identical', async () => {
  const old = await rig('notpicked-old', '2.1.100')
  const current = await rig('notpicked-current', '2.1.233')
  const a = await wizard(old, ['codex'])
  const b = await wizard(current, ['codex'])

  assert.equal(old.preflightCalls(), 0, 'the preflight was never asked')
  assert.equal(current.preflightCalls(), 0)
  assert.equal(a.stderr, '')
  assert.equal(a.stdout.replaceAll(old.home, '<home>'), b.stdout.replaceAll(current.home, '<home>'))
  assert.equal(a.stderr, b.stderr)
  assert.deepEqual(old.codexCalls, current.codexCalls)
  assert.equal(await fs.readFile(old.settingsPath, 'utf8'), SETTINGS_SEED)
})

test('dry run: the read-only preflight still speaks, and nothing is attached or written', async () => {
  const r = await rig('dryrun', '2.1.100')
  const run = await wizard(r, ['claude', 'codex'], { dryRun: true })

  assert.equal(run.result.exitCode, 0)
  assert.equal(run.stderr, REFUSAL)
  assert.equal(fsSync.existsSync(r.configPath), false)
  assert.equal(await fs.readFile(r.settingsPath, 'utf8'), SETTINGS_SEED)
  assert.deepEqual(
    run.result.finale?.attach.map((/** @type {any} */ a) => [a.client, a.dryRun, a.ok]),
    [['claude', true, false], ['codex', true, true]]
  )
  assert.deepEqual(r.codexCalls, [{ client: 'codex', endpoint: 'http://127.0.0.1:4388', dryRun: true }])
})

// The preflight asks nothing, so it is not a counted lane (LLP 0135
// #progress): the attended run's denominator is the local itinerary's.
test('interactive: the same refusal at the same point, handed to the finale, denominator unchanged', async () => {
  const r = await rig('interactive', '2.1.100')
  const run = await wizard(r, ['claude', 'codex'], { interactive: true })

  assert.equal(run.result.exitCode, 0)
  assert.equal(run.stderr, REFUSAL)
  assert.deepEqual(run.configLandedAtClaudeLine, [false])
  assert.equal(run.stderrAtConfigure, REFUSAL)
  assert.deepEqual([...run.finaleArgs().preflightRefused], ['claude'])
  assert.deepEqual(wizardItinerary('local'), ['pick', 'finale'])
  assert.match(String(run.pickProgress), /^Step 1 of 2 · /)
  for (const m of run.stdout.matchAll(/Step \d+ of (\d+)/g)) assert.equal(m[1], '2')
  assert.equal(await fs.readFile(r.settingsPath, 'utf8'), SETTINGS_SEED)
})

test('a detached Claude and a preflight that throws give no verdict', async () => {
  let asked = 0
  const stderr = makeBuf()
  const refuse = async () => { asked += 1; return { refuse: 'no' } }
  const refused = await preflightPickedClients({
    clientsPicked: ['claude', 'codex'],
    config: { version: 2, plugins: [{ name: '@hypaware/claude', recording: false }] },
    capabilities: /** @type {any} */ ({
      has: () => true,
      require: () => ({
        getClient: (/** @type {string} */ name) => name === 'claude'
          ? { name, attach: async () => {}, preflight: refuse }
          : { name, attach: async () => {}, preflight: async () => { throw new Error('probe broke') } },
      }),
    }),
    stderr,
  })
  assert.equal(asked, 0, 'a client whose recording is off is not asked')
  assert.equal(refused.size, 0)
  assert.equal(stderr.text(), '')
})
