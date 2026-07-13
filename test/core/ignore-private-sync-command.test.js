// @ts-check

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import {
  localOnlyListPath,
  readLocalOnlyEntries,
  writeLocalOnlyEntries,
} from '../../src/core/usage-policy/local_only.js'

/**
 * @import { CommandRegistration, CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// `hyp ignore --private` / `hyp ignore --sync` / symmetric `hyp unignore`
// (LLP 0103 #cli, task T2): the two new machine-local marking classes on top
// of the class-per-entry store, alongside the pre-existing `--local-only`
// (covered by `test/core/ignore-local-only-command.test.js`). These verbs
// never touch the repo tree - the write target is a `HYP_HOME`-state JSON
// file - so every test roots the repo tree and the `HYP_HOME` state tree at
// two distinct temp directories.

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
 * @param {string} name
 * @param {string[]} argv
 * @param {{ cwd: string, hypHome: string }} opts
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
    query: { getDataset: () => undefined, listDatasets: () => [] },
    storage: { cacheRoot: path.join(opts.cwd, '.cache'), pendingInfo: async () => ({ pending: false }) },
  })
  const code = await getCommand(name).run(argv, /** @type {CommandRunContext} */ (ctx))
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/** @param {(dirs: { root: string, hypHome: string }) => Promise<void> | void} fn */
async function withSandbox(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'hypign-priv-repo-'))
  const hypHome = mkdtempSync(path.join(tmpdir(), 'hypign-priv-home-'))
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

/* -------------------------------- ignore --private -------------------------------- */

test('hyp ignore --private marks the repo root ignore in the machine-local store, never touching the repo', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    mkdirSync(path.join(root, '.git'))
    const sub = path.join(root, 'src', 'deep')
    mkdirSync(sub, { recursive: true })

    const res = await run('ignore', ['--private'], { cwd: sub, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /marked .* as ignore/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'ignore' }])
    assert.ok(!existsSync(path.join(root, '.hypignore')), 'never writes a .hypignore dotfile')
  })
})

test('hyp ignore --private is idempotent: marking twice is a no-op success', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const first = await run('ignore', ['--private'], { cwd: root, hypHome })
    assert.equal(first.code, 0)

    const second = await run('ignore', ['--private'], { cwd: root, hypHome })
    assert.equal(second.code, 0)
    assert.match(second.stdout, /already ignore/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'ignore' }], 'no duplicate entry')
  })
})

test('hyp ignore --private upgrades an existing local-only entry to ignore', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'local-only' }] })

    const res = await run('ignore', ['--private'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /marked .* as ignore/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'ignore' }])
  })
})

test('hyp ignore --private on a path already governed by a stricter .hypignore is a no-op naming the dotfile', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    writeFileSync(path.join(root, '.hypignore'), 'ignore\n')

    const res = await run('ignore', ['--private'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /already ignore/)
    assert.match(res.stdout, new RegExp(path.join(root, '.hypignore').replace(/[.\\]/g, '\\$&')))

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [], 'the dotfile already suppresses recording; nothing is added to the store')
  })
})

/* --------------------------------- ignore --sync ---------------------------------- */

test('hyp ignore --sync writes an explicit full entry (the "asked; syncs" marker)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('ignore', ['--sync'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /marked .* as full/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'full' }])
  })
})

test('hyp ignore --sync is idempotent against an existing explicit full entry, but not against the mere implicit default', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    // Nothing governs yet: the implicit default already resolves to `full`,
    // but that is not the same as "explicitly answered" (LLP 0103), so the
    // mark still writes a new, durable entry rather than treating this cwd
    // as already-explicit.
    const first = await run('ignore', ['--sync'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    assert.match(first.stdout, /marked .* as full/, 'no entry existed yet, so this must write, not no-op')

    const second = await run('ignore', ['--sync'], { cwd: root, hypHome })
    assert.equal(second.code, 0)
    assert.match(second.stdout, /already full/, 'now an explicit entry exists, so this is idempotent')

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'full' }], 'no duplicate entry')
  })
})

test('hyp ignore --sync downgrades an existing ignore entry back to full (re-marking is not destructive of cached rows)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'ignore' }] })

    const res = await run('ignore', ['--sync'], { cwd: root, hypHome })
    assert.equal(res.code, 0)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'full' }])
  })
})

/* -------------------------------- flag exclusivity --------------------------------- */

test('hyp ignore rejects combining --local-only, --private, and --sync', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('ignore', ['--private', '--sync'], { cwd: root, hypHome })
    assert.equal(res.code, 2)
    assert.match(res.stderr, /mutually exclusive/)
  })
})

/* ------------------------------- unignore --private --------------------------------- */

test('hyp unignore --private removes an ignore entry and is idempotent, leaving other classes untouched', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const other = path.join(root, 'other')
    mkdirSync(other, { recursive: true })
    await writeLocalOnlyEntries({
      stateDir: stateDirOf(hypHome),
      entries: [
        { dir: root, class: 'ignore' },
        { dir: other, class: 'local-only' },
      ],
    })

    const first = await run('unignore', ['--private'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    assert.match(first.stdout, /removed 1 ignore entry/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: other, class: 'local-only' }], 'the unrelated local-only entry survives')

    const second = await run('unignore', ['--private'], { cwd: root, hypHome })
    assert.equal(second.code, 0, 'unignoring an already-clean path still succeeds (R5)')
    assert.match(second.stdout, /not ignore/)
  })
})

/* -------------------------------- unignore --sync ----------------------------------- */

test('hyp unignore --sync removes an explicit full entry and is idempotent', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'full' }] })

    const first = await run('unignore', ['--sync'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    assert.match(first.stdout, /removed 1 full entry/)
    assert.deepEqual(await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) }), [])

    const second = await run('unignore', ['--sync'], { cwd: root, hypHome })
    assert.equal(second.code, 0)
    assert.match(second.stdout, /not full/)
  })
})

/* -------------------------------- --check source naming ------------------------------ */

test('hyp ignore --check names the machine-local source for a --private mark', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'ignore' }] })

    const res = await run('ignore', ['--check', '--json'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.class, 'ignore')
    assert.equal(parsed.source, 'machine-local')
    assert.equal(parsed.governedBy, localOnlyListPath(stateDirOf(hypHome)))
  })
})

test('hyp ignore --check names the dotfile source when a .hypignore governs', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    writeFileSync(path.join(root, '.hypignore'), 'ignore\n')

    const res = await run('ignore', ['--check', '--json'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.source, 'dotfile')
  })
})

test('hyp ignore --check names no source when nothing governs (the implicit default)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('ignore', ['--check', '--json'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.class, 'full')
    assert.equal(parsed.source, 'none')
  })
})

/* ------------------------------ dotfile behavior untouched ---------------------------- */

test('bare hyp ignore [path] (no flags) still writes the LLP 0049 dotfile, unaffected by --private/--sync existing', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    mkdirSync(path.join(root, '.git'))

    const res = await run('ignore', [], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /wrote/)
    assert.ok(existsSync(path.join(root, '.hypignore')))

    // The machine-local store is untouched by the dotfile verb.
    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [])
  })
})
