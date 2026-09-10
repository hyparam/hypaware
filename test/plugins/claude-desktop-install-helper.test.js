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
import { shellQuote } from '../../hypaware-core/plugins-workspace/claude-desktop/src/profile.js'
import { isNpxBinPath } from '../../src/core/cli/global_install.js'

/**
 * @import { TestContext } from 'node:test'
 */

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
  // A wrapper this run just generated is live, so status must not nag (#1616).
  assert.ok(!/STALE/.test(after.out), after.out)
})

// @ref LLP 0116#helper-contract [tests]: Desktop is the only observer of a rotted wrapper, so status has to read the file rather than stat it
test('status reports a wrapper whose baked interpreter rotted away, rather than "installed"', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'))
  const { ctx, commands } = fakeCtx({ stateDir, mode: 'org_key' })
  await activate(ctx)

  await invoke(commands.get('client claude-desktop install-helper').run, [])
  const helperPath = path.join(stateDir, HELPER_BASENAME)
  // Stand in for an nvm/volta/asdf/brew node switch: same wrapper, same
  // path in the plist, an interpreter that is no longer there. Swapped by the
  // exact token the renderer wrote, not by a `\S+` match on it: an interpreter
  // under a path with a space is quoted, so the pattern would cut the token in
  // half and leave the rest of it as a third argument - a wrapper still judged
  // STALE, but for a shape `install-helper` never writes.
  const rotted = fs.readFileSync(helperPath, 'utf8').replace(
    `exec ${shellQuote(process.execPath)} `,
    `exec ${shellQuote(path.join(stateDir, 'nvm', 'v20.0.0', 'bin', 'node'))} `,
  )
  fs.writeFileSync(helperPath, rotted)

  const after = await invoke(commands.get('client claude-desktop status').run, [])

  assert.equal(after.code, 1, after.out)
  assert.ok(/STALE: baked interpreter path no longer exists/.test(after.out), after.out)
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
 * The top of a package-manager-owned tree: the manifest that makes
 * `isEphemeralBinPath` call it ephemeral, and the lockfile beside it.
 *
 * @param {string} dir
 * @param {string} lockfile
 */
function managerRoot(dir, lockfile) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"hypaware":"1.0.0"}}\n')
  fs.writeFileSync(path.join(dir, lockfile), '# lockfile\n')
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
 * `shimAhead` adds a second `hypaware`, a bare shell script, in its own `$PATH`
 * directory in FRONT of the global bin. That is not a contrived ordering: pnpm,
 * volta and asdf all install by putting their own directory ahead of
 * `/usr/local/bin`, so on a machine carrying both, the shim is what a `$PATH`
 * walk meets first and the durable install is what it meets second.
 *
 * @param {{ installedBin?: boolean | 'shim' | 'mjs', shimAhead?: boolean }} [opts]
 */
