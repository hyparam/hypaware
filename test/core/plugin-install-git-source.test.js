// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

import {
  applyGitSourceFlags,
  parseGitSource,
  provenanceFromUrl,
  redactGitUrl,
  redactRawSource,
} from '../../src/core/plugin_install/git_source.js'
import { resolveSource } from '../../src/core/plugin_install/resolver.js'
import {
  findSymlink,
  hashArtifactTree,
  validateEntrypoint,
} from '../../src/core/plugin_install/git_fetch.js'
import { pickLsRemoteSha } from '../../src/core/plugin_install/update_check.js'

test('parseGitSource accepts https GitHub URLs with and without .git suffix', () => {
  for (const url of [
    'https://github.com/hyperparam/hypaware-foo.git',
    'https://github.com/hyperparam/hypaware-foo',
  ]) {
    const parts = parseGitSource(url)
    assert.equal(parts.gitUrl, 'https://github.com/hyperparam/hypaware-foo.git')
    assert.equal(parts.host, 'github.com')
    assert.equal(parts.owner, 'hyperparam')
    assert.equal(parts.repo, 'hypaware-foo')
    assert.equal(parts.ref, undefined)
  }
})

test('parseGitSource extracts ref from URL fragment', () => {
  const parts = parseGitSource('https://github.com/owner/repo.git#v1.2.3')
  assert.equal(parts.gitUrl, 'https://github.com/owner/repo.git')
  assert.equal(parts.ref, 'v1.2.3')
})

test('parseGitSource normalizes github: shorthand to HTTPS clone URL', () => {
  const parts = parseGitSource('github:hyperparam/hypaware-foo#abc1234')
  assert.equal(parts.gitUrl, 'https://github.com/hyperparam/hypaware-foo.git')
  assert.equal(parts.owner, 'hyperparam')
  assert.equal(parts.repo, 'hypaware-foo')
  assert.equal(parts.ref, 'abc1234')
})

test('parseGitSource normalizes git@github.com SSH shorthand to HTTPS clone URL', () => {
  const parts = parseGitSource('git@github.com:hyperparam/hypaware-foo.git#main')
  assert.equal(parts.gitUrl, 'https://github.com/hyperparam/hypaware-foo.git')
  assert.equal(parts.owner, 'hyperparam')
  assert.equal(parts.repo, 'hypaware-foo')
  assert.equal(parts.ref, 'main')
})

test('parseGitSource passes through non-GitHub git URLs untouched', () => {
  const parts = parseGitSource('https://gitlab.com/org/proj.git')
  assert.equal(parts.gitUrl, 'https://gitlab.com/org/proj.git')
  assert.equal(parts.owner, undefined)
  assert.equal(parts.repo, undefined)
})

