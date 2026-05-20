import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Collector } from '../src/index.js'
import { bytesField, fixed64Field, lenDelim, stringField, u8 } from './helpers.js'

const TEST_GATEWAY_ID = 'tester'

/** @type {Collector} */
let collector
/** @type {string} */
let outputDir
/** @type {string} */
let baseUrl

beforeEach(async () => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-'))
  collector = new Collector({ port: 0, outputDir, gatewayId: TEST_GATEWAY_ID })
  await collector.start()
  const addr = collector.server?.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await collector.stop()
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * Read the raw OTLP envelopes the Collector wrote under
 * `<outputDir>/<id>/raw/<signal>/<UTC-date>.jsonl`. One envelope per line.
 *
 * @param {string} signal
 * @returns {unknown[]}
 */
function readLines(signal) {
  const file = path.join(outputDir, TEST_GATEWAY_ID, 'raw', signal, `${new Date().toISOString().slice(0, 10)}.jsonl`)
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return []
  return text.split('\n').map((line) => JSON.parse(line))
}

/**
 * Read normalized per-record rows from
 * `<outputDir>/<id>/<signal>/<UTC-date>.jsonl` and return only the rows whose
 * `serviceName` matches. Replaces the legacy per-service file split.
 *
 * @param {string} serviceName
 * @param {string} signal
 * @returns {Record<string, unknown>[]}
 */
function readServiceLines(serviceName, signal) {
  const file = path.join(outputDir, TEST_GATEWAY_ID, signal, `${new Date().toISOString().slice(0, 10)}.jsonl`)
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return []
  return text
    .split('\n')
    .map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line)))
    .filter((row) => row.serviceName === serviceName)
}

/**
 * @param {number | bigint} value
 * @returns {Buffer}
 */
function encodeVarint(value) {
  let remaining = BigInt(value)
  /** @type {number[]} */
  const bytes = []
  while (remaining >= 0x80n) {
    bytes.push(Number(remaining & 0x7fn | 0x80n))
    remaining >>= 7n
  }
  bytes.push(Number(remaining))
  return Buffer.from(bytes)
}

/**
 * @param {number} fieldNumber
 * @param {number} wireType
 * @returns {Buffer}
 */
function encodeTag(fieldNumber, wireType) {
  return encodeVarint(fieldNumber << 3 | wireType)
}

/**
 * @param {number} fieldNumber
 * @param {string} value
 * @returns {Buffer}
 */
function encodeString(fieldNumber, value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(bytes.length), bytes])
}

/**
 * @param {number} fieldNumber
 * @param {number | bigint} value
 * @returns {Buffer}
 */
function encodeUint(fieldNumber, value) {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)])
}

/**
 * @param {number} fieldNumber
 * @param {number} value
 * @returns {Buffer}
 */
function encodeFixed32(fieldNumber, value) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return Buffer.concat([encodeTag(fieldNumber, 5), bytes])
}

/**
 * @param {number} fieldNumber
 * @param {number | bigint | string} value
 * @returns {Buffer}
 */
function encodeFixed64(fieldNumber, value) {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(BigInt(value))
  return Buffer.concat([encodeTag(fieldNumber, 1), bytes])
}

/**
 * @param {number} fieldNumber
 * @param {number} value
 * @returns {Buffer}
 */
function encodeDouble(fieldNumber, value) {
  const bytes = Buffer.alloc(8)
  bytes.writeDoubleLE(value)
  return Buffer.concat([encodeTag(fieldNumber, 1), bytes])
}

/**
 * @param {number} fieldNumber
 * @param {Buffer} value
 * @returns {Buffer}
 */
function encodeBytes(fieldNumber, value) {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(value.length), value])
}

/**
 * @param {number} fieldNumber
 * @param {Buffer} message
 * @returns {Buffer}
 */
