// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { withLogRecords } from '../helpers/log_records.js'
import { bootKernel } from '../../src/core/runtime/boot.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { runPickerFinale, writeWalkthroughRunSummary } from '../../src/core/cli/walkthrough.js'
import { runInitWizard } from '../../src/core/cli/wizard/index.js'

// Issue #596. The setup finale's attach lane read "no adapter in the registry"
// as Claude Desktop's deliberate no-attach posture (LLP 0180, LLP 0115
// #no-attach-on-join), so a picked client whose owning plugin's `activate()`
// threw was skipped as `ok: true, noAdapter: true` with nothing printed, and a
// solo pick with no gateway skipped the lane outright. Every case here loads
// real plugin directories through the real loader: the owners that throw are
// actual manifests and entrypoints, not stubbed registries.
// @ref LLP 0522#decision [tests]:

/**
 * Where the fixture adapters record their attach calls. The fixture modules
 * run in this process, so a global is the one channel both sides share.
 * @returns {{ client: string, endpoint: string | undefined }[]}
 */
function attachCalls() {
  const g = /** @type {any} */ (globalThis)
  g.__hypWt596AttachCalls ??= []
  return g.__hypWt596AttachCalls
}

const SECRET = 'sk-PLACEHOLDER-NOT-A-REAL-KEY'

/** An adapter body that records its call and writes nothing. */
const ATTACH = (/** @type {string} */ client) => `
  async attach(attachCtx) {
    globalThis.__hypWt596AttachCalls.push({ client: ${JSON.stringify(client)}, endpoint: attachCtx.endpoint })
  },`

/**
 * The four owners. Names are real bundled names because the bundled
 * allowlist is a fixed name set; the bodies are this test's own.
 */
const FIXTURES = {
  // Registers its adapter, then throws: a partial registration the loader
  // does not roll back, so the registry still answers for `claude`.
  claude: {
    name: '@hypaware/claude',
    body: `ctx.clients.registerClient({ name: 'claude', requiresEndpoint: false, ${ATTACH('claude')} })
  throw new Error('half way through activation')`,
  },
  // Throws before registering anything, with a credential-shaped string in
  // both the message and the claimed `hypErrorKind`; neither may reach the
  // output.
  codex: {
    name: '@hypaware/codex',
    body: `throw Object.assign(new Error('could not read token ${SECRET}'), { hypErrorKind: '${SECRET}' })`,
  },
  // Healthy and endpoint-free (LLP 0306).
  opencode: {
    name: '@hypaware/opencode',
    body: `ctx.clients.registerClient({ name: 'opencode', requiresEndpoint: false, ${ATTACH('opencode')} })
  ctx.commands.register({
    name: 'opencode probe',
    plugin: '@hypaware/opencode',
    summary: 'Record what the command context carried',
    usage: 'hyp opencode probe',
    run: async (argv, runCtx) => {
      globalThis.__hypWt596Activations = runCtx.activations
      return 0
    },
  })`,
    commands: [{ name: 'opencode probe', summary: 'Record what the command context carried' }],
  },
  // Healthy and deliberately adapterless (LLP 0115 #no-attach-on-join).
  'claude-desktop': {
    name: '@hypaware/claude-desktop',
    body: '',
  },
}

/**
 * Stage the fixture plugins under a workspace dir and write a config that
 * enables them.
 *
 * @param {string} home
 * @returns {Promise<{ hypHome: string, workspaceDir: string, configPath: string }>}
 */
async function stageFixtures(home) {
  const hypHome = path.join(home, '.hyp')
  const workspaceDir = path.join(home, 'workspace')
  for (const [client, fixture] of Object.entries(FIXTURES)) {
    const dir = path.join(workspaceDir, client)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'hypaware.plugin.json'),
      JSON.stringify({
        schema_version: 1,
        name: fixture.name,
        version: '2.0.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
        contributes: {
          client: { name: client, skill_dir: `.${client}/skills` },
          ...('commands' in fixture ? { commands: fixture.commands } : {}),
        },
      })
    )
    await fs.writeFile(path.join(dir, 'index.js'), `export async function activate(ctx) {\n  ${fixture.body}\n}\n`)
  }
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.mkdir(hypHome, { recursive: true })
  await fs.writeFile(
    configPath,
    JSON.stringify({ version: 2, plugins: Object.values(FIXTURES).map((f) => ({ name: f.name, config: {} })) })
  )
  return { hypHome, workspaceDir, configPath }
}

