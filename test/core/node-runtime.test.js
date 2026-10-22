// @ts-check

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import {
  bootstrapNodeRuntime, ensureNodeRuntime, managedNodeForProcess, nodeRuntimeEnvironment, nodeRuntimePaths,
  runNodeRuntimeCommand, selectNodeArtifact,
} from '../../src/core/update/node_runtime.js'

/** @import { TestContext } from 'node:test' */

/** @param {TestContext} t */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-managed-node-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const env = isolatedClientEnv(process.env, path.join(root, 'home'))
  const directory = `node-v${process.versions.node}-${process.platform}-${process.arch}`
  const source = path.join(root, directory)
  await fs.mkdir(path.join(source, 'bin'), { recursive: true })
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  await fs.writeFile(path.join(source, 'bin', 'node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 })
  const archive = path.join(root, 'fixture.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', root, directory])
  const bytes = await fs.readFile(archive)
  const artifact = { version: process.versions.node, platform: process.platform, arch: process.arch, filename: directory + '.tar.gz', sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  let downloads = 0
  const events = []
  return {
    root, env, artifact, events,
    downloads: () => downloads,
    options: {
      env, artifact,
      download: async (_artifact, destination) => { downloads += 1; await fs.copyFile(archive, destination) },
      log: (event, fields) => events.push({ event, ...fields }),
    },
  }
}

test('all official targets are pinned, preserve supported majors, and reject unsupported platforms', () => {
  for (const [old, patched] of [['22.12.0', '22.23.4'], ['24.2.0', '24.22.1'], ['26.0.0', '26.12.1'], ['25.0.0', '24.22.1']]) {
    for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) {
      const artifact = selectNodeArtifact(old, platform, arch)
      assert.equal(artifact.version, patched)
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
    }
  }
  assert.throws(() => selectNodeArtifact('24.2.0', 'win32', 'x64'), /unsupported_platform/)
  assert.throws(() => selectNodeArtifact('24.2.0', 'linux', 'arm'), /unsupported_platform/)
})

test('concurrent installers verify, extract, and publish once, then reuse the cache', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const results = await Promise.all([ensureNodeRuntime(f.options), ensureNodeRuntime(f.options), ensureNodeRuntime(f.options)])
  assert.equal(f.downloads(), 1)
  assert.ok(results.every(r => r.nodePath === results[0].nodePath))
  const target = await fs.realpath(results[0].nodePath)
  assert.equal(managedNodeForProcess(f.env, target), results[0].nodePath)
  assert.equal(f.events.filter(e => e.event === 'node_runtime.verified').length, 1)
  assert.equal((await fs.readdir(nodeRuntimePaths(f.env).root)).some(n => n.startsWith('install-')), false)
})

test('a checksum mismatch cannot invoke tar or an executable and publishes nothing', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  let commands = 0
  await assert.rejects(ensureNodeRuntime({
    ...f.options, artifact: { ...f.artifact, sha256: 'a'.repeat(64) },
    run: async () => { commands += 1; return { exitCode: 0, stdout: '', stderr: '' } },
  }), /checksum_mismatch/)
  assert.equal(commands, 0)
  await assert.rejects(fs.lstat(nodeRuntimePaths(f.env).nodePath), { code: 'ENOENT' })
})

test('failed download or executable probe leaves the existing active selection intact', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const paths = nodeRuntimePaths(f.env)
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 })
  await fs.symlink('previous/bin/node', paths.nodePath)
  await assert.rejects(ensureNodeRuntime({ ...f.options, download: async () => { throw new Error('offline') } }), /offline/)
  assert.equal(await fs.readlink(paths.nodePath), 'previous/bin/node')
  await assert.rejects(ensureNodeRuntime({
    ...f.options,
    run: async (command, args, opts) => command === 'tar'
      ? runNodeRuntimeCommand(command, args, opts)
      : { exitCode: 0, stdout: JSON.stringify({ version: f.artifact.version, patched: false }), stderr: '' },
  }), /preflight_failed/)
  assert.equal(await fs.readlink(paths.nodePath), 'previous/bin/node')
})

