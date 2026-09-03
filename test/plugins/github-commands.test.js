// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runGithubBackfill } from '../../hypaware-core/plugins-workspace/github/src/commands.js'
import { setGithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/runtime.js'
import { fakeClient } from './github-fake-client.js'

/** @import { GithubClient } from '../../hypaware-core/plugins-workspace/github/src/types.js' */

/** Collect what a command writes, with the `CommandRunContext` surface it uses. */
function recordingCtx() {
  let out = ''
  let err = ''
  return {
    ctx: /** @type {any} */ ({
      stdout: { write: (/** @type {string} */ s) => { out += s } },
      stderr: { write: (/** @type {string} */ s) => { err += s } },
    }),
    stdout: () => out,
    stderr: () => err,
  }
}

/**
 * @param {string} stateDir
 * @param {GithubClient} client
 */
function activate(stateDir, client) {
  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    config: {
      ignore: [],
      token_env: 'GITHUB_TOKEN',
      poll_interval: '24h',
      inventory: 'all_visible',
    },
    observedRepos: { async list() { return [] } },
    clientFactory: () => client,
    storage: {
      cacheTablePath() { return path.join(stateDir, 'github_events') },
      async appendRows() { throw new Error('a failed inventory must not append') },
    },
    env: {},
    log: { info() {}, error() {} },
  }))
}

test('backfill reports a failed inventory resolve instead of diagnosing an absent repository', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-commands-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const client = fakeClient({})
  client.listViewerRepos = async () => {
    throw Object.assign(
      new Error('GitHub continuation URL refused: it does not address the configured API base'),
      { hypErrorKind: 'github_foreign_origin' },
    )
  }
  activate(stateDir, client)
  const rec = recordingCtx()

  const code = await runGithubBackfill(['owner/a'], rec.ctx)

  assert.equal(code, 1)
  assert.match(rec.stderr(), /continuation URL refused/)
  assert.ok(
    !rec.stderr().includes('active repository inventory'),
    'an unresolved inventory is unknown, not empty: the repository-absent diagnosis would be false',
  )
  assert.ok(
    !rec.stdout().includes('hyp graph project'),
    'a tick that captured nothing must not point at projection as the next step',
  )
})

test('backfill still diagnoses a genuinely absent repository', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-commands-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  activate(stateDir, fakeClient({ viewerRepos: ['owner/b'] }))
  const rec = recordingCtx()

  const code = await runGithubBackfill(['owner/a'], rec.ctx)

  assert.equal(code, 1)
  assert.match(rec.stderr(), /none of \[owner\/a\] are in the active repository inventory/)
})
