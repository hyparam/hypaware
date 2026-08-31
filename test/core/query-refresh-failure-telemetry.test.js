// @ts-check

/**
 * LLP 0333 made `hyp query refresh` attempt every table and report every
 * error instead of aborting at the first throw. Catching those throws is
 * what buys the completeness, and it costs two signals unless they are put
 * back deliberately:
 *
 * - the dispatcher's generic catch is what tags `command.run` with
 *   `error_kind`, and a command that returns 1 never reaches it, so a failed
 *   refresh's root span carried only a nonzero `exit_code` with nothing
 *   naming the broken step. LLP 0021 owes a handled failure its `error_kind`
 *   just the same, and `hyp privacy` already carries its own kind for
 *   exactly this reason (issue #413).
 * - the guarded `discoverPartitions` / `refreshPartition` calls had no span
 *   of their own, so unlike the forced `flushTable` sitting between them,
 *   a throw from either reached the trace nowhere at all. No in-repo dataset
 *   can throw from either call, so the only caller that can is a
 *   third-party plugin: the one case whose failure cannot be read out of
 *   this repo's source.
 *
 * Asserted on captured spans, because prose about telemetry proves nothing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TracerProvider } from '../../src/core/observability/runtime.js'
import { runRoot } from '../../src/core/observability/index.js'
import { runQueryRefresh } from '../../src/core/commands/query.js'

const FLUSH_ERROR =
  'cache-iceberg: partition field "session_id" is new - adding a partition field is spec evolution and requires an explicit migration'

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A refresh ctx over two datasets, `alpha` then `beta`. Each hook can be
 * made to throw for one named dataset, so a test picks which of the three
 * calls in the loop body fails.
 *
 * @param {{ failingFlush?: string, throwingDiscover?: string, throwingRefresh?: string }} [opts]
 */
function refreshCtx(opts = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {string[]} */
  const flushed = []
  /** @param {string} name */
  const dataset = (name) => ({
    name,
    discoverPartitions: async () => {
      if (opts.throwingDiscover === name) throw new Error(`plugin discover blew up in ${name}`)
      return [
        { dataset: name, partition: { source: 'claude' }, tablePath: `/cache/datasets/${name}/source=claude` },
      ]
    },
    refreshPartition: async () => {
      if (opts.throwingRefresh === name) throw new Error(`plugin refresh blew up in ${name}`)
      return { status: 'skipped', rows: 0 }
    },
  })
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    config: {},
    query: { listDatasets: () => ['alpha', 'beta'].map(dataset) },
    storage: {
      cacheRoot: '/cache',
      /** @param {string} tablePath */
      flushTable: async (tablePath) => {
        flushed.push(tablePath)
        if (opts.failingFlush && tablePath.includes(`/${opts.failingFlush}/`)) {
          throw new Error(`${FLUSH_ERROR} [${tablePath}]`)
        }
        return { flushed: true }
      },
    },
  })
  return { ctx, stdout, stderr, flushed }
}

/**
 * Run a refresh under a captured root `command.run` span, the way the
 * dispatcher runs every command.
 *
 * @param {any} ctx
 */
async function refreshUnderCommandSpan(ctx) {
  /** @type {any[]} */
  const captured = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch(spans) { captured.push(...spans) } }],
  })
  provider.register()
  let code = -1
  try {
    await runRoot('command.run', { hyp_command: 'query refresh', status: 'ok' }, async () => {
      code = await runQueryRefresh([], ctx)
    })
  } finally {
    await provider.shutdown()
  }
  return { code, captured }
}

/** @param {any[]} captured @param {string} name */
function spanNamed(captured, name) {
  return captured.find((span) => span.name === name)
}

