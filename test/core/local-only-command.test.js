// @ts-check

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { asyncRow } from 'squirreling'

import { listCapturedDirectories, runLocalOnlyPicker } from '../../src/core/commands/local_only.js'
import { readLocalOnlyDirs, writeLocalOnlyDirs } from '../../src/core/usage-policy/local_only.js'

/**
 * @import { CapturedDirectory } from '../../src/core/commands/types.js'
 */

// `src/core/commands/local_only.js` (LLP 0081 T5): the login-time enumeration
// query (LLP 0069 #enumerate) and the interactive picker (LLP 0072). The
// picker tests inject a `listCandidates` stub instead of a real query engine
// so they can exercise TTY-gating, cancellation, and editor semantics in
// isolation from squirreling.

/** @param {(dir: string) => Promise<void> | void} fn */
async function withTempStateDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-local-only-cmd-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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
  assert.equal(result, null, 'an unregistered dataset must not throw out of the picker')
})

/* ------------------------------ runLocalOnlyPicker ------------------------ */

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/** Fake TTY pair: PassThrough streams flagged `isTTY: true`, matching the pattern in test/core/cli/tui/runtime.test.js. */
function makeTty() {
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  Object.defineProperty(stdin, 'isTTY', { value: true })
  Object.defineProperty(stderr, 'isTTY', { value: true })
  Object.defineProperty(stdin, 'isRaw', { value: false, writable: true })
  // @ts-expect-error: PassThrough does not declare setRawMode; the runtime probes for it.
  stdin.setRawMode = (enabled) => { /** @type {any} */ (stdin).isRaw = enabled }
  /** @type {string[]} */
  const written = []
  stderr.on('data', (chunk) => written.push(String(chunk)))
  return { stdin, stderr, output: () => written.join('') }
}

/**
 * @param {import('node:stream').PassThrough} stdin
 * @param {string[]} chunks
 */
async function feed(stdin, chunks) {
  for (const c of chunks) {
    stdin.write(c)
    await new Promise((r) => setImmediate(r))
  }
}

/** @returns {CapturedDirectory[]} */
function candidates(n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    cwd: `/work/proj-${i}`,
    repoRoot: `/work/proj-${i}`,
    rows: i + 1,
    lastSeen: '2026-07-01',
  }))
}

test('runLocalOnlyPicker: non-TTY stdin skips the prompt, zero exclusions, prints the durable-command hint', async () => {
  await withTempStateDir(async (stateDir) => {
    const stdin = new PassThrough() // isTTY undefined => not a TTY
    const stderr = makeBuf()
    const ctx = /** @type {any} */ ({ stdin, stderr, env: {} })

    const result = await runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => candidates(3),
    })

    assert.equal(result.outcome, 'non_tty')
    assert.equal(result.selectedCount, 0)
    assert.deepEqual(result.excludedDirs, [])
    assert.match(stderr.text(), /hyp ignore --local-only/)
    assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [], 'a skipped picker must never write')
  })
})

test('runLocalOnlyPicker: an empty candidate list skips the prompt with the durable-command hint', async () => {
  await withTempStateDir(async (stateDir) => {
    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: {} })

    const result = await runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => [],
    })

    assert.equal(result.outcome, 'no_candidates')
    assert.equal(result.candidateCount, 0)
    assert.match(io.output(), /hyp ignore --local-only/)
  })
})

test('runLocalOnlyPicker: a failed enumeration (null) skips with the hint, never throws', async () => {
  await withTempStateDir(async (stateDir) => {
    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: {} })

    const result = await runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => null,
    })

    assert.equal(result.outcome, 'enumeration_failed')
    assert.match(io.output(), /hyp ignore --local-only/)
  })
})

test('runLocalOnlyPicker: Ctrl-C cancels the prompt and proceeds with zero exclusions, never writing', async () => {
  await withTempStateDir(async (stateDir) => {
    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: { NO_COLOR: '1' } })

    const promise = runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => candidates(2),
    })
    await feed(io.stdin, ['\x03']) // Ctrl-C
    const result = await promise

    assert.equal(result.outcome, 'cancelled')
    assert.equal(result.selectedCount, 0)
    assert.deepEqual(result.excludedDirs, [], 'no prior list existed, so cancel leaves it empty')
    assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [], 'a cancelled picker must never write')
  })
})

