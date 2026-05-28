// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RETENTION_DAYS } from '../../src/core/cache/retention.js'
import {
  parsePlanArgv,
  parseRunArgv,
  resolveRetentionDays,
  runBackfill,
  selectProviders,
} from '../../src/core/commands/backfill.js'
import {
  createBackfillMaterializerRegistry,
  createBackfillRegistry,
} from '../../src/core/registry/backfills.js'

/**
 * @import { CommandRunContext } from '../../collectivus-plugin-kernel-types.d.ts'
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
  assert.ok('error' in parseRunArgv(['--help']))
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
 */
function makeCtx() {
  const backfills = createBackfillRegistry()
  backfills.register({
    name: 'tester',
    plugin: '@test/plugin',
    datasets: ['ds'],
    async *run() {
      yield { dataset: 'ds', kind: 'test.kind', value: { x: 1 } }
    },
  })
  const backfillMaterializers = createBackfillMaterializerRegistry()
  backfillMaterializers.register({
    kind: 'test.kind',
    dataset: 'ds',
    plugin: '@test/plugin',
    materialize() { return [{ a: 1 }] },
  })

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
      if (name !== 'ds') return undefined
      return {
        name: 'ds',
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
    env: {},
    config: {},
    stdout: { write: (/** @type {string} */ s) => { out.push(s); return true } },
    stderr: { write: (/** @type {string} */ s) => { err.push(s); return true } },
    backfills,
    backfillMaterializers,
    query,
    storage,
  }))
  return { ctx, appended, flushed, out, err }
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

test('runBackfill fails with exit 1 for an unknown explicit provider', async () => {
  const { ctx, err } = makeCtx()
  const code = await runBackfill(['ghost'], ctx)
  assert.equal(code, 1)
  assert.ok(err.join('').includes('unknown provider'))
})