test('a failed refresh names the broken step on its command span, not just a nonzero exit', async () => {
  // @ref LLP 0021#the-attribute-contract [tests]: a handled failure still owes its span an `error_kind`
  const { ctx, stdout, stderr } = refreshCtx({ failingFlush: 'alpha' })

  const { code, captured } = await refreshUnderCommandSpan(ctx)

  const command = spanNamed(captured, 'command.run')
  assert.ok(command, 'command.run span emitted')
  assert.equal(command.attributes.error_kind, 'refresh_failed', 'the root span names the failure')
  assert.equal(command.attributes.refresh_failure_count, 1)
  assert.match(
    String(command.attributes.refresh_first_failure),
    /^alpha\/source=claude: cache-iceberg: partition field "session_id" is new/,
    'the root span carries a cause, not only a count'
  )
  // Restating one of N causes as a root exception would name a single cause
  // as if it were the failure; each cause is already an exception event on
  // its own child span in this trace.
  assert.deepEqual(command.events, [], 'no exception is fabricated on the root span')

  // The operator-visible surface LLP 0333 settled is untouched.
  assert.equal(code, 1)
  assert.match(stderr.text(), /hyp query refresh: alpha\/source=claude: cache-iceberg: partition field "session_id" is new/)
  assert.match(stdout.text(), /refreshed 2 dataset\(s\), wrote 0 row\(s\), 1 refresh failure\(s\)\n/)
})

test('a clean refresh leaves the command span unmarked', async () => {
  const { ctx, stdout } = refreshCtx()

  const { code, captured } = await refreshUnderCommandSpan(ctx)

  const command = spanNamed(captured, 'command.run')
  assert.ok(command)
  assert.equal(command.attributes.error_kind, undefined, 'a clean run is not tagged as failed')
  assert.equal(command.attributes.refresh_failure_count, undefined)
  assert.equal(code, 0)
  assert.match(stdout.text(), /refreshed 2 dataset\(s\), wrote 0 row\(s\)\n/)
})

test('a plugin refreshPartition throw lands on a span of its own, in the command trace', async () => {
  // @ref LLP 0021#span-helpers [tests]: the guarded plugin call reaches the trace the way `flushTable` does
  const { ctx, stderr, flushed } = refreshCtx({ throwingRefresh: 'alpha' })

  const { code, captured } = await refreshUnderCommandSpan(ctx)

  const command = spanNamed(captured, 'command.run')
  const refreshSpans = captured.filter((span) => span.name === 'dataset.refresh_partition')
  assert.equal(refreshSpans.length, 2, 'one span per attempted partition')
  const failed = refreshSpans.find((span) => span.attributes.hyp_dataset === 'alpha')
  assert.ok(failed, 'the throwing dataset got a span')
  assert.equal(failed.status.code, 2, 'the span ends ERROR')
  assert.equal(failed.attributes.error_kind, 'unhandled_exception')
  const exception = failed.events.find((/** @type {any} */ event) => event.name === 'exception')
  assert.ok(exception, 'the plugin throw is recorded as an exception event')
  assert.equal(exception.attributes['exception.message'], 'plugin refresh blew up in alpha')
  assert.equal(failed.spanContext().traceId, command.spanContext().traceId, 'same trace as the command')

  // The healthy dataset behind the throwing one still gets its forced flush
  // (LLP 0333), and the operator surface is unchanged.
  assert.deepEqual(flushed, ['/cache/datasets/beta/source=claude'])
  assert.equal(code, 1)
  assert.match(stderr.text(), /hyp query refresh: alpha\/source=claude: plugin refresh blew up in alpha\n/)
  assert.equal(command.attributes.error_kind, 'refresh_failed')
})

test('a plugin discoverPartitions throw lands on a span of its own too', async () => {
  // @ref LLP 0021#span-helpers [tests]: discovery is guarded the same way, so it is spanned the same way
  const { ctx, stderr, flushed } = refreshCtx({ throwingDiscover: 'alpha' })

  const { code, captured } = await refreshUnderCommandSpan(ctx)

  const discoverSpans = captured.filter((span) => span.name === 'dataset.discover_partitions')
  assert.equal(discoverSpans.length, 2, 'one span per dataset, throwing or not')
  const failed = discoverSpans.find((span) => span.attributes.hyp_dataset === 'alpha')
  assert.ok(failed, 'the throwing dataset got a span')
  assert.equal(failed.status.code, 2)
  assert.equal(failed.attributes.error_kind, 'unhandled_exception')
  const exception = failed.events.find((/** @type {any} */ event) => event.name === 'exception')
  assert.ok(exception)
  assert.equal(exception.attributes['exception.message'], 'plugin discover blew up in alpha')

  assert.deepEqual(flushed, ['/cache/datasets/beta/source=claude'])
  assert.equal(code, 1)
  assert.match(stderr.text(), /hyp query refresh: alpha: plugin discover blew up in alpha\n/)
})
