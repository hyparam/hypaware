// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_RETENTION_DAYS } from '../../src/core/cache/retention.js'
import {
  parsePlanArgv,
  parseRunArgv,
  resolveRetentionDays,
  runBackfill,
  runBackfillPlan,
  runBackfillProvider,
  selectProviders,
} from '../../src/core/commands/backfill.js'
import {
  createBackfillMaterializerRegistry,
  createBackfillRegistry,
} from '../../src/core/registry/backfills.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

/* ------------------------------ parseRunArgv ------------------------------ */

test('parseRunArgv collects providers and flags in space and = forms', () => {
  const parsed = parseRunArgv([
    'claude', '--since', '2026-01-01', '--until=2026-02-01',
    '--retention-days', '7', '--dry-run', '--json', 'codex',
  ])
  assert.deepEqual(parsed, {
    providers: ['claude', 'codex'],
    since: '2026-01-01',
    until: '2026-02-01',
    retentionDays: 7,
    dryRun: true,
    json: true,
  })
})

test('parseRunArgv defaults flags off and keeps date window unset', () => {
  assert.deepEqual(parseRunArgv([]), { providers: [], dryRun: false, json: false })
})

test('parseRunArgv reports usage errors for bad input', () => {
  assert.ok('error' in parseRunArgv(['--nope']))
  assert.ok('error' in parseRunArgv(['--retention-days', 'abc']))
  assert.ok('error' in parseRunArgv(['--retention-days', '-3']))
  assert.ok('error' in parseRunArgv(['--since']))
  assert.ok('error' in parseRunArgv(['--since', 'notadate']))
  assert.ok('error' in parseRunArgv(['--until', 'notadate']))
  assert.ok('error' in parseRunArgv(['--since', '2026-01-02', '--until', '2026-01-01']))
  assert.ok('error' in parseRunArgv(['--help']))
})

test('parseRunArgv accepts an equal since/until boundary', () => {
  assert.deepEqual(parseRunArgv([
    '--since', '2026-01-01T00:00:00.000Z',
    '--until', '2026-01-01T00:00:00.000Z',
  ]), {
    providers: [],
    since: '2026-01-01T00:00:00.000Z',
    until: '2026-01-01T00:00:00.000Z',
    dryRun: false,
    json: false,
  })
})

/* ------------------------------ parsePlanArgv ----------------------------- */

test('parsePlanArgv accepts retention-days but rejects since/until', () => {
  assert.deepEqual(parsePlanArgv(['claude', '--retention-days=14', '--json']), {
    providers: ['claude'],
    retentionDays: 14,
    json: true,
  })
  assert.ok('error' in parsePlanArgv(['--since', '2026-01-01']))
  assert.ok('error' in parsePlanArgv(['--until', '2026-01-01']))
})

/* ----------------------------- selectProviders ---------------------------- */

/** @param {string} name @param {string} plugin */
function prov(name, plugin) {
  return { name, plugin, datasets: ['ai_gateway_messages'], async *run() {} }
}

test('selectProviders intersects explicit names and reports unknowns', () => {
  const available = [prov('claude', '@hypaware/claude'), prov('codex', '@hypaware/codex')]
  const sel = selectProviders({ requested: ['claude', 'ghost'], available, activePlugins: [] })
  assert.deepEqual(sel.providers.map((p) => p.name), ['claude'])
  assert.deepEqual(sel.unknown, ['ghost'])
})

test('selectProviders defaults to providers whose plugin is enabled in config', () => {
  const available = [prov('claude', '@hypaware/claude'), prov('codex', '@hypaware/codex')]
  const activePlugins = [
    { name: '@hypaware/claude', enabled: true },
    { name: '@hypaware/codex', enabled: false },
  ]
  const sel = selectProviders({ requested: [], available, activePlugins })
  assert.deepEqual(sel.providers.map((p) => p.name), ['claude'])
  assert.deepEqual(sel.unknown, [])
})

/* --------------------------- resolveRetentionDays ------------------------- */