function encodeMessage(fieldNumber, message) {
  return encodeBytes(fieldNumber, message)
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {Buffer}
 */
function encodeStringKeyValue(key, value) {
  const anyValue = encodeString(1, value)
  return Buffer.concat([encodeString(1, key), encodeMessage(2, anyValue)])
}

/**
 * @returns {Buffer}
 */
function buildLogProtobufPayload() {
  const resource = Buffer.concat([
    encodeMessage(1, encodeStringKeyValue('service.name', 'svc-pb')),
    encodeMessage(1, encodeStringKeyValue('service.version', '0.1.0')),
  ])

  const scope = Buffer.concat([
    encodeString(1, 'gascity'),
    encodeString(2, '1.2.3'),
  ])

  const logRecord = Buffer.concat([
    encodeFixed64(1, '1776886719688000000'),
    encodeUint(2, 9),
    encodeString(3, 'INFO'),
    encodeMessage(5, encodeString(1, 'protobuf hello')),
    encodeMessage(6, encodeStringKeyValue('gc.agent', 'mayor')),
    encodeFixed32(8, 1),
    encodeBytes(9, Buffer.from('00112233445566778899aabbccddeeff', 'hex')),
    encodeBytes(10, Buffer.from('1122334455667788', 'hex')),
    encodeFixed64(11, '1776886719689000000'),
  ])

  const scopeLogs = Buffer.concat([
    encodeMessage(1, scope),
    encodeMessage(2, logRecord),
  ])

  const resourceLogs = Buffer.concat([
    encodeMessage(1, resource),
    encodeMessage(2, scopeLogs),
  ])

  return encodeMessage(1, resourceLogs)
}

/**
 * @returns {Buffer}
 */
function buildTraceProtobufPayload() {
  const resource = Buffer.concat([
    encodeMessage(1, encodeStringKeyValue('service.name', 'svc-trace-pb')),
  ])

  const scope = Buffer.concat([
    encodeString(1, 'gascity.trace'),
    encodeString(2, '2.0.0'),
  ])

  const span = Buffer.concat([
    encodeBytes(1, Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'hex')),
    encodeBytes(2, Buffer.from('bbbbbbbbbbbbbbbb', 'hex')),
    encodeBytes(4, Buffer.from('cccccccccccccccc', 'hex')),
    encodeString(5, 'protobuf span'),
    encodeUint(6, 2),
    encodeFixed64(7, '1776886719688000000'),
    encodeFixed64(8, '1776886719689000000'),
    encodeMessage(9, encodeStringKeyValue('http.method', 'GET')),
    encodeMessage(15, Buffer.concat([
      encodeString(2, 'ok'),
      encodeUint(3, 1),
    ])),
    encodeFixed32(16, 1),
  ])

  const scopeSpans = Buffer.concat([
    encodeMessage(1, scope),
    encodeMessage(2, span),
  ])

  const resourceSpans = Buffer.concat([
    encodeMessage(1, resource),
    encodeMessage(2, scopeSpans),
  ])

  return encodeMessage(1, resourceSpans)
}

/**
 * @returns {Buffer}
 */
function buildMetricProtobufPayload() {
  const resource = Buffer.concat([
    encodeMessage(1, encodeStringKeyValue('service.name', 'svc-metric-pb')),
  ])

  const scope = Buffer.concat([
    encodeString(1, 'gascity.metric'),
    encodeString(2, '3.0.0'),
  ])

  const dataPoint = Buffer.concat([
    encodeFixed64(2, '1776886719688000000'),
    encodeFixed64(3, '1776886719689000000'),
    encodeDouble(4, 12.5),
    encodeMessage(7, encodeStringKeyValue('route', '/health')),
  ])

  const gauge = encodeMessage(1, dataPoint)
  const metric = Buffer.concat([
    encodeString(1, 'rpc.duration'),
    encodeString(2, 'protobuf gauge'),
    encodeString(3, 'ms'),
    encodeMessage(5, gauge),
  ])

  const scopeMetrics = Buffer.concat([
    encodeMessage(1, scope),
    encodeMessage(2, metric),
  ])

  const resourceMetrics = Buffer.concat([
    encodeMessage(1, resource),
    encodeMessage(2, scopeMetrics),
  ])

  return encodeMessage(1, resourceMetrics)
}

