// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  HELPER_BASENAME,
  activate,
} from '../../hypaware-core/plugins-workspace/claude-desktop/src/index.js'
import { resolveHypBin } from '../../hypaware-core/plugins-workspace/claude-desktop/src/inputs.js'
import { isNpxBinPath } from '../../src/core/cli/global_install.js'

/**
 * Minimal activation context: capture registered commands and provide
 * the two required capabilities.
 *
 * @param {{ stateDir: string, mode: 'org_key' | 'subscription', credential?: boolean }} opts
 */
function fakeCtx(opts) {
  /** @type {Map<string, any>} */
  const commands = new Map()
  const ctx = /** @type {any} */ ({
    config: {},
    paths: { stateDir: opts.stateDir },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configRegistry: { registerSection() {} },
    commands: {
      register(/** @type {any} */ cmd) { commands.set(cmd.name, cmd) },
      registerGroup() {},
    },
    capabilities: {
      has(/** @type {string} */ name) {
        if (name === 'hypaware.anthropic-credential') return opts.credential !== false
        return name === 'hypaware.ai-gateway'
      },
    },
    requireCapability(/** @type {string} */ name) {
      if (name === 'hypaware.ai-gateway') return {}
      if (name === 'hypaware.anthropic-credential') {
        return { mode: opts.mode, helperCommandArgs: ['claude-account', 'credential'] }
      }
      throw new Error(`unexpected capability ${name}`)
    },
  })
  return { ctx, commands }
}

/**
 * @param {(argv: string[], cmdCtx: any) => Promise<number>} run
 * @param {string[]} argv
 * @param {any} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
async function invoke(run, argv, config, env) {
  let out = ''
  let err = ''
  const code = await run(argv, {
    stdout: { write: (s) => { out += s } },
    stderr: { write: (s) => { err += s } },
    env: env ?? {},
    config: config ?? { version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] },
  })
  return { code, out, err }
}

test('install-helper writes an executable no-arg wrapper under the state dir', { skip: process.platform === 'win32' && 'sh wrapper + exec bit are darwin artifacts' }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'))
  const { ctx, commands } = fakeCtx({ stateDir, mode: 'subscription' })
  await activate(ctx)

  const install = commands.get('client claude-desktop install-helper')
  const { code, out } = await invoke(install.run, [])
  assert.equal(code, 0)

  const helperPath = path.join(stateDir, HELPER_BASENAME)
  assert.ok(out.includes(helperPath))
  assert.ok(fs.existsSync(helperPath))
  const mode = fs.statSync(helperPath).mode & 0o777
  assert.equal(mode, 0o755)
  const body = fs.readFileSync(helperPath, 'utf8')
  assert.ok(body.startsWith('#!/bin/sh\n'))
  assert.ok(/exec .*claude-account credential/.test(body))
})

test('the generated wrapper runs its target with no arguments', { skip: process.platform === 'win32' && 'sh wrapper + exec bit are darwin artifacts' }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'))
  // A fake "hyp" that echoes JSON only when called with exactly the two
  // credential args, proving the wrapper appends nothing.
  const fakeHyp = path.join(stateDir, 'fake-hyp.sh')
  fs.writeFileSync(fakeHyp,
    '#!/bin/sh\n'
    + 'if [ "$1" = "claude-account" ] && [ "$2" = "credential" ] && [ -z "$3" ]; then\n'
    + '  printf \'{"token":"t","headers":{},"ttlSec":60}\'\n'
    + 'else echo "bad args: $@" >&2; exit 2; fi\n',
    { mode: 0o755 })
  fs.chmodSync(fakeHyp, 0o755)

  const helperPath = path.join(stateDir, HELPER_BASENAME)
  const { ctx, commands } = fakeCtx({ stateDir, mode: 'subscription' })
  await activate(ctx)
  const install = commands.get('client claude-desktop install-helper')
  // install-helper embeds resolveHypBin()/process.execPath, so hand-write
  // an equivalent wrapper against the fake to exercise no-arg exec. The
  // fake already includes its own `#!/bin/sh`, so exec it directly.
  fs.writeFileSync(helperPath, `#!/bin/sh\nexec ${fakeHyp} claude-account credential\n`, { mode: 0o755 })
  fs.chmodSync(helperPath, 0o755)

  const stdout = execFileSync(helperPath, [], { encoding: 'utf8' })
  assert.equal(stdout, '{"token":"t","headers":{},"ttlSec":60}')
  assert.ok(install, 'install-helper command registered')
})

test('status reports the helper as not installed until install-helper runs', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'))
  const { ctx, commands } = fakeCtx({ stateDir, mode: 'org_key' })
  await activate(ctx)
  const status = commands.get('client claude-desktop status')

  const before = await invoke(status.run, [])
  assert.equal(before.code, 1)
  assert.ok(/NOT installed/.test(before.out))
  assert.ok(/scheme x-api-key/.test(before.out))

  await invoke(commands.get('client claude-desktop install-helper').run, [])
  const after = await invoke(status.run, [])
  assert.equal(after.code, 0)
  assert.ok(/installed/.test(after.out))
})

// @ref LLP 0358#onboarding [tests]: missing credentials disable only the
// optional profile commands, never plugin activation or transcript ownership.
test('activation succeeds without a credential and legacy commands explain the optional dependency', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'))
  const { ctx, commands } = fakeCtx({ stateDir, mode: 'subscription', credential: false })
  await activate(ctx)

  assert.ok(commands.has('client claude-desktop install'))
  const result = await invoke(commands.get('client claude-desktop install').run, [])
  assert.equal(result.code, 1)
  assert.match(result.err, /managed-profile commands require @hypaware\/claude-account/)
  assert.match(result.err, /scheduled transcript capture does not/)
})

/**
 * The generated wrapper must never be pinned to npm's `_npx` cache.
 *
 * `install-helper` bakes an absolute CLI path into `credential-helper.sh`, and
 * that path is the running CLI's own entry script. Under `npx hypaware` the
 * running CLI *is* the npx cache checkout, so the wrapper records
 * `~/.npm/_npx/<hash>/...`, which npm prunes on its own schedule. Desktop runs
 * the wrapper outside any shell profile and reads its stdout, so a pruned cache
 * surfaces as a credential-helper failure inside the app with nothing here
 * reporting it (issue #1604, the sibling of #1602).
 *
 * Only a real `npx` run can put this package inside `_npx`, so these lay out a
 * real `$PATH` the way npx lays one out - its own shim directory in front,
 * anything durable behind it - and present the cache entrypoint as
 * `process.argv[1]`, which is where `install-helper` reads the running CLI.
 */

