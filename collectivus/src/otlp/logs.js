/**
 * Decoders for OTLP log messages.
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
  decodeAnyValue,
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
function decodeLogRecord(bytes) {
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
    case 2: out.severityNumber = readVarint(r); break
    case 3: out.severityText = decodeString(readBytes(r)); break
    case 5: out.body = decodeAnyValue(readBytes(r)); break
    case 6: attributes.push(decodeKeyValue(readBytes(r))); break
    case 7: out.droppedAttributesCount = readVarint(r); break
    case 8: out.flags = readFixed32(r); break
    case 9: out.traceId = toHex(readBytes(r)); break
    case 10: out.spanId = toHex(readBytes(r)); break
    case 11: out.observedTimeUnixNano = readFixed64(r).toString(); break
    case 12: out.eventName = decodeString(readBytes(r)); break
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
function decodeScopeLogs(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const logRecords = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.scope = decodeInstrumentationScope(readBytes(r)); break
    case 2: logRecords.push(decodeLogRecord(readBytes(r))); break
    case 3: out.schemaUrl = decodeString(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  if (logRecords.length) out.logRecords = logRecords
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeResourceLogs(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const scopeLogs = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.resource = decodeResource(readBytes(r)); break
    case 2: scopeLogs.push(decodeScopeLogs(readBytes(r))); break
    case 3: out.schemaUrl = decodeString(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  if (scopeLogs.length) out.scopeLogs = scopeLogs
  return out
}

/**
 * Decode an ExportLogsServiceRequest (the top-level OTLP/HTTP logs body).
 *
 * @param {Uint8Array} bytes
 * @returns {{ resourceLogs: object[] }}
 */
export function decodeExportLogsServiceRequest(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const resourceLogs = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      resourceLogs.push(decodeResourceLogs(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { resourceLogs }
}