test('resolveRetentionDays prefers the flag, then config, then the default', () => {
  const withConfig = /** @type {any} */ ({ query: { cache: { retention: { default_days: 12 } } } })
  assert.equal(resolveRetentionDays({ flag: 5, config: withConfig }), 5)
  assert.equal(resolveRetentionDays({ config: withConfig }), 12)
  assert.equal(resolveRetentionDays({ config: /** @type {any} */ ({}) }), DEFAULT_RETENTION_DAYS)
  // A negative flag is ignored and resolution falls through to config.
  assert.equal(resolveRetentionDays({ flag: -1, config: withConfig }), 12)
})

/* ------------------------------- runBackfill ------------------------------ */

/**
 * Build a minimal `CommandRunContext` stub plus spies for the storage
 * writes the runner performs. Only the fields `runBackfill` touches are
 * provided; the double-cast keeps the stub focused.
 *
 * @param {{
 *   item?: { dataset: string, kind: string, value: Record<string, unknown> },
 *   registerMaterializer?: boolean,
 *   materializerDataset?: string,
 *   materializeRows?: Record<string, unknown>[],
 *   registeredDatasets?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   config?: Record<string, unknown>,
 *   plugins?: { name: string }[],
 * }} [options]
 */
function makeCtx(options = {}) {
  const item = options.item ?? { dataset: 'ds', kind: 'test.kind', value: { x: 1 } }
  const registerMaterializer = options.registerMaterializer ?? true
  const materializerDataset = options.materializerDataset ?? item.dataset
  const materializeRows = options.materializeRows ?? [{ a: 1 }]
  const registeredDatasets = new Set(options.registeredDatasets ?? ['ds'])

  const backfills = createBackfillRegistry()
  /** @type {any[]} */
  const runContexts = []
  /** @type {any[]} */
  const planContexts = []
  backfills.register({
    name: 'tester',
    plugin: '@test/plugin',
    datasets: [item.dataset],
    async plan(planCtx) {
      planContexts.push(planCtx)
      return undefined
    },
    async *run(runCtx) {
      runContexts.push(runCtx)
      yield item
    },
  })
  const backfillMaterializers = createBackfillMaterializerRegistry()
  if (registerMaterializer) {
    backfillMaterializers.register({
      kind: item.kind,
      dataset: materializerDataset,
      plugin: '@test/plugin',
      materialize() { return materializeRows },
    })
  }

  /** @type {Array<{ tablePath: string, rows: Record<string, unknown>[] }>} */
  const appended = []
  /** @type {Array<{ tablePath: string }>} */
  const flushed = []
  const storage = {
    cacheRoot: '/tmp/fake-cache',
    /** @param {string} dataset @param {string[]} segs */
    cacheTablePath(dataset, segs) { return `/tmp/fake-cache/datasets/${dataset}/${segs.join('/')}` },
    /** @param {string} tablePath @param {unknown} _columns @param {Record<string, unknown>[]} rows */
    async appendRows(tablePath, _columns, rows) { appended.push({ tablePath, rows }) },
    /** @param {string} tablePath */
    async flushTable(tablePath) { flushed.push({ tablePath }) },
  }
  const query = {
    /** @param {string} name */
    getDataset(name) {
      if (!registeredDatasets.has(name)) return undefined
      return {
        name,
        plugin: '@test/plugin',
        schema: { columns: [{ name: 'a', type: 'INT32', nullable: true }] },
        discoverPartitions() { return [] },
        createDataSource() { return /** @type {any} */ ({}) },
      }
    },
    registerDataset() {},
    listDatasets() { return [] },
  }
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const err = []
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: options.env ?? {},
    config: options.config ?? {},
    ...(options.plugins ? { plugins: options.plugins } : {}),
    stdout: { write: (/** @type {string} */ s) => { out.push(s); return true } },
    stderr: { write: (/** @type {string} */ s) => { err.push(s); return true } },
    backfills,
    backfillMaterializers,
    query,
    storage,
  }))
  return { ctx, appended, flushed, out, err, runContexts, planContexts }
}

test('runBackfill materializes rows, appends to the dataset path, and flushes', async () => {
  const { ctx, appended, flushed } = makeCtx()
  const code = await runBackfill(['tester'], ctx)
  assert.equal(code, 0)
  assert.equal(appended.length, 1)
  assert.deepEqual(appended[0].rows, [{ a: 1 }])
  assert.equal(appended[0].tablePath, '/tmp/fake-cache/datasets/ds/backfill')
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].tablePath, '/tmp/fake-cache/datasets/ds/backfill')
})