describe('OTLP endpoints', () => {
  it.each(['traces', 'metrics', 'logs'])('accepts POST /v1/%s', async (signal) => {
    const res = await fetch(`${baseUrl}/v1/${signal}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: signal }),
    })
    expect(res.status).toBe(200)
    expect(readLines(signal)).toEqual([{ hello: signal }])
  })

  it('rejects non-POST methods', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`)
    expect(res.status).toBe(405)
  })

  it('returns an ASCII banner on GET /', async () => {
    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    const body = await res.text()
    expect(body).toContain('npx collectivus')
  })

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/v1/unknown`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('appends multiple payloads as separate lines', async () => {
    const headers = { 'Content-Type': 'application/json' }
    await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST', headers, body: JSON.stringify({ n: 1 }),
    })
    await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST', headers, body: JSON.stringify({ n: 2 }),
    })
    expect(readLines('logs')).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('writes normalized one-row-per-log-record files partitioned by service.name', async () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'test.scope', version: '1.2.3' },
              logRecords: [
                {
                  timeUnixNano: '1776886719688000000',
                  severityNumber: 9,
                  severityText: 'INFO',
                  body: { stringValue: 'hello 1' },
                  attributes: [{ key: 'k', value: { stringValue: 'v1' } }],
                },
                {
                  timeUnixNano: '1776886719689000000',
                  severityNumber: 13,
                  severityText: 'WARN',
                  body: { stringValue: 'hello 2' },
                  attributes: [{ key: 'k', value: { stringValue: 'v2' } }],
                },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)

    expect(readLines('logs')).toEqual([payload])
    expect(readServiceLines('svc-a', 'logs')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-a',
        timestamp: '2026-04-22T19:38:39.688Z',
        severityNumber: 9,
        severityText: 'INFO',
        body: 'hello 1',
        resource: { 'service.name': 'svc-a' },
        scope: { name: 'test.scope', version: '1.2.3', attributes: {} },
        attributes: { k: 'v1' },
      }),
      expect.objectContaining({
        serviceName: 'svc-a',
        timestamp: '2026-04-22T19:38:39.689Z',
        severityNumber: 13,
        severityText: 'WARN',
        body: 'hello 2',
        resource: { 'service.name': 'svc-a' },
        scope: { name: 'test.scope', version: '1.2.3', attributes: {} },
        attributes: { k: 'v2' },
      }),
    ])
  })

  it('uses _unknown when service.name is missing', async () => {
    /** @type {unknown} */
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: 'missing service name' } },
              ],
            },
          ],
        },
      ],
    }
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(readServiceLines('_unknown', 'logs')).toEqual([
      expect.objectContaining({
        serviceName: '_unknown',
        body: 'missing service name',
      }),
    ])
  })

  it('ignores malformed OTLP timestamps instead of failing the request', async () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: 'not-a-number',
                  observedTimeUnixNano: '999999999999999999999999999999999999',
                  body: { stringValue: 'bad timestamps' },
                },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(readServiceLines('svc-a', 'logs')).toEqual([
      expect.not.objectContaining({
        timestamp: expect.anything(),
      }),
    ])
    expect(readServiceLines('svc-a', 'logs')).toEqual([
      expect.not.objectContaining({
        observedTimestamp: expect.anything(),
      }),
    ])
    expect(readServiceLines('svc-a', 'logs')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-a',
        body: 'bad timestamps',
      }),
    ])
  })

  it('preserves empty-string AnyValue strings in normalized logs', async () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: '' },
                  attributes: [
                    { key: 'empty', value: { stringValue: '' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(readServiceLines('svc-a', 'logs')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-a',
        body: '',
        attributes: { empty: '' },
      }),
    ])
  })

  it('preserves unusual service.name values in the row body without affecting the path', async () => {
    // Under the unified <gateway_id>/<signal>/<date>.jsonl layout, the service
    // name is just a column on the row; it never becomes a path segment, so
    // values like ".." can't induce path traversal. The path-sanitization
    // helper that used to map ".." to "_dotdot" is gone.
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: '..' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'dot segment service' },
                },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(readServiceLines('..', 'logs')).toEqual([
      expect.objectContaining({
        serviceName: '..',
        body: 'dot segment service',
      }),
    ])
  })

  it('returns OTLP ExportPartialSuccess responses', async () => {
    const headers = { 'Content-Type': 'application/json' }
    const body = JSON.stringify({})

    const traces = await fetch(`${baseUrl}/v1/traces`, { method: 'POST', headers, body })
    expect(traces.headers.get('content-type')).toBe('application/json')
    expect(await traces.json()).toEqual({ partialSuccess: { rejectedSpans: 0 } })

    const metrics = await fetch(`${baseUrl}/v1/metrics`, { method: 'POST', headers, body })
    expect(await metrics.json()).toEqual({ partialSuccess: { rejectedDataPoints: 0 } })

    const logs = await fetch(`${baseUrl}/v1/logs`, { method: 'POST', headers, body })
    expect(await logs.json()).toEqual({ partialSuccess: { rejectedLogRecords: 0 } })
  })

  it('accepts Content-Type with charset parameter', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: true }),
    })
    expect(res.status).toBe(200)
  })

  it('accepts OTLP protobuf logs and returns a protobuf response', async () => {
    const payload = buildLogProtobufPayload()
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: new Uint8Array(payload),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')
    expect((await res.arrayBuffer()).byteLength).toBe(0)

    expect(readLines('logs')).toEqual([
      expect.objectContaining({
        resourceLogs: [
          expect.objectContaining({
            resource: expect.objectContaining({
              attributes: expect.arrayContaining([
                { key: 'service.name', value: { stringValue: 'svc-pb' } },
              ]),
            }),
          }),
        ],
      }),
    ])
    expect(readServiceLines('svc-pb', 'logs')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-pb',
        timestamp: '2026-04-22T19:38:39.688Z',
        observedTimestamp: '2026-04-22T19:38:39.689Z',
        severityNumber: 9,
        severityText: 'INFO',
        body: 'protobuf hello',
        traceId: '00112233445566778899aabbccddeeff',
        spanId: '1122334455667788',
        flags: 1,
        resource: { 'service.name': 'svc-pb', 'service.version': '0.1.0' },
        scope: { name: 'gascity', version: '1.2.3', attributes: {} },
        attributes: { 'gc.agent': 'mayor' },
      }),
    ])
  })

  it('accepts OTLP protobuf traces and returns a protobuf response', async () => {
    const payload = buildTraceProtobufPayload()
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: new Uint8Array(payload),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')
    expect((await res.arrayBuffer()).byteLength).toBe(0)

    expect(readLines('traces')).toEqual([
      expect.objectContaining({
        resourceSpans: [
          expect.objectContaining({
            resource: expect.objectContaining({
              attributes: [{ key: 'service.name', value: { stringValue: 'svc-trace-pb' } }],
            }),
            scopeSpans: [
              expect.objectContaining({
                scope: { name: 'gascity.trace', version: '2.0.0' },
                spans: [
                  expect.objectContaining({
                    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    spanId: 'bbbbbbbbbbbbbbbb',
                    parentSpanId: 'cccccccccccccccc',
                    name: 'protobuf span',
                    kind: 2,
                    startTimeUnixNano: '1776886719688000000',
                    endTimeUnixNano: '1776886719689000000',
                    attributes: [{ key: 'http.method', value: { stringValue: 'GET' } }],
                    status: { message: 'ok', code: 1 },
                    flags: 1,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ])
    expect(readServiceLines('svc-trace-pb', 'traces')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-trace-pb',
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanId: 'bbbbbbbbbbbbbbbb',
        parentSpanId: 'cccccccccccccccc',
        name: 'protobuf span',
        kind: 2,
        startTimestamp: '2026-04-22T19:38:39.688Z',
        endTimestamp: '2026-04-22T19:38:39.689Z',
        durationMs: 1,
        flags: 1,
        status: { code: 1, message: 'ok' },
        resource: { 'service.name': 'svc-trace-pb' },
        scope: { name: 'gascity.trace', version: '2.0.0', attributes: {} },
        attributes: { 'http.method': 'GET' },
        events: [],
        links: [],
      }),
    ])
  })

  it('accepts OTLP protobuf metrics and returns a protobuf response', async () => {
    const payload = buildMetricProtobufPayload()
    const res = await fetch(`${baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: new Uint8Array(payload),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')
    expect((await res.arrayBuffer()).byteLength).toBe(0)

    expect(readLines('metrics')).toEqual([
      expect.objectContaining({
        resourceMetrics: [
          expect.objectContaining({
            resource: expect.objectContaining({
              attributes: [{ key: 'service.name', value: { stringValue: 'svc-metric-pb' } }],
            }),
            scopeMetrics: [
              expect.objectContaining({
                scope: { name: 'gascity.metric', version: '3.0.0' },
                metrics: [
                  expect.objectContaining({
                    name: 'rpc.duration',
                    description: 'protobuf gauge',
                    unit: 'ms',
                    gauge: {
                      dataPoints: [
                        expect.objectContaining({
                          startTimeUnixNano: '1776886719688000000',
                          timeUnixNano: '1776886719689000000',
                          asDouble: 12.5,
                          attributes: [{ key: 'route', value: { stringValue: '/health' } }],
                        }),
                      ],
                    },
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ])
    expect(readServiceLines('svc-metric-pb', 'metrics')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-metric-pb',
        metricName: 'rpc.duration',
        description: 'protobuf gauge',
        unit: 'ms',
        metricType: 'gauge',
        startTimestamp: '2026-04-22T19:38:39.688Z',
        timestamp: '2026-04-22T19:38:39.689Z',
        value: 12.5,
        valueType: 'double',
        resource: { 'service.name': 'svc-metric-pb' },
        scope: { name: 'gascity.metric', version: '3.0.0', attributes: {} },
        metadata: {},
        attributes: { route: '/health' },
        exemplars: [],
      }),
    ])
  })

  it('splits mixed-service trace payloads into signal-prefixed files under services/', async () => {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeSpans: [
            {
              spans: [{ name: 'span-a' }],
            },
          ],
        },
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-b' } },
            ],
          },
          scopeSpans: [
            {
              spans: [{ name: 'span-b' }],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)

    expect(readServiceLines('svc-a', 'traces')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-a',
        name: 'span-a',
        resource: { 'service.name': 'svc-a' },
      }),
    ])
    expect(readServiceLines('svc-b', 'traces')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-b',
        name: 'span-b',
        resource: { 'service.name': 'svc-b' },
      }),
    ])
  })

  it('splits mixed-service metric payloads into signal-prefixed files under services/', async () => {
    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [{
                name: 'metric.a',
                gauge: {
                  dataPoints: [{ asDouble: 1.25 }],
                },
              }],
            },
          ],
        },
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-b' } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [{
                name: 'metric.b',
                gauge: {
                  dataPoints: [{ asDouble: 2.5 }],
                },
              }],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)

    expect(readServiceLines('svc-a', 'metrics')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-a',
        metricName: 'metric.a',
        metricType: 'gauge',
        value: 1.25,
        resource: { 'service.name': 'svc-a' },
      }),
    ])
    expect(readServiceLines('svc-b', 'metrics')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-b',
        metricName: 'metric.b',
        metricType: 'gauge',
        value: 2.5,
        resource: { 'service.name': 'svc-b' },
      }),
    ])
  })

  it('rejects missing Content-Type with 415', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ code: 3 })
  })

  it('rejects unsupported Content-Type with 415', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'binary',
    })
    expect(res.status).toBe(415)
  })

  it('returns 400 for malformed protobuf logs', async () => {
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: new Uint8Array([0x0a, 0x05, 0x08]),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 3, message: 'Invalid protobuf' })
  })
})