test('runLocalOnlyPicker: cancelling on a re-login leaves a prior selection completely untouched', async () => {
  await withTempStateDir(async (stateDir) => {
    const priorDir = path.resolve('/work/proj-0')
    await writeLocalOnlyDirs({ stateDir, dirs: [priorDir] })

    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: { NO_COLOR: '1' } })

    const promise = runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => candidates(2),
    })
    await feed(io.stdin, ['\x03'])
    const result = await promise

    assert.equal(result.outcome, 'cancelled')
    assert.deepEqual(result.excludedDirs, [priorDir], 'cancel never discards a prior session\'s choices')
    assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [priorDir])
  })
})

test('runLocalOnlyPicker: confirming with nothing checked persists zero exclusions (default is exclude-nothing)', async () => {
  await withTempStateDir(async (stateDir) => {
    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: { NO_COLOR: '1' } })

    const promise = runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => candidates(2),
    })
    await feed(io.stdin, ['\r']) // enter with nothing toggled
    const result = await promise

    assert.equal(result.outcome, 'none')
    assert.equal(result.selectedCount, 0)
    assert.deepEqual(result.excludedDirs, [])
    assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [])
    assert.doesNotMatch(io.output(), /withholding/, 'nothing withheld => no never-silent line')
  })
})

test('runLocalOnlyPicker: toggling and confirming persists the selection and prints the never-silent line', async () => {
  await withTempStateDir(async (stateDir) => {
    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: { NO_COLOR: '1' } })

    const promise = runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => candidates(2),
    })
    // space (toggle proj-0) → enter
    await feed(io.stdin, [' ', '\r'])
    const result = await promise

    assert.equal(result.outcome, 'selected')
    assert.equal(result.selectedCount, 1)
    assert.deepEqual(result.excludedDirs, [path.resolve('/work/proj-0')])
    assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [path.resolve('/work/proj-0')])
    assert.match(io.output(), /withholding 1 directory from forwarding — recorded locally, never sent/)
  })
})

test('runLocalOnlyPicker: pre-checks candidates already on the list (editor semantics)', async () => {
  await withTempStateDir(async (stateDir) => {
    const already = path.resolve('/work/proj-1')
    await writeLocalOnlyDirs({ stateDir, dirs: [already] })

    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: { NO_COLOR: '1' } })

    const promise = runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => candidates(2), // proj-0, proj-1
    })
    // Confirm immediately: the already-listed candidate should already be
    // checked, so an untouched enter reconfirms exactly that one directory.
    await feed(io.stdin, ['\r'])
    const result = await promise

    assert.equal(result.outcome, 'selected')
    assert.deepEqual(result.excludedDirs, [already])
    assert.match(io.output(), /\[x\].*proj-1/s, 'the pre-existing entry is rendered pre-checked')
  })
})

test('runLocalOnlyPicker: an unchecked-and-confirmed prior selection is removed, while non-candidate entries are preserved', async () => {
  await withTempStateDir(async (stateDir) => {
    const shown = path.resolve('/work/proj-0') // will be offered as a candidate this run
    const vanished = path.resolve('/work/no-longer-captured') // NOT offered this run
    await writeLocalOnlyDirs({ stateDir, dirs: [shown, vanished] })

    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: { NO_COLOR: '1' } })

    const promise = runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => candidates(1), // only proj-0 is offered
    })
    // Untoggle the pre-checked proj-0, then confirm.
    await feed(io.stdin, [' ', '\r'])
    const result = await promise

    assert.equal(result.outcome, 'none')
    assert.deepEqual(
      result.excludedDirs,
      [vanished],
      'the offered-and-unchecked entry is removed; the not-offered entry survives untouched'
    )
    assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [vanished])
  })
})

test('runLocalOnlyPicker: caps presentation at 50 and prints an overflow hint for the rest', async () => {
  await withTempStateDir(async (stateDir) => {
    const io = makeTty()
    const ctx = /** @type {any} */ ({ stdin: io.stdin, stderr: io.stderr, env: { NO_COLOR: '1' } })

    const promise = runLocalOnlyPicker({
      ctx,
      stateDir,
      listCandidates: async () => candidates(55),
    })
    await feed(io.stdin, ['\r'])
    const result = await promise

    assert.equal(result.candidateCount, 55)
    assert.match(io.output(), /…and 5 more/)
  })
})
