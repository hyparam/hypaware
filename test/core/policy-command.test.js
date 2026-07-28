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

// `hyp policy set/show/unset/list` (LLP 0110, LLP 0111, task T2): the
// class-neutral verb group over the machine-local class-per-entry store,
// mirroring test/core/ignore-private-sync-command.test.js for the new
// spellings, plus list and class-neutral unset coverage that has no flag-form
// counterpart. These verbs never touch the repo tree - the write target is a
// `HYP_HOME`-state JSON file - so every test roots the repo tree and the
// `HYP_HOME` state tree at two distinct temp directories.

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

/** @param {string} value */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  const root = mkdtempSync(path.join(tmpdir(), 'hyp-policy-repo-'))
  const hypHome = mkdtempSync(path.join(tmpdir(), 'hyp-policy-home-'))
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

/* --------------------------------- policy set -------------------------------- */

test('hyp policy set <path> ignore marks the path ignore in the machine-local store, never touching the repo', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    mkdirSync(path.join(root, '.git'))

    const res = await run('policy set', [root, 'ignore'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /marked .* as ignore/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'ignore' }])
    assert.ok(!existsSync(path.join(root, '.hypignore')), 'never writes a .hypignore dotfile')
  })
})

test('hyp policy set <path> ignore is idempotent: marking twice is a no-op success', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const first = await run('policy set', [root, 'ignore'], { cwd: root, hypHome })
    assert.equal(first.code, 0)

    const second = await run('policy set', [root, 'ignore'], { cwd: root, hypHome })
    assert.equal(second.code, 0)
    assert.match(second.stdout, /already ignore/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'ignore' }], 'no duplicate entry')
  })
})

test('hyp policy set <path> ignore upgrades an existing local-only entry to ignore', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'local-only' }] })

    const res = await run('policy set', [root, 'ignore'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /marked .* as ignore/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'ignore' }])
  })
})

test('hyp policy set <path> ignore on a path already governed by a stricter .hypignore is a no-op naming the dotfile', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    writeFileSync(path.join(root, '.hypignore'), 'ignore\n')

    const res = await run('policy set', [root, 'ignore'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /already ignore/)
    assert.match(res.stdout, new RegExp(path.join(root, '.hypignore').replace(/[.\\]/g, '\\$&')))

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [], 'the dotfile already suppresses recording; nothing is added to the store')
  })
})

test('hyp policy set <path> sync writes an explicit full entry (the sync -> full token mapping)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy set', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /marked .* as sync/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'full' }], 'the store keeps speaking `full`; only the CLI token is `sync`')
  })
})

test('hyp policy set <path> sync is idempotent against an existing explicit full entry, but not against the mere implicit default', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const first = await run('policy set', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    assert.match(first.stdout, /marked .* as sync/, 'no entry existed yet, so this must write, not no-op')

    const second = await run('policy set', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(second.code, 0)
    assert.match(second.stdout, /already sync/, 'now an explicit entry exists, so this is idempotent')

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'full' }], 'no duplicate entry')
  })
})

// Issue #393: a successful `policy set <path> sync` confirmed with the two
// internals the public verb exists to hide - the stored class (`full`) and the
// backing store file (`local-only.json`) - so a sync mark read as though it had
// become local-only. The human line speaks the CLI-edge vocabulary only.
test('hyp policy set <path> sync confirms in the public vocabulary and never names the backing store file', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy set', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.equal(res.stdout, `marked ${root} as sync (machine-local policy store)\n`)
    assert.doesNotMatch(res.stdout, /local-only\.json/, 'the backing store path is an implementation detail')
  })
})

// LLP 0111 #set: `set` was the only `policy` surface that didn't say a
// marking is machine-local (the no-op and `list` already do), so a bare
// `marked <p> as sync` gave no confirmation that nothing landed in the repo.
test('hyp policy set <path> ignore also names the marking as machine-local', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy set', [root, 'ignore'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.equal(res.stdout, `marked ${root} as ignore (machine-local policy store)\n`)
  })
})

test('hyp policy set <path> sync twice reports the existing mark in the public vocabulary, naming the store neutrally', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await run('policy set', [root, 'sync'], { cwd: root, hypHome })

    const res = await run('policy set', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /already sync/)
    assert.doesNotMatch(res.stdout, /already full/)
    assert.doesNotMatch(res.stdout, /local-only\.json/)
  })
})

