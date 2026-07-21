// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveRepoFromCwd, redactRemoteUserinfo } from '../../hypaware-core/plugins-workspace/hermes/src/git_repo.js'

/**
 * Unit tests for the hermes projector's repo-enrichment helper
 * (`deriveRepoFromCwd`, LLP 0122#projection). The git runner is injected so
 * the derivation is hermetic; no real repo on disk.
 */

/**
 * @param {Record<string, string>} byKey  e.g. { 'config': '<remote>', 'rev-parse:--show-toplevel': '<root>' }
 */
function gitStub(byKey) {
  /** @type {string[][]} */
  const calls = []
  /** @type {(file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>} */
  const exec = async (_file, args) => {
    calls.push(args)
    const sub = args[2]
    const key = sub === 'rev-parse' ? `rev-parse:${args[3]}` : sub
    const out = byKey[key]
    if (out === undefined) throw new Error(`not a git repo: ${args.join(' ')}`)
    return { stdout: `${out}\n` }
  }
  return { exec, calls }
}

test('derives redacted remote and repo_root, never asks for HEAD', async () => {
  const { exec, calls } = gitStub({
    'config': 'https://x-access-token:ghs_SECRET@github.com/acme/repo.git',
    'rev-parse:--show-toplevel': '/home/dev/project',
  })
  const out = await deriveRepoFromCwd('/home/dev/project', exec)

  assert.equal(out.git_remote, 'https://github.com/acme/repo.git')
  assert.equal(out.repo_root, '/home/dev/project')
  assert.equal(/** @type {any} */ (out).head_sha, undefined)

  const subcommands = calls.map((a) => (a[2] === 'rev-parse' ? `rev-parse ${a[3]}` : a[2]))
  assert.deepEqual(subcommands.sort(), ['config', 'rev-parse --show-toplevel'])
})

test('an SSH remote is left intact (no userinfo to strip)', async () => {
  const { exec } = gitStub({
    'config': 'git@github.com:acme/repo.git',
    'rev-parse:--show-toplevel': '/repo',
  })
  const out = await deriveRepoFromCwd('/repo', exec)
  assert.equal(out.git_remote, 'git@github.com:acme/repo.git')
})

test('degrades to empty when the cwd is not a git repo (deleted worktree, channel scope path)', async () => {
  const { exec } = gitStub({})
  const out = await deriveRepoFromCwd('/gone/worktree', exec)
  assert.deepEqual(out, {})
})

test('returns empty for an absent cwd without invoking git', async () => {
  let called = false
  const exec = async () => { called = true; return { stdout: '' } }
  assert.deepEqual(await deriveRepoFromCwd(undefined, exec), {})
  assert.deepEqual(await deriveRepoFromCwd('', exec), {})
  assert.equal(called, false)
})

test('redactRemoteUserinfo strips credential userinfo from an https remote only', () => {
  assert.equal(
    redactRemoteUserinfo('https://x-access-token:ghs_SECRET@github.com/acme/repo.git'),
    'https://github.com/acme/repo.git'
  )
  assert.equal(redactRemoteUserinfo('git@github.com:acme/repo.git'), 'git@github.com:acme/repo.git')
  assert.equal(redactRemoteUserinfo(undefined), undefined)
})
