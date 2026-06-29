// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { PassThrough } from 'node:stream'

import {
  buildTtyPrompt,
  buildWarnings,
  decideConfirmation,
  renderConfirmationSummary,
  sourceIsUnpinnedBranch,
} from '../../src/core/plugin_install/confirm.js'
import {
  installPlugin,
  updatePlugin,
  loadLock,
} from '../../src/core/plugin_install/install.js'

test('decideConfirmation: --yes returns auto_yes proceed', async () => {
  const decision = await decideConfirmation({ yes: true, tty: false })
  assert.equal(decision.proceed, true)
  assert.equal(decision.outcome, 'auto_yes')
})

test('decideConfirmation: --yes wins even with a tty (no prompt)', async () => {
  let asked = false
  const decision = await decideConfirmation({
    yes: true,
    tty: true,
    ask: async () => {
      asked = true
      return true
    },
  })
  assert.equal(decision.proceed, true)
  assert.equal(decision.outcome, 'auto_yes')
  assert.equal(asked, false)
})

test('decideConfirmation: non-tty without --yes returns non_tty_no_yes', async () => {
  const decision = await decideConfirmation({ yes: false, tty: false })
  assert.equal(decision.proceed, false)
  assert.equal(decision.outcome, 'non_tty_no_yes')
})

test('decideConfirmation: tty + ask returning true => confirmed/proceed', async () => {
  const decision = await decideConfirmation({
    yes: false,
    tty: true,
    ask: async () => true,
  })
  assert.equal(decision.proceed, true)
  assert.equal(decision.outcome, 'confirmed')
})

test('decideConfirmation: tty + ask returning false => rejected/abort', async () => {
  const decision = await decideConfirmation({
    yes: false,
    tty: true,
    ask: async () => false,
  })
  assert.equal(decision.proceed, false)
  assert.equal(decision.outcome, 'rejected')
})

test('buildTtyPrompt: real readline returns the trimmed answer (yes)', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const ask = buildTtyPrompt({ stdin, stdout, promptText: 'Proceed? ' })
  const pending = ask()
  stdin.write('Y\n')
  const answer = await pending
  assert.equal(answer, true)
})

test('buildTtyPrompt: real readline returns false when the user types anything else', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const ask = buildTtyPrompt({ stdin, stdout, promptText: 'Proceed? ' })
  const pending = ask()
  stdin.write('no thanks\n')
  const answer = await pending
  assert.equal(answer, false)
})

test('buildTtyPrompt: real readline trims whitespace before deciding', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const ask = buildTtyPrompt({ stdin, stdout })
  const pending = ask()
  stdin.write('   yes   \n')
  const answer = await pending
  assert.equal(answer, true)
})

test('sourceIsUnpinnedBranch: missing ref counts as unpinned', () => {
  const result = sourceIsUnpinnedBranch({
    kind: 'git',
    raw: 'https://github.com/owner/repo.git',
    gitUrl: 'https://github.com/owner/repo.git',
  })
  assert.equal(result, true)
})

test('sourceIsUnpinnedBranch: branch name counts as unpinned', () => {
  const result = sourceIsUnpinnedBranch({
    kind: 'git',
    raw: 'https://github.com/owner/repo.git#main',
    gitUrl: 'https://github.com/owner/repo.git',
    ref: 'main',
  })
  assert.equal(result, true)
})

test('sourceIsUnpinnedBranch: semver tag counts as pinned', () => {
  const result = sourceIsUnpinnedBranch({
    kind: 'git',
    raw: 'https://github.com/owner/repo.git#v1.2.3',
    gitUrl: 'https://github.com/owner/repo.git',
    ref: 'v1.2.3',
  })
  assert.equal(result, false)
})

test('sourceIsUnpinnedBranch: commit sha counts as pinned', () => {
  const result = sourceIsUnpinnedBranch({
    kind: 'git',
    raw: 'https://github.com/owner/repo.git#abc123def4567890abc123def4567890abc12345',
    gitUrl: 'https://github.com/owner/repo.git',
    ref: 'abc123def4567890abc123def4567890abc12345',
  })
  assert.equal(result, false)
})

test('sourceIsUnpinnedBranch: local-dir is not a branch', () => {
  const result = sourceIsUnpinnedBranch({
    kind: 'local-dir',
    raw: './plugin',
    path: '/tmp/plugin',
  })
  assert.equal(result, false)
})