/** @param {string} label */
async function bootFixtures(label) {
  const home = temporaryDirectory(`hyp-wt596-${label}-`)
  const { hypHome, workspaceDir, configPath } = await stageFixtures(home)
  const boot = await bootKernel({
    hypHome,
    configPath,
    workspaceDir,
    mode: 'smoke',
    runId: `wt596-${label}`,
    env: { ...process.env, HYP_HOME: hypHome },
  })
  attachCalls().length = 0
  return { home, hypHome, configPath, boot }
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
 * Run the real finale over a real boot, attach lane only.
 *
 * @param {Awaited<ReturnType<typeof bootFixtures>>} booted
 * @param {string[]} clientsPicked
 */
async function finale(booted, clientsPicked) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const summary = await runPickerFinale({
    finale: { skipDaemon: true },
    clientsPicked,
    capabilities: booted.boot.runtime.capabilities,
    clients: booted.boot.runtime.clients,
    activations: booted.boot.activations,
    config: { version: 2, plugins: [] },
    configPath: booted.configPath,
    env: { HOME: booted.home, HYP_HOME: booted.hypHome },
    stdout,
    stderr,
    retentionDays: 30,
    interactive: false,
  })
  return { summary, stdout: stdout.text(), stderr: stderr.text() }
}

const CLAUDE_LINE =
  "attach claude failed: plugin @hypaware/claude did not activate (activate_failed). Run 'hyp status' to see why, then 'hyp client attach claude' once it loads.\n"
const CODEX_LINE =
  "attach codex failed: plugin @hypaware/codex did not activate (activate_failed). Run 'hyp status' to see why, then 'hyp client attach codex' once it loads.\n"

test('the fixture owners really threw through the real loader', async () => {
  const booted = await bootFixtures('loader')
  const failed = booted.boot.activations.filter((r) => !r.ok).map((r) => r.plugin.manifest.name).sort()
  assert.deepEqual(failed, ['@hypaware/claude', '@hypaware/codex'])
  // The loader records the kind the throw claimed, so the finale is what keeps
  // it off the output.
  const codex = booted.boot.activations.find((r) => r.plugin.manifest.name === '@hypaware/codex')
  assert.equal(codex && !codex.ok && codex.errorKind, SECRET)
  // The partial registration stayed behind: this is what the old lane would
  // have attached through.
  assert.ok(booted.boot.runtime.clients.getClient('claude'))
  assert.equal(booted.boot.runtime.clients.getClient('codex'), undefined)
})

test('a solo pick whose owner threw, with no gateway, is reported as not attached', async () => {
  const booted = await bootFixtures('solo')
  assert.equal(booted.boot.runtime.capabilities.has('hypaware.ai-gateway'), false)

  const { result, records } = await withLogRecords(() => finale(booted, ['codex']))

  assert.deepEqual(result.summary.attach, [
    { client: 'codex', dryRun: false, ok: false, activationFailed: true, plugin: '@hypaware/codex', errorKind: 'activate_failed' },
  ])
  assert.equal(result.stderr, CODEX_LINE)
  assert.equal(result.stderr.includes(SECRET), false, 'neither the thrown message nor its claimed kind is printed')
  assert.equal(JSON.stringify(result.summary).includes(SECRET), false, 'nor carried on the summary')
  assert.deepEqual(attachCalls(), [])

  const log = records.find((r) => r.body === 'walkthrough.attach_owner_not_active')
  assert.ok(log, 'the lane logged the failed owner')
  assert.equal(log.attributes.hyp_plugin, '@hypaware/codex')
  assert.equal(log.attributes.hyp_client, 'codex')
  assert.equal(log.attributes.error_kind, 'activate_failed')
  assert.equal(log.attributes.status, 'failed')
  assert.equal(JSON.stringify(log).includes(SECRET), false, 'nor logged here')

  // The scripted run summary reports it as failed, not silently skipped.
  const summaryOut = makeBuf()
  writeWalkthroughRunSummary({ stdout: summaryOut, configPath: booted.configPath, finaleSummary: result.summary, dryRun: false })
  assert.match(summaryOut.text(), /^attach: codex failed$/m)
})

