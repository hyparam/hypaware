// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createPluginPaths } from '../../src/core/runtime/paths.js'

// `hyp setup --dry-run` promises to change nothing, but its boot used to
// activate every plugin the normal way, and activation makes each plugin's
// state and cache dirs and the local-fs exports root. A preview in a fresh
// HOME therefore left a `.hyp` tree behind (#2512). These run the real CLI.
// @ref LLP 0525#preview-boot [tests]: a setup preview leaves the tree as it found it; a real setup still makes the dirs

const BIN = fileURLToPath(new URL('../../bin/hypaware.js', import.meta.url))

/**
 * Run the real CLI with `home` as HOME and nothing else steering it, unless
 * `extra` says so.
 *
 * @param {string} home
 * @param {string[]} argv
 * @param {Record<string, string>} [extra]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(home, argv, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra }
  for (const key of ['HYP_HOME', 'HYP_CONFIG', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    if (!(key in extra)) delete env[key]
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...argv], { cwd: home, env, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/**
 * Every directory and file under `dir`, files with a hash of their bytes, so
 * an empty directory left behind counts as a change.
 *
 * @param {string} dir
 * @returns {Promise<Map<string, string>>}
 */
async function snapshot(dir) {
  /** @type {Map<string, string>} */
  const tree = new Map()
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name)
    const rel = path.relative(dir, full)
    if (entry.isDirectory()) tree.set(rel, 'dir')
    else if (entry.isFile()) tree.set(rel, createHash('sha256').update(await fs.readFile(full)).digest('hex'))
    else tree.set(rel, 'other')
  }
  return tree
}

/** @param {{ code: number, stdout: string, stderr: string }} run */
function show(run) {
  return `exit ${run.code}\n${run.stdout}\n${run.stderr}`
}

test('a setup preview in a fresh HOME leaves it empty, in every form', { timeout: 180_000 }, async () => {
  /** @type {Array<[string, string[]]>} */
  const forms = [
    ['--yes', ['setup', '--yes', '--dry-run']],
    // The scripted answers drive the same wizard an attended run does
    // (runInitWizard with picks), without the --yes default.
    ['answers given, no --yes', ['setup', '--dry-run', '--source', 'codex']],
    ['--dry-run=true', ['setup', '--dry-run=true', '--yes']],
    ['preset', ['setup', 'claude-and-otel-local', '--dry-run']],
  ]
  for (const [label, argv] of forms) {
    const home = temporaryDirectory('hyp-setup-preview-')
    const run = await runCli(home, argv)
    assert.equal(run.code, 0, `${label}: ${show(run)}`)
    assert.deepEqual([...(await snapshot(home)).keys()], [], `${label}: HOME is still empty`)
  }
})

test('a setup preview with HYP_HOME outside HOME leaves both empty', { timeout: 60_000 }, async () => {
  const home = temporaryDirectory('hyp-setup-preview-home-')
  const hypHome = temporaryDirectory('hyp-setup-preview-state-')
  const run = await runCli(home, ['setup', '--yes', '--dry-run'], { HYP_HOME: hypHome })
  assert.equal(run.code, 0, show(run))
  assert.deepEqual([...(await snapshot(home)).keys()], [], 'HOME')
  assert.deepEqual([...(await snapshot(hypHome)).keys()], [], 'HYP_HOME')
})

test('a real setup in the same harness still creates the plugin and export dirs', { timeout: 60_000 }, async () => {
  const home = temporaryDirectory('hyp-setup-real-')
  const run = await runCli(home, ['setup', '--yes', '--no-daemon'])
  assert.equal(run.code, 0, show(run))
  const tree = await snapshot(home)
  for (const dir of [
    '.hyp/hypaware/plugins/@hypaware/local-fs',
    '.hyp/hypaware/cache/plugins/@hypaware/local-fs',
    '.hyp/exports',
  ]) assert.equal(tree.get(dir), 'dir', `${dir} was created`)
  assert.notEqual(tree.get('.hyp/hypaware-config.json'), undefined, 'config written')
})

