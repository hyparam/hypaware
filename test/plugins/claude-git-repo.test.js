// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveRepoFromCwd } from '../../hypaware-core/plugins-workspace/claude/src/git_repo.js'

/**
 * Unit tests for the backfill-time repo recovery helper. The git runner is
 * injected so the derivation is hermetic — no real repo on disk.
 */

/**
 * Build an `execFile`-shaped stub that answers each git subcommand from a map
 * keyed on the subcommand, and records every argv it was asked to run.
 *
 * @param {Record<string, string>} byKey  e.g. { 'config': '<remote>', 'rev-parse:--show-toplevel': '<root>' }
 */
function gitStub(byKey) {
  /** @type {string[][]} */
  const calls = []
  /** @type {(file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>} */
  const exec = async (_file, args) => {
    calls.push(args)
    // args look like ['-C', cwd, 'config', '--get', 'remote.origin.url'] or
    // ['-C', cwd, 'rev-parse', '--show-toplevel'].
    const sub = args[2]
    const key = sub === 'rev-parse' ? `rev-parse:${args[3]}` : sub
    const out = byKey[key]
    if (out === undefined) throw new Error(`not a git repo: ${args.join(' ')}`)
    return { stdout: `${out}\n` }
  }
  return { exec, calls }
}

test('derives redacted remote and repo_root, and never asks for HEAD', async () => {
  const { exec, calls } = gitStub({
    'config': 'https://x-access-token:ghs_SECRET@github.com/acme/repo.git',
    'rev-parse:--show-toplevel': '/Users/phil/workspace/repo',
  })
  const out = await deriveRepoFromCwd('/Users/phil/workspace/repo', exec)

  // Credential userinfo stripped at ingress (LLP 0032 §remote-redaction).
  assert.equal(out.git_remote, 'https://github.com/acme/repo.git')
  assert.equal(out.repo_root, '/Users/phil/workspace/repo')
  assert.equal(/** @type {any} */ (out).head_sha, undefined)

  // It must never run `rev-parse HEAD` — a backfilled head_sha would be
  // anachronistic. Only remote + toplevel are probed.
  const subcommands = calls.map((a) => (a[2] === 'rev-parse' ? `rev-parse ${a[3]}` : a[2]))
  assert.deepEqual(subcommands.sort(), ['config', 'rev-parse --show-toplevel'])
  assert.ok(!subcommands.includes('rev-parse HEAD'))
})

test('an SSH remote is left intact (no userinfo to strip)', async () => {
  const { exec } = gitStub({
    'config': 'git@github.com:acme/repo.git',
    'rev-parse:--show-toplevel': '/repo',
  })
  const out = await deriveRepoFromCwd('/repo', exec)
  assert.equal(out.git_remote, 'git@github.com:acme/repo.git')
})

test('degrades to empty when the cwd is not a git repo', async () => {
  // Stub answers nothing → every git call throws.
  const { exec } = gitStub({})
  const out = await deriveRepoFromCwd('/gone/worktree', exec)
  assert.deepEqual(out, {})
})

test('a repo with no origin still yields repo_root', async () => {
  const { exec } = gitStub({ 'rev-parse:--show-toplevel': '/local/only' })
  const out = await deriveRepoFromCwd('/local/only', exec)
  assert.equal(out.git_remote, undefined)
  assert.equal(out.repo_root, '/local/only')
})

test('returns empty for an absent cwd without invoking git', async () => {
  let called = false
  const exec = async () => { called = true; return { stdout: '' } }
  assert.deepEqual(await deriveRepoFromCwd(undefined, exec), {})
  assert.deepEqual(await deriveRepoFromCwd('', exec), {})
  assert.equal(called, false)
})
