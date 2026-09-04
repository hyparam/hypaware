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

test('every read that names a repository runs the guard it was given', async () => {
  /** @type {string[]} */
  const seen = []
  const client = fakeGithubClient({ assertRepo: (owner, name) => { seen.push(`${owner}/${name}`) } })
  await client.listIssuesPage('Acme', 'Widgets')
  await client.listPullRequestsPage('Acme', 'Widgets')
  await client.listCommitsPage('Acme', 'Widgets')
  assert.deepEqual(seen, ['Acme/Widgets', 'Acme/Widgets', 'Acme/Widgets'])

  // A refusal has to reach the caller rather than being swallowed into an
  // empty page, which would read as a repository that was simply never asked
  // about.
  const guarded = fakeGithubClient({
    assertRepo: (owner, name) => { throw new Error(`withheld repository reached the GitHub client: ${owner}/${name}`) },
  })
  await assert.rejects(
    () => guarded.listIssuesPage('acme', 'secrets'),
    /withheld repository reached the GitHub client: acme\/secrets/
  )
})
