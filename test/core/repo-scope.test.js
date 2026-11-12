// @ts-check

// Repository-scoped sync (LLP 0601): an organization's `sync_repos` allowlist
// keeps every session outside its repositories on the machine. Covers the
// resolver, the export-seam enforcement, and the config key.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { mergeConfigLayers } from '../../src/core/config/merge.js'
import { parseConfigShape } from '../../src/core/config/schema.js'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { cwdWithheldFromCaller, defaultQueryVisibilityResolver, resolveCallerClass } from '../../src/core/query/visibility.js'
import { localOnlyListPath, writeLocalOnlyEntries } from '../../src/core/usage-policy/local_only.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/matcher.js'
import {
  createRepoScopeResolver,
  normalizeRepoPrefix,
  readOriginRemote,
  repoIdentityFromRemote,
  withRepoScope,
} from '../../src/core/usage-policy/repo_scope.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.d.ts'
 * @import { ResolveResult, UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-repo-scope-'))
}

/**
 * Lay down just enough of a clone for the config reader: `.git/config`
 * with an `origin` remote.
 *
 * @param {string} dir
 * @param {string | null} remote
 */
async function makeClone(dir, remote) {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true })
  const origin = remote === null ? '' : `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
  await fs.writeFile(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/thing.git\n${origin}`)
}

test('normalizeRepoPrefix accepts host/owner and host/owner/repo, lowercased', () => {
  assert.equal(normalizeRepoPrefix('github.com/Acme'), 'github.com/acme')
  assert.equal(normalizeRepoPrefix(' GitHub.com/Acme/Tool.git '), 'github.com/acme/tool')
  for (const bad of ['acme', 'github.com/', '/acme', 'github.com/a/b/c', 'https://github.com/acme', 'git@github.com:acme', 'github.com/ac me', 42, null]) {
    assert.equal(normalizeRepoPrefix(bad), null, `rejects ${String(bad)}`)
  }
})

test('repoIdentityFromRemote reduces every remote form to host/owner/repo without credentials', () => {
  assert.equal(repoIdentityFromRemote('git@github.com:Acme/Tool.git'), 'github.com/acme/tool')
  assert.equal(repoIdentityFromRemote('https://github.com/acme/tool'), 'github.com/acme/tool')
  assert.equal(repoIdentityFromRemote('https://x-access-token:secret@github.com/acme/tool.git/'), 'github.com/acme/tool')
  assert.equal(repoIdentityFromRemote('ssh://git@git.acme.dev:2222/platform/tool.git'), 'git.acme.dev/platform/tool')
  assert.equal(repoIdentityFromRemote('https://gitlab.com/acme/group/tool.git'), 'gitlab.com/acme/group/tool')
  for (const bad of ['/srv/git/tool.git', '../tool', '', 'github.com', undefined]) {
    assert.equal(repoIdentityFromRemote(bad), null, `rejects ${String(bad)}`)
  }
})

