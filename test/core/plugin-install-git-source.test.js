// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

test('findSymlink reports the first symlink encountered in the tree', { skip: process.platform === 'win32' && 'symlink creation needs Developer Mode on win32' }, async () => {
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

const fakeGitOptions = { skip: process.platform === 'win32' && 'fake git uses a POSIX executable' }
const execute = promisify(execFile)

// Isolate PATH and process.env in a child so concurrent tests cannot run real git
// or inherit a fixture's timeout. The outer deadline makes pipe deadlocks fail.
/** @param {string} body @param {'fetch' | 'update' | 'missing'} [action] @param {number} [probeTimeoutMs] */
async function runFakeGit(body, action = 'fetch', probeTimeoutMs = 5000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-git-output-'))
  try {
    const bin = path.join(dir, 'bin')
    await fs.mkdir(bin)
    await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
    if (action !== 'missing') {
      await fs.writeFile(path.join(bin, 'git'), `#!${process.execPath}
import fs from 'node:fs/promises'
import path from 'node:path'
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('git version fixture')
  process.exit(0)
}
async function emit(stream, data) {
  await new Promise((resolve, reject) => stream.write(data, error => error ? reject(error) : resolve()))
}
async function flood(stream) {
  const block = Buffer.alloc(65536, 120)
  for (let i = 0; i < 128; i++) await emit(stream, block)
}
async function artifact() {
  const dest = args.at(-1)
  await fs.mkdir(dest, { recursive: true })
  await fs.writeFile(path.join(dest, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1, runtime: 'node', hypaware_api: '^1.0.0',
    name: '@hypaware/output-fixture', version: '1.0.0', entrypoint: './index.js',
    requires: {}, provides: {}, permissions: [],
  }))
  await fs.writeFile(path.join(dest, 'index.js'), 'export function activate() {}')
}
${body}
await fs.writeFile(process.env.FIXTURE_MARKER, 'drained')
`, { mode: 0o755 })
    }
    const source = { kind: 'git', raw: 'https://example.invalid/fixture.git', gitUrl: 'https://example.invalid/fixture.git', ref: 'main' }
    const script = `
import fs from 'node:fs/promises'
import { fetchGitSource } from ${JSON.stringify(new URL('../../src/core/plugin_install/git_fetch.js', import.meta.url).href)}
import { checkForPluginUpdate } from ${JSON.stringify(new URL('../../src/core/plugin_install/update_check.js', import.meta.url).href)}
const source = ${JSON.stringify(source)}
const stateDir = ${JSON.stringify(path.join(dir, 'state'))}
const result = ${action === 'update'
  ? "await checkForPluginUpdate({ entry: { name: '@hypaware/output-fixture', source, resolved_ref: '1'.repeat(40) } })"
  : "await fetchGitSource({ source, stateDir, runId: 'output-test' })"}
const temporaryStatePresent = await fs.access(stateDir + '/tmp/plugin-fetch/output-test').then(() => true, () => false)
const drained = await fs.readFile(${JSON.stringify(path.join(dir, 'marker'))}, 'utf8').catch(() => '')
console.log(JSON.stringify({ result, temporaryStatePresent, drained }))
`
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PATH: bin, FIXTURE_MARKER: path.join(dir, 'marker'), HYP_GIT_PROBE_TIMEOUT_MS: String(probeTimeoutMs) },
      timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('git clone bounds large failure diagnostics while draining both pipes and cleaning staging', fakeGitOptions, async () => {
  const { result, temporaryStatePresent, drained } = await runFakeGit(String.raw`
await emit(process.stderr, 'fatal: https://u:secret@example.invalid/repo token=secret\n')
await Promise.all([flood(process.stdout), flood(process.stderr)])
process.exitCode = 1
`)
  assert.equal(result.errorKind, 'git_clone_failed')
  assert.ok(Buffer.byteLength(result.message) <= 65536 + 128)
  assert.match(result.message, /fatal: https:\/\/<redacted>@/)
  assert.match(result.message, /truncated/)
  assert.doesNotMatch(result.message, /secret/)
  assert.equal(drained, 'drained')
  assert.equal(temporaryStatePresent, false)
})

test('git diagnostic truncation cannot reveal credentials cut before their closing delimiter', fakeGitOptions, async () => {
  const { result } = await runFakeGit(String.raw`
await emit(process.stderr, 'fatal: permission denied\n')
await emit(process.stderr, 'x'.repeat(65480) + '\nhttps://u:secret-prefix')
await emit(process.stderr, 'secret-suffix'.repeat(10000) + '@example.invalid/repo\n')
process.exitCode = 1
`)
  assert.ok(Buffer.byteLength(result.message) <= 65536 + 128)
  assert.doesNotMatch(result.message, /secret|https:\/\/u:/)
  assert.match(result.message, /permission denied/)
})

test('git small diagnostics retain text and split UTF-8 while redacting split credentials', fakeGitOptions, async () => {
  const { result } = await runFakeGit(String.raw`
await emit(process.stderr, 'fatal: https://u:sec')
await emit(process.stderr, 'ret@example.invalid/repo token=sec')
await emit(process.stderr, 'ret caf')
await emit(process.stderr, Buffer.from([0xc3]))
await emit(process.stderr, Buffer.from([0xa9, 10]))
process.exitCode = 1
`)
  assert.equal(result.message, 'plugin install: git clone failed: fatal: https://<redacted>@example.invalid/repo token=<redacted> café')
})

test('git successful clone drains oversized progress without changing the resolved commit', fakeGitOptions, async () => {
  const { result, temporaryStatePresent, drained } = await runFakeGit(String.raw`
if (args[0] === 'clone') {
  await Promise.all([flood(process.stdout), flood(process.stderr)])
  await artifact()
} else if (args.includes('rev-parse')) await emit(process.stdout, '1'.repeat(40) + '\n')
`)
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300))
  assert.equal(result.resolvedRef, '1'.repeat(40))
  assert.equal(temporaryStatePresent, false)
  assert.equal(drained, 'drained')
})

test('git resolve refuses oversized functional stdout instead of installing a partial ref', fakeGitOptions, async () => {
  const { result, temporaryStatePresent, drained } = await runFakeGit(String.raw`
if (args[0] === 'clone') await artifact()
else if (args.includes('rev-parse')) {
  await emit(process.stdout, '1'.repeat(40) + '\n')
  await flood(process.stdout)
}
`)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'git_checkout_failed')
  assert.match(result.message, /stdout.*limit/)
  assert.equal(temporaryStatePresent, false)
  assert.equal(drained, 'drained')
})

