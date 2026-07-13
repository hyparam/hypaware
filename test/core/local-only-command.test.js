// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { asyncRow } from 'squirreling'

import { listCapturedDirectories } from '../../src/core/commands/local_only.js'

/**
 * @import { CapturedDirectory } from '../../src/core/commands/types.js'
 */

// `src/core/commands/local_only.js`: the captured-directory enumeration query
// (LLP 0069 #enumerate) that the hypaware-privacy skill's survey drives. The
// in-login picker that once lived here is retired (LLP 0102); its editor
// semantics are gone with it.

/* ------------------------- listCapturedDirectories ------------------------ */

/**
 * Build a minimal in-memory `ai_gateway_messages` dataset so
 * `executeQuerySql` can run the real enumeration `GROUP BY`/aggregate query
 * against fixed rows (same pattern as `test/core/ignore-command.test.js`'s
 * `makeAiGatewayCache`, extended with the `date` column the enumeration
 * query aggregates on).
 *
 * @param {Record<string, unknown>[]} data
 */
function makeAiGatewayCache(data) {
  const columns = ['cwd', 'repo_root', 'date']
  const dataset = {
    name: 'ai_gateway_messages',
    plugin: 'test',
    schema: { columns: columns.map((name) => ({ name, type: 'string' })) },
    discoverPartitions: async () => [],
    createDataSource: () => ({
      numRows: data.length,
      columns,
      /** @param {{ columns?: string[] }} [opts] */
      scan(opts) {
        const cols = opts?.columns ?? columns
        return {
          async *rows() {
            for (const obj of data) yield asyncRow(/** @type {any} */ (obj), cols)
          },
          appliedWhere: false,
          appliedLimitOffset: false,
        }
      },
    }),
  }
  const query = {
    getDataset: (/** @type {string} */ name) => (name === 'ai_gateway_messages' ? dataset : undefined),
    listDatasets: () => [dataset],
  }
  const storage = { cacheRoot: '/tmp/hyp-local-only-test', pendingInfo: async () => ({ pending: false }) }
  return { query, storage }
}

test('listCapturedDirectories: groups by cwd, carries repo_root/rows/last_seen, most-recent first', async () => {
  const { query, storage } = makeAiGatewayCache([
    { cwd: '/repo/a', repo_root: '/repo/a', date: '2026-07-01' },
    { cwd: '/repo/a', repo_root: '/repo/a', date: '2026-07-03' },
    { cwd: '/repo/b', repo_root: null, date: '2026-06-01' },
  ])

  const result = await listCapturedDirectories({ query: /** @type {any} */ (query), storage: /** @type {any} */ (storage) })
  assert.ok(result)
  const dirs = /** @type {CapturedDirectory[]} */ (result)
  assert.equal(dirs.length, 2, 'one candidate per distinct cwd')

  const a = dirs.find((d) => d.cwd === '/repo/a')
  assert.ok(a)
  assert.equal(a?.rows, 2, 'the two /repo/a rows are aggregated into one candidate')
  assert.equal(a?.repoRoot, '/repo/a')
  assert.equal(a?.lastSeen, '2026-07-03')

  const b = dirs.find((d) => d.cwd === '/repo/b')
  assert.ok(b)
  assert.equal(b?.repoRoot, null, 'a null repo_root (Codex) is preserved, not stringified')

  // Most-recently-active first (R3).
  assert.deepEqual(dirs.map((d) => d.cwd), ['/repo/a', '/repo/b'])
})

test('listCapturedDirectories: a cwd is not offered when it has never been captured', async () => {
  const { query, storage } = makeAiGatewayCache([])
  const result = await listCapturedDirectories({ query: /** @type {any} */ (query), storage: /** @type {any} */ (storage) })
  assert.deepEqual(result, [])
})

test('listCapturedDirectories: best-effort — a broken registry resolves to null, never throws', async () => {
  const query = /** @type {any} */ ({
    getDataset: () => undefined,
    listDatasets: () => [],
  })
  const storage = /** @type {any} */ ({ cacheRoot: '/tmp/hyp-local-only-missing', pendingInfo: async () => ({ pending: false }) })
  const result = await listCapturedDirectories({ query, storage })
  assert.equal(result, null, 'an unregistered dataset resolves to null, never throws')
})