test('readOriginRemote reads origin from a clone, a subdirectory, a linked worktree, and a deleted worktree', async () => {
  const root = await makeTmpDir()
  const clone = path.join(root, 'tool')
  await makeClone(clone, 'git@github.com:acme/tool.git')
  await fs.mkdir(path.join(clone, 'src', 'deep'), { recursive: true })

  assert.equal(readOriginRemote(clone), 'git@github.com:acme/tool.git')
  assert.equal(readOriginRemote(path.join(clone, 'src', 'deep')), 'git@github.com:acme/tool.git')
  // A directory that is gone resolves through its surviving ancestor.
  assert.equal(readOriginRemote(path.join(clone, 'worktrees-gone', 'x')), 'git@github.com:acme/tool.git')

  // Linked worktree: `.git` is a file pointing at a per-worktree git dir
  // whose `commondir` points back at the shared one.
  const worktree = path.join(root, 'tool-wt')
  const wtGitDir = path.join(clone, '.git', 'worktrees', 'wt')
  await fs.mkdir(wtGitDir, { recursive: true })
  await fs.writeFile(path.join(wtGitDir, 'commondir'), '../..\n')
  await fs.mkdir(worktree, { recursive: true })
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${wtGitDir}\n`)
  assert.equal(readOriginRemote(worktree), 'git@github.com:acme/tool.git')

  const noRemote = path.join(root, 'scratch')
  await makeClone(noRemote, null)
  assert.equal(readOriginRemote(noRemote), null, 'a repository with no origin has none, whatever other remotes it lists')
  assert.equal(readOriginRemote(await makeTmpDir()), null, 'a directory outside any repository has none')

  await fs.rm(root, { recursive: true, force: true })
})

test('the resolver keeps a row unless its repository is under an allowed prefix', async () => {
  const root = await makeTmpDir()
  const work = path.join(root, 'work')
  const side = path.join(root, 'side')
  const loose = path.join(root, 'notes')
  await makeClone(work, 'https://github.com/acme/tool.git')
  await makeClone(side, 'git@github.com:me/side.git')
  await fs.mkdir(loose, { recursive: true })

  const scope = createRepoScopeResolver({ allowed: ['github.com/Acme', 'github.com/partner/shared'] })
  assert.deepEqual(scope.prefixes, ['github.com/acme', 'github.com/partner/shared'])

  // The recorded remote decides when the row has one.
  assert.equal(scope.withholds('git@github.com:acme/tool.git', side), false)
  assert.equal(scope.withholds('git@github.com:me/side.git', work), true)
  assert.equal(scope.withholds('git@github.com:partner/shared.git', undefined), false)
  assert.equal(scope.withholds('git@github.com:partner/other.git', undefined), true)
  assert.equal(scope.withholds('git@github.com:acme-labs/tool.git', undefined), true, 'a prefix matches whole path segments only')
  assert.equal(scope.withholds('git@gitlab.com:acme/tool.git', undefined), true, 'the host is part of the match')

  // Otherwise the directory's current origin does.
  assert.equal(scope.withholds(undefined, work), false)
  assert.equal(scope.withholds('', side), true)
  assert.equal(scope.withholds(null, loose), true, 'no repository: stays on the machine')

  // A row with neither is outside this rule.
  assert.equal(scope.withholds(undefined, undefined), false)
  assert.equal(scope.withholds('', ''), false)

  await fs.rm(root, { recursive: true, force: true })
})

test('the resolver memoizes a directory verdict for its TTL', () => {
  let reads = 0
  let clock = 0
  const scope = createRepoScopeResolver({
    allowed: ['github.com/acme'],
    existsSync: (p) => p === path.join('/w/tool', '.git'),
    readFileSync: (p) => {
      reads += 1
      if (p === path.join('/w/tool', '.git', 'config')) return '[remote "origin"]\n  url = git@github.com:acme/tool.git\n'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    now: () => clock,
    ttlMs: 1000,
  })
  assert.equal(scope.withholds(undefined, '/w/tool'), false)
  const first = reads
  for (let i = 0; i < 100; i += 1) scope.withholds(undefined, '/w/tool')
  assert.equal(reads, first, 'no disk reads inside the TTL')
  clock = 1001
  scope.withholds(undefined, '/w/tool')
  assert.ok(reads > first, 're-read once the TTL lapses')
})

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'git_remote', type: 'STRING', nullable: true },
]

/**
 * @param {{ localOnly?: string[], explicitSync?: string[] }} [opts]
 * @returns {UsagePolicyResolver}
 */
function makeUsageResolver({ localOnly = [], explicitSync = [] } = {}) {
  /** @type {(cwd: string) => ResolveResult} */
  const resolve = (cwd) => {
    if (localOnly.includes(cwd)) return { class: 'local-only', governedBy: '/list', declared: 'local-only' }
    if (explicitSync.includes(cwd)) return { class: 'full', governedBy: '/list', declared: 'full' }
    return { class: 'full', governedBy: null, declared: null }
  }
  return { resolve, isIgnored: () => false }
}

/**
 * @param {ReturnType<typeof createQueryStorageService>} svc
 * @param {string[]} [columns]
 */
async function exported(svc, columns) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  let dropped = 0
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, columns ? { columns } : {})) {
      if (entry.dropped) dropped += 1
      else rows.push(entry.row)
    }
  }
  rows.sort((a, b) => Number(a.id) - Number(b.id))
  return { rows, ids: rows.map((r) => Number(r.id)), dropped }
}

test('readRowsSince: only rows in allowed repositories are exported; the rest stay in the cache', async () => {
  const cacheRoot = await makeTmpDir()
  const root = await makeTmpDir()
  const work = path.join(root, 'work')
  const side = path.join(root, 'side')
  const loose = path.join(root, 'notes')
  const marked = path.join(root, 'marked')
  await makeClone(work, 'git@github.com:acme/tool.git')
  await makeClone(side, 'git@github.com:me/side.git')
  await fs.mkdir(loose, { recursive: true })
  await fs.mkdir(marked, { recursive: true })

  const svc = createQueryStorageService({
    cacheRoot,
    usagePolicyResolver: makeUsageResolver({ localOnly: ['/acme/secret'], explicitSync: [marked] }),
    repoScopeResolver: createRepoScopeResolver({ allowed: ['github.com/acme'] }),
  })
  const table = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(table, COLS, [
    { id: 1, cwd: '/gone/a', git_remote: 'git@github.com:acme/tool.git' }, // recorded remote allowed -> shipped
    { id: 2, cwd: '/gone/b', git_remote: 'git@github.com:me/side.git' }, // recorded remote not allowed -> kept
    { id: 3, cwd: work, git_remote: null }, // derived from cwd, allowed -> shipped
    { id: 4, cwd: side, git_remote: null }, // derived from cwd, not allowed -> kept
    { id: 5, cwd: loose, git_remote: null }, // no repository -> kept
    { id: 6, cwd: marked, git_remote: null }, // no repository, but explicitly marked sync -> shipped
    { id: 7, cwd: '/acme/secret', git_remote: 'git@github.com:acme/tool.git' }, // allowed repo, local-only dir -> kept
    { id: 8, cwd: null, git_remote: null }, // neither -> outside this rule, shipped
  ])
  await svc.flushTable(table, { reason: 'manual' })

  const all = await exported(svc)
  assert.deepEqual(all.ids, [1, 3, 6, 8])
  assert.equal(all.dropped, 4)

  // A projection that names neither column cannot blind the filter, and the
  // forced columns do not reach the payload.
  const projected = await exported(svc, ['id'])
  assert.deepEqual(projected.ids, [1, 3, 6, 8])
  assert.deepEqual(projected.rows[0], { id: projected.rows[0].id })

  /** @type {number[]} */
  const cached = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const row of svc.readRows(part.path)) cached.push(Number(row.id))
  }
  assert.deepEqual(cached.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8], 'withheld rows remain locally queryable')

  await fs.rm(cacheRoot, { recursive: true, force: true })
  await fs.rm(root, { recursive: true, force: true })
})

test('exportPolicyFingerprint names the allowlist only when one is configured', async () => {
  const cacheRoot = await makeTmpDir()
  const plain = createQueryStorageService({ cacheRoot })
  assert.equal(plain.exportPolicyFingerprint?.(), 'v1 usage:none source:none')
  const scoped = createQueryStorageService({
    cacheRoot,
    repoScopeResolver: createRepoScopeResolver({ allowed: ['github.com/b', 'github.com/a'] }),
  })
  assert.equal(scoped.exportPolicyFingerprint?.(), 'v1 usage:none source:none repo:github.com/a,github.com/b')
  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('config: sync_repos parses, normalizes, and rejects malformed lists', () => {
  const ok = parseConfigShape({ version: 2, sync_repos: ['GitHub.com/Acme', 'github.com/partner/shared.git'] })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.deepEqual(ok.config.sync_repos, ['github.com/acme', 'github.com/partner/shared'])

  assert.equal(parseConfigShape({ version: 2 }).ok, true)
  for (const bad of [[], 'github.com/acme', {}]) {
    const res = parseConfigShape({ version: 2, sync_repos: bad })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.errors[0].pointer, '/sync_repos')
  }
  const entry = parseConfigShape({ version: 2, sync_repos: ['github.com/acme', 'acme'] })
  assert.equal(entry.ok, false)
  if (!entry.ok) assert.equal(entry.errors[0].pointer, '/sync_repos/1')
})

test('config: the central allowlist wins, and a local one applies only when central sets none', () => {
  const acme = /** @type {any} */ ({ version: 2, sync_repos: ['github.com/acme'] })
  const mine = /** @type {any} */ ({ version: 2, sync_repos: ['github.com/me'] })
  const none = /** @type {any} */ ({ version: 2 })
  assert.deepEqual(mergeConfigLayers(acme, mine).effective.sync_repos, ['github.com/acme'])
  assert.deepEqual(mergeConfigLayers(none, mine).effective.sync_repos, ['github.com/me'])
  assert.deepEqual(mergeConfigLayers(null, mine).effective.sync_repos, ['github.com/me'])
  assert.equal(mergeConfigLayers(none, none).effective.sync_repos, undefined)
})

// @ref LLP 0601#query-seam [tests]: a synced session cannot read rows the allowlist keeps local; a local session reads everything
test('query seam: rows outside the allowlist are local-only to a caller whose own session uploads', async () => {
  const stateDir = await makeTmpDir()
  const cacheRoot = path.join(stateDir, 'cache')
  const root = await makeTmpDir()
  const work = path.join(root, 'work')
  const side = path.join(root, 'side')
  const marked = path.join(root, 'marked')
  await makeClone(work, 'git@github.com:acme/tool.git')
  await makeClone(side, 'git@github.com:me/side.git')
  await fs.mkdir(marked, { recursive: true })
  await writeLocalOnlyEntries({ stateDir, entries: [{ dir: marked, class: 'full' }] })

  // Wired as boot wires it: the machine-local list for both seams, the
  // allowlist on the storage handle.
  const svc = createQueryStorageService({
    cacheRoot,
    usagePolicyResolver: createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir) }),
    repoScopeResolver: createRepoScopeResolver({ allowed: ['github.com/acme'] }),
  })
  const table = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(table, COLS, [
    { id: 1, cwd: work, git_remote: null }, // allowed by directory
    { id: 2, cwd: side, git_remote: null }, // outside by directory
    { id: 3, cwd: work, git_remote: 'git@github.com:me/side.git' }, // recorded remote outranks the directory: outside
    { id: 4, cwd: side, git_remote: 'git@github.com:acme/tool.git' }, // and the other way: allowed
    { id: 5, cwd: null, git_remote: 'git@github.com:me/side.git' }, // no cwd, recorded remote outside
    { id: 6, cwd: null, git_remote: null }, // neither: outside this rule
    { id: 7, cwd: marked, git_remote: null }, // no repository, explicitly marked sync
  ])
  await svc.flushTable(table, { reason: 'manual' })
  const [part] = await svc.discoverCachePartitions()
  const registry = /** @type {any} */ ({
    getDataset: () => ({ discoverPartitions: async () => [], createDataSource: async () => svc.dataSourceForTable(part.path) }),
    listDatasets: () => [],
  })

  /** @param {{ callerCwd?: string | null, includeLocalOnly?: boolean, sql?: string }} opts */
  const ids = async ({ sql, ...opts }) => {
    const out = await executeQuerySql({ query: sql ?? 'SELECT id FROM t ORDER BY id', registry, storage: svc, refresh: 'never', ...opts })
    return { ids: out.rows.map((r) => Number(r.id)), withheld: out.localOnly.withheldRows }
  }

  // The export seam and the query seam agree row for row.
  const shipped = []
  for await (const entry of svc.readRowsSince(part.path, {})) if (!entry.dropped) shipped.push(Number(entry.row.id))
  shipped.sort((a, b) => a - b)
  assert.deepEqual(shipped, [1, 4, 6, 7])

  assert.deepEqual(await ids({ callerCwd: work }), { ids: shipped, withheld: 3 }, 'a session in an allowed repository')
  assert.deepEqual(await ids({ callerCwd: marked }), { ids: shipped, withheld: 3 }, 'a session in an explicitly synced folder')
  assert.deepEqual(await ids({ callerCwd: null }), { ids: shipped, withheld: 3 }, 'an unknown caller fails closed')
  assert.deepEqual(await ids({ callerCwd: side }), { ids: [1, 2, 3, 4, 5, 6, 7], withheld: 0 }, 'a session outside the allowlist stays local, so it reads everything')
  assert.deepEqual((await ids({ callerCwd: work, includeLocalOnly: true })).ids, [1, 2, 3, 4, 5, 6, 7])
  // Counting cannot see around the filter, and a projection without either
  // column cannot blind it.
  const count = await executeQuerySql({ query: 'SELECT count(*) AS n FROM t', registry, storage: svc, refresh: 'never', callerCwd: work })
  assert.equal(Number(count.rows[0].n), 4)

  await fs.rm(stateDir, { recursive: true, force: true })
  await fs.rm(root, { recursive: true, force: true })
})

test('query seam: the wrapped resolver ranks callers and rows, and leaves explicit answers alone', () => {
  /** @type {Record<string, ResolveResult>} */
  const answers = {
    '/w/lo': { class: 'local-only', governedBy: '/list', declared: 'local-only' },
    '/w/ig': { class: 'ignore', governedBy: '/w/ig/.hypignore', declared: 'ignore' },
    '/w/marked': { class: 'full', governedBy: '/list', declared: 'full' },
  }
  /** @type {UsagePolicyResolver} */
  const base = {
    resolve: (cwd) => answers[cwd] ?? { class: 'full', governedBy: null, declared: null },
    isIgnored: (cwd) => answers[cwd]?.class === 'ignore',
    fingerprint: () => 'base',
  }
  const scope = createRepoScopeResolver({
    allowed: ['github.com/acme'],
    existsSync: (p) => p === path.join('/w/org', '.git'),
    readFileSync: (p) => {
      if (p === path.join('/w/org', '.git', 'config')) return '[remote "origin"]\n\turl = git@github.com:acme/tool.git\n'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  })
  const resolver = withRepoScope(base, scope)

  assert.equal(resolver.resolve('/w/org').class, 'full')
  assert.deepEqual(resolver.resolve('/w/me'), { class: 'local-only', governedBy: 'config:sync_repos', declared: 'local-only' })
  assert.equal(resolver.resolve('/w/marked').class, 'full', 'an explicit sync marking is not second-guessed')
  assert.equal(resolver.resolve('/w/ig').class, 'ignore')
  assert.equal(resolver.isIgnored('/w/ig'), true)
  assert.equal(resolver.fingerprint?.(), 'base repo:github.com/acme')

  assert.equal(resolver.rowClass?.('/w/lo', 'git@github.com:acme/tool.git'), 'local-only', 'a local-only folder stays local inside an allowed repository')
  assert.equal(resolver.rowClass?.('/w/marked', 'git@github.com:me/side.git'), 'full')

  const synced = resolveCallerClass(resolver, '/w/org').callerRank
  const local = resolveCallerClass(resolver, '/w/me').callerRank
  assert.equal(cwdWithheldFromCaller(resolver, synced, '/w/me', undefined), true)
  assert.equal(cwdWithheldFromCaller(resolver, synced, '/w/org', 'git@github.com:me/side.git'), true)
  assert.equal(cwdWithheldFromCaller(resolver, synced, undefined, 'git@github.com:me/side.git'), true)
  assert.equal(cwdWithheldFromCaller(resolver, synced, undefined, undefined), false)
  assert.equal(cwdWithheldFromCaller(resolver, local, '/w/me', undefined), false)

  // No allowlist on the storage handle: the plain resolver, untouched.
  assert.equal(defaultQueryVisibilityResolver(/** @type {any} */ ({})).rowClass, undefined)
})
