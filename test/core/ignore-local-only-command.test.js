// @ts-check

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { asyncRow } from 'squirreling'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { localOnlyListPath, readLocalOnlyDirs, writeLocalOnlyDirs } from '../../src/core/usage-policy/local_only.js'

/**
 * @import { CommandRegistration, CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// `hyp ignore --local-only` / `hyp unignore --local-only` (LLP 0081 T6,
// LLP 0072 #cli): the durable, non-login authoring path over the
// machine-local `local-only` list (LLP 0071). Unlike `test/core/ignore-command.test.js`
// (the dotfile verbs), these commands never touch the repo tree — the write
// target is a `HYP_HOME`-state JSON file — so every test roots the repo tree
// and the `HYP_HOME` state tree at two distinct temp directories, asserting
// the repo tree is never touched (R4).

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
 * CommandRunContext rooted at `cwd`, with `env.HYP_HOME` pointed at a
 * sandboxed state tree so the local-only list never touches the real
 * machine's `~/.hyp`.
 *
 * @param {string} name
 * @param {string[]} argv
 * @param {{ cwd: string, hypHome: string, query?: unknown, storage?: unknown }} opts
 */
async function run(name, argv, opts) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    cwd: opts.cwd,
    env: { HYP_HOME: opts.hypHome },
    config: { version: 2 },
    query: opts.query ?? { getDataset: () => undefined, listDatasets: () => [] },
    storage: opts.storage ?? { cacheRoot: path.join(opts.cwd, '.cache'), pendingInfo: async () => ({ pending: false }) },
  })
  const code = await getCommand(name).run(argv, /** @type {CommandRunContext} */ (ctx))
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/** @param {(dirs: { root: string, hypHome: string }) => Promise<void> | void} fn */
async function withSandbox(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'hypign-lo-repo-'))
  const hypHome = mkdtempSync(path.join(tmpdir(), 'hypign-lo-home-'))
  try {
    await fn({ root, hypHome })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(hypHome, { recursive: true, force: true })
  }
}

/** @param {string} hypHome */
function stateDirOf(hypHome) {
  return path.join(hypHome, 'hypaware')
}

/* ---------------------------- ignore --local-only -------------------------- */

test('hyp ignore --local-only adds the git repo root to the machine-local list, never touching the repo', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    mkdirSync(path.join(root, '.git'))
    const sub = path.join(root, 'src', 'deep')
    mkdirSync(sub, { recursive: true })

    const res = await run('ignore', ['--local-only'], { cwd: sub, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /added/)

    const dirs = await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(dirs, [root])

    // Never writes into the repo (R4): no new file anywhere under root.
    assert.ok(!existsSync(path.join(root, '.hypignore')))
    assert.deepEqual(readdirSync(path.join(root, 'src')), ['deep'])
  })
})

test('hyp ignore --local-only [path] overrides the repo-root default', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    mkdirSync(path.join(root, '.git'))
    const target = path.join(root, 'pkg')
    mkdirSync(target)

    const res = await run('ignore', ['--local-only', target], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const dirs = await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(dirs, [target])
  })
})

test('hyp ignore --local-only accepts a nonexistent, non-repo path (R4)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const target = path.join(root, 'never', 'created')

    const res = await run('ignore', ['--local-only', target], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.ok(!existsSync(target), 'the target itself is never created')

    const dirs = await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(dirs, [target])
  })
})

test('hyp ignore --local-only is idempotent: adding the same directory twice is a no-op success', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    mkdirSync(path.join(root, '.git'))

    const first = await run('ignore', ['--local-only'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    const after1 = await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(after1, [root])

    const second = await run('ignore', ['--local-only'], { cwd: root, hypHome })
    assert.equal(second.code, 0)
    assert.match(second.stdout, /already local-only/)
    const after2 = await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(after2, [root], 'no duplicate entry')
  })
})

test('hyp ignore --local-only on a directory under an already-listed ancestor is a no-op (ancestor-governed)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    mkdirSync(path.join(root, '.git'))
    const sub = path.join(root, 'a', 'b')
    mkdirSync(sub, { recursive: true })

    await writeLocalOnlyDirs({ stateDir: stateDirOf(hypHome), dirs: [root] })

    // An explicit path prevents the repo-root default from re-deriving
    // `root`; the ancestor-governed check must still catch it.
    const res = await run('ignore', ['--local-only', sub], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /already local-only/)
    assert.match(res.stdout, new RegExp(localOnlyListPath(stateDirOf(hypHome)).replace(/[.\\]/g, '\\$&')))

    const dirs = await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(dirs, [root], 'the sub-directory is not added; the ancestor entry alone still governs it')
  })
})

test('hyp ignore --local-only on a path already governed by a stricter .hypignore is a no-op naming the dotfile', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    mkdirSync(path.join(root, '.git'))
    writeFileSync(path.join(root, '.hypignore'), 'ignore\n')

    const res = await run('ignore', ['--local-only'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /already ignore/)
    assert.match(res.stdout, new RegExp(path.join(root, '.hypignore').replace(/[.\\]/g, '\\$&')))

    const dirs = await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(dirs, [], 'the dotfile already suppresses recording; nothing is added to the list')
  })
})