describe('Content-Encoding', () => {
  it('decompresses gzip bodies', async () => {
    const body = new Uint8Array(zlib.gzipSync(JSON.stringify({ compressed: true })))
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
    })
    expect(res.status).toBe(200)
    expect(readLines('traces')).toEqual([{ compressed: true }])
  })

  it('decompresses deflate bodies', async () => {
    const body = zlib.deflateSync(JSON.stringify({ deflated: true }))
    const res = await fetch(`${baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' },
      body,
    })
    expect(res.status).toBe(200)
    expect(readLines('metrics')).toEqual([{ deflated: true }])
  })

  it('treats identity encoding as plain body', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' },
      body: JSON.stringify({ plain: true }),
    })
    expect(res.status).toBe(200)
    expect(readLines('traces')).toEqual([{ plain: true }])
  })

  it('rejects unknown encodings with 415', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
      body: 'whatever',
    })
    expect(res.status).toBe(415)
  })

  it('decodes protobuf trace bodies', async () => {
    const span = [
      ...bytesField(1, new Array(16).fill(0x01)),
      ...bytesField(2, new Array(8).fill(0x02)),
      ...stringField(5, 'GET /'),
      ...fixed64Field(7, 1n),
      ...fixed64Field(8, 2n),
    ]
    const body = Buffer.from(u8(lenDelim(1, lenDelim(2, lenDelim(2, span)))))

    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')
    expect(await res.arrayBuffer()).toEqual(new ArrayBuffer(0))
    const lines = readLines('traces')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'GET /' }] }] }],
    })
  })

  it('decodes gzipped protobuf metric bodies', async () => {
    const metric = [...stringField(1, 'm'), ...lenDelim(5, lenDelim(1, fixed64Field(3, 100n)))]
    const proto = u8(lenDelim(1, lenDelim(2, lenDelim(2, metric))))
    const body = Buffer.from(zlib.gzipSync(proto))

    const res = await fetch(`${baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip' },
      body,
    })
    expect(res.status).toBe(200)
    const lines = readLines('metrics')
    expect(lines[0]).toMatchObject({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'm' }] }] }],
    })
  })

  it('returns 400 on malformed protobuf', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: Buffer.from([0xff, 0xff, 0xff]),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on malformed gzip', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: 'not actually gzipped',
    })
    expect(res.status).toBe(400)
  })
})