function npxRig(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-bin-'))

  const npxRoot = path.join(root, '.npm', '_npx', 'a1b2c3d4')
  const npxCliPath = path.join(npxRoot, 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  writeExecutable(npxCliPath)
  writeExecutable(path.join(npxRoot, 'node_modules', '.bin', 'hypaware'))

  // A checkout that carries `hypaware` as a dependency: the same hazard with
  // no `_npx` tell, and the manifest beside the tree is what makes it one. Its
  // `.bin` is on `$PATH` because that is where `npm run` puts it.
  const projectDir = path.join(root, 'repo')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"app"}\n')
  const projectCliPath = path.join(projectDir, 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  writeExecutable(projectCliPath)
  writeExecutable(path.join(projectDir, 'node_modules', '.bin', 'hypaware'))

  const globalBinDir = path.join(root, 'npm-global', 'bin')
  const globalBin = path.join(globalBinDir, 'hypaware')
  if (opts.installedBin === false) fs.mkdirSync(globalBinDir, { recursive: true })
  else if (opts.installedBin === 'shim') writeExecutable(globalBin)
  else {
    const entry = opts.installedBin === 'mjs' ? 'hypaware.mjs' : 'hypaware.js'
    const linkTarget = path.join(root, 'npm-global', 'lib', 'node_modules', 'hypaware', 'bin', entry)
    writeExecutable(linkTarget)
    fs.mkdirSync(globalBinDir, { recursive: true })
    fs.symlinkSync(linkTarget, globalBin)
  }

  // A `pnpm add -g` and a `yarn global add`, at each manager's default global
  // dir. Both write a manifest and a lockfile beside their global root and put
  // the package under a `node_modules` inside it, which is a project's shape
  // exactly, so `isEphemeralBinPath` reads them ephemeral (issue #1625). The
  // pnpm entry is inside the store the visible link points into, because that
  // is the path `realpath` returns and the path the wrapper records.
  const pnpmGlobalDir = path.join(root, '.local', 'share', 'pnpm', 'global', '5')
  managerRoot(pnpmGlobalDir, 'pnpm-lock.yaml')
  const pnpmGlobalCliPath = path.join(
    pnpmGlobalDir, 'node_modules', '.pnpm', 'hypaware@1.0.0',
    'node_modules', 'hypaware', 'bin', 'hypaware.js',
  )
  writeExecutable(pnpmGlobalCliPath)
  const yarnGlobalDir = path.join(root, '.config', 'yarn', 'global')
  managerRoot(yarnGlobalDir, 'yarn.lock')
  const yarnGlobalCliPath = path.join(
    yarnGlobalDir, 'node_modules', 'hypaware', 'bin', 'hypaware.js',
  )
  writeExecutable(yarnGlobalCliPath)

  const shimDir = path.join(root, 'pnpm-ish')
  const shimBin = path.join(shimDir, 'hypaware')
  if (opts.shimAhead) writeExecutable(shimBin)

  return {
    stateDir: root,
    npxCliPath,
    projectCliPath,
    pnpmGlobalCliPath,
    yarnGlobalCliPath,
    globalBin,
    shimBin,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    env: {
      HOME: root,
      npm_config_cache: path.join(root, '.npm'),
      PATH: [
        path.join(npxRoot, 'node_modules', '.bin'),
        path.join(projectDir, 'node_modules', '.bin'),
        ...(opts.shimAhead ? [shimDir] : []),
        globalBinDir,
      ].join(path.delimiter),
    },
  }
}

/**
 * Run `install-helper` with `process.argv[1]` pointed at `entry`, which is the
 * only seam that decides which CLI the wrapper records.
 *
 * @param {TestContext} t
 * @param {{ stateDir: string, env: NodeJS.ProcessEnv, cleanup: () => void }} rig
 * @param {string} entry
 */
async function runInstallHelperWithEntry(t, rig, entry) {
  const realArgv1 = process.argv[1]
  process.argv[1] = entry
  t.after(() => { process.argv[1] = realArgv1 })
  t.after(() => rig.cleanup())

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

test('a shim in front of a durable install does not end the search', async (t) => {
  // The shim test above only proves a shim is not recorded. It is not enough:
  // the walk stops at the first `hypaware` it meets, so testing runnability on
  // that single answer throws away the search instead of continuing it. pnpm,
  // volta and asdf all put their directory ahead of `/usr/local/bin`, so on a
  // machine carrying both, the shim IS what the walk meets first - and the
  // operator is then told to run `npm install -g hypaware`, which is precisely
  // what put the durable install one entry behind it. Re-running never helps.
  const rig = npxRig({ installedBin: true, shimAhead: true })

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, rig.npxCliPath)

  assert.equal(code, 0)
  assert.ok(!body.includes(rig.shimBin), `wrapper records a shim node cannot run: ${body}`)
  assert.ok(body.includes(rig.globalBin), `the durable install behind the shim was missed: ${body}`)
  assert.ok(!body.includes('_npx'), `wrapper was pinned to the npx cache: ${body}`)
  assert.equal(err, '', 'a durable path was found, so there is nothing to repair')
})

test('the runnability test tracks what node loads, not this package\'s bin name', async (t) => {
  // The check asks whether `node <path>` can run the target, so it accepts
  // every extension node loads and not just the one `package.json` names
  // today. Pinned to `hypaware.js`, a later rename of the bin entry would put
  // every npx-run install back on an ephemeral wrapper, silently, with the
  // suite still green - the failure mode this whole PR exists to remove.
  const rig = npxRig({ installedBin: 'mjs' })

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, rig.npxCliPath)

  assert.equal(code, 0)
  assert.ok(body.includes(rig.globalBin), `an .mjs entry was declined: ${body}`)
  assert.equal(err, '')
})

// Issue #1619. `npm ci`, a branch switch, or a plain `rm -rf node_modules`
// deletes a project-local install exactly as npm's prune deletes the `_npx`
// cache, and Desktop then fails its credential helper inside the app with
// nothing on this machine reporting it. The walk already refuses these
// directories on the `$PATH` side; before this the entrypoint check did not,
// so the path was baked into the wrapper flagged durable and nothing warned.
test('the wrapper records the installed CLI, not a project-local node_modules path', async (t) => {
  const rig = npxRig({ installedBin: true })

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, rig.projectCliPath)

  assert.equal(code, 0)
  assert.ok(body.includes(rig.globalBin), `wrapper does not run the installed CLI: ${body}`)
  assert.ok(!body.includes(rig.projectCliPath), `wrapper was pinned to the project tree: ${body}`)
  assert.equal(err, '', 'a durable path is not worth warning about')
})

