// @ts-check

/**
 * The `claude_telemetry_events` dataset: the row split (behavioral
 * events in, content and body events out; hot fields typed, the rest in
 * the attributes JSON), the metrics decoder that feeds it, and the
 * registration's cache roundtrip.
 *
 * @ref LLP 0255#row-shape [tests]: one row per event, typed hot fields,
 *   no attribute dropped
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import {
  flattenClaudeTelemetryMetrics,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/events.js'
import {
  CLAUDE_TELEMETRY_EVENT_COLUMNS,
  TELEMETRY_EVENTS_DATASET,
  claudeTelemetryDatasetRegistration,
  claudeTelemetryEventRows,
  claudeTelemetryTablePath,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/events_dataset.js'

/**
 * @import { ClaudeTelemetryEvent } from '../../hypaware-core/plugins-workspace/claude/src/types.js'
 */

const SESSION = 'e53c128d-9f45-470f-86f1-d5b5f3766708'

/**
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @returns {ClaudeTelemetryEvent}
 */
function event(name, attrs = {}) {
  return {
    name,
    timestamp: '2026-08-17T19:30:20.000Z',
    attributes: {
      'event.name': name,
      'event.timestamp': '2026-08-17T19:30:20.000Z',
      'session.id': SESSION,
      'app.version': '2.1.233',
      ...attrs,
    },
  }
}

// ---------------------------------------------------------------------
// claudeTelemetryEventRows: the behavioral/content split and the row shape
// ---------------------------------------------------------------------

test('content and body-pointer events yield no behavioral rows', () => {
  const rows = claudeTelemetryEventRows([
    event('user_prompt', { prompt: 'secret prompt text', 'message.uuid': 'u-1' }),
    event('assistant_response', { response: 'secret response', 'message.uuid': 'u-2' }),
    event('api_request_body', { body_ref: '/tmp/spool/req.json' }),
    event('api_response_body', { body_ref: '/tmp/spool/resp.json' }),
  ])
  assert.deepEqual(rows, [])
})

test('a tool_decision event becomes one row with the hot fields typed and lifted out of the JSON', () => {
  const rows = claudeTelemetryEventRows([
    event('tool_decision', {
      tool_name: 'Read',
      decision: 'reject',
      source: 'user_reject',
      language: 'javascript',
    }),
  ])
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.event_name, 'tool_decision')
  assert.equal(row.event_timestamp, '2026-08-17T19:30:20.000Z')
  assert.equal(row.session_id, SESSION)
  assert.equal(row.tool_name, 'Read')
  assert.equal(row.decision, 'reject')
  assert.equal(row.source, 'user_reject')
  assert.equal(row.cost_usd, null)
  const attrs = /** @type {Record<string, unknown>} */ (row.attributes)
  // Promoted keys and the event.name/event.timestamp identity leave the
  // JSON; everything else stays.
  assert.equal(attrs['session.id'], undefined)
  assert.equal(attrs.tool_name, undefined)
  assert.equal(attrs.decision, undefined)
  assert.equal(attrs.source, undefined)
  assert.equal(attrs['event.name'], undefined)
  assert.equal(attrs['event.timestamp'], undefined)
  assert.equal(attrs.language, 'javascript')
  assert.equal(attrs['app.version'], '2.1.233')
})

test('cost_usd is typed from the string-typed numeric Claude Code sends', () => {
  const rows = claudeTelemetryEventRows([
    event('api_request', { cost_usd: '0.0047732', input_tokens: 73, request_id: 'req_1' }),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].cost_usd, 0.0047732)
  const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes)
  assert.equal(attrs.cost_usd, undefined)
  assert.equal(attrs.input_tokens, 73)
  assert.equal(attrs.request_id, 'req_1')
})

test('an unrecognized event name is recorded with its attributes, not discarded', () => {
  // @ref LLP 0257#failure-modes [tests]: unknown names keep their attributes
  const rows = claudeTelemetryEventRows([
    event('brand_new_event', { detail: 'something upstream added' }),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event_name, 'brand_new_event')
  const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes)
  assert.equal(attrs.detail, 'something upstream added')
})

test('a hot key whose value does not fit its typed column stays in the JSON instead of vanishing', () => {
  const rows = claudeTelemetryEventRows([
    event('tool_decision', { tool_name: 'Read', decision: 42 }),
  ])
  assert.equal(rows[0].decision, null)
  const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes)
  assert.equal(attrs.decision, 42)
})

test('an event with no session id and no timestamp still lands, with nulls', () => {
  const rows = claudeTelemetryEventRows([
    { name: 'mcp_server_connection', attributes: { server_name: 'some-mcp', status: 'connected' } },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].session_id, null)
  assert.equal(rows[0].event_timestamp, null)
  const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes)
  assert.equal(attrs.server_name, 'some-mcp')
})

// ---------------------------------------------------------------------
// flattenClaudeTelemetryMetrics: data points become events
// ---------------------------------------------------------------------

/** @param {Record<string, unknown>} attrs */
function kv(attrs) {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key, value: { intValue: value } }
        : { key, value: { doubleValue: value } }
    }
    if (typeof value === 'boolean') return { key, value: { boolValue: value } }
    return { key, value: { stringValue: String(value) } }
  })
}

const NANOS = String(BigInt(Date.parse('2026-08-17T19:31:00.000Z')) * 1_000_000n)

/**
 * @param {Record<string, unknown>[]} metrics
 * @param {Record<string, unknown>} [resourceAttrs]
 */
function metricsEnvelope(metrics, resourceAttrs = { 'service.name': 'claude-code' }) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: kv(resourceAttrs) },
        scopeMetrics: [
          { scope: { name: 'com.anthropic.claude_code', version: '2.1.233' }, metrics },
        ],
      },
    ],
  }
}