test('hyp policy set <path> local-only marks the path local-only', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy set', [root, 'local-only'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /marked .* as local-only/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: root, class: 'local-only' }])
  })
})

test('hyp policy set rejects an unknown class token with a usage error naming the three valid tokens', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy set', [root, 'private'], { cwd: root, hypHome })
    assert.equal(res.code, 2)
    assert.match(res.stderr, /sync/)
    assert.match(res.stderr, /local-only/)
    assert.match(res.stderr, /ignore/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [], 'nothing is written on a rejected token')
  })
})

test('hyp policy set requires a path (bare class token alone is ambiguous, so it is rejected)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy set', ['sync'], { cwd: root, hypHome })
    assert.equal(res.code, 2)
  })
})

/* -------------------------------- policy show --------------------------------- */

test('hyp policy show [path] --json is byte-compatible with hyp ignore --check --json for a machine-local mark', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'ignore' }] })

    const legacy = await run('ignore', ['--check', '--json'], { cwd: root, hypHome })
    const next = await run('policy show', [root, '--json'], { cwd: root, hypHome })
    assert.equal(next.code, 0)
    assert.equal(legacy.code, 0)
    assert.deepEqual(JSON.parse(next.stdout), JSON.parse(legacy.stdout))

    const parsed = JSON.parse(next.stdout)
    assert.equal(parsed.class, 'ignore')
    assert.equal(parsed.source, 'machine-local')
    assert.equal(parsed.governedBy, localOnlyListPath(stateDirOf(hypHome)))
  })
})

test('hyp policy show defaults to cwd and names the dotfile source when a .hypignore governs', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    writeFileSync(path.join(root, '.hypignore'), 'ignore\n')

    const res = await run('policy show', ['--json'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.source, 'dotfile')
    assert.equal(parsed.class, 'ignore')
  })
})

// Issue #393: the human `policy show` printed the stored class and the store
// file path verbatim, so a synced folder read `class: full` governed by
// `local-only.json`. The `--json` shape must NOT move with it.
test('hyp policy show (human) renders a stored full entry as sync and names the store neutrally', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'full' }] })

    const res = await run('policy show', [root], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /^class: sync$/m)
    assert.doesNotMatch(res.stdout, /^class: full$/m)
    assert.match(res.stdout, /^source: machine-local$/m, 'the source line is unchanged')
    assert.doesNotMatch(res.stdout, /local-only\.json/, 'the backing store path is an implementation detail')
  })
})

test('hyp policy show (human) keeps naming a governing dotfile by its real path', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    writeFileSync(path.join(root, '.hypignore'), 'ignore\n')

    const res = await run('policy show', [root], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /^class: ignore$/m)
    assert.match(res.stdout, new RegExp(`^governed-by: ${escapeRe(path.join(root, '.hypignore'))}$`, 'm'))
  })
})

test('hyp policy show --json keeps the stored vocabulary and the store path (unchanged machine contract)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'full' }] })

    const legacy = await run('ignore', ['--check', '--json'], { cwd: root, hypHome })
    const next = await run('policy show', [root, '--json'], { cwd: root, hypHome })
    assert.equal(next.code, 0)
    assert.equal(next.stdout, legacy.stdout, 'byte-compatible with the --check --json shape')

    const parsed = JSON.parse(next.stdout)
    assert.equal(parsed.class, 'full', 'the JSON keeps emitting the resolver vocabulary')
    assert.equal(parsed.governedBy, localOnlyListPath(stateDirOf(hypHome)), 'the JSON keeps emitting the store path')
    assert.equal(parsed.source, 'machine-local')
  })
})

test('hyp policy show names no source when nothing governs (the implicit default)', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy show', [root, '--json'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.class, 'full')
    assert.equal(parsed.source, 'none')
  })
})

// The privacy skill reads `hyp policy show`'s human `class:` line to decide
// whether a directory has already been classified. Without a tell, an
// unmarked directory's implicit `full` default renders through the same
// `sync` token an explicit machine-local `full` mark would, so it would read
// as "the user already said sync" and get dropped from a review list even
// though nothing was ever recorded (review finding on #411).
test('hyp policy show (human) flags the implicit default so it cannot be mistaken for an explicit sync mark', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy show', [root], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /^class: sync \(implicit default, not yet classified\)$/m)
    assert.match(res.stdout, /^source: none$/m)
  })
})

