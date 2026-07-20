// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { compileConfig, FALLBACK_LISTEN } from '../../hypaware-core/plugins-workspace/ai-gateway/src/config.js'
import { bindProxyWithFallback } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'

/** A log stub capturing warn() calls. */
function captureLog() {
  /** @type {{ message: string, fields: Record<string, unknown> | undefined }[]} */
  const warns = []
  return {
    warns,
    warn(/** @type {string} */ message, /** @type {Record<string, unknown> | undefined} */ fields) {
      warns.push({ message, fields })
    },
  }
}

/** @param {string | undefined} code */
function bindError(code) {
  const err = /** @type {NodeJS.ErrnoException} */ (new Error(`bind failed (${code ?? 'no code'})`))
  if (code) err.code = code
  return err
}

// ---------------------------------------------------------------------------
// @ref LLP 0114#fixed-default-port [tests]: the default listen is the fixed
// well-known port and is distinguishable from a configured one.

test('compileConfig defaults listen to the fixed well-known port', () => {
  const config = compileConfig({ upstreams: [] })
  assert.equal(config.listen, '127.0.0.1:18521')
  assert.equal(config.listenConfigured, false)
})

test('compileConfig marks an explicit listen as configured', () => {
  const config = compileConfig({ listen: '127.0.0.1:9999', upstreams: [] })
  assert.equal(config.listen, '127.0.0.1:9999')
  assert.equal(config.listenConfigured, true)
})

// ---------------------------------------------------------------------------
// @ref LLP 0114#ephemeral-fallback [tests]: default-only fallback on
// EADDRINUSE; everything else propagates.

test('a defaulted listen falls back to an ephemeral bind on EADDRINUSE', async () => {
  const config = compileConfig({ upstreams: [] })
  const log = captureLog()
  /** @type {string[]} */
  const attempts = []
  let fallbacks = 0
  const proxy = await bindProxyWithFallback({
    config,
    log,
    onFallback: () => { fallbacks += 1 },
    bind: async (listen) => {
      attempts.push(listen)
      if (listen === config.listen) throw bindError('EADDRINUSE')
      return /** @type {any} */ ({ host: '127.0.0.1', port: 54321, stop: async () => {} })
    },
  })
  assert.deepEqual(attempts, [config.listen, FALLBACK_LISTEN])
  assert.equal(proxy.port, 54321)
  assert.equal(log.warns.length, 1)
  assert.equal(log.warns[0].message, 'aigw.default_port_taken')
  // @ref LLP 0114#fallback-is-visible [tests]: the fallback path signals the
  // caller so the steady status surface can record it.
  assert.equal(fallbacks, 1)
})

test('a clean default bind never signals fallback', async () => {
  const config = compileConfig({ upstreams: [] })
  const log = captureLog()
  let fallbacks = 0
  await bindProxyWithFallback({
    config,
    log,
    onFallback: () => { fallbacks += 1 },
    bind: async () => /** @type {any} */ ({ host: '127.0.0.1', port: 18521, stop: async () => {} }),
  })
  assert.equal(fallbacks, 0)
  assert.equal(log.warns.length, 0)
})

// @ref LLP 0114#explicit-listen-fails-loudly [tests]: a configured listen
// never rebinds elsewhere.
test('a configured listen propagates EADDRINUSE instead of falling back', async () => {
  const config = compileConfig({ listen: '127.0.0.1:9999', upstreams: [] })
  const log = captureLog()
  await assert.rejects(
    bindProxyWithFallback({
      config,
      log,
      bind: async () => { throw bindError('EADDRINUSE') },
    }),
    /EADDRINUSE/
  )
  assert.equal(log.warns.length, 0)
})

test('a defaulted listen propagates non-EADDRINUSE bind errors', async () => {
  const config = compileConfig({ upstreams: [] })
  const log = captureLog()
  await assert.rejects(
    bindProxyWithFallback({
      config,
      log,
      bind: async () => { throw bindError('EACCES') },
    }),
    /EACCES/
  )
  assert.equal(log.warns.length, 0)
})