test('a sum data point becomes one event named by the metric, with value and unit joined', () => {
  const events = flattenClaudeTelemetryMetrics(metricsEnvelope([
    {
      name: 'claude_code.cost.usage',
      unit: 'USD',
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          { attributes: kv({ 'session.id': SESSION, model: 'claude-haiku-4-5-20251001' }), timeUnixNano: NANOS, asDouble: 0.0047732 },
        ],
      },
    },
  ]))
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'claude_code.cost.usage')
  assert.equal(events[0].timestamp, '2026-08-17T19:31:00.000Z')
  assert.equal(events[0].attributes['session.id'], SESSION)
  assert.equal(events[0].attributes.value, 0.0047732)
  assert.equal(events[0].attributes.unit, 'USD')
  assert.equal(events[0].attributes.model, 'claude-haiku-4-5-20251001')
})

test('an int64 value rendered as a string on the wire keeps numeric identity', () => {
  const events = flattenClaudeTelemetryMetrics(metricsEnvelope([
    {
      name: 'claude_code.lines_of_code.count',
      sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [
        { attributes: kv({ 'session.id': SESSION, type: 'added' }), timeUnixNano: NANOS, asInt: '42' },
      ] },
    },
  ]))
  assert.equal(events.length, 1)
  assert.equal(events[0].attributes.value, 42)
  assert.equal(events[0].attributes.unit, undefined)
})

test('a gauge aggregation is read the same way a sum is', () => {
  const events = flattenClaudeTelemetryMetrics(metricsEnvelope([
    {
      name: 'claude_code.active_time.total',
      unit: 's',
      gauge: { dataPoints: [
        { attributes: kv({ 'session.id': SESSION }), timeUnixNano: NANOS, asDouble: 12.5 },
      ] },
    },
  ]))
  assert.equal(events.length, 1)
  assert.equal(events[0].attributes.value, 12.5)
})

test('metrics outside the claude scope and self-marked resources contribute nothing', () => {
  const foreignScope = {
    resourceMetrics: [
      {
        resource: { attributes: kv({ 'service.name': 'someone-else' }) },
        scopeMetrics: [
          { scope: { name: 'io.other.meter' }, metrics: [
            { name: 'other.count', sum: { dataPoints: [{ attributes: [], timeUnixNano: NANOS, asInt: '1' }] } },
          ] },
        ],
      },
    ],
  }
  assert.deepEqual(flattenClaudeTelemetryMetrics(foreignScope), [])

  const selfMarked = metricsEnvelope(
    [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ attributes: [], timeUnixNano: NANOS, asDouble: 1 }] } }],
    { 'service.name': 'hypaware', 'hypaware.self': true }
  )
  assert.deepEqual(flattenClaudeTelemetryMetrics(selfMarked), [])
})

test('a malformed metrics envelope never throws', () => {
  assert.deepEqual(flattenClaudeTelemetryMetrics(null), [])
  assert.deepEqual(flattenClaudeTelemetryMetrics('nope'), [])
  assert.deepEqual(flattenClaudeTelemetryMetrics({ resourceMetrics: [null, { scopeMetrics: [{ scope: {}, metrics: [{}] }] }] }), [])
})

// ---------------------------------------------------------------------
// The registration and its cache roundtrip
// ---------------------------------------------------------------------

test('the registration names the dataset, its owner, its signal, and its timestamp column', () => {
  const registration = claudeTelemetryDatasetRegistration()
  assert.equal(registration.name, 'claude_telemetry_events')
  assert.equal(registration.plugin, '@hypaware/claude')
  assert.equal(registration.sourceSignal, 'claude_telemetry')
  assert.equal(registration.primaryTimestampColumn, 'event_timestamp')
  assert.equal(registration.localOnlyContentColumns, undefined)
  assert.deepEqual(
    registration.schema.columns.map((c) => c.name),
    ['event_name', 'event_timestamp', 'session_id', 'tool_name', 'decision', 'source', 'cost_usd', 'cwd', 'attributes']
  )
})

test('rows written through storage flush, discover, and read back through the registration', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-events-'))
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const rows = claudeTelemetryEventRows([
      event('tool_decision', { tool_name: 'Read', decision: 'accept', source: 'config' }),
      event('permission_mode_changed', { from_mode: 'default', to_mode: 'acceptEdits' }),
    ])
    const tablePath = claudeTelemetryTablePath(storage)
    await storage.appendRows(tablePath, [...CLAUDE_TELEMETRY_EVENT_COLUMNS], rows)
    await storage.flushTable(tablePath, { force: true })

    const registration = claudeTelemetryDatasetRegistration()
    const partitions = await registration.discoverPartitions(
      /** @type {any} */ ({ config: { version: 2, plugins: [] }, scope: {}, cacheDir: cacheRoot })
    )
    assert.ok(partitions.length >= 2, 'spool partition plus the flushed source partition')
    assert.equal(partitions[0].tablePath, path.join(cacheRoot, 'datasets', TELEMETRY_EVENTS_DATASET, 'all'))

    const source = await registration.createDataSource(partitions, /** @type {any} */ ({ scope: {}, storage }))
    /** @type {Record<string, unknown>[]} */
    const seen = []
    for await (const row of source.scan({}).rows()) {
      if (/** @type {any} */ (row).resolved) seen.push(/** @type {any} */ (row).resolved)
    }
    assert.equal(seen.length, 2)
    const names = seen.map((r) => r.event_name).sort()
    assert.deepEqual(names, ['permission_mode_changed', 'tool_decision'])
    const decision = seen.find((r) => r.event_name === 'tool_decision')
    assert.ok(decision)
    assert.equal(decision.decision, 'accept')
    assert.equal(decision.source, 'config')
    assert.equal(decision.session_id, SESSION)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
