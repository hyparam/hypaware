// @ts-check

// Export-seam source-scoped withholding (LLP 0188): the shared export read
// (`storage.readRowsSince`) withholds a row attributed (via the dataset's
// declared `attribution_column`) to a withheld picker source (an opted-out
// source on an enrolled machine), but still surfaces its `after` so the
// cursor advances across it (drop-but-advance, mirroring the existing
// `cwd`/`local-only` filter's continuation semantics). A dataset with no
// declared `attribution_column` is never subject to per-row withholding,
// the conservative default; a dataset whose every contributing source is
// withheld is dropped wholesale via `shouldWithholdDataset`
// (LLP 0188 #enforcement-scope).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createSourceWithholdResolver } from '../../src/core/cache/source-withhold.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.d.ts'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-source-withhold-'))
}

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
]

test('readRowsSince: rows attributed to a withheld source are dropped from the payload but the cursor advances across them', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' }, // not withheld -> shipped
    { id: 2, client_name: 'hermes' }, // withheld -> dropped
    { id: 3, client_name: 'hermes' }, // withheld -> dropped
    // Empty/null attribution passes HERE only because this hand-built
    // resolver has no datasetOwnedSourceIds map, so the LLP 0192
    // fail-closed rule cannot fire; the production resolver always has
    // the map (see the fail-closed test below).
    { id: 4, client_name: '' },
    { id: 5, client_name: null },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shippedIds = []
  let droppedCount = 0
  let prev = -1n
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      const cur = BigInt(entry.after.seq)
      assert.ok(cur >= prev, 'the `after` cursor never regresses, even across a drop')
      prev = cur
      if (entry.dropped) {
        droppedCount += 1
        assert.equal(entry.row, undefined, 'a drop-only entry carries no row payload')
      } else {
        shippedIds.push(Number(entry.row.id))
      }
    }
  }

  assert.deepEqual(shippedIds.sort((a, b) => a - b), [1, 4, 5], 'only rows not attributed to a withheld source reach the payload')
  assert.equal(droppedCount, 2, 'both hermes-attributed rows are withheld')

  // Cache-but-never-forward, not a capture-time drop: withheld rows stay
  // fully queryable locally through the unfiltered `readRows` scan.
  /** @type {number[]} */
  const cachedIds = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const row of svc.readRows(part.path)) cachedIds.push(Number(row.id))
  }
  assert.deepEqual(cachedIds.sort((a, b) => a - b), [1, 2, 3, 4, 5], 'all rows remain locally queryable in the cache')

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: a dataset with no declared attribution_column is never subject to source-scoped withholding', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    // `hermes` is withheld, but `datasetAttributionColumns` has no entry for
    // the `demo` dataset this test writes to, the conservative default.
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['some-other-dataset', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' },
    { id: 2, client_name: 'hermes' }, // would be withheld under a governed dataset, but this one isn't governed
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shippedIds = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      assert.ok(!entry.dropped && entry.row, 'no attribution_column for this dataset ⇒ nothing is ever withheld')
      shippedIds.push(Number(entry.row.id))
    }
  }
  assert.deepEqual(shippedIds.sort((a, b) => a - b), [1, 2])

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: with no sourceWithholdResolver configured, nothing is ever withheld on attribution', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot }) // no sourceWithholdResolver
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' },
    { id: 2, client_name: 'hermes' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const ids = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      assert.ok(!entry.dropped && entry.row, 'no resolver ⇒ every entry is a payload row')
      ids.push(Number(entry.row.id))
    }
  }
  assert.deepEqual(ids.sort((a, b) => a - b), [1, 2])

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: a `columns` projection omitting the attribution column still withholds, and shipped rows come back without it', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' },
    { id: 2, client_name: 'hermes' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {Record<string, unknown>[]} */
  const shipped = []
  let droppedCount = 0
  for (const part of await svc.discoverCachePartitions()) {
    // Caller asks for `id` only, NOT `client_name`. Withholding must not
    // depend on the caller remembering to project the attribution column in.
    for await (const entry of svc.readRowsSince(part.path, { columns: ['id'] })) {
      if (entry.dropped) {
        droppedCount += 1
      } else {
        shipped.push(entry.row)
      }
    }
  }

  assert.equal(droppedCount, 1, 'the hermes-attributed row is still withheld despite the projection')
  assert.deepEqual(shipped, [{ id: 1n }], 'the shipped row is the projected columns only')
  assert.ok(!('client_name' in shipped[0]), "the forced-in attribution column is stripped back off, the caller's projection contract is honored")

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: a dataset with no attribution column whose every owning source is withheld is dropped wholesale, cursor still advancing', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['otel'],
      datasetAttributionColumns: new Map(),
      datasetOwnedSourceIds: new Map([['demo', ['otel']]]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: null },
    { id: 2, client_name: null },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  let droppedCount = 0
  let prev = -1n
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      const cur = BigInt(entry.after.seq)
      assert.ok(cur >= prev, 'drop-but-advance holds for the dataset-scoped drop too')
      prev = cur
      assert.ok(entry.dropped, 'every row of a wholly-withheld dataset is dropped')
      droppedCount += 1
    }
  }
  assert.equal(droppedCount, 2)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