test('git update refuses oversized ref lists even when their prefix contains a valid SHA', fakeGitOptions, async () => {
  const { result, drained } = await runFakeGit(String.raw`
await emit(process.stdout, '1'.repeat(40) + '\trefs/tags/main\n')
await Promise.all([flood(process.stdout), flood(process.stderr)])
await emit(process.stdout, '\n' + '2'.repeat(40) + '\trefs/tags/main^{}\n')
`, 'update')
  assert.equal(result.available, false)
  assert.equal(result.error, 'git_ls_remote_failed')
  assert.equal(result.latest_ref, undefined)
  assert.equal(drained, 'drained')
})

test('git update preserves ordinary peeled-ref selection and failure classification', fakeGitOptions, async () => {
  const { result } = await runFakeGit(String.raw`
await emit(process.stdout, '1'.repeat(40) + '\trefs/tags/main\n' + '2'.repeat(40) + '\trefs/tags/main^{}\n')
`, 'update')
  assert.equal(result.latest_ref, '2'.repeat(40))
  assert.equal(result.available, true)
  const failed = await runFakeGit('await Promise.all([flood(process.stdout), flood(process.stderr)])\nprocess.exitCode = 1', 'update')
  assert.equal(failed.result.error, 'git_ls_remote_failed')
  assert.equal(failed.drained, 'drained')
})

test('git spawn failure and probe timeout retain their existing classifications', fakeGitOptions, async () => {
  assert.equal((await runFakeGit('', 'missing')).result.errorKind, 'git_unavailable')
  assert.equal((await runFakeGit('setInterval(() => {}, 1000)', 'update', 250)).result.error, 'git_probe_timeout')
})
