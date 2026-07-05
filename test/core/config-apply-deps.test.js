// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildConfigApplyDeps } from '../../src/core/config/apply_deps.js'
import { loadLock } from '../../src/core/plugin_install/install.js'
import { getEntry, writeLock } from '../../src/core/plugin_install/lock.js'

/**
 * @import { PluginName } from '../../collectivus-plugin-kernel-types.js'
 */

/**
 * Pin enforcement is the apply path's core security property: nothing
 * may substitute code after the config was authored (LLP 0025
 * install-on-config). The apply-engine tests mock these deps away, so
 * the real decisions are exercised here against real fixtures: a
 * fixture bundled workspace, a lock-backed installed plugin, and a
 * local git repo standing in for a served artifact.
 */

const HASH_A = 'a'.repeat(64)

/** @param {string} dir @param {string} name @param {string} version */
async function writePluginDir(dir, name, version) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version,
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    })
  )
  await fs.writeFile(path.join(dir, 'index.js'), 'export async function activate(){}\n')
}

/**
 * A temp HYP state root plus a fixture bundled workspace holding a
 * fake `@hypaware/otel` at a controlled version, so the bundled-pin
 * checks don't depend on the real workspace's version numbers.
 */
async function makeFixture() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-apply-deps-'))
  const stateRoot = path.join(tmpRoot, 'state')
  const workspaceDir = path.join(tmpRoot, 'workspace')
  await writePluginDir(path.join(workspaceDir, 'otel'), '@hypaware/otel', '9.9.9')
  return {
    tmpRoot,
    stateRoot,
    workspaceDir,
    cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }),
  }
}

test('bundled plugin: pinned version mismatch is a bundled_version_mismatch failure', async () => {
  const fx = await makeFixture()
  try {
    const deps = buildConfigApplyDeps({ stateRoot: fx.stateRoot, workspaceDir: fx.workspaceDir })
    const result = await deps.installPinnedPlugins([
      { name: '@hypaware/otel', version: '1.0.0' },
    ])
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.errorKind, 'bundled_version_mismatch')
    assert.ok(!result.ok && /1\.0\.0/.test(result.message) && /9\.9\.9/.test(result.message))
  } finally {
    await fx.cleanup()
  }
})

test('bundled plugin: matching version pin is satisfied without an install; hash is not checked', async () => {
  const fx = await makeFixture()
  try {
    const deps = buildConfigApplyDeps({ stateRoot: fx.stateRoot, workspaceDir: fx.workspaceDir })
    // The artifact_hash refers to a git release artifact that
    // legitimately differs from the npm-bundled tree, so a garbage hash
    // must not fail a bundled pin (LLP 0025 bundled-first-party).
    const result = await deps.installPinnedPlugins([
      { name: '@hypaware/otel', version: '9.9.9', artifact_hash: 'f'.repeat(64) },
    ])
    assert.deepEqual(result, { ok: true })
    const lock = await loadLock(fx.stateRoot)
    assert.equal(getEntry(lock, /** @type {PluginName} */ ('@hypaware/otel')), undefined)
  } finally {
    await fx.cleanup()
  }
})

test('bundled plugin: an unpinned entry is satisfied by any bundled version', async () => {
  const fx = await makeFixture()
  try {
    const deps = buildConfigApplyDeps({ stateRoot: fx.stateRoot, workspaceDir: fx.workspaceDir })
    const result = await deps.installPinnedPlugins([{ name: '@hypaware/otel' }])
    assert.deepEqual(result, { ok: true })
  } finally {
    await fx.cleanup()
  }
})

test('disabled entries are skipped entirely', async () => {
  const fx = await makeFixture()
  try {
    const deps = buildConfigApplyDeps({ stateRoot: fx.stateRoot, workspaceDir: fx.workspaceDir })
    // The unreachable source proves no install was attempted.
    const result = await deps.installPinnedPlugins([
      { name: '@third-party/off', enabled: false, source: `file://${fx.tmpRoot}/nonexistent` },
    ])
    assert.deepEqual(result, { ok: true })
  } finally {
    await fx.cleanup()
  }
})

test('an installed lock entry matching version + hash is satisfied without re-install', async () => {
  const fx = await makeFixture()
  try {
    const installDir = path.join(fx.tmpRoot, 'installed-fixture')
    await writePluginDir(installDir, '@third-party/installed-fixture', '1.0.0')
    await writeLock(fx.stateRoot, {
      schema_version: 1,
      plugins: {
        '@third-party/installed-fixture': {
          name: '@third-party/installed-fixture',
          version: '1.0.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: HASH_A,
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-06-12T00:00:00.000Z',
        },
      },
    })
    const deps = buildConfigApplyDeps({ stateRoot: fx.stateRoot, workspaceDir: fx.workspaceDir })
    // The unreachable source proves the satisfied entry never hits the
    // install path.
    const result = await deps.installPinnedPlugins([
      {
        name: '@third-party/installed-fixture',
        version: '1.0.0',
        artifact_hash: HASH_A,
        source: `file://${fx.tmpRoot}/nonexistent`,
      },
    ])
    assert.deepEqual(result, { ok: true })

    // A different pinned hash is NOT satisfied: the install path runs
    // (and fails here on the unreachable source).
    const mismatched = await deps.installPinnedPlugins([
      {
        name: '@third-party/installed-fixture',
        version: '1.0.0',
        artifact_hash: 'c'.repeat(64),
        source: `file://${fx.tmpRoot}/nonexistent`,
      },
    ])
    assert.equal(mismatched.ok, false)
    assert.equal(!mismatched.ok && mismatched.errorKind, 'plugin_install_failed')
  } finally {
    await fx.cleanup()
  }
})

