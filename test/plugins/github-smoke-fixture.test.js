// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { fakeGithubClient, noWithheldRepo } from '../../hypaware-core/smoke/lib/github_fixture.js'

// `assertRepo` is the network seam the paired GitHub smokes rest on: it fails
// inside the command and names the repository that escaped, rather than
// leaving a row count to disagree several steps later. A guard that can be
// omitted takes the seam with it and leaves every other assertion passing, so
// these pin the two halves of the contract (issue #1327): no client exists
// without a guard, and every read that names a repository runs the one given.

test('fakeGithubClient refuses to build without a guard', () => {
  for (const bad of [undefined, {}, { assertRepo: 'acme/widgets' }]) {
    assert.throws(
      () => /** @type {any} */ (fakeGithubClient)(bad),
      { name: 'TypeError', message: /assertRepo is required/ }
    )
  }
  assert.ok(fakeGithubClient({ assertRepo: noWithheldRepo }))
})

// Enumerated rather than listed by hand, so a read added to the fake without
// the guard fails here instead of quietly widening the hole the guard closes.
// Every `GithubClient` method but `listViewerRepos` takes `(owner, repo)`
// first (github/src/types.d.ts), and the arguments after those two are
// ignored by the fake, so one call shape covers them all.
const repoReads = Object.keys(/** @type {any} */ (fakeGithubClient({ assertRepo: noWithheldRepo })))
  .filter((name) => name !== 'listViewerRepos')

test('every read that names a repository runs the guard it was given', async () => {
  assert.ok(repoReads.length >= 8, `expected the fake to serve the repo-naming reads, got ${repoReads}`)
  for (const read of repoReads) {
    /** @type {string[]} */
    const seen = []
    const client = /** @type {any} */ (fakeGithubClient({
      assertRepo: (owner, name) => { seen.push(`${owner}/${name}`) },
    }))
    await client[read]('Acme', 'Widgets', 7)
    assert.deepEqual(seen, ['Acme/Widgets'], `${read} did not run the guard`)
  }
})

test('a refusal reaches the caller of every repo-naming read', async () => {
  // A refusal has to propagate rather than be swallowed into an empty page,
  // which would read as a repository that was simply never asked about.
  for (const read of repoReads) {
    const client = /** @type {any} */ (fakeGithubClient({
      assertRepo: (owner, name) => { throw new Error(`withheld repository reached the GitHub client: ${owner}/${name}`) },
    }))
    await assert.rejects(
      () => client[read]('acme', 'secrets', 7),
      /withheld repository reached the GitHub client: acme\/secrets/,
      read
    )
  }
})

test('the viewer-repository read is the one method with no repository to guard', async () => {
  const client = fakeGithubClient({ assertRepo: noWithheldRepo })
  await assert.rejects(() => client.listViewerRepos(), /must not enumerate GitHub/)
})