test('a partial registration followed by a throw is never attached through', async () => {
  const booted = await bootFixtures('partial')
  const result = await finale(booted, ['claude'])

  assert.deepEqual(result.summary.attach, [
    { client: 'claude', dryRun: false, ok: false, activationFailed: true, plugin: '@hypaware/claude', errorKind: 'activate_failed' },
  ])
  assert.equal(result.stderr, CLAUDE_LINE)
  assert.deepEqual(attachCalls(), [], 'the adapter the failed owner registered was not called')
  assert.doesNotMatch(result.stdout, /claude attached/)
})

test('a mixed pick attaches the healthy clients and reports each failed one', async () => {
  const booted = await bootFixtures('mixed')
  const result = await finale(booted, ['claude', 'opencode', 'codex', 'claude-desktop'])

  assert.deepEqual(result.summary.attach, [
    { client: 'claude', dryRun: false, ok: false, activationFailed: true, plugin: '@hypaware/claude', errorKind: 'activate_failed' },
    { client: 'opencode', dryRun: false, ok: true },
    { client: 'codex', dryRun: false, ok: false, activationFailed: true, plugin: '@hypaware/codex', errorKind: 'activate_failed' },
    { client: 'claude-desktop', dryRun: false, ok: true, noAdapter: true },
  ])
  assert.equal(result.stderr, CLAUDE_LINE + CODEX_LINE)
  assert.match(result.stdout, /✓ opencode attached/)
  // Only the healthy endpoint-free owner was attached, and with no endpoint.
  assert.deepEqual(attachCalls(), [{ client: 'opencode', endpoint: undefined }])
})

test('an activated adapterless Claude Desktop stays a silent not-applicable skip', async () => {
  const booted = await bootFixtures('desktop')
  // Alone, with no gateway and no adapter picked, the lane has nothing to do
  // and records nothing at all, as before.
  const solo = await finale(booted, ['claude-desktop'])
  assert.deepEqual(solo.summary.attach, [])
  assert.equal(solo.stderr, '')
  // Beside an attachable client it enters the lane and is still skipped as
  // not applicable, never as a failure.
  const result = await finale(booted, ['opencode', 'claude-desktop'])
  assert.deepEqual(result.summary.attach, [
    { client: 'opencode', dryRun: false, ok: true },
    { client: 'claude-desktop', dryRun: false, ok: true, noAdapter: true },
  ])
  assert.equal(result.stderr, '')
  assert.doesNotMatch(result.stdout, /claude-desktop/)
  const summaryOut = makeBuf()
  writeWalkthroughRunSummary({ stdout: summaryOut, configPath: booted.configPath, finaleSummary: result.summary, dryRun: false })
  assert.doesNotMatch(summaryOut.text(), /claude-desktop/)
})

test('an endpoint-free adapter still attaches on its own', async () => {
  const booted = await bootFixtures('endpointfree')
  const result = await finale(booted, ['opencode'])
  assert.deepEqual(result.summary.attach, [{ client: 'opencode', dryRun: false, ok: true }])
  assert.deepEqual(attachCalls(), [{ client: 'opencode', endpoint: undefined }])
  assert.equal(result.stderr, '')
})

test('without activation outcomes the lane keeps its existing reading', async () => {
  // A direct caller that passes no activations has said nothing about the
  // owners; the lane does not invent a failure, and the absence is not
  // treated as proof of success either (it only keeps the old behavior).
  const booted = await bootFixtures('unknown')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const summary = await runPickerFinale({
    finale: { skipDaemon: true },
    clientsPicked: ['codex', 'opencode'],
    capabilities: booted.boot.runtime.capabilities,
    clients: booted.boot.runtime.clients,
    config: { version: 2, plugins: [] },
    configPath: booted.configPath,
    env: { HOME: booted.home, HYP_HOME: booted.hypHome },
    stdout,
    stderr,
    retentionDays: 30,
    interactive: false,
  })
  assert.deepEqual(summary.attach, [
    { client: 'codex', dryRun: false, ok: true, noAdapter: true },
    { client: 'opencode', dryRun: false, ok: true },
  ])
  assert.equal(stderr.text(), '')
})

