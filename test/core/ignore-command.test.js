// @ts-check

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { asyncRow } from 'squirreling'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'

/**
 * @import { CommandRegistration, CommandRunContext } from '../../collectivus-plugin-kernel-types.js'
 */

// `hyp ignore` / `hyp unignore` write and remove a `.hypignore` to gate folder
// capture (LLP 0049 #cli). The tests run the real command bodies against a
// real temp tree, so idempotency and `--check` reporting are exercised
// end-to-end through the same registry the dispatcher uses.

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

/** @param {string} name */
function getCommand(name) {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const command = registry.get(name)
  assert.ok(command, `${name} is registered`)
  return /** @type {CommandRegistration} */ (command)
}

/**
 * Run a registered command body the same way dispatch would, against a fake
 * CommandRunContext rooted at `cwd`.
 *
 * @param {string} name
 * @param {string[]} argv
 * @param {{ cwd: string, query?: unknown, storage?: unknown }} opts
 */
async function run(name, argv, opts) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    cwd: opts.cwd,
    env: {},
    config: { version: 2 },
    query: opts.query ?? { getDataset: () => undefined, listDatasets: () => [] },
    storage: opts.storage ?? { cacheRoot: path.join(opts.cwd, '.cache'), pendingInfo: async () => ({ pending: false }) },
  })
  const code = await getCommand(name).run(argv, /** @type {CommandRunContext} */ (ctx))
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/** @param {(dir: string) => Promise<void> | void} fn */
async function withTempTree(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hypign-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* --------------------------------- ignore -------------------------------- */

test('hyp ignore writes a self-documenting .hypignore at the git repo root', async () => {
  await withTempTree(async (root) => {
    mkdirSync(path.join(root, '.git'))
    const sub = path.join(root, 'src', 'deep')
    mkdirSync(sub, { recursive: true })

    const res = await run('ignore', [], { cwd: sub })
    assert.equal(res.code, 0)

    const file = path.join(root, '.hypignore')
    assert.ok(existsSync(file), 'wrote .hypignore at the repo root, not the cwd')
    assert.ok(!existsSync(path.join(sub, '.hypignore')), 'did not write a nested file')
    const body = readFileSync(file, 'utf8')
    assert.match(body, /^ignore$/m, 'first meaningful token is the ignore class')
    assert.match(body, /HypAware usage policy/, 'has a self-documenting comment header')
    assert.match(res.stdout, new RegExp(`wrote ${file.replace(/[.\\]/g, '\\$&')}`))
  })
})

test('hyp ignore without a repo writes .hypignore at the cwd', async () => {
  await withTempTree(async (root) => {
    // No `.git` anywhere under the temp tree => fall back to the cwd.
    const res = await run('ignore', [], { cwd: root })
    assert.equal(res.code, 0)
    assert.ok(existsSync(path.join(root, '.hypignore')))
  })
})

test('hyp ignore [path] writes exactly at the explicit path, overriding the repo root', async () => {
  await withTempTree(async (root) => {
    mkdirSync(path.join(root, '.git'))
    const target = path.join(root, 'pkg')
    mkdirSync(target)

    const res = await run('ignore', [target], { cwd: root })
    assert.equal(res.code, 0)
    assert.ok(existsSync(path.join(target, '.hypignore')), 'explicit path overrides repo-root placement')
    assert.ok(!existsSync(path.join(root, '.hypignore')))
  })
})

test('hyp ignore is idempotent: re-ignoring an already-ignored path is a no-op success', async () => {
  await withTempTree(async (root) => {
    mkdirSync(path.join(root, '.git'))
    const sub = path.join(root, 'a', 'b')
    mkdirSync(sub, { recursive: true })

    const first = await run('ignore', [], { cwd: sub })
    assert.equal(first.code, 0)
    const file = path.join(root, '.hypignore')
    const before = readFileSync(file, 'utf8')

    const second = await run('ignore', [], { cwd: sub })
    assert.equal(second.code, 0, 'second ignore still succeeds (R5)')
    assert.match(second.stdout, /already ignored/)
    assert.match(second.stdout, new RegExp(file.replace(/[.\\]/g, '\\$&')))
    assert.equal(readFileSync(file, 'utf8'), before, 'the existing file is not rewritten or clobbered')
  })
})

/* -------------------------------- unignore ------------------------------- */

test('hyp unignore removes the governing .hypignore and is idempotent', async () => {
  await withTempTree(async (root) => {
    mkdirSync(path.join(root, '.git'))
    const file = path.join(root, '.hypignore')
    writeFileSync(file, 'ignore\n')
    const sub = path.join(root, 'x')
    mkdirSync(sub)

    const first = await run('unignore', [], { cwd: sub })
    assert.equal(first.code, 0)
    assert.match(first.stdout, /removed/)
    assert.ok(!existsSync(file), 'the governing file is gone')

    const second = await run('unignore', [], { cwd: sub })
    assert.equal(second.code, 0, 'unignoring an unignored path still succeeds (R5)')
    assert.match(second.stdout, /not ignored/)
  })
})

/* ------------------------------ ignore --check --------------------------- */

test('hyp ignore --check reports an ignored path, its governor, and residual count', async () => {
  await withTempTree(async (root) => {
    const file = path.join(root, '.hypignore')
    writeFileSync(file, 'ignore\n')

    const res = await run('ignore', ['--check'], { cwd: root })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /ignored: yes/)
    assert.match(res.stdout, new RegExp(`governed-by: ${file.replace(/[.\\]/g, '\\$&')}`))
    // No `ai_gateway_messages` dataset registered in this ctx => residual is
    // reported as `unknown` rather than failing the command.
    assert.match(res.stdout, /residual-cached-rows: unknown/)
  })
})