test('runBackfill --dry-run scans without appending or flushing any rows', async () => {
  const { ctx, appended, flushed } = makeCtx()
  const code = await runBackfill(['tester', '--dry-run'], ctx)
  assert.equal(code, 0)
  assert.equal(appended.length, 0, 'dry-run must not append rows')
  assert.equal(flushed.length, 0, 'dry-run must not flush')
})

test('runBackfill --json reports per-provider counts', async () => {
  const { ctx, out } = makeCtx()
  const code = await runBackfill(['tester', '--json'], ctx)
  assert.equal(code, 0)
  const payload = JSON.parse(out.join(''))
  assert.equal(payload.providers.length, 1)
  assert.equal(payload.providers[0].provider, 'tester')
  assert.equal(payload.providers[0].status, 'ok')
  assert.equal(payload.providers[0].rows_written, 1)
})

for (const scenario of [
  {
    name: 'materializer_missing',
    options: { registerMaterializer: false },
  },
  {
    name: 'dataset_mismatch',
    options: { materializerDataset: 'other_ds' },
  },
  {
    name: 'dataset_not_registered',
    options: {
      item: { dataset: 'missing_ds', kind: 'test.kind', value: { x: 1 } },
      materializerDataset: 'missing_ds',
      registeredDatasets: [],
    },
  },
]) {
  test(`runBackfill --json marks provider failed for ${scenario.name}`, async () => {
    const { ctx, out } = makeCtx(scenario.options)
    const code = await runBackfill(['tester', '--json'], ctx)
    assert.notEqual(code, 0)
    const payload = JSON.parse(out.join(''))
    assert.equal(payload.providers.length, 1)
    assert.equal(payload.providers[0].provider, 'tester')
    assert.equal(payload.providers[0].status, 'failed')
  })
}

test('runBackfill fails with exit 1 for an unknown explicit provider', async () => {
  const { ctx, err } = makeCtx()
  const code = await runBackfill(['ghost'], ctx)
  assert.equal(code, 1)
  assert.ok(err.join('').includes('unknown provider'))
})

for (const scenario of [
  {
    name: 'invalid --since',
    argv: ['--since', 'notadate'],
    message: '--since expects a parseable date',
  },
  {
    name: 'invalid --until',
    argv: ['--until', 'notadate'],
    message: '--until expects a parseable date',
  },
  {
    name: '--since after --until',
    argv: ['--since', '2026-01-02', '--until', '2026-01-01'],
    message: '--since must be before or equal to --until',
  },
]) {
  test(`runBackfill fails with exit 2 for ${scenario.name}`, async () => {
    const { ctx, err } = makeCtx()
    const code = await runBackfill(scenario.argv, ctx)
    assert.equal(code, 2)
    assert.ok(err.join('').includes(scenario.message))
  })
}

/* --------------------------- runBackfillProvider -------------------------- */

test('runBackfillProvider runs one provider and returns compact counts + appends', async () => {
  const { ctx, appended, flushed } = makeCtx()
  const result = await runBackfillProvider({ ctx, provider: 'tester', dryRun: false })
  assert.deepEqual(result, { ok: true, scanned: 1, rowsWritten: 1, skipped: 0 })
  assert.equal(appended.length, 1)
  assert.equal(flushed.length, 1)
})

test('runBackfillProvider dry-run scans without appending or flushing', async () => {
  const { ctx, appended, flushed } = makeCtx()
  const result = await runBackfillProvider({ ctx, provider: 'tester', dryRun: true })
  assert.deepEqual(result, { ok: true, scanned: 1, rowsWritten: 0, skipped: 0 })
  assert.equal(appended.length, 0, 'dry-run must not append rows')
  assert.equal(flushed.length, 0, 'dry-run must not flush')
})

test('runBackfillProvider reports a failed result for an unknown provider', async () => {
  const { ctx, appended } = makeCtx()
  const result = await runBackfillProvider({ ctx, provider: 'ghost', dryRun: false })
  assert.deepEqual(result, { ok: false, scanned: 0, rowsWritten: 0, skipped: 0 })
  assert.equal(appended.length, 0)
})

