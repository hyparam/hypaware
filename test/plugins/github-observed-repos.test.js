// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createLocalObservedReposIndex } from '../../hypaware-core/plugins-workspace/github/src/observed-repos.js'
import { runCaptureTick } from '../../hypaware-core/plugins-workspace/github/src/tick.js'

/** @import { QueryStorageService } from '../../hypaware-core/plugins-workspace/github/src/types.d.ts' */

test('local session inventory is incremental, durable, narrow, and privacy-aware', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-observed-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  let phase = 0
  let discoveries = 0
  /** @type {Array<{ tablePath: string, since: unknown, includeLegacy: boolean | undefined, columns: string[] | undefined }>} */
  const reads = []
  const storage = /** @type {QueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      discoveries += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [
        { dataset: 'ai_gateway_messages', path: '/cache/messages/a', epoch: 0, rowCount: phase === 0 ? 3 : 5, partition: {} },
        { dataset: 'other', path: '/cache/other', epoch: 0, rowCount: 1, partition: {} },
        { dataset: 'ai_gateway_messages', path: '/cache/messages/a', epoch: 0, rowCount: phase === 0 ? 3 : 5, partition: {} },
        { dataset: 'ai_gateway_messages', path: '/cache/messages/b', epoch: 0, rowCount: 4, partition: {} },
      ]
    },
    async *readRowsSince(tablePath, opts) {
      reads.push({ tablePath, since: opts.since, includeLegacy: opts.includeLegacy, columns: opts.columns })
      if (phase === 0 && tablePath.endsWith('/a')) {
        yield { row: { git_remote: 'git@github.com:Acme/Widgets.git' }, after: { v: 1, seq: '1' } }
        yield { row: { git_remote: 'https://gitlab.com/acme/not-github.git' }, after: { v: 1, seq: '2' } }
        yield { dropped: true, after: { v: 1, seq: '3' } }
      }
      if (phase === 0 && tablePath.endsWith('/b')) {
        yield { row: { git_remote: 'https://www.github.com/Beta/Tool/' }, after: { v: 1, seq: '4' } }
      }
      if (phase === 1 && tablePath.endsWith('/a')) {
        yield { row: { git_remote: 'https://github.com/acme/new-repo.git' }, after: { v: 1, seq: '5' } }
      }
    },
  }))

  const index = createLocalObservedReposIndex({ storage, stateDir })
  const [first, concurrent] = await Promise.all([index.list(), index.list()])
  assert.equal(discoveries, 1)
  assert.deepEqual(first, ['acme/widgets', 'beta/tool'])
  assert.deepEqual(concurrent, first)
  assert.equal(reads.length, 2)
  assert.ok(reads.every((read) => read.since === undefined && read.includeLegacy === true))
  assert.ok(reads.every((read) => JSON.stringify(read.columns) === JSON.stringify(['git_remote'])))

  const persisted = fs.readFileSync(path.join(stateDir, 'github-observed-repos.json'), 'utf8')
  assert.match(persisted, /acme\/widgets/)
  assert.match(persisted, /beta\/tool/)
  assert.doesNotMatch(persisted, /github\.com|gitlab\.com/)

  phase = 1
  reads.length = 0
  const resumed = await createLocalObservedReposIndex({ storage, stateDir }).list()
  assert.equal(reads.length, 1)
  assert.ok(reads[0].tablePath.endsWith('/a'))
  assert.deepEqual(reads[0].since, { v: 1, seq: '3' })
  assert.equal(reads[0].includeLegacy, false)
  assert.deepEqual(resumed, ['acme/new-repo', 'acme/widgets', 'beta/tool'])

  reads.length = 0
  const unchanged = await createLocalObservedReposIndex({ storage, stateDir }).list()
  assert.deepEqual(unchanged, resumed)
  assert.equal(reads.length, 0)
})

test('default capture tick uses local session evidence without GitHub enumeration', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-empty-tick-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  let observedReads = 0
  let viewerEnumerations = 0

  const report = await runCaptureTick(
    /** @type {any} */ ({
      stateDir,
      config: {
        ignore: [],
        token_env: 'GITHUB_TOKEN',
        poll_interval: '24h',
        inventory: 'session_repos',
      },
      observedRepos: {
        async list() {
          observedReads += 1
          return []
        },
      },
      clientFactory: () => ({
        async listViewerRepos() { viewerEnumerations += 1; return ['outside/not-used'] },
      }),
      storage: {
        cacheTablePath() { return '/cache/github_events' },
        async appendRows() { throw new Error('empty evidence must not append') },
      },
      log: { error() {}, info() {} },
    }),
    { mode: 'backfill' },
  )

  assert.equal(observedReads, 1)
  assert.equal(viewerEnumerations, 0)
  assert.deepEqual(report, { repos: 0, events: 0, errors: [] })
})