/** @param {string} file */
function writeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(file, 0o755)
}

/**
 * A temp root standing in for a machine running `npx hypaware`, plus the state
 * dir the wrapper is written into.
 *
 * `installedBin` picks what sits at the global bin name: `npm install -g`
 * links it onto the package's own `bin/hypaware.js`, which is what makes the
 * wrapper's `exec <node> <hypBin>` work at all, while pnpm, volta and asdf put
 * a shell script or a compiled shim there under the same name.
 *
 * @param {{ installedBin?: boolean | 'shim' }} [opts]
 */
function npxRig(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-bin-'))

  const npxRoot = path.join(root, '.npm', '_npx', 'a1b2c3d4')
  const npxCliPath = path.join(npxRoot, 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  writeExecutable(npxCliPath)
  writeExecutable(path.join(npxRoot, 'node_modules', '.bin', 'hypaware'))

  const globalBinDir = path.join(root, 'npm-global', 'bin')
  const globalBin = path.join(globalBinDir, 'hypaware')
  if (opts.installedBin === false) fs.mkdirSync(globalBinDir, { recursive: true })
  else if (opts.installedBin === 'shim') writeExecutable(globalBin)
  else {
    const linkTarget = path.join(root, 'npm-global', 'lib', 'node_modules', 'hypaware', 'bin', 'hypaware.js')
    writeExecutable(linkTarget)
    fs.mkdirSync(globalBinDir, { recursive: true })
    fs.symlinkSync(linkTarget, globalBin)
  }

  return {
    stateDir: root,
    npxCliPath,
    globalBin,
    env: {
      HOME: root,
      npm_config_cache: path.join(root, '.npm'),
      PATH: [path.join(npxRoot, 'node_modules', '.bin'), globalBinDir].join(path.delimiter),
    },
  }
}

/**
 * Run `install-helper` with `process.argv[1]` pointed at `entry`, which is the
 * only seam that decides which CLI the wrapper records.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ stateDir: string, env: NodeJS.ProcessEnv }} rig
 * @param {string} entry
 */
async function runInstallHelperWithEntry(t, rig, entry) {
  const realArgv1 = process.argv[1]
  process.argv[1] = entry
  t.after(() => { process.argv[1] = realArgv1 })

  const { ctx, commands } = fakeCtx({ stateDir: rig.stateDir, mode: 'subscription' })
  await activate(ctx)
  const result = await invoke(
    commands.get('client claude-desktop install-helper').run,
    [],
    undefined,
    rig.env,
  )
  return { ...result, body: fs.readFileSync(path.join(rig.stateDir, HELPER_BASENAME), 'utf8') }
}

test('the generated wrapper records the installed CLI, not the npx cache path', async (t) => {
  const rig = npxRig({ installedBin: true })
  assert.equal(isNpxBinPath(rig.npxCliPath, rig.env), true, 'rig did not build an npx entrypoint')

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, rig.npxCliPath)

  assert.equal(code, 0)
  assert.ok(
    body.includes(rig.globalBin),
    `wrapper does not run the installed CLI: ${body}`,
  )
  assert.ok(
    !body.includes('_npx'),
    `wrapper was pinned to the npx cache: ${body}`,
  )
  assert.equal(err, '', 'a durable path is not worth warning about')
})

