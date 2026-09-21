// @ts-check

// Issue #1857. The loader catches whatever a plugin's `activate()` throws so
// one bad plugin does not take down the boot, and `withSpan` records it on the
// `plugin.activate` span on the way past. Both catches rendered the value with
// the bare `err instanceof Error ? err.message : String(err)` idiom, and both
// reads of it are the plugin's to answer: `message` and `stack` are own
// accessors a genuine `Error` can have redefined, `hypErrorKind` is an
// ordinary property read, and `instanceof` walks `[[GetPrototypeOf]]`, a
// `Proxy` trap.
//
// So a two-step payload escaped outright: `instanceof Error` said yes, and the
// read that followed threw out of the catch that was recording the failure,
// out of `withSpan`, and out of `activatePlugins` itself - the kernel boot
// lost to the plugin it was booting. Every hostile case below rejected the
// `activatePlugins` call before the fix.
//
// The whole point is the real path: these drive `activatePlugins` on a real
// on-disk plugin whose real `activate()` throws, through the real `withSpan`,
// with a real tracer provider installed so the span the helper recorded can be
// read back.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { TracerProvider } from '../../src/core/observability/runtime.js'
import { activatePlugins } from '../../src/core/runtime/loader.js'

const PLUGIN_NAME = '@acme/hostile'

/**
 * Activate one throwaway plugin whose `activate()` body is `body`, and return
 * what the loader reported beside the `plugin.activate` span `withSpan` ended.
 *
 * A fresh directory per call: the loader imports the entrypoint by URL and
 * `import()` caches on that, so two bodies at one path would be one body.
 *
 * @param {string} body
 */
async function activateThrowing(body) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-plugin-'))
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-state-'))
  await fs.writeFile(path.join(rootDir, 'index.js'), `export async function activate() { ${body} }\n`)
  const manifest = /** @type {any} */ ({
    schema_version: 1,
    name: PLUGIN_NAME,
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  })
  /** @type {any[]} */
  const spans = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch(/** @type {any[]} */ batch) { spans.push(...batch) } }],
  })
  provider.register()
  try {
    const { results } = await activatePlugins({
      plugins: [{ manifest, rootDir, config: {} }],
      stateRoot,
      runId: 'hostile-activation',
      tmpRoot: stateRoot,
    })
    assert.equal(results.length, 1)
    const span = spans.find((s) => s.name === 'plugin.activate')
    assert.ok(span, 'the activation span was never ended')
    return { result: /** @type {any} */ (results[0]), span }
  } finally {
    await provider.shutdown()
    await fs.rm(rootDir, { recursive: true, force: true })
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
}

// [body, expected message]. The two the issue names, plus the third read on
// the same line: a value whose `hypErrorKind` throws rather than its `message`.
const HOSTILE = /** @type {[string, string, string][]} */ ([
  [
    'an Error whose message getter throws an object with no prototype',
    `const e = new Error('unreadable message')
     Object.defineProperty(e, 'message', { get() { throw Object.create(null) } })
     throw e`,
    // Nothing can read it, and saying so is the whole of what is left to say.
    'a value that cannot be described',
  ],
  [
    'an Error whose stack getter throws a revoked Proxy',
    `const r = Proxy.revocable({}, {}); r.revoke()
     const e = new Error('unreadable stack')
     Object.defineProperty(e, 'stack', { get() { throw r.proxy } })
     throw e`,
    // `message` is still readable here, so the report is the real one; only
    // the span's exception event, which wants the stack, is lost.
    'unreadable stack',
  ],
  [
    'a Proxy over an Error whose error-kind read throws',
    `const e = new Error('unreadable kind')
     throw new Proxy(e, {
       get(target, prop, recv) {
         if (prop === 'hypErrorKind') throw new Error('kind trap')
         return Reflect.get(target, prop, recv)
       },
     })`,
    'unreadable kind',
  ],
])