test('buildWarnings: broad permission `network` triggers a warning', () => {
  const warnings = buildWarnings({
    manifest: {
      schema_version: 1,
      name: '@hypaware/foo',
      version: '0.1.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      permissions: ['network'],
    },
    source: {
      kind: 'git',
      raw: 'https://github.com/owner/repo.git#v1.0.0',
      gitUrl: 'https://github.com/owner/repo.git',
      ref: 'v1.0.0',
    },
    resolvedRef: 'abc',
    contentHash: 'h',
    manifestHash: 'mh',
  })
  assert.ok(warnings.some((w) => /broad permissions/.test(w) && /network/.test(w)))
})

test('buildWarnings: unpinned branch triggers a warning', () => {
  const warnings = buildWarnings({
    manifest: {
      schema_version: 1,
      name: '@hypaware/foo',
      version: '0.1.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    },
    source: {
      kind: 'git',
      raw: 'https://github.com/owner/repo.git#main',
      gitUrl: 'https://github.com/owner/repo.git',
      ref: 'main',
    },
    resolvedRef: 'abc',
    contentHash: 'h',
    manifestHash: 'mh',
  })
  assert.ok(warnings.some((w) => /unpinned branch/.test(w) && /main/.test(w)))
})

test('buildWarnings: pinned tag emits no warning', () => {
  const warnings = buildWarnings({
    manifest: {
      schema_version: 1,
      name: '@hypaware/foo',
      version: '0.1.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    },
    source: {
      kind: 'git',
      raw: 'https://github.com/owner/repo.git#v1.0.0',
      gitUrl: 'https://github.com/owner/repo.git',
      ref: 'v1.0.0',
    },
    resolvedRef: 'abc',
    contentHash: 'h',
    manifestHash: 'mh',
  })
  assert.deepEqual(warnings, [])
})

test('renderConfirmationSummary: install header lists permissions, entrypoint, content_hash, resolved_ref', () => {
  const summary = renderConfirmationSummary({
    manifest: {
      schema_version: 1,
      name: '@hypaware/foo',
      version: '0.1.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      permissions: ['network'],
    },
    source: {
      kind: 'git',
      raw: 'https://github.com/owner/repo.git#v1.0.0',
      gitUrl: 'https://github.com/owner/repo.git',
      ref: 'v1.0.0',
    },
    resolvedRef: 'aaaaaaaa',
    contentHash: 'cccccccc',
    manifestHash: 'mmmmmmmm',
  })
  assert.ok(/About to install plugin @hypaware\/foo@0\.1\.0/.test(summary))
  assert.ok(/source:.*git \(https:\/\/github\.com\/owner\/repo\.git#v1\.0\.0\)/.test(summary))
  assert.ok(/resolved_ref:.*aaaaaaaa/.test(summary))
  assert.ok(/permissions:.*network/.test(summary))
  assert.ok(/entrypoint:.*\.\/index\.js/.test(summary))
  assert.ok(/content_hash:.*cccccccc/.test(summary))
})

test('renderConfirmationSummary: update header shows diff arrows when version/ref/hash change', () => {
  const summary = renderConfirmationSummary(
    {
      manifest: {
        schema_version: 1,
        name: '@hypaware/foo',
        version: '0.2.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
      },
      source: {
        kind: 'git',
        raw: 'https://github.com/owner/repo.git#v0.2.0',
        gitUrl: 'https://github.com/owner/repo.git',
        ref: 'v0.2.0',
      },
      resolvedRef: 'bbbbbbbb',
      contentHash: 'newhash',
      manifestHash: 'mh',
    },
    {
      headerKind: 'update',
      previous: {
        name: '@hypaware/foo',
        version: '0.1.0',
        source: {
          kind: 'git',
          raw: 'https://github.com/owner/repo.git#v0.2.0',
          gitUrl: 'https://github.com/owner/repo.git',
          ref: 'v0.2.0',
        },
        install_dir: '/tmp/foo',
        content_hash: 'oldhash',
        manifest_hash: 'mh',
        installed_at: '2026-01-01T00:00:00.000Z',
        resolved_ref: 'aaaaaaaa',
      },
    }
  )
  assert.ok(/About to update plugin @hypaware\/foo@0\.2\.0/.test(summary))
  assert.ok(/resolved_ref:.*aaaaaaaa -> bbbbbbbb/.test(summary))
  assert.ok(/version:.*0\.1\.0 -> 0\.2\.0/.test(summary))
  assert.ok(/content_hash:.*oldhash -> newhash/.test(summary))
})

test('installPlugin (git): non-tty without confirm callback succeeds (legacy direct caller)', async () => {
  // The `confirm` callback is the trust gate. When it is not supplied
  // the install proceeds, which preserves the legacy programmatic path
  // for callers that already know they want to commit.
  const { stateDir, sourceUrl, commitSha, cleanup } = await buildGitFixture()
  try {
    const result = await installPlugin({ rawSource: sourceUrl, stateDir })
    assert.equal(result.ok, true, /** @type {any} */ (result).message)
    if (!result.ok) return
    assert.equal(result.entry.name, '@hypaware/confirm-fixture')
    assert.equal(result.entry.resolved_ref, commitSha)
  } finally {
    await cleanup()
  }
})

test('installPlugin (git): confirm returning non_tty_no_yes fails with remote_install_confirmation_required', async () => {
  const { stateDir, sourceUrl, cleanup } = await buildGitFixture()
  try {
    const result = await installPlugin({
      rawSource: sourceUrl,
      stateDir,
      confirm: async () => ({ proceed: false, outcome: 'non_tty_no_yes' }),
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.errorKind, 'remote_install_confirmation_required')
    assert.equal(result.confirmation, 'non_tty_no_yes')
    // No artifact landed on disk for this plugin name.
    const lock = await loadLock(stateDir)
    assert.equal(lock.plugins['@hypaware/confirm-fixture'], undefined)
  } finally {
    await cleanup()
  }
})

test('installPlugin (git): confirm returning auto_yes proceeds and stamps confirmation', async () => {
  const { stateDir, sourceUrl, commitSha, cleanup } = await buildGitFixture()
  try {
    const result = await installPlugin({
      rawSource: sourceUrl,
      stateDir,
      confirm: async () => ({ proceed: true, outcome: 'auto_yes' }),
    })
    assert.equal(result.ok, true, /** @type {any} */ (result).message)
    if (!result.ok) return
    assert.equal(result.confirmation, 'auto_yes')
    assert.equal(result.entry.resolved_ref, commitSha)
  } finally {
    await cleanup()
  }
})

test('installPlugin (git): confirm sees manifest, source, hashes, resolved_ref before commit', async () => {
  const { stateDir, sourceUrl, commitSha, cleanup } = await buildGitFixture()
  try {
    /** @type {any} */
    let seen
    await installPlugin({
      rawSource: sourceUrl,
      stateDir,
      confirm: async (staged) => {
        seen = staged
        return { proceed: true, outcome: 'auto_yes' }
      },
    })
    assert.equal(seen?.manifest?.name, '@hypaware/confirm-fixture')
    assert.equal(seen?.source?.kind, 'git')
    assert.equal(seen?.resolvedRef, commitSha)
    assert.ok(typeof seen?.contentHash === 'string' && /^[0-9a-f]{64}$/.test(seen.contentHash))
    assert.ok(typeof seen?.manifestHash === 'string' && /^[0-9a-f]{64}$/.test(seen.manifestHash))
    assert.equal(seen?.previous, undefined)
  } finally {
    await cleanup()
  }
})

test('installPlugin (local-dir): does not invoke the confirm callback', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-confirm-local-'))
  try {
    const pluginDir = path.join(tmpRoot, 'plugin')
    await fs.mkdir(pluginDir)
    await fs.writeFile(
      path.join(pluginDir, 'hypaware.plugin.json'),
      JSON.stringify({
        schema_version: 1,
        name: '@hypaware/local-confirm-fixture',
        version: '0.1.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
      })
    )
    await fs.writeFile(path.join(pluginDir, 'index.js'), 'export async function activate(){}\n')
    const stateDir = path.join(tmpRoot, 'state')
    let confirmFired = false
    const result = await installPlugin({
      rawSource: pluginDir,
      stateDir,
      confirm: async () => {
        confirmFired = true
        return { proceed: false, outcome: 'rejected' }
      },
    })
    assert.equal(confirmFired, false)
    assert.equal(result.ok, true, /** @type {any} */ (result).message)
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }
})

test('updatePlugin: returns plugin_not_installed for an unknown name', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-update-missing-'))
  try {
    const result = await updatePlugin({ name: 'missing', stateDir: tmpRoot })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.errorKind, 'plugin_not_installed')
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }
})

test('updatePlugin (git): re-fetches with same source, exposes previous to confirm', async () => {
  const { stateDir, sourceUrl, commitSha, cleanup } = await buildGitFixture()
  try {
    const first = await installPlugin({
      rawSource: sourceUrl,
      stateDir,
      confirm: async () => ({ proceed: true, outcome: 'auto_yes' }),
    })
    assert.equal(first.ok, true, /** @type {any} */ (first).message)

    /** @type {any} */
    let seen
    const second = await updatePlugin({
      name: '@hypaware/confirm-fixture',
      stateDir,
      confirm: async (staged) => {
        seen = staged
        return { proceed: true, outcome: 'auto_yes' }
      },
    })
    assert.equal(second.ok, true, /** @type {any} */ (second).message)
    assert.equal(seen?.previous?.name, '@hypaware/confirm-fixture')
    assert.equal(seen?.previous?.resolved_ref, commitSha)
    assert.equal(seen?.resolvedRef, commitSha)
  } finally {
    await cleanup()
  }
})

test('updatePlugin (git): rejection leaves the prior install untouched', async () => {
  const { stateDir, sourceUrl, commitSha, cleanup } = await buildGitFixture()
  try {
    const first = await installPlugin({
      rawSource: sourceUrl,
      stateDir,
      confirm: async () => ({ proceed: true, outcome: 'auto_yes' }),
    })
    assert.equal(first.ok, true)
    if (!first.ok) return

    const second = await updatePlugin({
      name: '@hypaware/confirm-fixture',
      stateDir,
      confirm: async () => ({ proceed: false, outcome: 'rejected' }),
    })
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.errorKind, 'remote_install_rejected')
    assert.equal(second.confirmation, 'rejected')

    const lock = await loadLock(stateDir)
    const entry = lock.plugins['@hypaware/confirm-fixture']
    assert.equal(entry?.resolved_ref, commitSha)
    assert.equal(entry?.content_hash, first.entry.content_hash)
  } finally {
    await cleanup()
  }
})

/**
 * Build a hermetic file:// bare-repo fixture so the integration tests
 * exercise the same git_fetch code path real installs hit. Returns the
 * stateDir to install into, the file:// URL, the commit SHA, and a
 * cleanup hook for the temp tree.
 *
 * @returns {Promise<{
 *   stateDir: string,
 *   sourceUrl: string,
 *   commitSha: string,
 *   cleanup: () => Promise<void>,
 * }>}
 */
async function buildGitFixture() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-confirm-git-'))
  const fixtureDir = path.join(tmpRoot, 'fixture')
  await fs.mkdir(fixtureDir, { recursive: true })
  await fs.writeFile(
    path.join(fixtureDir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name: '@hypaware/confirm-fixture',
      version: '0.1.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    })
  )
  await fs.writeFile(
    path.join(fixtureDir, 'index.js'),
    "export async function activate() {}\n"
  )

  const workdir = `${fixtureDir}.work`
  await fs.cp(fixtureDir, workdir, { recursive: true })
  await runGit(['init', '-q', '-b', 'main'], { cwd: workdir })
  await runGit(['config', 'user.email', 'unit@hypaware.test'], { cwd: workdir })
  await runGit(['config', 'user.name', 'HypAware Test'], { cwd: workdir })
  await runGit(['add', '.'], { cwd: workdir })
  await runGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'initial'], { cwd: workdir })
  const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: workdir })).stdout.trim()

  const bareRepoDir = path.join(tmpRoot, 'bare.git')
  await runGit(['init', '--bare', '-q', '-b', 'main', bareRepoDir])
  await runGit(['remote', 'add', 'origin', bareRepoDir], { cwd: workdir })
  await runGit(['push', '--quiet', 'origin', 'main'], { cwd: workdir })

  return {
    stateDir: path.join(tmpRoot, 'state'),
    sourceUrl: `file://${bareRepoDir}`,
    commitSha: sha,
    cleanup: async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    },
  }
}

/**
 * Minimal git wrapper. Throws when the subprocess exits non-zero so
 * the test fails fast if the fixture cannot be built.
 *
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ stdout: string }>}
 */
function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** @type {Buffer[]} */
    const stdoutChunks = []
    /** @type {Buffer[]} */
    const stderrChunks = []
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      if (code === 0) return resolve({ stdout })
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr || stdout}`))
    })
  })
}
