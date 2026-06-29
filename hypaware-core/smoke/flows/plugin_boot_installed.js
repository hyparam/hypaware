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
import { defaultConfigPath } from '../../../src/core/config/schema.js'

/**
 * hy-gh-2 smoke. Drives the CLI dispatcher end-to-end with one
 * installed third-party plugin from a local bare git repo and one
 * config file activating it. The fixture plugin contributes a single
 * command (`hyp installed-greet`) so the smoke can prove the boot
 * loaded the installed manifest into the merged pool, not just that
 * `plugin list` saw the lock entry.
 *
 * Acceptance points from the bead:
 *
 *  - `hyp` boots cleanly with one installed third-party plugin from a
 *    local git fixture.
 *  - A command contributed by the installed plugin runs and produces
 *    its expected output.
 *  - Boot telemetry shows the installed plugin in the active set:
 *    `kernel.boot` carries `installed_available=1` and
 *    `installed_selected=1`; a `plugin.installed_active` log lands for
 *    the fixture plugin; a `plugin.activate` span fires for it as a
 *    child of `kernel.boot`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'plugin_boot_installed: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  // ----- 1. Build the installable fixture in a local bare repo -----
  const pluginName = '@hypaware/boot-installed-fixture'
  const fixtureDir = path.join(harness.tmpDir, 'fixtures', 'boot-installed-fixture')
  await writeFixturePlugin(fixtureDir, pluginName)
  const bareRepoDir = path.join(harness.tmpDir, 'fixtures', 'boot-installed-fixture.git')
  await buildBareRepoFromFixture(fixtureDir, bareRepoDir)
  const sourceUrl = `file://${bareRepoDir}`

  const baseEnv = {
    ...process.env,
    HYP_HOME: harness.hypHome,
    DEV_RUN_ID: harness.devRunId,
  }

  // ----- 2. Install the fixture through the regular install pipeline -----
  const installStdout = makeBuf()
  const installStderr = makeBuf()
  const installCode = await runRoot(
    'smoke.driver',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_install',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () =>
      dispatch(['plugin', 'install', sourceUrl, '--yes'], {
        stdout: installStdout,
        stderr: installStderr,
        env: baseEnv,
        cwd: harness.tmpDir,
      })
  )
  expect.that('dispatch: plugin install exited 0', installCode, (v) => v === 0)
  // The confirmation summary lands on stderr by design; the smoke only
  // cares that we got the success exit code and nothing surprising
  // bled through. Match the install-git-url smoke contract.
  expect.that(
    'stderr: confirmation summary names the plugin',
    installStderr.text(),
    (v) => typeof v === 'string' && v.includes(pluginName)
  )

  // ----- 3. Write a config that activates the installed plugin -----
  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        version: 2,
        plugins: [{ name: pluginName }],
      },
      null,
      2
    )
  )
  const configEnv = { ...baseEnv, HYP_CONFIG: configPath }

  // ----- 4. Run the installed plugin's contributed command -----
  const greetStdout = makeBuf()
  const greetStderr = makeBuf()
  const greetCode = await dispatch(['installed-greet'], {
    stdout: greetStdout,
    stderr: greetStderr,
    env: configEnv,
  })
  expect.that('dispatch: installed-greet exited 0', greetCode, (v) => v === 0)
  expect.that(
    'stderr: installed-greet had no errors',
    greetStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )
  expect.that(
    'stdout: installed-greet printed the fixture greeting',
    greetStdout.text(),
    (v) => typeof v === 'string' && v.includes('hello from boot-installed-fixture')
  )

  // ----- 5. plugin list --json should report the active installed plugin -----
  const listStdout = makeBuf()
  const listStderr = makeBuf()
  const listCode = await dispatch(['plugin', 'list', '--json'], {
    stdout: listStdout,
    stderr: listStderr,
    env: configEnv,
  })
  expect.that('dispatch: plugin list --json exited 0', listCode, (v) => v === 0)
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
  const fixtureRow = (listJson?.plugins ?? []).find(
    (/** @type {any} */ p) => p.name === pluginName
  )
  expect.that(
    'plugin list: fixture row carries source=installed',
    fixtureRow?.source,
    (v) => v === 'installed'
  )
  expect.that(
    'plugin list: fixture row is active=true (booted from config)',
    fixtureRow?.active,
    (v) => v === true
  )

  await obs.shutdown()

  // ----- 6. Telemetry assertions -----
  const traces = await expect.traces()
  const logs = await expect.logs()

  // kernel.boot spans driven by `installed-greet` and `plugin list`
  // should each see installed_available=1 and installed_selected=1.
  const bootSpans = traces.filter((/** @type {any} */ t) => t.name === 'kernel.boot')
  const configBoots = bootSpans.filter(
    (/** @type {any} */ s) => s.attributes?.boot_profile === 'config'
  )
  expect.that(
    'traces: at least one config-profile kernel.boot span emitted',
    configBoots,
    (rows) => Array.isArray(rows) && rows.length >= 1
  )
  // The first dispatch (`plugin install`) boots before the lock is
  // written, so its `installed_available` is 0. Every *post-install*
  // boot (`installed-greet`, `plugin list`) sees the fixture in the
  // merged manifest pool, so at least two config-profile boots tag
  // `installed_available=1` and at least one tags `installed_selected=1`.
  const installedAvailableCounts = configBoots
    .map((/** @type {any} */ s) => s.attributes?.installed_available)
    .filter((n) => typeof n === 'number')
  expect.that(
    'traces: at least two config-profile boots report installed_available=1',
    installedAvailableCounts.filter((n) => n === 1).length,
    (n) => n >= 2
  )
  expect.that(
    'traces: at least one config-profile boot reports installed_selected=1',
    configBoots.map((/** @type {any} */ s) => s.attributes?.installed_selected),
    (rows) => Array.isArray(rows) && rows.some((n) => n === 1)
  )

  // plugin.installed_active log row for the fixture
  const installedActiveLogs = logs.filter(
    (/** @type {any} */ l) =>
      l.body === 'plugin.installed_active' &&
      l.attributes?.hyp_plugin === pluginName &&
      l.attributes?.hyp_source === 'installed'
  )
  expect.that(
    'logs: plugin.installed_active emitted for the fixture',
    installedActiveLogs.length,
    (n) => n >= 1
  )

  // plugin.activate span for the fixture, parented to a kernel.boot span
  const activateSpans = traces.filter(
    (/** @type {any} */ t) =>
      t.name === 'plugin.activate' && t.attributes?.hyp_plugin === pluginName
  )
  expect.that(
    'traces: plugin.activate span exists for the installed fixture',
    activateSpans.length,
    (n) => n >= 1
  )
  expect.that(
    'traces: each plugin.activate for the fixture is a child of a kernel.boot',
    activateSpans.map((/** @type {any} */ s) => s.parentSpanId),
    (ids) =>
      Array.isArray(ids) &&
      ids.every((id) =>
        bootSpans.some((/** @type {any} */ b) => b.spanId === id)
      )
  )

  // No shadow collisions should appear in the happy path.
  const shadowCollisions = logs.filter(
    (/** @type {any} */ l) => l.body === 'plugin.shadow_collision'
  )
  expect.that(
    'logs: no plugin.shadow_collision events in the happy path',
    shadowCollisions.length,
    (n) => n === 0
  )
}