test('a fetched artifact failing its hash pin is an artifact_hash_mismatch and nothing is installed', async () => {
  const fx = await makeFixture()
  const git = await buildGitPluginFixture()
  try {
    const deps = buildConfigApplyDeps({ stateRoot: fx.stateRoot, workspaceDir: fx.workspaceDir })
    const result = await deps.installPinnedPlugins([
      {
        name: '@third-party/pin-fixture',
        source: git.sourceUrl,
        version: '0.1.0',
        artifact_hash: 'f'.repeat(64),
      },
    ])
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.errorKind, 'artifact_hash_mismatch')
    const lock = await loadLock(fx.stateRoot)
    assert.equal(getEntry(lock, /** @type {PluginName} */ ('@third-party/pin-fixture')), undefined)
  } finally {
    await git.cleanup()
    await fx.cleanup()
  }
})

test('a correct hash pin installs, and validation then sees the plugin it could not know before', async () => {
  // The install-before-validate ordering only works because a fresh
  // catalog is discovered per call: this is the integration check for
  // a served config naming a not-yet-installed plugin.
  const fx = await makeFixture()
  const git = await buildGitPluginFixture()
  try {
    const deps = buildConfigApplyDeps({ stateRoot: fx.stateRoot, workspaceDir: fx.workspaceDir })
    const document = { version: 2, plugins: [{ name: '@third-party/pin-fixture' }] }

    const before = await deps.validateDocument(document)
    assert.equal(before.ok, false)
    assert.ok(before.errors.some((e) => /pin-fixture/.test(e.message)))

    // Learn the artifact hash by installing unpinned once, then prove a
    // config pinning that exact hash is accepted from a clean state.
    const unpinned = await deps.installPinnedPlugins([
      { name: '@third-party/pin-fixture', source: git.sourceUrl, version: '0.1.0' },
    ])
    assert.deepEqual(unpinned, { ok: true })
    const lock = await loadLock(fx.stateRoot)
    const entry = getEntry(lock, /** @type {PluginName} */ ('@third-party/pin-fixture'))
    assert.ok(entry)

    const fresh = await makeFixture()
    try {
      const freshDeps = buildConfigApplyDeps({
        stateRoot: fresh.stateRoot,
        workspaceDir: fresh.workspaceDir,
      })
      const pinned = await freshDeps.installPinnedPlugins([
        {
          name: '@third-party/pin-fixture',
          source: git.sourceUrl,
          version: '0.1.0',
          artifact_hash: entry?.content_hash,
        },
      ])
      assert.deepEqual(pinned, { ok: true })

      const after = await freshDeps.validateDocument(document)
      assert.equal(after.ok, true, JSON.stringify(after.errors))
    } finally {
      await fresh.cleanup()
    }
  } finally {
    await git.cleanup()
    await fx.cleanup()
  }
})

/* ---------- git fixture ---------- */

/**
 * A bare local git repo serving a plugin tagged `v0.1.0`, standing in
 * for a served config's pinned artifact source.
 */
async function buildGitPluginFixture() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-apply-deps-git-'))
  const workdir = path.join(tmpRoot, 'work')
  await writePluginDir(workdir, '@third-party/pin-fixture', '0.1.0')
  await runGit(['init', '-q', '-b', 'main'], { cwd: workdir })
  await runGit(['config', 'user.email', 'unit@hypaware.test'], { cwd: workdir })
  await runGit(['config', 'user.name', 'HypAware Test'], { cwd: workdir })
  await runGit(['add', '.'], { cwd: workdir })
  await runGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'initial'], { cwd: workdir })
  await runGit(['tag', 'v0.1.0'], { cwd: workdir })

  const bareRepoDir = path.join(tmpRoot, 'bare.git')
  await runGit(['init', '--bare', '-q', '-b', 'main', bareRepoDir])
  await runGit(['remote', 'add', 'origin', bareRepoDir], { cwd: workdir })
  await runGit(['push', '--quiet', 'origin', 'main', '--tags'], { cwd: workdir })

  return {
    sourceUrl: `file://${bareRepoDir}`,
    cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }),
  }
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<void>}
 */
function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    // Neutralize host-level signing config: a global tag.gpgsign=true
    // would turn the fixture's lightweight `git tag` into a signed tag
    // that demands a message and a key.
    const child = spawn('git', ['-c', 'tag.gpgsign=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    /** @type {Buffer[]} */
    const stderrChunks = []
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${Buffer.concat(stderrChunks)}`))
    })
  })
}