for (const [label, body, expected] of HOSTILE) {
  test(`activate that throws ${label} is reported, not rethrown`, async () => {
    const { result, span } = await activateThrowing(body)
    assert.equal(result.ok, false)
    assert.equal(result.plugin.name, PLUGIN_NAME)
    assert.equal(result.errorKind, 'activate_failed')
    assert.equal(result.message, expected)
    // The span the helper recorded says the same thing the loader reported.
    assert.equal(span.status.code, 2)
    assert.equal(span.status.message, expected)
    assert.equal(span.attributes.error_kind, 'unhandled_exception')
  })
}

// These two never escaped, and only by accident: `instanceof` walks
// `[[GetPrototypeOf]]`, so the type test threw first, inside `withSpan`, and
// handed the loader a real `TypeError` to report instead. The accident is not
// the guarantee - the first attempt at the same defect on the doctor path
// (hyparam/hypaware#1558) passed every check written for it and still failed,
// because `instanceof` had been left outside the guard - so the type test that
// decides what to rethrow is pinned here too, by values that trap it.
const TRAPPED_TYPE_TEST = /** @type {[string, string, string][]} */ ([
  [
    'a revoked Proxy',
    `const r = Proxy.revocable({}, {}); r.revoke(); throw r.proxy`,
    'a value that cannot be described',
  ],
  [
    'a Proxy over an Error whose getPrototypeOf trap throws',
    `throw new Proxy(new Error('trapped prototype'), { getPrototypeOf() { throw new Error('gpo trap') } })`,
    // The type test is lost, but the coercion still renders a genuine `Error`.
    'Error: trapped prototype',
  ],
])

for (const [label, body, expected] of TRAPPED_TYPE_TEST) {
  test(`activate that throws ${label} is reported, not rethrown`, async () => {
    const { result, span } = await activateThrowing(body)
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'activate_failed')
    assert.equal(result.message, expected)
    assert.equal(span.status.code, 2)
    assert.equal(span.status.message, expected)
  })
}

// The other half of the acceptance: containment that changed what an ordinary
// failure reports would be a worse bug than the one it fixed, because every
// real activation failure is one of these.
const ORDINARY = /** @type {[string, string, string][]} */ ([
  ['an Error', `throw new Error('ordinary boom')`, 'ordinary boom'],
  ['a string', `throw 'just a string'`, 'just a string'],
])

for (const [label, body, expected] of ORDINARY) {
  test(`activate that throws ${label} reports and records exactly what it did before`, async () => {
    const { result, span } = await activateThrowing(body)
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'activate_failed')
    assert.equal(result.message, expected)
    assert.equal(span.status.code, 2)
    assert.equal(span.status.message, expected)
    assert.equal(span.attributes.error_kind, 'unhandled_exception')
    // A readable value still gets its exception event, with the stack on it.
    const events = span.events.filter((/** @type {any} */ e) => e.name === 'exception')
    assert.equal(events.length, 1)
    assert.equal(events[0].attributes['exception.message'], expected)
  })
}

// The kind a plugin sets is still the kind reported: the guarded read returns
// the value, it does not flatten every failure to the default.
test('a thrown activation error keeps the error_kind it carries', async () => {
  const { result } = await activateThrowing(
    `const e = new Error('kinded'); e.hypErrorKind = 'acme_specific'; throw e`
  )
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'acme_specific')
  assert.equal(result.message, 'kinded')
})

// The loader's own thrown error, from the same catch, on the same path.
test('a plugin with no activate() export is still reported as activate_missing', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-plugin-'))
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-state-'))
  try {
    await fs.writeFile(path.join(rootDir, 'index.js'), 'export const nothing = 1\n')
    const manifest = /** @type {any} */ ({
      schema_version: 1,
      name: PLUGIN_NAME,
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    })
    const { results } = await activatePlugins({
      plugins: [{ manifest, rootDir, config: {} }],
      stateRoot,
      runId: 'hostile-activation',
      tmpRoot: stateRoot,
    })
    assert.equal(results[0].ok, false)
    assert.equal(/** @type {any} */ (results[0]).errorKind, 'activate_missing')
    assert.match(/** @type {any} */ (results[0]).message, /does not export activate\(\)/)
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true })
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