test('applyGitSourceFlags rejects --ref when a URL fragment was already supplied', () => {
  const parts = parseGitSource('https://github.com/owner/repo.git#v1.0.0')
  assert.throws(
    () => applyGitSourceFlags(parts, { ref: 'v2.0.0' }),
    (err) => {
      assert.equal(/** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind, 'source_ambiguous')
      return true
    }
  )
})

test('applyGitSourceFlags adopts --ref when the URL has no fragment', () => {
  const parts = parseGitSource('https://github.com/owner/repo.git')
  const merged = applyGitSourceFlags(parts, { ref: 'v2.0.0' })
  assert.equal(merged.ref, 'v2.0.0')
})

test('applyGitSourceFlags rejects --path subdir with git_subdir_unsupported', () => {
  const parts = parseGitSource('https://github.com/owner/repo.git')
  assert.throws(
    () => applyGitSourceFlags(parts, { subdir: 'packages/foo' }),
    (err) => {
      assert.equal(
        /** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind,
        'git_subdir_unsupported'
      )
      return true
    }
  )
})

test('resolveSource forwards --ref into the resolved git source spec', () => {
  const spec = resolveSource('https://github.com/owner/repo.git', { ref: 'v3.1.0' })
  assert.equal(spec.kind, 'git')
  assert.equal(spec.ref, 'v3.1.0')
  assert.equal(spec.gitUrl, 'https://github.com/owner/repo.git')
})

test('resolveSource throws git_subdir_unsupported when --path is provided', () => {
  assert.throws(
    () => resolveSource('https://github.com/owner/repo.git', { subdir: 'packages/foo' }),
    (err) => {
      assert.equal(
        /** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind,
        'git_subdir_unsupported'
      )
      return true
    }
  )
})

test('resolveSource throws source_ambiguous when --ref conflicts with URL fragment', () => {
  assert.throws(
    () => resolveSource('https://github.com/owner/repo.git#v1.0.0', { ref: 'v2.0.0' }),
    (err) => {
      assert.equal(
        /** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind,
        'source_ambiguous'
      )
      return true
    }
  )
})

test('resolveSource still routes github: shorthand through the git path', () => {
  const spec = resolveSource('github:hyperparam/hypaware-foo')
  assert.equal(spec.kind, 'git')
  assert.equal(spec.gitUrl, 'https://github.com/hyperparam/hypaware-foo.git')
})

test('provenanceFromUrl extracts host/owner/repo from HTTPS clone URL', () => {
  const prov = provenanceFromUrl('https://github.com/hyperparam/hypaware-foo.git')
  assert.equal(prov.host, 'github.com')
  assert.equal(prov.owner, 'hyperparam')
  assert.equal(prov.repo, 'hypaware-foo')
})

test('validateEntrypoint rejects absolute paths', () => {
  const result = validateEntrypoint('/etc/passwd', '/tmp/artifact')
  assert.equal(typeof result, 'string')
})

test('validateEntrypoint rejects parent-directory traversal', () => {
  const result = validateEntrypoint('../escape.js', '/tmp/artifact')
  assert.equal(typeof result, 'string')
})

test('validateEntrypoint accepts a relative path that stays inside the artifact root', () => {
  const result = validateEntrypoint('./src/index.js', '/tmp/artifact')
  assert.equal(result, undefined)
})

test('findSymlink reports the first symlink encountered in the tree', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-git-symlink-'))
  try {
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', 'a.txt'), 'hello')
    await fs.symlink(path.join(dir, 'sub', 'a.txt'), path.join(dir, 'link.txt'))

    const offender = await findSymlink(dir, dir)
    assert.equal(offender, 'link.txt')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('findSymlink returns null for a tree with no symlinks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-git-nosym-'))
  try {
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', 'a.txt'), 'hello')
    await fs.writeFile(path.join(dir, 'b.txt'), 'world')

    const offender = await findSymlink(dir, dir)
    assert.equal(offender, null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('hashArtifactTree is stable across two equal trees', async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hash-a-'))
  const b = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hash-b-'))
  try {
    for (const dir of [a, b]) {
      await fs.writeFile(path.join(dir, 'one.txt'), 'one\n')
      await fs.mkdir(path.join(dir, 'sub'))
      await fs.writeFile(path.join(dir, 'sub', 'two.txt'), 'two\n')
    }
    const hashA = await hashArtifactTree(a)
    const hashB = await hashArtifactTree(b)
    assert.equal(hashA, hashB)
  } finally {
    await fs.rm(a, { recursive: true, force: true })
    await fs.rm(b, { recursive: true, force: true })
  }
})

test('hashArtifactTree changes when file content changes', async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hash-c-'))
  try {
    await fs.writeFile(path.join(a, 'one.txt'), 'one\n')
    const hashFirst = await hashArtifactTree(a)
    await fs.writeFile(path.join(a, 'one.txt'), 'different\n')
    const hashSecond = await hashArtifactTree(a)
    assert.notEqual(hashFirst, hashSecond)
  } finally {
    await fs.rm(a, { recursive: true, force: true })
  }
})

test('parseGitSource rejects raw input that begins with a dash', () => {
  assert.throws(
    () => parseGitSource('--upload-pack=evil'),
    (err) => {
      assert.equal(/** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind, 'resolver_error')
      return true
    }
  )
})

test('parseGitSource rejects URL fragment refs that begin with a dash', () => {
  assert.throws(
    () => parseGitSource('https://github.com/owner/repo.git#--upload-pack=evil'),
    (err) => {
      assert.equal(/** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind, 'resolver_error')
      return true
    }
  )
})

test('parseGitSource strips userinfo from passthrough URLs', () => {
  const parts = parseGitSource('https://x:secret@gitlab.com/org/proj.git')
  assert.equal(parts.gitUrl, 'https://gitlab.com/org/proj.git')
})

test('parseGitSource strips userinfo from passthrough URLs with a fragment', () => {
  const parts = parseGitSource('https://x:secret@gitlab.com/org/proj.git#v1.0.0')
  assert.equal(parts.gitUrl, 'https://gitlab.com/org/proj.git')
  assert.equal(parts.ref, 'v1.0.0')
})

test('parseGitSource accepts GitHub HTTPS URLs that carry userinfo and ignores it', () => {
  const parts = parseGitSource('https://token:x-oauth-basic@github.com/owner/repo.git')
  assert.equal(parts.gitUrl, 'https://github.com/owner/repo.git')
  assert.equal(parts.owner, 'owner')
  assert.equal(parts.repo, 'repo')
})

test('applyGitSourceFlags rejects --ref values that start with a dash', () => {
  const parts = parseGitSource('https://github.com/owner/repo.git')
  assert.throws(
    () => applyGitSourceFlags(parts, { ref: '--upload-pack=evil' }),
    (err) => {
      assert.equal(/** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind, 'resolver_error')
      return true
    }
  )
})

test('applyGitSourceFlags rejects --path values that start with a dash before reporting unsupported', () => {
  const parts = parseGitSource('https://github.com/owner/repo.git')
  assert.throws(
    () => applyGitSourceFlags(parts, { subdir: '--upload-pack=evil' }),
    (err) => {
      assert.equal(/** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind, 'resolver_error')
      return true
    }
  )
})

test('redactGitUrl strips user:pass@ userinfo', () => {
  assert.equal(
    redactGitUrl('https://x:secret@example.com/foo.git'),
    'https://example.com/foo.git'
  )
})

test('redactGitUrl is a no-op on URLs without userinfo', () => {
  assert.equal(
    redactGitUrl('https://example.com/foo.git'),
    'https://example.com/foo.git'
  )
})

test('redactGitUrl preserves port and path through the redaction', () => {
  assert.equal(
    redactGitUrl('https://u:p@example.com:8443/foo/bar.git'),
    'https://example.com:8443/foo/bar.git'
  )
})

test('redactRawSource strips userinfo while preserving the #ref fragment', () => {
  assert.equal(
    redactRawSource('https://u:p@example.com/foo.git#v1.2.3'),
    'https://example.com/foo.git#v1.2.3'
  )
})

test('resolveSource persists redacted raw + gitUrl for a passthrough URL with credentials', () => {
  const spec = resolveSource('https://x:secret@gitlab.com/org/proj.git#v1.0.0')
  assert.equal(spec.kind, 'git')
  assert.equal(spec.raw, 'https://gitlab.com/org/proj.git#v1.0.0')
  assert.equal(spec.gitUrl, 'https://gitlab.com/org/proj.git')
  assert.equal(spec.ref, 'v1.0.0')
})

test('resolveSource rejects rawSource that begins with a dash', () => {
  assert.throws(
    () => resolveSource('https://github.com/owner/repo.git', { ref: '--upload-pack=evil' }),
    (err) => {
      assert.equal(/** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind, 'resolver_error')
      return true
    }
  )
})

test('pickLsRemoteSha prefers the peeled commit for an annotated tag', () => {
  const stdout = [
    '1111111111111111111111111111111111111111\trefs/tags/v1.2.3',
    '2222222222222222222222222222222222222222\trefs/tags/v1.2.3^{}',
  ].join('\n')
  assert.equal(
    pickLsRemoteSha(stdout, 'v1.2.3'),
    '2222222222222222222222222222222222222222'
  )
})

test('pickLsRemoteSha returns the lightweight tag SHA when no peeled line exists', () => {
  const stdout = '1111111111111111111111111111111111111111\trefs/tags/v1.2.3\n'
  assert.equal(
    pickLsRemoteSha(stdout, 'v1.2.3'),
    '1111111111111111111111111111111111111111'
  )
})

test('pickLsRemoteSha prefers the HEAD line when HEAD was requested', () => {
  const stdout = [
    '3333333333333333333333333333333333333333\trefs/tags/old',
    '4444444444444444444444444444444444444444\tHEAD',
  ].join('\n')
  assert.equal(
    pickLsRemoteSha(stdout, 'HEAD'),
    '4444444444444444444444444444444444444444'
  )
})

test('pickLsRemoteSha returns undefined when no commit-shaped SHA is present', () => {
  assert.equal(pickLsRemoteSha('not-a-sha refs/heads/main\n', 'main'), undefined)
})
