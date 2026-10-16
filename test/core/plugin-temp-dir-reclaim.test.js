// @ts-check

// Issue #2465. Every plugin-activating `hyp` run left one temp directory per
// activated plugin in the user's temp root, and nothing removed them:
// `createPluginPaths` mkdirs `<tmpRoot ?? os.tmpdir()>/<plugin>-<runId>` per
// plugin at activation, and the only readers of `PluginPaths.tempDir`
// (`src/core/sinks/encoder.js`, `@hypaware/local-fs`, `@hypaware/s3`) stage an
// in-flight blob in it and never clean up after themselves.
//
// The in-process sibling is activation-env-forwarding.test.js, which can assert
// on the test-owned `tmpRoot` it injects. The first test here covers what an
// in-process `dispatch` call cannot show: that the shipped entrypoint, run as a
// user runs it, leaves nothing behind after the process exits.
//
// The last two cover the hazards the reclaim itself created by making a stray
// `mkdir -p` target into an `fs.rm(recursive)` target: a `runId` that steers
// the delete out of the temp root, and two boots that adopt one directory.
// Those live against `createPluginPaths` directly, because neither is
// reachable by spawning the binary with a well-formed environment.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { createPluginPaths, reclaimPluginTempDirs } from '../../src/core/runtime/paths.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hypaware.js')

