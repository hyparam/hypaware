/**
 * Decoders for OTLP common message types (AnyValue, KeyValue, Resource,
 * InstrumentationScope). Output matches OTLP/JSON: camelCase field names,
 * int64 as string, bytes as base64, trace/span ids as lowercase hex.
 *
 * @import {DataReader} from '../types.js'
 */

import {
  readBytes,
  readDouble,
  readTag,
  readVarInt64,
  readVarint,
  skipField,
} from '../protobuf.js'

const textDecoder = new TextDecoder()

/**
 * Wrap a byte slice in a DataReader for field-by-field decoding.
 *
 * @param {Uint8Array} bytes
 * @returns {DataReader}
 */
export function makeReader(bytes) {
  return {
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: 0,
  }
}

/**
 * Lowercase hex encoding for trace_id/span_id/parent_span_id fields.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')
}

/**
 * Standard base64 for generic bytes fields.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeString(bytes) {
  return textDecoder.decode(bytes)
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeAnyValue(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.stringValue = decodeString(readBytes(r)); break
    case 2: out.boolValue = readVarint(r) !== 0; break
    case 3: out.intValue = readVarInt64(r).toString(); break
    case 4: out.doubleValue = readDouble(r); break
    case 5: out.arrayValue = decodeArrayValue(readBytes(r)); break
    case 6: out.kvlistValue = decodeKeyValueList(readBytes(r)); break
    case 7: out.bytesValue = toBase64(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ values: object[] }}
 */
export function decodeArrayValue(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const values = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      values.push(decodeAnyValue(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { values }
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ values: object[] }}
 */
export function decodeKeyValueList(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const values = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      values.push(decodeKeyValue(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { values }
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeKeyValue(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.key = decodeString(readBytes(r)); break
    case 2: out.value = decodeAnyValue(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeInstrumentationScope(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.name = decodeString(readBytes(r)); break
    case 2: out.version = decodeString(readBytes(r)); break
    case 3: attributes.push(decodeKeyValue(readBytes(r))); break
    case 4: out.droppedAttributesCount = readVarint(r); break
    default: skipField(r, wireType)
    }
  }
  if (attributes.length) out.attributes = attributes
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeResource(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: attributes.push(decodeKeyValue(readBytes(r))); break
    case 2: out.droppedAttributesCount = readVarint(r); break
    default: skipField(r, wireType)
    }
  }
  if (attributes.length) out.attributes = attributes
  return out
}