/* --------------------- entrypoint ownership: "configured" ------------------ */

/**
 * Write a local config document and return an env that points the runner
 * at it. `HYP_HOME` is set too so the state dir the catalog is discovered
 * from is a scratch dir rather than the developer's real one.
 *
 * @param {string[]} pluginNames
 * @returns {NodeJS.ProcessEnv}
 */
function envWithConfig(pluginNames) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-owners-'))
  const configPath = path.join(home, 'hypaware-config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({ version: 2, plugins: pluginNames.map((name) => ({ name })) }),
    'utf8'
  )
  return { HYP_HOME: home, HYP_CONFIG: configPath }
}

// The regression this pins: `hyp init` boots the `all-available` profile,
// which by construction never activates a `V1_EXCLUDED_FROM_DEFAULT` plugin
// like `@hypaware/claude-desktop`, and the picker cannot change an
// activation set fixed at process start. Deriving "configured" from the
// activation set therefore gated Desktop history out of the finale's own
// backfill for a user who had just ticked the row and accepted the consent
// prompt, contradicting LLP 0139 and LLP 0140 on that very path.
// @ref LLP 0140#manifest-declares-ownership [tests]: "configured" is membership of the effective config, not of the boot profile's activation set
test('the entrypoint gate counts a config-listed plugin as configured even when this process never activated it', async () => {
  const { ctx, runContexts } = makeCtx({
    env: envWithConfig(['@hypaware/claude', '@hypaware/claude-account', '@hypaware/claude-desktop']),
    plugins: [{ name: '@hypaware/claude' }],
  })
  const result = await runBackfillProvider({ ctx, provider: 'tester', dryRun: true })
  assert.equal(result.ok, true)

  const owners = runContexts[0]?.entrypointOwners
  assert.ok(owners instanceof Map, 'the runner hands the provider a resolved owner map')
  assert.equal(owners.get('claude-desktop')?.plugin, '@hypaware/claude-desktop')
  assert.equal(
    owners.get('claude-desktop')?.configured,
    true,
    'ticking the picker row wrote the plugin into the config, so its history may import'
  )
})

test('the entrypoint gate stays closed for a plugin in neither the config nor the activation set', async () => {
  const { ctx, runContexts } = makeCtx({
    env: envWithConfig(['@hypaware/claude']),
    plugins: [{ name: '@hypaware/claude' }],
  })
  await runBackfillProvider({ ctx, provider: 'tester', dryRun: true })

  const owners = runContexts[0]?.entrypointOwners
  assert.equal(owners.get('claude-desktop')?.configured, false, 'no opt-in: Desktop sessions are gated')
  assert.equal(owners.get('cli')?.configured, true, 'the scanning client itself is configured')
})

test('a plugin listed with enabled:false is not configured', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-owners-'))
  const configPath = path.join(home, 'hypaware-config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/claude' }, { name: '@hypaware/claude-desktop', enabled: false }],
  }), 'utf8')
  const { ctx, runContexts } = makeCtx({
    env: { HYP_HOME: home, HYP_CONFIG: configPath },
    plugins: [{ name: '@hypaware/claude' }],
  })
  await runBackfillProvider({ ctx, provider: 'tester', dryRun: true })
  assert.equal(runContexts[0]?.entrypointOwners.get('claude-desktop')?.configured, false)
})

// `entrypointOwners` is declared on `BackfillPlanContext`, so a provider
// that consults it while planning has to see the same answer the run will,
// or `hyp backfill plan` estimates over sessions the run then gates out.
test('hyp backfill plan hands providers the same entrypoint owner map the run gets', async () => {
  const { ctx, planContexts } = makeCtx({
    env: envWithConfig(['@hypaware/claude']),
    plugins: [{ name: '@hypaware/claude' }],
    config: { version: 2, plugins: [{ name: '@test/plugin' }] },
  })
  const code = await runBackfillPlan(['tester'], ctx)
  assert.equal(code, 0)
  const owners = planContexts[0]?.entrypointOwners
  assert.ok(owners instanceof Map, 'the plan context carries the resolved owner map')
  assert.equal(owners.get('claude-desktop')?.configured, false)
})
