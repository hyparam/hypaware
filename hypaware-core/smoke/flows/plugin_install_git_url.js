// @ts-check

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { hashArtifactTree } from '../../../src/core/plugin_install/git_fetch.js'
import {
  pluginInstallDir,
  pluginLockPath,
} from '../../../src/core/plugin_install/paths.js'

/**
 * Hy-gh-1 smoke. Builds a local bare git repo containing a tiny
 * `@hypaware/git-url-fixture` plugin and installs it through the CLI
 * dispatcher via `file://<bare-repo>` so the install exercises the
 * SAME git fetch path remote URLs would take. There is no
 * special-case for `file://`. After the install we verify:
 *
 *  - `plugin-lock.json` has a `source.kind="git"` entry.
 *  - The lock entry's `resolved_ref` matches the commit SHA we made.
 *  - `content_hash` and `manifest_hash` are present and `content_hash`
 *    matches a re-hash of the install directory.
 *  - `hyp plugin list --json` lists the plugin.
 *  - The expected `plugin.install`, `plugin.git.*`, and
 *    `plugin.artifact.*` spans land in the JSONL telemetry export.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'plugin_install_git_url: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const fixtureDir = path.join(harness.tmpDir, 'fixtures', 'git-url-fixture')
  await writeFixturePlugin(fixtureDir)

  const bareRepoDir = path.join(harness.tmpDir, 'fixtures', 'git-url-fixture.git')
  const commitSha = await buildBareRepoFromFixture(fixtureDir, bareRepoDir)
  const sourceUrl = `file://${bareRepoDir}`

  const stateDir = harness.stateDir
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: path.join(stateDir, 'cache'),
  })

  const installStdout = makeBuf()
  const installStderr = makeBuf()
  const installCode = await runRoot(
    'smoke.driver',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_install_git_url',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () =>
      dispatch(['plugin', 'install', sourceUrl, '--yes'], {
        stdout: installStdout,
        stderr: installStderr,
        env: { ...process.env, HYP_HOME: harness.hypHome },
        cwd: harness.tmpDir,
        registry,
        kernel,
      })
  )
  expect.that('dispatch: plugin install exited 0', installCode, (v) => v === 0)
  // The confirmation summary lands on stderr by design (stdout stays
  // clean for the install success line). Smoke just asserts that the
  // summary mentions the plugin name and resolved commit.
  expect.that(
    'stderr: confirmation summary names the plugin',
    installStderr.text(),
    (v) => typeof v === 'string' && v.includes('@hypaware/git-url-fixture')
  )
  expect.that(
    'stderr: confirmation summary lists the resolved ref',
    installStderr.text(),
    (v) => typeof v === 'string' && v.includes(commitSha)
  )
  expect.that(
    'stdout: install summary lists the plugin name',
    installStdout.text(),
    (v) => typeof v === 'string' && v.includes('@hypaware/git-url-fixture')
  )
  expect.that(
    'stdout: install summary lists the resolved ref',
    installStdout.text(),
    (v) => typeof v === 'string' && v.includes(commitSha)
  )

  const listStdout = makeBuf()
  const listStderr = makeBuf()
  const listCode = await dispatch(['plugin', 'list', '--json'], {
    stdout: listStdout,
    stderr: listStderr,
    env: { ...process.env, HYP_HOME: harness.hypHome },
    cwd: harness.tmpDir,
    registry,
    kernel,
  })
  expect.that('dispatch: plugin list exited 0', listCode, (v) => v === 0)
  expect.that(
    'stderr: plugin list had no errors',
    listStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )

  /** @type {any} */
  let listJson
  try {
    listJson = JSON.parse(listStdout.text())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    expect.that(
      `stdout: plugin list --json was valid JSON (parse error: ${message})`,
      false,
      (v) => v === true
    )
    return
  }
  expect.that(
    'stdout: plugin list --json contains the git plugin',
    listJson?.plugins,
    (v) =>
      Array.isArray(v) &&
      v.length === 1 &&
      v[0]?.name === '@hypaware/git-url-fixture' &&
      typeof v[0]?.installed_at === 'string' &&
      v[0]?.installed_at.length > 0
  )

  const lockPath = pluginLockPath(stateDir)
  const lockRaw = await fs.readFile(lockPath, 'utf8')
  const lock = JSON.parse(lockRaw)
  expect.that(
    'lock: schema_version is 1',
    lock?.schema_version,
    (v) => v === 1
  )
  const entry = lock?.plugins?.['@hypaware/git-url-fixture']
  expect.that(
    'lock: contains @hypaware/git-url-fixture entry',
    entry,
    (v) => v !== undefined
  )
  expect.that(
    'lock: source.kind is git',
    entry?.source?.kind,
    (v) => v === 'git'
  )
  expect.that(
    'lock: source.raw is the original file:// URL',
    entry?.source?.raw,
    (v) => v === sourceUrl
  )
  expect.that(
    'lock: install_dir points at the expected install root',
    entry?.install_dir,
    (v) => v === pluginInstallDir(stateDir, '@hypaware/git-url-fixture')
  )
  expect.that(
    'lock: resolved_ref matches the bare-repo commit sha',
    entry?.resolved_ref,
    (v) => v === commitSha
  )
  expect.that(
    'lock: manifest_hash is a 64-char hex sha',
    entry?.manifest_hash,
    (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  )
  expect.that(
    'lock: installed_at is set',
    entry?.installed_at,
    (v) => typeof v === 'string' && v.length > 0
  )

  const rehash = await hashArtifactTree(entry.install_dir)
  expect.that(
    'lock: content_hash matches a re-hash of the install dir',
    entry?.content_hash,
    (v) => v === rehash
  )

  await obs.shutdown()

  const traces = await expect.traces()
  const installSpans = traces.filter((/** @type {any} */ t) => t.name === 'plugin.install')
  expect.that(
    'traces: exactly one plugin.install span',
    installSpans,
    (rows) => rows.length === 1
  )
  const installSpan = installSpans[0]
  expect.that(
    'traces: plugin.install status=ok',
    installSpan?.attributes?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: plugin.install hyp_source_kind=git',
    installSpan?.attributes?.hyp_source_kind,
    (v) => v === 'git'
  )
  expect.that(
    'traces: plugin.install records git_resolved_ref',
    installSpan?.attributes?.git_resolved_ref,
    (v) => v === commitSha
  )
  expect.that(
    'traces: plugin.install records content_hash on the parent span',
    installSpan?.attributes?.content_hash,
    (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  )
  expect.that(
    'traces: plugin.install stamps confirmation=auto_yes for --yes installs',
    installSpan?.attributes?.confirmation,
    (v) => v === 'auto_yes'
  )

  const expectedChildSpans = [
    'plugin.git.clone',
    'plugin.git.checkout',
    'plugin.git.resolve_ref',
    'plugin.artifact.validate',
    'plugin.artifact.copy',
  ]
  for (const name of expectedChildSpans) {
    const rows = traces.filter((/** @type {any} */ t) => t.name === name)
    expect.that(
      `traces: ${name} emitted with status=ok`,
      rows,
      (list) =>
        list.length >= 1 &&
        list.every((/** @type {any} */ r) => r.attributes?.status === 'ok')
    )
  }

  const resolveRefSpan = traces.find(
    (/** @type {any} */ t) => t.name === 'plugin.git.resolve_ref'
  )
  expect.that(
    'traces: plugin.git.resolve_ref records git_resolved_ref',
    resolveRefSpan?.attributes?.git_resolved_ref,
    (v) => v === commitSha
  )

  const updateChecks = traces.filter(
    (/** @type {any} */ t) => t.name === 'plugin.update_check'
  )
  const fixtureCheck = updateChecks.find(
    (/** @type {any} */ s) => s.attributes?.hyp_plugin === '@hypaware/git-url-fixture'
  )
  expect.that(
    'traces: plugin.update_check for the fixture exists',
    fixtureCheck,
    (v) => v !== undefined
  )

  const metrics = await expect.metrics()
  const installCounter = metrics.find(
    (/** @type {any} */ m) =>
      m.name === 'hyp_plugin_installs_total' && m.attributes?.status === 'ok'
  )
  expect.that(
    'metrics: hyp_plugin_installs_total{status=ok} ticked',
    installCounter,
    (v) => v !== undefined
  )

  const logs = await expect.logs()
  const credentialLeak = logs.some((/** @type {any} */ l) => {
    const body = typeof l?.body === 'string' ? l.body : JSON.stringify(l?.body ?? '')
    const attrs = JSON.stringify(l?.attributes ?? {})
    return /\b(token|password|authorization)=([A-Za-z0-9]{8,})/i.test(body + attrs)
  })
  expect.that(
    'logs: no credential-shaped strings landed in the install logs',
    credentialLeak,
    (v) => v === false
  )
}

/**
 * Drop a minimal fixture plugin under `dir`. The shape mirrors a tiny
 * remote-installable plugin: a manifest and an entrypoint, nothing
 * else. The smoke does not activate the plugin, but installing it
 * through the git path is enough to exercise the §hy-gh-1 contract.
 *
 * @param {string} dir
 */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/git-url-fixture',
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify(manifest, null, 2)
  )
  await fs.writeFile(
    path.join(dir, 'index.js'),
    "// fixture: @hypaware/git-url-fixture\nexport async function activate() {}\n"
  )
}

