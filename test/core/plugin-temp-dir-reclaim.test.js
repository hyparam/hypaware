// @ts-check

// Issue #2465. Every plugin-activating `hyp` run left one temp directory per
// activated plugin in the user's temp root, and nothing removed them:
// `createPluginPaths` mkdirs `<tmpRoot ?? os.tmpdir()>/<plugin>-<runId>` per
// plugin at activation, and the only readers of `PluginPaths.tempDir`
// (`src/core/sinks/encoder.js`, `@hypaware/local-fs`, `@hypaware/s3`) stage an
// in-flight blob in it and never clean up after themselves.
//
// The in-process sibling is activation-env-forwarding.test.js, which can assert
// on the test-owned `tmpRoot` it injects. This file covers what an in-process
// `dispatch` call cannot show: that the shipped entrypoint, run as a user runs
// it, leaves nothing behind after the process exits.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hypaware.js')

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