test('with no CLI installed the project-local wrapper says what will break it', async (t) => {
  const rig = npxRig({ installedBin: false })

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, rig.projectCliPath)

  assert.equal(code, 0)
  assert.ok(body.includes(fs.realpathSync(rig.projectCliPath)))
  // Named for the tree it is actually in: the two are deleted by different
  // acts, so telling an operator their wrapper is in an npx cache when it is
  // in their own checkout sends them looking in the wrong place.
  assert.match(err, /node_modules/)
  assert.doesNotMatch(err, /npx cache/)
  assert.match(err, /npm install -g hypaware/)
})

// Issue #1625. pnpm and yarn write a manifest beside their GLOBAL root, so a
// global install under either takes this same branch, and the wording used to
// assert a project's `node_modules` removed by an `npm ci` or a branch switch.
// For an operator whose only install is `pnpm add -g hypaware` there is no
// checkout, no `npm ci` and no branch to switch, so the sentence sent them
// looking for a tree they do not have. Nothing on disk separates the two
// (test/core/global-install.test.js lays both out side by side), so what the
// warning must do is describe what was observed and leave the tree to the path
// it already prints.
for (const manager of ['pnpm', 'yarn']) {
  test(`a ${manager} global install is not described as a project the operator does not have`, async (t) => {
    // Their own shim is on `$PATH` and nothing else is, which is that machine
    // exactly: the walk refuses the shim as unparseable by node and comes back
    // empty, so the global root is what gets recorded.
    const rig = npxRig({ installedBin: false, shimAhead: true })
    const entry = manager === 'pnpm' ? rig.pnpmGlobalCliPath : rig.yarnGlobalCliPath

    const { code, err, body } = await runInstallHelperWithEntry(t, rig, entry)

    assert.equal(code, 0)
    assert.ok(body.includes(fs.realpathSync(entry)), `wrapper does not run ${entry}: ${body}`)
    // The warning still fires and still names the repair, which does work here:
    // `npm install -g` puts a node-parseable entry on `$PATH` for the walk to
    // find, and this operator's wrapper really would rot if they removed the
    // global root. What it must not do is assert whose tree it is.
    assert.match(err, /npm install -g hypaware/)
    assert.match(err, /node_modules tree/)
    assert.doesNotMatch(err, /project's node_modules/)
    assert.doesNotMatch(err, /once an npm ci or a branch switch removes it/)
    assert.doesNotMatch(err, /npx cache/)
  })
}

test('a HypAware clone is not a project-local install', async (t) => {
  // `node <clone>/bin/hypaware.js` is the normal development entrypoint and
  // carries a `package.json` of its own. It is not under a `node_modules`, so
  // a developer never gets the warning and their wrapper is never repointed.
  const rig = npxRig({ installedBin: true })
  const clone = path.join(rig.stateDir, 'src', 'hypaware', 'bin', 'hypaware.js')
  writeExecutable(clone)
  fs.writeFileSync(path.join(rig.stateDir, 'src', 'hypaware', 'package.json'), '{}\n')

  const { code, err, body } = await runInstallHelperWithEntry(t, rig, clone)

  assert.equal(code, 0)
  assert.ok(body.includes(fs.realpathSync(clone)), `wrapper was repointed: ${body}`)
  assert.ok(!body.includes(rig.globalBin), `wrapper was repointed at ${rig.globalBin}`)
  assert.equal(err, '')
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

test('an explicit binary override wins over both', (t) => {
  const rig = npxRig({ installedBin: true })
  t.after(() => rig.cleanup())
  const cases = [
    { override: { HYP_BIN: '/custom/hyp' }, expected: '/custom/hyp' },
    { override: { HYPAWARE_BIN: '/preferred/hyp', HYP_BIN: '/custom/hyp' }, expected: '/preferred/hyp' },
    // The emptiness test above trims, so the value taken has to trim too:
    // ` /custom/hyp` is not absolute, and `path.resolve` would silently anchor
    // it to whatever directory install-helper ran in.
    { override: { HYP_BIN: '  /custom/hyp  ' }, expected: '/custom/hyp' },
  ]
  for (const { override, expected } of cases) {
    assert.deepEqual(resolveHypBin({ ...rig.env, ...override }, rig.npxCliPath), {
      binPath: path.resolve(expected),
      ephemeral: false,
    })
  }
})