/* -------------------------------- policy unset --------------------------------- */

test('hyp policy unset <path> ignore (scoped) removes an ignore entry and is idempotent, leaving other classes untouched', async () => {
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

    const first = await run('policy unset', [root, 'ignore'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    assert.match(first.stdout, /removed 1 ignore entry/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: other, class: 'local-only' }], 'the unrelated local-only entry survives')

    const second = await run('policy unset', [root, 'ignore'], { cwd: root, hypHome })
    assert.equal(second.code, 0, 'unsetting an already-clean path still succeeds')
    assert.match(second.stdout, /not ignore/)
  })
})

test('hyp policy unset <path> sync (scoped) removes an explicit full entry and is idempotent', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'full' }] })

    const first = await run('policy unset', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    assert.match(first.stdout, /removed 1 sync entry/)
    assert.deepEqual(await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) }), [])

    const second = await run('policy unset', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(second.code, 0)
    assert.match(second.stdout, /not sync/)
  })
})

// Issue #393: `unset` reported the stored class too.
test('hyp policy unset <path> sync reports removal and the no-op in the public vocabulary', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'full' }] })

    const first = await run('policy unset', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(first.code, 0)
    assert.doesNotMatch(first.stdout, /full/)

    const second = await run('policy unset', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(second.code, 0)
    assert.doesNotMatch(second.stdout, /full/)
  })
})

test('hyp policy unset <path> (class-neutral) names each removed entry class in the public vocabulary', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'full' }] })

    const res = await run('policy unset', [root], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /\(sync\)/)
    assert.doesNotMatch(res.stdout, /\(full\)/)
  })
})

test('hyp policy unset <path> (no trailing class token) is class-neutral: removes every machine-local entry governing the target', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const sub = path.join(root, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    const unrelated = path.join(root, 'sibling')
    mkdirSync(unrelated)
    // Two entries of different classes both govern `sub` (via ancestry);
    // an unrelated sibling entry must survive untouched.
    await writeLocalOnlyEntries({
      stateDir: stateDirOf(hypHome),
      entries: [
        { dir: root, class: 'local-only' },
        { dir: unrelated, class: 'ignore' },
      ],
    })

    const res = await run('policy unset', [sub], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /removed 1 entry/)
    assert.match(res.stdout, /local-only/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [{ dir: unrelated, class: 'ignore' }], 'only the entry governing sub is removed')
  })
})

test('hyp policy unset <path> (no trailing class token) removes multiple entries of different classes governing the same target', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    // Not physically realizable via the store's one-entry-per-dir shape at a
    // single dir, but an ancestor entry plus an exact-dir entry can both
    // govern the same target simultaneously.
    const sub = path.join(root, 'nested')
    mkdirSync(sub, { recursive: true })
    await writeLocalOnlyEntries({
      stateDir: stateDirOf(hypHome),
      entries: [
        { dir: root, class: 'local-only' },
        { dir: sub, class: 'ignore' },
      ],
    })

    const res = await run('policy unset', [sub], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /removed 2 entries/)

    const entries = await readLocalOnlyEntries({ stateDir: stateDirOf(hypHome) })
    assert.deepEqual(entries, [], 'both the exact-dir entry and the governing ancestor entry are removed')
  })
})

test('hyp policy unset <path> (no trailing class token) on an already-clean path is a class-neutral no-op success', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy unset', [root], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /not governed/)
  })
})

test('hyp policy unset rejects an unknown trailing class token with a usage error naming the three valid tokens', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy unset', [root, 'private'], { cwd: root, hypHome })
    assert.equal(res.code, 2)
    assert.match(res.stderr, /sync/)
    assert.match(res.stderr, /local-only/)
    assert.match(res.stderr, /ignore/)
  })
})

test('hyp policy unset requires a path', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy unset', [], { cwd: root, hypHome })
    assert.equal(res.code, 2)
  })
})

/* --------------------------------- policy list --------------------------------- */

test('hyp policy list --json enumerates every machine-local entry with the store path', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const other = path.join(root, 'other')
    mkdirSync(other, { recursive: true })
    await writeLocalOnlyEntries({
      stateDir: stateDirOf(hypHome),
      entries: [
        { dir: root, class: 'full' },
        { dir: other, class: 'ignore' },
      ],
    })

    const res = await run('policy list', ['--json'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.path, localOnlyListPath(stateDirOf(hypHome)))
    assert.deepEqual(parsed.entries, [
      { dir: root, class: 'full' },
      { dir: other, class: 'ignore' },
    ])
  })
})

