/**
 * Decoders for OTLP metric data-point message types: NumberDataPoint,
 * HistogramDataPoint, ExponentialHistogramDataPoint (+ Buckets),
 * SummaryDataPoint (+ ValueAtQuantile), and Exemplar. Also holds the
 * packed-scalar readers these data points need.
 *
 * Repeated scalar fields (bucket_counts, explicit_bounds) accept both
 * the proto3-default packed LEN form and the legacy unpacked form.
 */

import {
  WIRE_LEN,
  readBytes,
  readDouble,
  readFixed32,
  readFixed64,
  readSFixed64,
  readTag,
  readVarBigInt,
  readVarint,
  skipField,
  zigzagDecode,
} from '../protobuf.js'
import { decodeKeyValue, makeReader, toHex } from './common.js'

/**
 * Iterate a packed LEN blob of fixed64 values, returning each as a string.
 *
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
function readPackedFixed64Strings(bytes) {
  const r = makeReader(bytes)
  /** @type {string[]} */
  const out = []
  while (r.offset < bytes.byteLength) out.push(readFixed64(r).toString())
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
function readPackedDoubles(bytes) {
  const r = makeReader(bytes)
  /** @type {number[]} */
  const out = []
  while (r.offset < bytes.byteLength) out.push(readDouble(r))
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
function readPackedVarBigIntStrings(bytes) {
  const r = makeReader(bytes)
  /** @type {string[]} */
  const out = []
  while (r.offset < bytes.byteLength) out.push(readVarBigInt(r).toString())
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeExemplar(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const filteredAttributes = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 2: out.timeUnixNano = readFixed64(r).toString(); break
    case 3: out.asDouble = readDouble(r); break
    case 4: out.spanId = toHex(readBytes(r)); break
    case 5: out.traceId = toHex(readBytes(r)); break
    case 6: out.asInt = readSFixed64(r).toString(); break
    case 7: filteredAttributes.push(decodeKeyValue(readBytes(r))); break
    default: skipField(r, wireType)
    }
  }
  if (filteredAttributes.length) out.filteredAttributes = filteredAttributes
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeNumberDataPoint(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  /** @type {object[]} */
  const exemplars = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 2: out.startTimeUnixNano = readFixed64(r).toString(); break
    case 3: out.timeUnixNano = readFixed64(r).toString(); break
    case 4: out.asDouble = readDouble(r); break
    case 5: exemplars.push(decodeExemplar(readBytes(r))); break
    case 6: out.asInt = readSFixed64(r).toString(); break
    case 7: attributes.push(decodeKeyValue(readBytes(r))); break
    case 8: out.flags = readFixed32(r); break
    default: skipField(r, wireType)
    }
  }
  if (attributes.length) out.attributes = attributes
  if (exemplars.length) out.exemplars = exemplars
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeHistogramDataPoint(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  /** @type {string[]} */
  const bucketCounts = []
  /** @type {number[]} */
  const explicitBounds = []
  /** @type {object[]} */
  const exemplars = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 9: attributes.push(decodeKeyValue(readBytes(r))); break
    case 2: out.startTimeUnixNano = readFixed64(r).toString(); break
    case 3: out.timeUnixNano = readFixed64(r).toString(); break
    case 4: out.count = readFixed64(r).toString(); break
    case 5: out.sum = readDouble(r); break
    case 6:
      if (wireType === WIRE_LEN) {
        for (const v of readPackedFixed64Strings(readBytes(r))) bucketCounts.push(v)
      } else {
        bucketCounts.push(readFixed64(r).toString())
      }
      break
    case 7:
      if (wireType === WIRE_LEN) {
        for (const v of readPackedDoubles(readBytes(r))) explicitBounds.push(v)
      } else {
        explicitBounds.push(readDouble(r))
      }
      break
    case 8: exemplars.push(decodeExemplar(readBytes(r))); break
    case 10: out.flags = readFixed32(r); break
    case 11: out.min = readDouble(r); break
    case 12: out.max = readDouble(r); break
    default: skipField(r, wireType)
    }
  }
  if (attributes.length) out.attributes = attributes
  if (bucketCounts.length) out.bucketCounts = bucketCounts
  if (explicitBounds.length) out.explicitBounds = explicitBounds
  if (exemplars.length) out.exemplars = exemplars
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeBuckets(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {string[]} */
  const bucketCounts = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.offset = zigzagDecode(readVarint(r)); break
    case 2:
      if (wireType === WIRE_LEN) {
        for (const v of readPackedVarBigIntStrings(readBytes(r))) bucketCounts.push(v)
      } else {
        bucketCounts.push(readVarBigInt(r).toString())
      }
      break
    default: skipField(r, wireType)
    }
  }
  if (bucketCounts.length) out.bucketCounts = bucketCounts
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeExponentialHistogramDataPoint(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  /** @type {object[]} */
  const exemplars = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: attributes.push(decodeKeyValue(readBytes(r))); break
    case 2: out.startTimeUnixNano = readFixed64(r).toString(); break
    case 3: out.timeUnixNano = readFixed64(r).toString(); break
    case 4: out.count = readFixed64(r).toString(); break
    case 5: out.sum = readDouble(r); break
    case 6: out.scale = zigzagDecode(readVarint(r)); break
    case 7: out.zeroCount = readFixed64(r).toString(); break
    case 8: out.positive = decodeBuckets(readBytes(r)); break
    case 9: out.negative = decodeBuckets(readBytes(r)); break
    case 10: out.flags = readFixed32(r); break
    case 11: exemplars.push(decodeExemplar(readBytes(r))); break
    case 12: out.min = readDouble(r); break
    case 13: out.max = readDouble(r); break
    case 14: out.zeroThreshold = readDouble(r); break
    default: skipField(r, wireType)
    }
  }
  if (attributes.length) out.attributes = attributes
  if (exemplars.length) out.exemplars = exemplars
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeValueAtQuantile(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.quantile = readDouble(r); break
    case 2: out.value = readDouble(r); break
    default: skipField(r, wireType)
    }
  }
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeSummaryDataPoint(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  /** @type {object[]} */
  const quantileValues = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 7: attributes.push(decodeKeyValue(readBytes(r))); break
    case 2: out.startTimeUnixNano = readFixed64(r).toString(); break
    case 3: out.timeUnixNano = readFixed64(r).toString(); break
    case 4: out.count = readFixed64(r).toString(); break
    case 5: out.sum = readDouble(r); break
    case 6: quantileValues.push(decodeValueAtQuantile(readBytes(r))); break
    case 8: out.flags = readFixed32(r); break
    default: skipField(r, wireType)
    }
  }
  if (attributes.length) out.attributes = attributes
  if (quantileValues.length) out.quantileValues = quantileValues
  return out
}
