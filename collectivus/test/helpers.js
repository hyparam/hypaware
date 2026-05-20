/**
 * Hand-rolled protobuf encoders for crafting test payloads. Mirrors the
 * subset of the wire format covered by src/protobuf.js readers.
 */

/**
 * @param {number} n
 * @returns {number[]}
 */
export function varint(n) {
  /** @type {number[]} */
  const out = []
  while (n > 0x7f) {
    out.push(n & 0x7f | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}

/**
 * @param {number} field
 * @param {number} wireType
 * @returns {number[]}
 */
export function tag(field, wireType) {
  return varint(field << 3 | wireType)
}

/**
 * @param {number} field
 * @param {number[]} bytes
 * @returns {number[]}
 */
export function lenDelim(field, bytes) {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes]
}

/**
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
export function varintField(field, value) {
  return [...tag(field, 0), ...varint(value)]
}

/**
 * @param {number} field
 * @param {bigint | number} value
 * @returns {number[]}
 */
export function fixed64Field(field, value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return [...tag(field, 1), ...buf]
}

/**
 * @param {number} field
 * @param {bigint | number} value
 * @returns {number[]}
 */
export function sfixed64Field(field, value) {
  const buf = Buffer.alloc(8)
  buf.writeBigInt64LE(BigInt(value))
  return [...tag(field, 1), ...buf]
}

/**
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
export function fixed32Field(field, value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value)
  return [...tag(field, 5), ...buf]
}

/**
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
export function doubleField(field, value) {
  const buf = Buffer.alloc(8)
  buf.writeDoubleLE(value)
  return [...tag(field, 1), ...buf]
}

/**
 * @param {number} field
 * @param {string} s
 * @returns {number[]}
 */
export function stringField(field, s) {
  return lenDelim(field, [...Buffer.from(s, 'utf8')])
}

/**
 * @param {number} field
 * @param {number[]} bytes
 * @returns {number[]}
 */
export function bytesField(field, bytes) {
  return lenDelim(field, bytes)
}

/**
 * Packed repeated fixed64 field (all values in a single LEN blob).
 *
 * @param {number} field
 * @param {(bigint | number)[]} values
 * @returns {number[]}
 */
export function packedFixed64Field(field, values) {
  const buf = Buffer.alloc(values.length * 8)
  for (let i = 0; i < values.length; i++) {
    buf.writeBigUInt64LE(BigInt(values[i]), i * 8)
  }
  return lenDelim(field, [...buf])
}

/**
 * Packed repeated double field.
 *
 * @param {number} field
 * @param {number[]} values
 * @returns {number[]}
 */
export function packedDoubleField(field, values) {
  const buf = Buffer.alloc(values.length * 8)
  for (let i = 0; i < values.length; i++) {
    buf.writeDoubleLE(values[i], i * 8)
  }
  return lenDelim(field, [...buf])
}

/**
 * Varint encoder for bigints (uint64).
 *
 * @param {bigint} n
 * @returns {number[]}
 */
export function varBigInt(n) {
  /** @type {number[]} */
  const out = []
  while (n > 0x7fn) {
    out.push(Number(n & 0x7fn) | 0x80)
    n >>= 7n
  }
  out.push(Number(n))
  return out
}

/**
 * Varint encoder for int64 using two's-complement encoding.
 *
 * @param {bigint | number} n
 * @returns {number[]}
 */
export function varInt64(n) {
  return varBigInt(BigInt.asUintN(64, BigInt(n)))
}

/**
 * Packed repeated uint64 field (bigint varints).
 *
 * @param {number} field
 * @param {(bigint | number)[]} values
 * @returns {number[]}
 */
export function packedVarBigIntField(field, values) {
  /** @type {number[]} */
  const payload = []
  for (const v of values) payload.push(...varBigInt(BigInt(v)))
  return lenDelim(field, payload)
}

/**
 * int64 varint field encoded with two's-complement semantics.
 *
 * @param {number} field
 * @param {bigint | number} value
 * @returns {number[]}
 */
export function int64Field(field, value) {
  return [...tag(field, 0), ...varInt64(value)]
}

/**
 * Zigzag-encoded sint32 varint field.
 *
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
export function sint32Field(field, value) {
  const zz = value << 1 ^ value >> 31
  return [...tag(field, 0), ...varint(zz >>> 0)]
}

/**
 * @param {number[]} arr
 * @returns {Uint8Array}
 */
export function u8(arr) {
  return new Uint8Array(arr)
}
