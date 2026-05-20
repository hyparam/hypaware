/**
 * Decoders for OTLP trace messages. Produces OTLP/JSON-shaped output:
 * trace_id/span_id/parent_span_id as lowercase hex, fixed64 timestamps
 * as strings, enums as integers.
 */

import {
  readBytes,
  readFixed32,
  readFixed64,
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
  toHex,
} from './common.js'

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeStatus(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 2: out.message = decodeString(readBytes(r)); break
    case 3: out.code = readVarint(r); break
    default: skipField(r, wireType)
    }
  }
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeEvent(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.timeUnixNano = readFixed64(r).toString(); break
    case 2: out.name = decodeString(readBytes(r)); break
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
function decodeLink(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.traceId = toHex(readBytes(r)); break
    case 2: out.spanId = toHex(readBytes(r)); break
    case 3: out.traceState = decodeString(readBytes(r)); break
    case 4: attributes.push(decodeKeyValue(readBytes(r))); break
    case 5: out.droppedAttributesCount = readVarint(r); break
    case 6: out.flags = readFixed32(r); break
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
function decodeSpan(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  /** @type {object[]} */
  const events = []
  /** @type {object[]} */
  const links = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.traceId = toHex(readBytes(r)); break
    case 2: out.spanId = toHex(readBytes(r)); break
    case 3: out.traceState = decodeString(readBytes(r)); break
    case 4: out.parentSpanId = toHex(readBytes(r)); break
    case 5: out.name = decodeString(readBytes(r)); break
    case 6: out.kind = readVarint(r); break
    case 7: out.startTimeUnixNano = readFixed64(r).toString(); break
    case 8: out.endTimeUnixNano = readFixed64(r).toString(); break
    case 9: attributes.push(decodeKeyValue(readBytes(r))); break
    case 10: out.droppedAttributesCount = readVarint(r); break
    case 11: events.push(decodeEvent(readBytes(r))); break
    case 12: out.droppedEventsCount = readVarint(r); break
    case 13: links.push(decodeLink(readBytes(r))); break
    case 14: out.droppedLinksCount = readVarint(r); break
    case 15: out.status = decodeStatus(readBytes(r)); break
    case 16: out.flags = readFixed32(r); break
    default: skipField(r, wireType)
    }
  }
  if (attributes.length) out.attributes = attributes
  if (events.length) out.events = events
  if (links.length) out.links = links
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeScopeSpans(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const spans = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.scope = decodeInstrumentationScope(readBytes(r)); break
    case 2: spans.push(decodeSpan(readBytes(r))); break
    case 3: out.schemaUrl = decodeString(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  if (spans.length) out.spans = spans
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeResourceSpans(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const scopeSpans = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.resource = decodeResource(readBytes(r)); break
    case 2: scopeSpans.push(decodeScopeSpans(readBytes(r))); break
    case 3: out.schemaUrl = decodeString(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  if (scopeSpans.length) out.scopeSpans = scopeSpans
  return out
}

/**
 * Decode an ExportTraceServiceRequest (the top-level OTLP/HTTP traces body).
 *
 * @param {Uint8Array} bytes
 * @returns {{ resourceSpans: object[] }}
 */
export function decodeExportTraceServiceRequest(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const resourceSpans = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      resourceSpans.push(decodeResourceSpans(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { resourceSpans }
}