/* --------------------------- unignore --local-only -------------------------- */

test('hyp unignore --local-only removes an exact entry and is idempotent', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyDirs({ stateDir: stateDirOf(hypHome), dirs: [root] })

    const first = await run('unignore', ['--local-only'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    assert.match(first.stdout, /removed 1 local-only entry/)
    assert.deepEqual(await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) }), [])

    const second = await run('unignore', ['--local-only'], { cwd: root, hypHome })
    assert.equal(second.code, 0, 'unignoring an already-clean path still succeeds (R5)')
    assert.match(second.stdout, /not local-only/)
  })
})

test('hyp unignore --local-only [path] removes every governing (equal-or-ancestor) entry', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const sub = path.join(root, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    const unrelated = path.join(root, 'sibling')
    mkdirSync(unrelated)

    await writeLocalOnlyDirs({ stateDir: stateDirOf(hypHome), dirs: [root, unrelated] })

    const res = await run('unignore', ['--local-only', sub], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, new RegExp(root.replace(/[.\\]/g, '\\$&')))

    const dirs = await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(dirs, [unrelated], 'the ancestor entry governing sub is removed; the unrelated sibling entry is preserved')
  })
})

test('hyp unignore --local-only does not remove a sibling that merely shares a string prefix', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const scope = path.join(root, 'my_app')
    const sibling = path.join(root, 'myXapp')
    mkdirSync(scope, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    await writeLocalOnlyDirs({ stateDir: stateDirOf(hypHome), dirs: [sibling] })

    const res = await run('unignore', ['--local-only', scope], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /not local-only/)
    assert.deepEqual(await readLocalOnlyDirs({ stateDir: stateDirOf(hypHome) }), [sibling])
  })
})

/* ------------------------------ ignore --check ------------------------------ */

test('hyp ignore --check reports the local-only class and the list file as the governor', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyDirs({ stateDir: stateDirOf(hypHome), dirs: [root] })

    const res = await run('ignore', ['--check'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /class: local-only/)
    assert.match(res.stdout, /ignored: no/, 'local-only is not the (fully suppressed) ignore class')
    assert.match(res.stdout, new RegExp(localOnlyListPath(stateDirOf(hypHome)).replace(/[.\\]/g, '\\$&')))
  })
})

test('hyp ignore --check --json reports local-only class + governedBy pointing at the list file', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const sub = path.join(root, 'nested')
    mkdirSync(sub, { recursive: true })
    await writeLocalOnlyDirs({ stateDir: stateDirOf(hypHome), dirs: [root] })

    const res = await run('ignore', ['--check', '--json'], { cwd: sub, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.class, 'local-only')
    assert.equal(parsed.ignored, false)
    assert.equal(parsed.governedBy, localOnlyListPath(stateDirOf(hypHome)))
  })
})

test('hyp ignore --check still reports the dotfile ignore class + its governing file (unaffected by an empty list)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    writeFileSync(path.join(root, '.hypignore'), 'ignore\n')

    const res = await run('ignore', ['--check', '--json'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.class, 'ignore')
    assert.equal(parsed.ignored, true)
    assert.equal(parsed.governedBy, path.join(root, '.hypignore'))
  })
})

test('hyp ignore --check counts residual cached rows for a local-only scope (recorded, withheld from forwarding)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const scope = path.join(root, 'proj')
    mkdirSync(scope, { recursive: true })
    await writeLocalOnlyDirs({ stateDir: stateDirOf(hypHome), dirs: [scope] })

    const rows = [
      { cwd: scope, repo_root: scope },
      { cwd: path.join(scope, 'src'), repo_root: scope },
      { cwd: '/elsewhere', repo_root: '/elsewhere' },
    ]
    const { query, storage } = makeAiGatewayCache(rows)

    const res = await run('ignore', ['--check', '--json'], { cwd: scope, hypHome, query, storage })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.class, 'local-only')
    assert.equal(parsed.residualCachedRows, 2)
  })
})

test('hyp ignore --check on a clean path with a populated-but-non-matching list reports full/no residue', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const other = path.join(root, 'other-project')
    mkdirSync(other, { recursive: true })
    await writeLocalOnlyDirs({ stateDir: stateDirOf(hypHome), dirs: [other] })

    const res = await run('ignore', ['--check'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /class: full/)
    assert.match(res.stdout, /governed-by: \(none\)/)
    assert.match(res.stdout, /residual-cached-rows: 0/)
  })
})

/* -------------------------------- helpers -------------------------------- */

/**
 * Build a minimal in-memory `ai_gateway_messages` dataset + registry/storage
 * so `executeQuerySql` can run the residual-count query against fixed rows
 * (same fixture shape as `test/core/ignore-command.test.js`).
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
  const storage = { cacheRoot: '/tmp/hypaware-ignore-local-only-test', pendingInfo: async () => ({ pending: false }) }
  return { query, storage }
}