test('hyp policy list --json on an empty store lists zero entries successfully', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy list', ['--json'], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    const parsed = JSON.parse(res.stdout)
    assert.deepEqual(parsed.entries, [])
    assert.equal(parsed.path, localOnlyListPath(stateDirOf(hypHome)))
  })
})

// Issue #393: the human listing rendered the stored class (`full (sync)`) and
// printed the store path bare. It now speaks the public vocabulary and labels
// the store; `--json` is unchanged (see the --json tests above).
test('hyp policy list (human) renders a full entry as sync and labels the store path', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    await writeLocalOnlyEntries({ stateDir: stateDirOf(hypHome), entries: [{ dir: root, class: 'full' }] })

    const res = await run('policy list', [], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, new RegExp(`^${escapeRe(root)}: sync$`, 'm'))
    assert.doesNotMatch(res.stdout, /: full/)
    assert.match(
      res.stdout,
      new RegExp(`^\\(policy store: ${escapeRe(localOnlyListPath(stateDirOf(hypHome)))}\\)$`, 'm'),
      'the store path is labelled, not dumped bare'
    )
  })
})

test('hyp policy list (human) on an empty store reports no entries without error, labelling the store path', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy list', [], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.equal(res.stdout, `no machine-local entries (policy store: ${localOnlyListPath(stateDirOf(hypHome))})\n`)
  })
})

/* --------------------------- corrupt store, policy edge --------------------------- */

// Review finding on #411: the corrupt-store error propagated from
// `readLocalOnlyEntries` (`LocalOnlyListUnreadableError`) named the store
// "the local-only list", the exact internal `policy` exists to stop naming.
// `policy show` / `policy list` must catch it and speak the same
// "machine-local policy store" wording every other `policy` line uses, while
// still naming the real file path so the user knows what to repair.
/** @param {string} hypHome */
function corruptStore(hypHome) {
  const listPath = localOnlyListPath(stateDirOf(hypHome))
  mkdirSync(path.dirname(listPath), { recursive: true })
  writeFileSync(listPath, '{ not valid json')
  return listPath
}

test('hyp policy show on a corrupt store fails with the policy-store wording, not "local-only list"', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const listPath = corruptStore(hypHome)

    const res = await run('policy show', [root], { cwd: root, hypHome })
    assert.equal(res.code, 1)
    assert.equal(res.stderr, `error: the machine-local policy store at '${listPath}' is unreadable or malformed\n`)
    assert.doesNotMatch(res.stderr, /local-only list/)
  })
})

test('hyp policy list on a corrupt store fails with the policy-store wording, not "local-only list"', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const listPath = corruptStore(hypHome)

    const res = await run('policy list', [], { cwd: root, hypHome })
    assert.equal(res.code, 1)
    assert.equal(res.stderr, `error: the machine-local policy store at '${listPath}' is unreadable or malformed\n`)
    assert.doesNotMatch(res.stderr, /local-only list/)
  })
})

test('hyp policy set on a corrupt store fails with the policy-store wording, not "local-only list"', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const listPath = corruptStore(hypHome)

    const res = await run('policy set', [root, 'sync'], { cwd: root, hypHome })
    assert.equal(res.code, 1)
    assert.equal(res.stderr, `error: the machine-local policy store at '${listPath}' is unreadable or malformed\n`)
    assert.doesNotMatch(res.stderr, /local-only list/)
  })
})

test('hyp policy unset on a corrupt store fails with the policy-store wording, not "local-only list"', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const listPath = corruptStore(hypHome)

    const res = await run('policy unset', [root], { cwd: root, hypHome })
    assert.equal(res.code, 1)
    assert.equal(res.stderr, `error: the machine-local policy store at '${listPath}' is unreadable or malformed\n`)
    assert.doesNotMatch(res.stderr, /local-only list/)
  })
})

/* ------------------------------ group registration ------------------------------ */

test('hyp policy (bare) renders group help listing set/show/unset/list', async () => {
  await withSandbox(async ({ root, hypHome }) => {
    const res = await run('policy', [], { cwd: root, hypHome })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /set/)
    assert.match(res.stdout, /show/)
    assert.match(res.stdout, /unset/)
    assert.match(res.stdout, /list/)
  })
})
