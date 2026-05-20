/**
 * Protobuf wire format reader.
 *
 * The wire format is schema-agnostic: every field is a (tag, value) pair where
 * the tag encodes a field number and one of five wire types. Turning these
 * into named fields requires a schema, which lives outside this file.
 *
 * @import {DataReader} from './types.js'
 */

// Wire types
export const WIRE_VARINT = 0
export const WIRE_I64 = 1
export const WIRE_LEN = 2
export const WIRE_I32 = 5

/**
 * Read a varint as a Number. Safe for values up to 2^53 - 1; use
 * readVarBigInt for the full uint64/int64 range.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export function readVarint(reader) {
  let result = 0
  let shift = 0
  while (true) {
    const byte = reader.view.getUint8(reader.offset++)
    if (shift < 28) {
      result |= (byte & 0x7f) << shift
    } else {
      // Avoid 32-bit sign extension once shift >= 28
      result += (byte & 0x7f) * 2 ** shift
    }
    if (!(byte & 0x80)) return result
    shift += 7
  }
}

/**
 * Read a varint as a bigint. Use for raw varint payloads or the full uint64
 * range before applying signed or zigzag decoding.
 *
 * @param {DataReader} reader
 * @returns {bigint}
 */
export function readVarBigInt(reader) {
  let result = 0n
  let shift = 0n
  while (true) {
    const byte = reader.view.getUint8(reader.offset++)
    result |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return result
    shift += 7n
  }
}

/**
 * Read an int64 varint as a signed bigint using two's-complement decoding.
 *
 * @param {DataReader} reader
 * @returns {bigint}
 */
export function readVarInt64(reader) {
  const value = readVarBigInt(reader)
  return value >= 0x8000000000000000n ? value - 0x10000000000000000n : value
}

/**
 * Decode zigzag-encoded number (sint32/sint64).
 *
 * @param {number} n
 * @returns {number}
 */
export function zigzagDecode(n) {
  return n >>> 1 ^ -(n & 1)
}

/**
 * Decode zigzag-encoded bigint.
 *
 * @param {bigint} n
 * @returns {bigint}
 */
export function zigzagDecodeBigInt(n) {
  return n >> 1n ^ -(n & 1n)
}

/**
 * Read a field tag, returning the field number and wire type.
 *
 * @param {DataReader} reader
 * @returns {{ fieldNumber: number, wireType: number }}
 */
export function readTag(reader) {
  const tag = readVarint(reader)
  return { fieldNumber: tag >>> 3, wireType: tag & 0x07 }
}

/**
 * Read a fixed 32-bit unsigned integer.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export function readFixed32(reader) {
  const value = reader.view.getUint32(reader.offset, true)
  reader.offset += 4
  return value
}

/**
 * Read a fixed 32-bit signed integer.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export function readSFixed32(reader) {
  const value = reader.view.getInt32(reader.offset, true)
  reader.offset += 4
  return value
}

/**
 * Read a fixed 64-bit unsigned integer.
 *
 * @param {DataReader} reader
 * @returns {bigint}
 */
export function readFixed64(reader) {
  const value = reader.view.getBigUint64(reader.offset, true)
  reader.offset += 8
  return value
}

/**
 * Read a fixed 64-bit signed integer.
 *
 * @param {DataReader} reader
 * @returns {bigint}
 */
export function readSFixed64(reader) {
  const value = reader.view.getBigInt64(reader.offset, true)
  reader.offset += 8
  return value
}

/**
 * Read a 32-bit float.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export function readFloat(reader) {
  const value = reader.view.getFloat32(reader.offset, true)
  reader.offset += 4
  return value
}

/**
 * Read a 64-bit double.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export function readDouble(reader) {
  const value = reader.view.getFloat64(reader.offset, true)
  reader.offset += 8
  return value
}

/**
 * Read a length-delimited byte slice (string, bytes, or embedded message).
 * Returns a view over the underlying buffer; do not retain across requests.
 *
 * @param {DataReader} reader
 * @returns {Uint8Array}
 */
export function readBytes(reader) {
  const length = readVarint(reader)
  if (reader.offset + length > reader.view.byteLength) {
    throw new Error('protobuf: length-delimited field extends past buffer')
  }
  const bytes = new Uint8Array(reader.view.buffer, reader.view.byteOffset + reader.offset, length)
  reader.offset += length
  return bytes
}

/**
 * Skip a field of the given wire type. Used for unknown fields so callers
 * can stay forward-compatible with newer schemas.
 *
 * @param {DataReader} reader
 * @param {number} wireType
 */
export function skipField(reader, wireType) {
  if (wireType === WIRE_VARINT) {
    while (reader.view.getUint8(reader.offset++) & 0x80) { /* keep going */ }
  } else if (wireType === WIRE_I64) {
    reader.offset += 8
  } else if (wireType === WIRE_LEN) {
    const length = readVarint(reader)
    if (reader.offset + length > reader.view.byteLength) {
      throw new Error('protobuf: length-delimited field extends past buffer')
    }
    reader.offset += length
  } else if (wireType === WIRE_I32) {
    reader.offset += 4
  } else {
    throw new Error(`protobuf unsupported wire type: ${wireType}`)
  }
}
