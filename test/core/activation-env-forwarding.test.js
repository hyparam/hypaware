// @ts-check

// Issue #2443. `bootKernel` resolves the env a caller injected
// (`opts.env ?? process.env`) and uses it for config resolution and
// observability, but `activatePlugins` had no `env` parameter to hand it to, so
// `createActivationContext` fell back to its `env ?? process.env` default and
// every plugin's `ctx.env` was the ambient process environment no matter what
// the caller injected.
//
// A dozen bundled plugins read `ctx.env`, and `@hypaware/local-fs` is the one
// with a visible footprint: it resolves its BlobStore base from
// `ctx.env.HYP_HOME` and `mkdir`s it in `activate()`, so a caller booting with
// an injected HYP_HOME still created `~/.hyp/exports` in the real home.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { activatePlugins } from '../../src/core/runtime/loader.js'

/** @param {string} p */
async function exists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

test('activatePlugins hands the injected env to each activation context', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-plugin-'))
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-state-'))
  const seen = path.join(stateRoot, 'seen.txt')
  await fs.writeFile(
    path.join(rootDir, 'index.js'),
    'import fs from \'node:fs/promises\'\n' +
    'export async function activate(ctx) {\n' +
    `  await fs.writeFile(${JSON.stringify(seen)}, String(ctx.env.HYP_TEST_MARKER))\n` +
    '}\n'
  )
  const manifest = /** @type {any} */ ({
    schema_version: 1,
    name: '@acme/env-reader',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  })

  try {
    const cacheRoot = path.join(stateRoot, 'cache')
    const { results, runtime } = await activatePlugins({
      plugins: [{ manifest, rootDir, config: {} }],
      stateRoot,
      runId: 'env-forwarding',
      tmpRoot: stateRoot,
      env: /** @type {any} */ ({ HYP_TEST_MARKER: 'injected' }),
      // Issue #2454. Without a runtime, `createKernelRuntime` falls back to
      // `defaultCacheRoot()`, which reads HYP_HOME or the real home, rooting
      // this fixture in the home the test exists to keep state out of.
      // `<stateRoot>/cache` is the shape `bootKernel` passes.
      runtime: createKernelRuntime({ cacheRoot }),
    })
    assert.equal(results[0]?.ok, true, /** @type {any} */ (results[0])?.message)
    assert.equal(await fs.readFile(seen, 'utf8'), 'injected')
    // Pinned, not incidental: with no runtime this reads `<home>/.hyp/hypaware/cache`.
    assert.equal(runtime.cacheRoot, cacheRoot, 'the fixture runtime rooted its cache outside the test tmpdir')
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true })
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a dispatch boot places plugin state under the injected HYP_HOME, not the real home', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-home-'))
  const realExports = path.join(os.homedir(), '.hyp', 'exports')
  const realExistedBefore = await exists(realExports)

  const fromFile = path.join(hypHome, 'incoming.json')
  await fs.writeFile(fromFile, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/otel' }] }) + '\n')

  const stderr = makeBuf()
  const code = await dispatch(['init', '--from-file', fromFile], {
    stdout: makeBuf(),
    stderr,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
  })
  assert.equal(code, 0, stderr.text())

  // `@hypaware/local-fs` mkdirs `<HYP_HOME>/exports` in `activate()`, so where
  // that directory landed is the shortest proof of where activation read its env.
  assert.ok(await exists(path.join(hypHome, 'exports')), 'the exports dir did not land under the injected HYP_HOME')
  assert.equal(
    await exists(realExports),
    realExistedBefore,
    'the boot created .hyp/exports in the invoking user\'s real home'
  )

  await fs.rm(hypHome, { recursive: true, force: true })
})
