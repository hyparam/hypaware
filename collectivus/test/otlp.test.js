import { describe, expect, it } from 'vitest'
import {
  decodeAnyValue,
  decodeInstrumentationScope,
  decodeKeyValue,
  decodeKeyValueList,
  decodeResource,
} from '../src/otlp/common.js'
import { decodeExportLogsServiceRequest } from '../src/otlp/logs.js'
import { decodeExportMetricsServiceRequest } from '../src/otlp/metrics.js'
import { decodeExportTraceServiceRequest } from '../src/otlp/traces.js'
import {
  bytesField,
  doubleField,
  fixed32Field,
  fixed64Field,
  int64Field,
  lenDelim,
  packedDoubleField,
  packedFixed64Field,
  packedVarBigIntField,
  sfixed64Field,
  sint32Field,
  stringField,
  u8,
  varintField,
} from './helpers.js'

describe('decodeAnyValue', () => {
  it('decodes stringValue', () => {
    expect(decodeAnyValue(u8(stringField(1, 'hello')))).toEqual({ stringValue: 'hello' })
  })

  it('decodes boolValue, intValue, doubleValue', () => {
    expect(decodeAnyValue(u8(varintField(2, 1)))).toEqual({ boolValue: true })
    expect(decodeAnyValue(u8(varintField(3, 42)))).toEqual({ intValue: '42' })
    expect(decodeAnyValue(u8(doubleField(4, 1.5)))).toEqual({ doubleValue: 1.5 })
  })

  it('decodes negative intValue as signed int64', () => {
    expect(decodeAnyValue(u8(int64Field(3, -5n)))).toEqual({ intValue: '-5' })
  })
  it('decodes bytesValue as base64', () => {
    expect(decodeAnyValue(u8(bytesField(7, [0xde, 0xad])))).toEqual({ bytesValue: '3q0=' })
  })

  it('decodes arrayValue', () => {
    const inner = stringField(1, 'a')
    expect(decodeAnyValue(u8(lenDelim(5, [...lenDelim(1, inner)])))).toEqual({
      arrayValue: { values: [{ stringValue: 'a' }] },
    })
  })
})

describe('decodeKeyValue', () => {
  it('decodes a simple string attribute', () => {
    const bytes = [...stringField(1, 'host.name'), ...lenDelim(2, stringField(1, 'alice'))]
    expect(decodeKeyValue(u8(bytes))).toEqual({
      key: 'host.name',
      value: { stringValue: 'alice' },
    })
  })
})

describe('decodeResource', () => {
  it('decodes attributes and droppedAttributesCount', () => {
    const attr = lenDelim(1, [
      ...stringField(1, 'service.name'),
      ...lenDelim(2, stringField(1, 'svc')),
    ])
    const bytes = [...attr, ...varintField(2, 3)]
    expect(decodeResource(u8(bytes))).toEqual({
      attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }],
      droppedAttributesCount: 3,
    })
  })
})

describe('decodeExportTraceServiceRequest', () => {
  it('decodes a single span', () => {
    const traceId = Array.from({ length: 16 }, (_, i) => i + 1)
    const spanId = Array.from({ length: 8 }, (_, i) => i + 1)
    const span = [
      ...bytesField(1, traceId),
      ...bytesField(2, spanId),
      ...stringField(5, 'GET /'),
      ...varintField(6, 2),
      ...fixed64Field(7, 1000n),
      ...fixed64Field(8, 2000n),
      ...lenDelim(15, varintField(3, 1)),
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, span)))

    expect(decodeExportTraceServiceRequest(u8(req))).toEqual({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: '0102030405060708090a0b0c0d0e0f10',
            spanId: '0102030405060708',
            name: 'GET /',
            kind: 2,
            startTimeUnixNano: '1000',
            endTimeUnixNano: '2000',
            status: { code: 1 },
          }],
        }],
      }],
    })
  })
})

describe('decodeExportLogsServiceRequest', () => {
  it('decodes a single log record', () => {
    const traceId = new Array(16).fill(0xab)
    const spanId = new Array(8).fill(0xcd)
    const logRecord = [
      ...fixed64Field(1, 1234n),
      ...varintField(2, 9),
      ...stringField(3, 'INFO'),
      ...lenDelim(5, stringField(1, 'hello world')),
      ...fixed32Field(8, 7),
      ...bytesField(9, traceId),
      ...bytesField(10, spanId),
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, logRecord)))

    expect(decodeExportLogsServiceRequest(u8(req))).toEqual({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1234',
            severityNumber: 9,
            severityText: 'INFO',
            body: { stringValue: 'hello world' },
            flags: 7,
            traceId: 'abababababababababababababababab',
            spanId: 'cdcdcdcdcdcdcdcd',
          }],
        }],
      }],
    })
  })
})