/**
 * Lay down the fixture plugin tree. The entrypoint registers a single
 * command (`installed-greet`) so the smoke can prove the boot wired
 * the installed manifest into the active command registry.
 *
 * @param {string} dir
 * @param {string} pluginName
 */
async function writeFixturePlugin(dir, pluginName) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: pluginName,
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    contributes: {
      commands: [
        { name: 'installed-greet', summary: 'greet from the installed fixture' },
      ],
    },
  }
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify(manifest, null, 2)
  )
  await fs.writeFile(
    path.join(dir, 'index.js'),
    [
      "// fixture: " + pluginName,
      'export async function activate(ctx) {',
      '  ctx.commands.register({',
      "    name: 'installed-greet',",
      '    plugin: ctx.plugin.name,',
      "    summary: 'greet from the installed fixture',",
      "    usage: 'hyp installed-greet',",
      '    async run(_argv, runCtx) {',
      "      runCtx.stdout.write('hello from boot-installed-fixture\\n')",
      '      return 0',
      '    },',
      '  })',
      '}',
      '',
    ].join('\n')
  )
}

/**
 * Initialize a working repo from `fixtureDir`, commit it, then push to a
 * bare repo at `bareRepoDir` so the smoke can clone from
 * `file://<bareRepoDir>`.
 *
 * @param {string} fixtureDir
 * @param {string} bareRepoDir
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
  await runGit(['init', '--bare', '-q', '-b', 'main', bareRepoDir])
  await runGit(['remote', 'add', 'origin', bareRepoDir], { cwd: workdir })
  await runGit(['push', '--quiet', 'origin', 'main'], { cwd: workdir })
}

/**
 * Tiny git wrapper. Throws on non-zero exit so the smoke fails fast if
 * the test fixture cannot be built.
 *
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 */
function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const errs = []
    child.stdout?.on('data', (c) => out.push(Buffer.from(c)))
    child.stderr?.on('data', (c) => errs.push(Buffer.from(c)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout: Buffer.concat(out).toString('utf8') })
      const stderr = Buffer.concat(errs).toString('utf8')
      reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr}`))
    })
  })
}

/**
 * Minimal capture stream mirroring the other smokes.
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