test('hyp ignore --check reports a clean path as not ignored with zero residue', async () => {
  await withTempTree(async (root) => {
    const res = await run('ignore', ['--check'], { cwd: root })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /ignored: no/)
    assert.match(res.stdout, /governed-by: \(none\)/)
    assert.match(res.stdout, /residual-cached-rows: 0/)
  })
})

test('hyp ignore --check --json emits a machine-readable status', async () => {
  await withTempTree(async (root) => {
    const file = path.join(root, '.hypignore')
    writeFileSync(file, 'ignore\n')

    const res = await run('ignore', ['--check', '--json'], { cwd: root })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.ignored, true)
    assert.equal(parsed.governedBy, file)
    assert.equal(parsed.class, 'ignore')
  })
})

test('hyp ignore --check counts already-cached rows under the scope (LIKE superset, refined exactly)', async () => {
  await withTempTree(async (root) => {
    const scope = path.join(root, 'my_app') // underscore => LIKE wildcard trap
    mkdirSync(scope)
    writeFileSync(path.join(scope, '.hypignore'), 'ignore\n')

    // `my_app` LIKE-matches the sibling `myXapp` (squirreling maps `_` -> any
    // single char), so the exact JS refine must exclude it.
    const sibling = path.join(root, 'myXapp')
    const rows = [
      { cwd: scope, repo_root: scope }, // exact scope: counts
      { cwd: path.join(scope, 'src', 'a'), repo_root: scope }, // under scope: counts
      { cwd: path.join('/outside', 'zone'), repo_root: path.join(scope, 'deep') }, // repo_root under: counts
      { cwd: path.join(sibling, 'y'), repo_root: sibling }, // LIKE false-positive: excluded
      { cwd: '/elsewhere/unrelated', repo_root: '/elsewhere/unrelated' }, // unrelated: excluded
    ]

    const { query, storage } = makeAiGatewayCache(rows)
    const res = await run('ignore', ['--check', '--json'], { cwd: scope, query, storage })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.ignored, true)
    assert.equal(parsed.residualCachedRows, 3)
  })
})

/* -------------------------------- helpers -------------------------------- */

/**
 * Build a minimal in-memory `ai_gateway_messages` dataset + registry/storage
 * so `executeQuerySql` can run the residual-count query against fixed rows.
 *
 * @param {Record<string, unknown>[]} data
 */
function makeAiGatewayCache(data) {
  const columns = ['cwd', 'repo_root']
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
  const storage = { cacheRoot: '/tmp/hypaware-ignore-test', pendingInfo: async () => ({ pending: false }) }
  return { query, storage }
}