/**
 * Initialize a working repo from `fixtureDir`, commit it, then push
 * to a bare repo at `bareRepoDir` so the smoke can clone from
 * `file://<bareRepoDir>`. Returns the commit SHA so assertions can
 * compare against `entry.resolved_ref`.
 *
 * @param {string} fixtureDir
 * @param {string} bareRepoDir
 * @returns {Promise<string>}
 */
async function buildBareRepoFromFixture(fixtureDir, bareRepoDir) {
  const workdir = `${fixtureDir}.work`
  await fs.cp(fixtureDir, workdir, { recursive: true })
  await runGit(['init', '-q', '-b', 'main'], { cwd: workdir })
  await runGit(['config', 'user.email', 'smoke@hypaware.test'], { cwd: workdir })
  await runGit(['config', 'user.name', 'HypAware Smoke'], { cwd: workdir })
  await runGit(['add', '.'], { cwd: workdir })
  await runGit(
    ['commit', '--quiet', '--no-gpg-sign', '-m', 'fixture: initial commit'],
    { cwd: workdir }
  )
  const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: workdir })).stdout.trim()

  await runGit(['init', '--bare', '-q', '-b', 'main', bareRepoDir])
  await runGit(['remote', 'add', 'origin', bareRepoDir], { cwd: workdir })
  await runGit(['push', '--quiet', 'origin', 'main'], { cwd: workdir })

  return sha
}

/**
 * Tiny git wrapper. Throws when the subprocess exits non-zero so the
 * smoke fails fast if the test fixture cannot be built.
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

/**
 * Minimal capture stream mirroring the local-dir smoke. Smoke flows
 * keep the shape identical so assertions stay consistent.
 */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    write(/** @type {unknown} */ chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