// The arming set is the dataset's declared owners (`datasetOwnedSourceIds`),
// not every source that writes into it, so this fixture hands the resolver
// an explicit owner list.
// @ref LLP 0192#fail-closed [tests]: an unattributed row cannot be tied to a synced source, so one standing opt-out among the dataset's declared owners withholds it (`some`, not `every`)
test('readRowsSince: unattributed rows in an attributed dataset are withheld once any owning source is opted out (fail closed)', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
      datasetOwnedSourceIds: new Map([['demo', ['claude', 'hermes']]]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' }, // attributed to a synced source -> ships
    { id: 2, client_name: 'hermes' }, // attributed to the opted-out source -> dropped
    { id: 3, client_name: '' }, // unattributed -> dropped (fail closed)
    { id: 4, client_name: null }, // unattributed -> dropped (fail closed)
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shippedIds = []
  let droppedCount = 0
  let prev = -1n
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      const cur = BigInt(entry.after.seq)
      assert.ok(cur >= prev, 'drop-but-advance holds for the fail-closed drop too')
      prev = cur
      if (entry.dropped) droppedCount += 1
      else shippedIds.push(Number(entry.row.id))
    }
  }
  assert.deepEqual(shippedIds, [1], 'only the row provably attributed to a synced source ships')
  assert.equal(droppedCount, 3)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: with no opt-out standing, unattributed rows still ship (the fail-closed rule is inert)', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: [],
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
      datasetOwnedSourceIds: new Map([['demo', ['claude', 'hermes']]]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: null },
    { id: 2, client_name: '' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shippedIds = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      if (!entry.dropped) shippedIds.push(Number(entry.row.id))
    }
  }
  assert.deepEqual(shippedIds.sort((a, b) => a - b), [1, 2], 'default-sync is unchanged until a real opt-out exists')

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: the provider form of withheldSourceIds is consulted live, so an opt-out lands mid-run without a rebuild', async () => {
  const cacheRoot = await makeTmpDir()
  /** @type {Set<string>} */
  let withheld = new Set()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: () => withheld,
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'hermes' },
    { id: 2, client_name: 'claude' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  const readIds = async () => {
    /** @type {number[]} */
    const out = []
    for (const part of await svc.discoverCachePartitions()) {
      for await (const entry of svc.readRowsSince(part.path, {})) {
        if (!entry.dropped) out.push(Number(entry.row.id))
      }
    }
    return out.sort((a, b) => a - b)
  }

  assert.deepEqual(await readIds(), [1, 2], 'nothing withheld before the opt-out')
  withheld = new Set(['hermes'])
  assert.deepEqual(await readIds(), [2], 'the provider is re-consulted, so the opt-out applies without rebuilding the resolver')

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: cwd-based and source-scoped withholding compose independently', async () => {
  const cacheRoot = await makeTmpDir()
  /** @type {ColumnSpec[]} */
  const cols = [
    { name: 'id', type: 'INT64', nullable: false },
    { name: 'client_name', type: 'STRING', nullable: true },
    { name: 'cwd', type: 'STRING', nullable: true },
  ]
  const svc = createQueryStorageService({
    cacheRoot,
    usagePolicyResolver: {
      resolve: (cwd) => (cwd === '/work/secret' ? { class: 'local-only', governedBy: '/list', declared: 'local-only' } : { class: 'full', governedBy: null, declared: null }),
      isIgnored: () => false,
    },
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, cols, [
    { id: 1, client_name: 'claude', cwd: '/work/public' }, // shipped
    { id: 2, client_name: 'hermes', cwd: '/work/public' }, // withheld by source
    { id: 3, client_name: 'claude', cwd: '/work/secret' }, // withheld by cwd
    { id: 4, client_name: 'hermes', cwd: '/work/secret' }, // withheld by both
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shippedIds = []
  let droppedCount = 0
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      if (entry.dropped) droppedCount += 1
      else shippedIds.push(Number(entry.row.id))
    }
  }
  assert.deepEqual(shippedIds, [1], 'only the row cleared by both filters ships')
  assert.equal(droppedCount, 3)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

// --- aliased-client opt-out (LLP 0346) ---------------------------------------
//
// `claude-desktop` is a real picker id, so `hyp privacy client claude-desktop
// local-only` writes a real opt-out entry, but Desktop's live rows land under
// `client_name: "claude"` with a Desktop-owned `entrypoint` (LLP 0133
// #attribution). Keyed on the picker id and tested against `client_name`, that
// entry matched nothing and the rows kept shipping. The refinement reads the
// `entrypoint` a client's manifest claims, scoped to the clients that declare
// entrypoint ownership so a hermes row (whose own interactive `entrypoint` is
// literally `cli`, a value the claude client claims) is never reinterpreted.

/** @type {ColumnSpec[]} */
const ALIAS_COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'entrypoint', type: 'STRING', nullable: true },
]