describe('decodeExportMetricsServiceRequest', () => {
  it('decodes a Gauge with a double datapoint', () => {
    const dp = [
      ...fixed64Field(2, 100n),
      ...fixed64Field(3, 200n),
      ...doubleField(4, 3.14),
    ]
    const metric = [
      ...stringField(1, 'cpu.usage'),
      ...stringField(3, '1'),
      ...lenDelim(5, lenDelim(1, dp)),
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    expect(decodeExportMetricsServiceRequest(u8(req))).toEqual({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: 'cpu.usage',
            unit: '1',
            gauge: {
              dataPoints: [{
                startTimeUnixNano: '100',
                timeUnixNano: '200',
                asDouble: 3.14,
              }],
            },
          }],
        }],
      }],
    })
  })

  it('decodes a Sum with an int datapoint and isMonotonic flag', () => {
    const dp = [
      ...fixed64Field(3, 500n),
      ...sfixed64Field(6, 42n),
    ]
    const sum = [
      ...lenDelim(1, dp),
      ...varintField(2, 2),
      ...varintField(3, 1),
    ]
    const metric = [
      ...stringField(1, 'requests'),
      ...lenDelim(7, sum),
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    expect(decodeExportMetricsServiceRequest(u8(req))).toEqual({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: 'requests',
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [{
                timeUnixNano: '500',
                asInt: '42',
              }],
            },
          }],
        }],
      }],
    })
  })

  it('decodes a Sum with a negative sfixed64', () => {
    const dp = lenDelim(1, [...fixed64Field(3, 10n), ...sfixed64Field(6, -5n)])
    const sum = lenDelim(7, dp)
    const metric = [...stringField(1, 'delta'), ...sum]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    /** @type {any} */
    const result = decodeExportMetricsServiceRequest(u8(req))
    expect(result.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]).toEqual({
      timeUnixNano: '10',
      asInt: '-5',
    })
  })

  it('decodes a Gauge datapoint with an exemplar', () => {
    const traceId = new Array(16).fill(0x11)
    const spanId = new Array(8).fill(0x22)
    const exemplar = [
      ...fixed64Field(2, 999n),
      ...doubleField(3, 2.5),
      ...bytesField(4, spanId),
      ...bytesField(5, traceId),
    ]
    const dp = [...fixed64Field(3, 200n), ...doubleField(4, 1.0), ...lenDelim(5, exemplar)]
    const metric = [...stringField(1, 'm'), ...lenDelim(5, lenDelim(1, dp))]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    /** @type {any} */
    const result = decodeExportMetricsServiceRequest(u8(req))
    expect(result.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].exemplars).toEqual([{
      timeUnixNano: '999',
      asDouble: 2.5,
      spanId: '2222222222222222',
      traceId: '11111111111111111111111111111111',
    }])
  })

  it('decodes a Histogram with packed bucket_counts and explicit_bounds', () => {
    const dp = [
      ...fixed64Field(3, 1000n),
      ...fixed64Field(4, 5n),
      ...doubleField(5, 12.5),
      ...packedFixed64Field(6, [1n, 2n, 2n]),
      ...packedDoubleField(7, [1.0, 5.0]),
      ...doubleField(11, 0.5),
      ...doubleField(12, 9.0),
    ]
    const histogram = [...lenDelim(1, dp), ...varintField(2, 1)]
    const metric = [...stringField(1, 'latency'), ...lenDelim(9, histogram)]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    /** @type {any} */
    const result = decodeExportMetricsServiceRequest(u8(req))
    expect(result.resourceMetrics[0].scopeMetrics[0].metrics[0]).toEqual({
      name: 'latency',
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [{
          timeUnixNano: '1000',
          count: '5',
          sum: 12.5,
          bucketCounts: ['1', '2', '2'],
          explicitBounds: [1.0, 5.0],
          min: 0.5,
          max: 9.0,
        }],
      },
    })
  })

  it('decodes an ExponentialHistogram with negative scale and Buckets', () => {
    const positive = [...sint32Field(1, 3), ...packedVarBigIntField(2, [0n, 1n, 4n])]
    const dp = [
      ...fixed64Field(3, 2000n),
      ...fixed64Field(4, 5n),
      ...doubleField(5, 10.0),
      ...sint32Field(6, -2),
      ...fixed64Field(7, 1n),
      ...lenDelim(8, positive),
      ...doubleField(14, 1e-9),
    ]
    const expHist = [...lenDelim(1, dp), ...varintField(2, 2)]
    const metric = [...stringField(1, 'exp'), ...lenDelim(10, expHist)]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    /** @type {any} */
    const result = decodeExportMetricsServiceRequest(u8(req))
    expect(result.resourceMetrics[0].scopeMetrics[0].metrics[0].exponentialHistogram).toEqual({
      aggregationTemporality: 2,
      dataPoints: [{
        timeUnixNano: '2000',
        count: '5',
        sum: 10.0,
        scale: -2,
        zeroCount: '1',
        positive: { offset: 3, bucketCounts: ['0', '1', '4'] },
        zeroThreshold: 1e-9,
      }],
    })
  })

  it('decodes a Summary with two quantile_values', () => {
    const q1 = lenDelim(6, [...doubleField(1, 0.5), ...doubleField(2, 1.5)])
    const q2 = lenDelim(6, [...doubleField(1, 0.99), ...doubleField(2, 9.9)])
    const dp = [...fixed64Field(3, 100n), ...fixed64Field(4, 20n), ...doubleField(5, 50.0), ...q1, ...q2]
    const summary = lenDelim(11, lenDelim(1, dp))
    const metric = [...stringField(1, 'lat'), ...summary]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    /** @type {any} */
    const result = decodeExportMetricsServiceRequest(u8(req))
    expect(result.resourceMetrics[0].scopeMetrics[0].metrics[0].summary).toEqual({
      dataPoints: [{
        timeUnixNano: '100',
        count: '20',
        sum: 50.0,
        quantileValues: [
          { quantile: 0.5, value: 1.5 },
          { quantile: 0.99, value: 9.9 },
        ],
      }],
    })
  })

  it('decodes Metric.metadata', () => {
    const kv = lenDelim(12, [...stringField(1, 'k'), ...lenDelim(2, stringField(1, 'v'))])
    const dp = lenDelim(1, [...fixed64Field(3, 1n), ...doubleField(4, 1)])
    const metric = [...stringField(1, 'm'), ...lenDelim(5, dp), ...kv]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    /** @type {any} */
    const result = decodeExportMetricsServiceRequest(u8(req))
    expect(result.resourceMetrics[0].scopeMetrics[0].metrics[0].metadata).toEqual([
      { key: 'k', value: { stringValue: 'v' } },
    ])
  })
})