test('a setup preview over an existing install with custom destinations changes nothing', { timeout: 60_000 }, async () => {
  const home = temporaryDirectory('hyp-setup-preview-existing-')
  const outside = temporaryDirectory('hyp-setup-preview-outside-')
  const hypHome = path.join(home, '.hyp')
  await fs.mkdir(hypHome)
  // Destinations that do not exist yet: a boot that activates or opens the
  // sink the normal way would make them.
  await fs.writeFile(path.join(hypHome, 'hypaware-config.json'), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/otel' },
      { name: '@hypaware/local-fs', config: { exports_dir: path.join(outside, 'exports') } },
      { name: '@hypaware/format-parquet' },
    ],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: { dir: path.join(outside, 'sink'), schedule: '*/5 * * * *' },
      },
    },
  }, null, 2) + '\n')
  const beforeHome = await snapshot(home)
  const beforeOutside = await snapshot(outside)
  const run = await runCli(home, ['setup', '--yes', '--dry-run', '--force'])
  assert.equal(run.code, 0, show(run))
  assert.deepEqual(await snapshot(home), beforeHome, 'HOME unchanged, dirs included')
  assert.deepEqual(await snapshot(outside), beforeOutside, 'custom destinations not created')
})

test('the legacy proxy preflight refuses a preview the same way and changes nothing', { timeout: 60_000 }, async () => {
  const home = temporaryDirectory('hyp-setup-preview-proxy-')
  await fs.mkdir(path.join(home, '.hyp'))
  await fs.writeFile(path.join(home, '.hyp', 'hypaware-config.json'), JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/otel' }] }) + '\n')
  await fs.mkdir(path.join(home, '.claude'))
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    env: { HTTPS_PROXY: 'http://127.0.0.1:4123' },
    _hypaware: { version: '0.2.0', port: 4123, mode: 'proxy' },
  }, null, 2) + '\n')
  const before = await snapshot(home)
  const run = await runCli(home, ['setup', '--yes', '--no-daemon', '--source', 'otel', '--dry-run', '--force'])
  assert.equal(run.code, 1, show(run))
  assert.match(run.stderr, /hyp setup: claude is still attached through the HypAware proxy, and this config turns the proxy off, so claude would stop being captured\. Nothing was changed\./)
  assert.deepEqual(await snapshot(home), before, 'HOME unchanged, dirs included')
})

test('the unsupported-platform guard refuses a preview the same way and changes nothing', async () => {
  const home = temporaryDirectory('hyp-setup-preview-platform-')
  const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(process, 'platform'))
  let stderr = ''
  let stdout = ''
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
  let code
  try {
    code = await dispatch(['setup', '--yes', '--dry-run'], {
      stdout: { write: (/** @type {string} */ chunk) => { stdout += chunk; return true } },
      stderr: { write: (/** @type {string} */ chunk) => { stderr += chunk; return true } },
      env: { ...process.env, HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_CONFIG: '' },
    })
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
  assert.equal(code, 1)
  assert.match(stderr, /hyp setup: unsupported platform: win32 \(only macOS and Linux are supported\)/)
  assert.equal(stdout, '')
  assert.deepEqual([...(await snapshot(home)).keys()], [], 'HOME is still empty')
})

test('createPluginPaths names the durable dirs without creating them on a preview', async () => {
  const root = temporaryDirectory('hyp-plugin-paths-preview-')
  const stateRoot = path.join(root, 'state')
  const tmpRoot = path.join(root, 'tmp')
  const paths = await createPluginPaths({ pluginName: '@hypaware/local-fs', rootDir: root, stateRoot, runId: 'r1', tmpRoot, preview: true })
  assert.equal(paths.stateDir, path.join(stateRoot, 'plugins', '@hypaware', 'local-fs'))
  await assert.rejects(fs.stat(stateRoot), { code: 'ENOENT' })
  await assert.rejects(fs.stat(paths.cacheDir), { code: 'ENOENT' })
  assert.ok((await fs.stat(paths.tempDir)).isDirectory(), 'the boot-owned temp dir is still made')
})