test('with no CLI installed the wrapper still works, and says what will break it', async (t) => {
  const rig = npxRig({ installedBin: false })

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, rig.npxCliPath)

  // A wrapper that works until npm prunes the cache beats no wrapper at all,
  // so the path is still written. What changes is that it is no longer silent.
  assert.equal(code, 0)
  assert.ok(body.includes(fs.realpathSync(rig.npxCliPath)))
  assert.match(err, /npx cache/)
  assert.match(err, /npm install -g hypaware/)
})

test('a $PATH entry node cannot run is declined, not recorded as durable', async (t) => {
  // pnpm, volta and asdf all put a shell script or a compiled shim at the
  // global bin name. The wrapper runs `exec <node> <hypBin>`, so recording one
  // writes a wrapper that fails on its very first run - strictly worse than
  // the npx path it would displace, which works until npm prunes the cache.
  // So the walk declines it and the machine keeps the path plus the warning.
  const rig = npxRig({ installedBin: 'shim' })

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, rig.npxCliPath)

  assert.equal(code, 0)
  assert.ok(!body.includes(rig.globalBin), `wrapper records a shim node cannot run: ${body}`)
  assert.ok(body.includes(fs.realpathSync(rig.npxCliPath)))
  assert.match(err, /npx cache/)
})

test('an ordinary durable install is recorded as it stands', async (t) => {
  // The one regression that would be worse than the bug: repointing a working
  // install at some other `hypaware` that happens to be on `$PATH`.
  const rig = npxRig({ installedBin: true })
  const durable = path.join(rig.stateDir, 'opt', 'hypaware', 'bin', 'hypaware.js')
  writeExecutable(durable)

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, durable)

  assert.equal(code, 0)
  assert.ok(body.includes(fs.realpathSync(durable)), `wrapper was repointed: ${body}`)
  assert.ok(!body.includes(rig.globalBin), `wrapper was repointed at ${rig.globalBin}`)
  assert.equal(err, '')
})

test('an explicit binary override wins over both', () => {
  const rig = npxRig({ installedBin: true })
  const cases = [
    { override: { HYP_BIN: '/custom/hyp' }, expected: '/custom/hyp' },
    { override: { HYPAWARE_BIN: '/preferred/hyp', HYP_BIN: '/custom/hyp' }, expected: '/preferred/hyp' },
  ]
  for (const { override, expected } of cases) {
    assert.deepEqual(resolveHypBin({ ...rig.env, ...override }, rig.npxCliPath), {
      binPath: path.resolve(expected),
      ephemeral: false,
    })
  }
})