describe('common gap-fills', () => {
  it('decodeKeyValueList wraps KeyValue entries', () => {
    const kv1 = lenDelim(1, [...stringField(1, 'a'), ...lenDelim(2, stringField(1, '1'))])
    const kv2 = lenDelim(1, [...stringField(1, 'b'), ...lenDelim(2, varintField(2, 1))])
    expect(decodeKeyValueList(u8([...kv1, ...kv2]))).toEqual({
      values: [
        { key: 'a', value: { stringValue: '1' } },
        { key: 'b', value: { boolValue: true } },
      ],
    })
  })

  it('decodeInstrumentationScope decodes name, version, attributes, droppedAttributesCount', () => {
    const attr = lenDelim(3, [...stringField(1, 'k'), ...lenDelim(2, stringField(1, 'v'))])
    const bytes = [
      ...stringField(1, 'my-lib'),
      ...stringField(2, '1.2.3'),
      ...attr,
      ...varintField(4, 2),
    ]
    expect(decodeInstrumentationScope(u8(bytes))).toEqual({
      name: 'my-lib',
      version: '1.2.3',
      attributes: [{ key: 'k', value: { stringValue: 'v' } }],
      droppedAttributesCount: 2,
    })
  })
})

describe('traces gap-fills', () => {
  it('decodes a Span with event, link, and Status.message', () => {
    const event = lenDelim(11, [
      ...fixed64Field(1, 500n),
      ...stringField(2, 'hit'),
    ])
    const linkTrace = new Array(16).fill(0xaa)
    const linkSpan = new Array(8).fill(0xbb)
    const link = lenDelim(13, [
      ...bytesField(1, linkTrace),
      ...bytesField(2, linkSpan),
      ...fixed32Field(6, 3),
    ])
    const status = lenDelim(15, [...stringField(2, 'oops'), ...varintField(3, 2)])
    const span = [
      ...bytesField(1, new Array(16).fill(0x01)),
      ...bytesField(2, new Array(8).fill(0x02)),
      ...stringField(5, 's'),
      ...fixed64Field(7, 1n),
      ...fixed64Field(8, 2n),
      ...event,
      ...link,
      ...status,
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, span)))

    /** @type {any} */
    const result = decodeExportTraceServiceRequest(u8(req))
    const decoded = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(decoded.events).toEqual([{ timeUnixNano: '500', name: 'hit' }])
    expect(decoded.links).toEqual([{
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: 'bbbbbbbbbbbbbbbb',
      flags: 3,
    }])
    expect(decoded.status).toEqual({ message: 'oops', code: 2 })
  })
})

describe('logs gap-fills', () => {
  it('decodes a log body that is a kvlist', () => {
    const kv = lenDelim(1, [...stringField(1, 'user'), ...lenDelim(2, stringField(1, 'alice'))])
    const body = lenDelim(5, lenDelim(6, kv))
    const logRecord = [...fixed64Field(1, 1n), ...body]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, logRecord)))

    /** @type {any} */
    const result = decodeExportLogsServiceRequest(u8(req))
    expect(result.resourceLogs[0].scopeLogs[0].logRecords[0].body).toEqual({
      kvlistValue: {
        values: [{ key: 'user', value: { stringValue: 'alice' } }],
      },
    })
  })
})