/** The shipped `transcript_entrypoints` declarations, as the catalog folds them. */
const SHIPPED_ENTRYPOINT_OWNERS = new Map([
  ['cli', 'claude'],
  ['sdk-cli', 'claude'],
  ['claude-desktop', 'claude-desktop'],
  ['claude-desktop-3p', 'claude-desktop'],
])

/**
 * Run the export read over `rows` with `withheld` opted out, and report which
 * ids reached the payload.
 * @param {{ withheld: string[], rows: Record<string, unknown>[], columns?: string[] }} args
 * @returns {Promise<{ shipped: number[], dropped: number }>}
 */
async function runAliasExport({ withheld, rows, columns }) {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: withheld,
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
      clientEntrypointOwners: SHIPPED_ENTRYPOINT_OWNERS,
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, ALIAS_COLS, rows)
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shipped = []
  let dropped = 0
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, columns ? { columns } : {})) {
      if (entry.dropped) dropped += 1
      else shipped.push(Number(entry.row.id))
    }
  }
  await fs.rm(cacheRoot, { recursive: true, force: true })
  return { shipped: shipped.sort((a, b) => a - b), dropped }
}

// @ref LLP 0346#entrypoint-refinement [tests]: the opt-out of a client that stamps another client's `client_name` is enforced through the entrypoint its manifest claims, and reaches no other client's rows
test('readRowsSince: opting out claude-desktop withholds its live rows (client_name "claude") without touching Claude Code rows', async () => {
  const { shipped, dropped } = await runAliasExport({
    withheld: ['claude-desktop'],
    rows: [
      // Claude Code, the client the user did NOT opt out. Must still ship:
      // over-withholding here is a different broken promise, not a fix.
      { id: 1, client_name: 'claude', entrypoint: 'cli' },
      { id: 2, client_name: 'claude', entrypoint: 'sdk-cli' },
      // Desktop's live third-party-inference route: the defect. Stamped
      // `client_name: "claude"` by design (LLP 0133), so the id-keyed opt-out
      // could never match it.
      { id: 3, client_name: 'claude', entrypoint: 'claude-desktop-3p' },
      // Desktop's shared-tree value, same route in an older build.
      { id: 4, client_name: 'claude', entrypoint: 'claude-desktop' },
      // Desktop's backfilled rows already carry the owner's name.
      { id: 5, client_name: 'claude-desktop', entrypoint: 'claude-desktop' },
      // A client that declares no entrypoint ownership: its own `cli` value
      // belongs to its vocabulary, not claude's.
      { id: 6, client_name: 'hermes', entrypoint: 'cli' },
    ],
  })
  assert.deepEqual(shipped, [1, 2, 6], 'only the clients the user kept syncing reach the payload')
  assert.equal(dropped, 3, 'both live Desktop rows and the backfilled one are withheld')
})