test('join-completed attach work is respected, not rerun or reported failed', async () => {
  const booted = await bootFixtures('joined')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const summary = await runPickerFinale({
    finale: { skipDaemon: true },
    clientsPicked: ['claude'],
    capabilities: booted.boot.runtime.capabilities,
    clients: booted.boot.runtime.clients,
    activations: booted.boot.activations,
    skipAttachClients: new Set(['claude']),
    config: { version: 2, plugins: [] },
    configPath: booted.configPath,
    env: { HOME: booted.home, HYP_HOME: booted.hypHome },
    stdout,
    stderr,
    retentionDays: 30,
    interactive: false,
  })
  assert.deepEqual(summary.attach, [{ client: 'claude', dryRun: false, ok: true, skipped: true }])
  assert.deepEqual(attachCalls(), [])
  assert.equal(stderr.text(), '')
})

test('dispatch hands a command the boot activation outcomes, message withheld', async () => {
  const home = temporaryDirectory('hyp-wt596-dispatch-')
  const { hypHome, workspaceDir, configPath } = await stageFixtures(home)
  const g = /** @type {any} */ (globalThis)
  g.__hypWt596Activations = undefined
  const code = await dispatch(['opencode', 'probe'], {
    stdout: makeBuf(),
    stderr: makeBuf(),
    workspaceDir,
    env: { ...process.env, HOME: home, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })
  assert.equal(code, 0)
  /** @type {any[]} */
  const seen = g.__hypWt596Activations
  assert.ok(Array.isArray(seen), 'the command context carries activations')
  const failed = seen.filter((a) => !a.ok)
  assert.deepEqual(
    failed.map((a) => [a.plugin.manifest.name, a.errorKind]).sort(),
    [['@hypaware/claude', 'activate_failed'], ['@hypaware/codex', 'activate_failed']]
  )
  for (const a of seen) assert.equal('message' in a, false, 'the raw thrown message is not on the context')
  assert.equal(JSON.stringify(failed.map((a) => a.errorKind)).includes(SECRET), false)
})

test('setup through the wizard exits non-zero when a picked client did not attach', async () => {
  const booted = await bootFixtures('wizard')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const result = await runInitWizard(/** @type {any} */ ({
    stdout,
    stderr,
    env: { HOME: booted.home, HYP_HOME: booted.hypHome, HYP_NO_TUI: '1' },
    // The same ctx fields dispatch fills from the boot.
    ctx: {
      commands: { run: async () => 0 },
      clients: booted.boot.runtime.clients,
      activations: booted.boot.activations.map((r) =>
        r.ok ? { ok: true, plugin: r.plugin } : { ok: false, plugin: r.plugin, errorKind: r.errorKind }
      ),
    },
    capabilities: booted.boot.runtime.capabilities,
    catalog: {
      plugins: new Map(),
      pluginMetadata: new Map(),
      knownDatasets: new Set(),
      clientDescriptors: new Map(),
      pickerDescriptors: new Map(),
    },
    finale: { skipDaemon: true },
    picks: { sources: ['claude', 'opencode'], exportChoice: 'keep-local', retentionDays: 30 },
    gate: async () => ({ action: 'first-run', managed: false, report: {} }),
    pick: async () => ({
      exitCode: 0,
      configPath: booted.configPath,
      config: { version: 2, plugins: [] },
      sourcesPicked: ['claude', 'opencode'],
      exportPicked: 'local-parquet',
      clientsPicked: ['claude', 'opencode'],
      retentionDays: 30,
      descriptors: [],
      lockedSources: [],
    }),
    configure: async () => ({ results: [] }),
    suggestSkill: { launchable: false },
  }))

  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.finale?.attach.map((a) => [a.client, a.ok]), [['claude', false], ['opencode', true]])
  assert.match(stderr.text(), /attach claude failed: plugin @hypaware\/claude did not activate \(activate_failed\)/)
  assert.match(stdout.text(), /^attach: claude failed$/m)
  assert.match(stdout.text(), /^attach: opencode ok$/m)
  assert.deepEqual(attachCalls(), [{ client: 'opencode', endpoint: undefined }])
})