test('a symlinked runtime directory is refused before downloading', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const paths = nodeRuntimePaths(f.env)
  await fs.mkdir(path.dirname(paths.root), { recursive: true })
  const elsewhere = path.join(f.root, 'elsewhere')
  await fs.mkdir(elsewhere)
  await fs.symlink(elsewhere, paths.root)
  await assert.rejects(ensureNodeRuntime(f.options), /unsafe_directory/)
  assert.equal(f.downloads(), 0)
  assert.deepEqual(await fs.readdir(elsewhere), [])
})

test('runtime cleanup retains the active and preceding distributions', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const paths = nodeRuntimePaths(f.env)
  await fs.mkdir(paths.versions, { recursive: true, mode: 0o700 })
  for (const version of ['22.20.0', '22.21.0', '22.22.0']) await fs.mkdir(path.join(paths.versions, `node-v${version}-darwin-arm64`, 'bin'), { recursive: true })
  await fs.symlink('versions/node-v22.22.0-darwin-arm64/bin/node', paths.nodePath)
  await ensureNodeRuntime(f.options)
  const retained = await fs.readdir(paths.versions)
  assert.equal(retained.length, 2)
  assert.ok(retained.includes('node-v22.22.0-darwin-arm64'))
  assert.ok(retained.includes(f.artifact.filename.slice(0, -7)))
})

test('an unattended runtime migration honors the existing auto_update off switch before any download', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-node-update-off-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'custom-config.json')
  await fs.writeFile(config, JSON.stringify({ auto_update: false }))
  await assert.rejects(bootstrapNodeRuntime({
    argv: ['daemon', 'run', '--config=' + config], binPath: '/example/hyp',
    env: { HYP_HOME: root, XPC_SERVICE_NAME: 'com.hyperparam.hypaware' },
  }), /update_disabled/)
  await assert.rejects(fs.lstat(nodeRuntimePaths({ HYP_HOME: root }).root), { code: 'ENOENT' })
})

test('private Node keeps npm pointed at the original global package prefix', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-node-prefix-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const env = { HYP_HOME: root, PATH: '/usr/bin:/bin', NPM_CONFIG_PREFIX: '/other' }
  const nodePath = path.join(nodeRuntimePaths(env).versions, 'node-v24.22.1-darwin-arm64', 'bin', 'node')
  const result = nodeRuntimeEnvironment(env, '/old-node/lib/node_modules/hypaware', nodePath)
  assert.equal(result.npm_config_prefix, '/old-node')
  assert.equal(result.NPM_CONFIG_PREFIX, undefined)
  assert.equal(result.PATH?.split(path.delimiter)[0], path.dirname(nodePath))
  assert.equal(env.NPM_CONFIG_PREFIX, '/other', 'the caller environment is not mutated')
})

test('bootstrap re-executes a real CLI on cached patched Node without changing the invoking runtime', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const artifact = selectNodeArtifact('24.2.0', process.platform, process.arch)
  const paths = nodeRuntimePaths(f.env)
  const directory = path.join(paths.versions, artifact.filename.slice(0, -7))
  await fs.mkdir(path.join(directory, 'bin'), { recursive: true, mode: 0o700 })
  // A real binary copy gives the child a distinct execPath; the parent-only
  // version injection cannot accidentally fake an old runtime in the child.
  await fs.copyFile(process.execPath, path.join(directory, 'bin', 'node'), 2)
  await fs.writeFile(path.join(directory, 'archive.sha256'), artifact.sha256)
  const preload = path.join(f.root, 'old-node.mjs')
  await fs.writeFile(preload, `if (process.execPath === ${JSON.stringify(process.execPath)}) Object.defineProperty(process.versions, 'node', { value: '24.2.0' })`)
  const bin = fileURLToPath(new URL('../../bin/hypaware.js', import.meta.url))
  const run = spawnSync(process.execPath, ['--import', preload, bin, 'version'], { env: f.env, encoding: 'utf8', timeout: 15000 })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stderr, /node_runtime.reexec/)
  assert.ok(run.stdout.includes(`node:     ${process.version}`), run.stdout)
})