test('readRowsSince: opting out claude still withholds every claude-attributed row, and reaches no client that merely shares an entrypoint value', async () => {
  const { shipped, dropped } = await runAliasExport({
    withheld: ['claude'],
    rows: [
      { id: 1, client_name: 'claude', entrypoint: 'cli' },
      // Unchanged by the refinement: the `client_name` test alone already
      // withholds this, so nothing that was withheld before ships now.
      { id: 2, client_name: 'claude', entrypoint: 'claude-desktop-3p' },
      { id: 3, client_name: 'claude', entrypoint: null },
      // hermes stamps its session source as the entrypoint, and `cli` is one
      // of its interactive values. Reading it as claude's claim would withhold
      // a client the user never opted out.
      { id: 4, client_name: 'hermes', entrypoint: 'cli' },
      { id: 5, client_name: 'codex', entrypoint: 'codex_cli' },
      { id: 6, client_name: 'claude-desktop', entrypoint: 'claude-desktop' },
    ],
  })
  assert.deepEqual(shipped, [4, 5, 6], 'the opt-out stops at the client it names')
  assert.equal(dropped, 3)
})

test('readRowsSince: a `columns` projection omitting `entrypoint` still enforces the aliased-client opt-out', async () => {
  const { shipped, dropped } = await runAliasExport({
    withheld: ['claude-desktop'],
    columns: ['id'],
    rows: [
      { id: 1, client_name: 'claude', entrypoint: 'cli' },
      { id: 2, client_name: 'claude', entrypoint: 'claude-desktop-3p' },
    ],
  })
  assert.deepEqual(shipped, [1], 'the guarantee never rides on the caller projecting the column in')
  assert.equal(dropped, 1)
})

// The two residuals LLP 0346 #consequences states, pinned so they are
// retired deliberately rather than discovered. Both are rows the seam
// cannot tell apart from a Claude Code row: `client_name: "claude"` with
// an `entrypoint` no manifest claims, or none at all. Only the
// capture-side attribution fix LLP 0192 defers can close them, and when it
// lands these expectations flip.
// @ref LLP 0346#local-agent-residual [tests]: the current attached-Desktop build tags its transcripts with an unclaimed container value, so a claude-desktop-only opt-out does not reach its live rows
test('readRowsSince: a claude-desktop opt-out does not reach a live row tagged with an unclaimed container entrypoint', async () => {
  const { shipped, dropped } = await runAliasExport({
    withheld: ['claude-desktop'],
    rows: [
      // Desktop app 1.13576.0 / embedded CLI 2.1.177 (LLP 0133
      // #attribution). `local-agent` names a CLI mode, not a client, so
      // Desktop's manifest deliberately does not claim it.
      { id: 1, client_name: 'claude', entrypoint: 'local-agent' },
      // The projector could not correlate the exchange to a transcript, so
      // the row has no second axis to read at all.
      { id: 2, client_name: 'claude', entrypoint: null },
      // The claimed value, for contrast: this one is withheld.
      { id: 3, client_name: 'claude', entrypoint: 'claude-desktop-3p' },
    ],
  })
  assert.deepEqual(shipped, [1, 2], 'the stated residuals: unclaimed and absent entrypoints still ship')
  assert.equal(dropped, 1)
})