/** @param {string} p */
async function exists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Run the shipped entrypoint with HOME, TMPDIR and HYP_HOME all inside `root`.
 * A minimal env, so the test runner's own TMPDIR cannot be the one the child
 * resolves.
 *
 * @param {string[]} argv
 * @param {string} root
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function runCli(argv, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: path.join(root, 'home'),
        TMPDIR: path.join(root, 'tmp'),
        HYP_HOME: path.join(root, 'home', '.hyp'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

test('a plugin-activating CLI run leaves no plugin boot temp dirs in the user tmpdir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-tempdir-reclaim-'))
  const tmp = path.join(root, 'tmp')
  await fs.mkdir(path.join(root, 'home'), { recursive: true })
  await fs.mkdir(tmp, { recursive: true })

  try {
    // `hyp init --from-file` is the shape the issue measured: it boots
    // `all-available`, so every bundled plugin activates and gets a temp dir.
    const fromFile = path.join(root, 'incoming.json')
    await fs.writeFile(fromFile, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/otel' }] }) + '\n')

    const first = await runCli(['init', '--from-file', fromFile], root)
    assert.equal(first.code, 0, first.stderr)
    // Named by the `-boot-` the default runId carries (`boot-<pid>-<ts>`),
    // which is what makes these per-boot rather than durable state.
    assert.deepEqual(
      (await fs.readdir(tmp)).filter((e) => e.includes('-boot-')),
      [],
      'plugin boot temp dirs survived `hyp init` in the invoking user\'s tmpdir'
    )
    // Positive half of the check: the two assertions above are both
    // negatives (nothing named `-boot-` is left in tmp), so this test would
    // pass just as well if plugin activation silently stopped happening
    // altogether. `createPluginPaths` mkdirs each plugin's durable state dir
    // (`pluginStateDir` in src/core/runtime/paths.js, under `stateRoot` from
    // src/core/runtime/boot.js, i.e. `<HYP_HOME>/hypaware/plugins/<plugin>`)
    // in the same call that creates the temp dir, so a non-empty state
    // directory root is proof that activation really happened.
    const pluginStateRoot = path.join(root, 'home', '.hyp', 'hypaware', 'plugins')
    // `readdir` rejects with ENOENT on a missing directory, and missing is
    // exactly the case this assertion exists to catch: `createPluginPaths` only
    // ever creates `plugins/` as the parent of a plugin's own state dir, so it
    // never exists empty. Without the catch the failure surfaces as an ENOENT
    // stack and the message below can never print.
    const pluginStateDirs = await fs.readdir(pluginStateRoot).catch(() => [])
    assert.ok(
      pluginStateDirs.length > 0,
      'expected plugin activation to have created per-plugin state directories'
    )

    // A second run on the now-configured machine, because the growth the issue
    // is about is per invocation: `init` activates once and writes the config,
    // and then every command that boots `config` activates that set again under
    // a fresh runId. `hyp status` would not do: it boots `{ activate: [] }`, so
    // it never had a temp dir to leak.
    const second = await runCli(['query', 'sql', 'select 1'], root)
    assert.equal(second.code, 0, second.stderr)
    assert.deepEqual(
      (await fs.readdir(tmp)).filter((e) => e.includes('-boot-')),
      [],
      'plugin boot temp dirs accumulated across CLI invocations'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Issue #2473. The reclaim above only ran on dispatch's success and
// handled-error paths, and the sink-materialization warning pass writes to
// `stderr` after the kernel has booted. A `stderr` whose `write` throws (what
// a pipe write raises once the reader closed, `hyp sync | head`) therefore left
// the whole boot behind: one temp dir per activated plugin, and every source the
// activations started still listening.
test('a throw from the post-boot sink warning path still reclaims the boot temp dirs', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-tempdir-epipe-'))
  const tmpRoot = path.join(hypHome, 'plugin-temp-root')
  const runId = `issue-2473-${process.pid}-${Date.now()}`

  try {
    // A directory in the temp root that this boot does not own. Teardown now
    // runs on a throw as well as on a clean exit, and widening *when* the
    // recursive delete runs must not widen *what* it deletes: reclaim only ever
    // gets the `tempDir` paths this boot's own activation contexts recorded.
    await fs.mkdir(path.join(tmpRoot, 'not-ours', 'sub'), { recursive: true })
    await fs.writeFile(path.join(tmpRoot, 'not-ours', 'sub', 'keepme.txt'), 'CANARY')

    // A sink naming a plugin `plugins[]` does not enable is the shortest route
    // into the warning pass: it cannot materialize, and the `config` boot
    // profile `hyp query sql` boots activates plugins, so the pass is not
    // skipped.
    await fs.writeFile(
      path.join(hypHome, 'hypaware-config.json'),
      JSON.stringify({
        version: 2,
        plugins: [{ name: '@hypaware/otel' }],
        sinks: { bad: { plugin: '@hypaware/local-fs' } },
      }) + '\n'
    )

    let writes = 0
    const epipe = {
      write() {
        writes += 1
        const err = /** @type {NodeJS.ErrnoException} */ (new Error('write EPIPE'))
        err.code = 'EPIPE'
        throw err
      },
    }

    await assert.rejects(
      () => dispatch(['query', 'sql', 'select 1'], {
        stdout: { write: () => true },
        stderr: epipe,
        env: {
          ...process.env,
          HYP_HOME: hypHome,
          HYP_CONFIG: '',
          DEV_RUN_ID: runId,
        },
        tmpRoot,
      }),
      (err) => {
        // The teardown runs in a `finally`, so it must not throw out of it and
        // stand in for the error that got us there.
        assert.equal(/** @type {NodeJS.ErrnoException} */ (err).code, 'EPIPE', String(err))
        return true
      }
    )

    assert.ok(writes > 0, 'nothing wrote to stderr: this fixture no longer reaches the sink warning pass')
    assert.deepEqual(
      await fs.readdir(tmpRoot),
      ['not-ours'],
      'a throw from the post-boot sink warning path exited dispatch without tearing the boot down'
    )
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'not-ours', 'sub', 'keepme.txt'), 'utf8'),
      'CANARY',
      'the teardown reclaim deleted a directory in the temp root that this boot did not create'
    )
    // The assertion above is on the test-owned root, so on its own it would also
    // pass if `tmpRoot` forwarding broke and the dirs landed in the shared OS
    // temp root instead. `runId` is unique to this run, so naming the survivors
    // by suffix stays safe under parallel `npm test` workers.
    assert.deepEqual(
      (await fs.readdir(os.tmpdir())).filter((e) => e.endsWith('-' + runId)),
      [],
      'plugin boot temp dirs from this boot survived in the OS temp root'
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Both of the following need an environment the spawned binary above will not
// produce on its own: a hostile `DEV_RUN_ID`, and two kernel boots racing on
// one runId. So they drive `createPluginPaths` directly, which is the function
// that decides the path the teardown later deletes.

test('a hostile runId cannot steer the reclaim out of the temp root', async () => {
  // `runId` arrives from `DEV_RUN_ID` (`src/core/runtime/boot.js`) and is not
  // validated anywhere on the way in. `pluginName` was sanitized and `runId`
  // was not, so `path.join` normalized any `/` or `..` the runId contributed
  // straight out of `tempBase` and the teardown deleted whatever it landed on.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-tempdir-escape-'))
  try {
    const tempBase = path.join(root, 'a', 'b', 'c', 'tmp')
    await fs.mkdir(tempBase, { recursive: true })
    for (const runId of ['..', '../..', '../../../victim', '/etc', '..\\..\\victim', '....//victim', '.']) {
      // A populated directory at every level a traversal out of `tempBase`
      // could land on, so an escape has something to destroy.
      const victims = ['victim', 'a/victim', 'a/b/victim', 'a/b/c/victim']
      for (const v of victims) {
        await fs.mkdir(path.join(root, v, 'sub'), { recursive: true })
        await fs.writeFile(path.join(root, v, 'sub', 'keepme.txt'), 'CANARY')
      }
      const paths = await createPluginPaths({
        pluginName: '@hypaware/dummy',
        rootDir: root,
        stateRoot: path.join(root, 'state'),
        runId,
        tmpRoot: tempBase,
      })
      // The only containment that matters: whatever the runId spelled, the
      // directory handed to the recursive delete is a direct child of
      // `tempBase`. `sanitizeTempSegment` maps `/` to `__` and everything
      // outside `[A-Za-z0-9._@-]` to `_`, and the `<plugin>-<runId>` join
      // always leaves a `-` in the middle, so the segment can never be `.`
      // or `..` either.
      assert.equal(
        path.dirname(paths.tempDir),
        tempBase,
        `runId ${JSON.stringify(runId)} resolved a temp dir outside the temp root: ${paths.tempDir}`
      )
      await fs.writeFile(path.join(paths.tempDir, 'staged.bin'), 'x')
      await reclaimPluginTempDirs([paths.tempDir])
      for (const v of victims) {
        assert.equal(
          await exists(path.join(root, v, 'sub', 'keepme.txt')),
          true,
          `runId ${JSON.stringify(runId)} let the reclaim delete ${v} outside the temp root`
        )
      }
      assert.equal(await exists(tempBase), true, `runId ${JSON.stringify(runId)} let the reclaim delete the temp root itself`)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('boots sharing a runId get separate temp dirs, so one teardown cannot destroy another', async () => {
  // The name derives only from plugin name and runId, so two kernel boots
  // sharing a `DEV_RUN_ID` resolve the same path and the first teardown
  // recursively deletes the other's in-flight scratch. Whoever creates the
  // directory owns it; everyone else takes a unique sibling.
  //
  // Both `tempBase` states, because the ownership probe depends on it:
  // `fs.mkdir(p, { recursive: true })` resolves to "the first directory path
  // created", which is an ancestor rather than `p` whenever an ancestor was
  // missing too. An injected `tmpRoot` that does not exist yet is the shape
  // several smokes and activation-env-forwarding.test.js pass, and reading
  // that return as "I created the leaf" let concurrent boots collide again.
  for (const tempBaseExists of [true, false]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-tempdir-collide-'))
    try {
      const tempBase = path.join(root, 'missing', 'tmp')
      if (tempBaseExists) await fs.mkdir(tempBase, { recursive: true })
      const runId = 'boot-shared'
      const boots = await Promise.all(
        [0, 1, 2, 3].map((i) => createPluginPaths({
          pluginName: '@hypaware/dummy',
          rootDir: root,
          stateRoot: path.join(root, 'state', String(i)),
          runId,
          tmpRoot: tempBase,
        }))
      )
      const label = `tempBase ${tempBaseExists ? 'existing' : 'missing'}`
      assert.equal(
        new Set(boots.map((b) => b.tempDir)).size,
        boots.length,
        `${label}: concurrent boots sharing a runId adopted the same temp dir`
      )
      // The uncontended name is still exactly `<plugin>-<runId>`, which is what
      // makes these dirs recognizable as per-boot.
      assert.ok(
        boots.some((b) => path.basename(b.tempDir) === `@hypaware__dummy-${runId}`),
        `${label}: no boot took the plain <plugin>-<runId> name`
      )
      await Promise.all(boots.map((b, i) => fs.writeFile(path.join(b.tempDir, 'inflight.bin'), `boot${i}`)))
      // One boot tears down while the other three are still live.
      await reclaimPluginTempDirs([boots[0].tempDir])
      assert.equal(await exists(boots[0].tempDir), false, `${label}: the reclaimed boot's temp dir survived`)
      for (const b of boots.slice(1)) {
        assert.equal(
          await exists(path.join(b.tempDir, 'inflight.bin')),
          true,
          `${label}: one boot's teardown destroyed a concurrently live boot's in-flight scratch`
        )
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})
