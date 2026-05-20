/**
 * Decoders for OTLP metric messages. Data-point shapes live in
 * ./datapoints.js; this file handles the Metric oneof dispatch and the
 * Resource/Scope/Export wrappers.
 */

import {
  readBytes,
  readTag,
  readVarint,
  skipField,
} from '../protobuf.js'
import {
  decodeInstrumentationScope,
  decodeKeyValue,
  decodeResource,
  decodeString,
  makeReader,
} from './common.js'
import {
  decodeExponentialHistogramDataPoint,
  decodeHistogramDataPoint,
  decodeNumberDataPoint,
  decodeSummaryDataPoint,
} from './datapoints.js'

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeGauge(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const dataPoints = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      dataPoints.push(decodeNumberDataPoint(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { dataPoints }
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeSum(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const dataPoints = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: dataPoints.push(decodeNumberDataPoint(readBytes(r))); break
    case 2: out.aggregationTemporality = readVarint(r); break
    case 3: out.isMonotonic = readVarint(r) !== 0; break
    default: skipField(r, wireType)
    }
  }
  out.dataPoints = dataPoints
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeHistogram(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const dataPoints = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: dataPoints.push(decodeHistogramDataPoint(readBytes(r))); break
    case 2: out.aggregationTemporality = readVarint(r); break
    default: skipField(r, wireType)
    }
  }
  out.dataPoints = dataPoints
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeExponentialHistogram(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const dataPoints = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: dataPoints.push(decodeExponentialHistogramDataPoint(readBytes(r))); break
    case 2: out.aggregationTemporality = readVarint(r); break
    default: skipField(r, wireType)
    }
  }
  out.dataPoints = dataPoints
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeSummary(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const dataPoints = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      dataPoints.push(decodeSummaryDataPoint(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { dataPoints }
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeMetric(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const metadata = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.name = decodeString(readBytes(r)); break
    case 2: out.description = decodeString(readBytes(r)); break
    case 3: out.unit = decodeString(readBytes(r)); break
    case 5: out.gauge = decodeGauge(readBytes(r)); break
    case 7: out.sum = decodeSum(readBytes(r)); break
    case 9: out.histogram = decodeHistogram(readBytes(r)); break
    case 10: out.exponentialHistogram = decodeExponentialHistogram(readBytes(r)); break
    case 11: out.summary = decodeSummary(readBytes(r)); break
    case 12: metadata.push(decodeKeyValue(readBytes(r))); break
    default: skipField(r, wireType)
    }
  }
  if (metadata.length) out.metadata = metadata
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeScopeMetrics(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const metrics = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.scope = decodeInstrumentationScope(readBytes(r)); break
    case 2: metrics.push(decodeMetric(readBytes(r))); break
    case 3: out.schemaUrl = decodeString(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  if (metrics.length) out.metrics = metrics
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeResourceMetrics(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const scopeMetrics = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.resource = decodeResource(readBytes(r)); break
    case 2: scopeMetrics.push(decodeScopeMetrics(readBytes(r))); break
    case 3: out.schemaUrl = decodeString(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  if (scopeMetrics.length) out.scopeMetrics = scopeMetrics
  return out
}

/**
 * Decode an ExportMetricsServiceRequest (the top-level OTLP/HTTP metrics body).
 *
 * @param {Uint8Array} bytes
 * @returns {{ resourceMetrics: object[] }}
 */
export function decodeExportMetricsServiceRequest(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const resourceMetrics = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      resourceMetrics.push(decodeResourceMetrics(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { resourceMetrics }
}
