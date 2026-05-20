import { describe, expect, it } from 'vitest'
import {
  WIRE_I32,
  WIRE_I64,
  WIRE_LEN,
  WIRE_VARINT,
  readBytes,
  readDouble,
  readFixed32,
  readFixed64,
  readFloat,
  readSFixed32,
  readSFixed64,
  readTag,
  readVarBigInt,
  readVarint,
  skipField,
  zigzagDecode,
  zigzagDecodeBigInt,
} from '../src/protobuf.js'

/**
 * @param {number[]} bytes
 * @returns {{ view: DataView, offset: number }}
 */
function reader(bytes) {
  const buf = new Uint8Array(bytes)
  return { view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength), offset: 0 }
}

describe('readVarint', () => {
  it('reads single-byte varints', () => {
    const r = reader([0x00, 0x01, 0x7f])
    expect(readVarint(r)).toBe(0)
    expect(readVarint(r)).toBe(1)
    expect(readVarint(r)).toBe(127)
  })

  it('reads multi-byte varints', () => {
    // 150 = 0x96 0x01
    expect(readVarint(reader([0x96, 0x01]))).toBe(150)
    // 300 = 0xac 0x02
    expect(readVarint(reader([0xac, 0x02]))).toBe(300)
  })

  it('reads varints above 2^32', () => {
    // 2^33 = 8589934592 = 0x80 0x80 0x80 0x80 0x20
    expect(readVarint(reader([0x80, 0x80, 0x80, 0x80, 0x20]))).toBe(2 ** 33)
    // 2^53 - 1 = MAX_SAFE_INTEGER, 7 bytes of 0xff then 0x0f
    expect(readVarint(reader([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('advances offset', () => {
    const r = reader([0x96, 0x01, 0x05])
    readVarint(r)
    expect(r.offset).toBe(2)
  })
})

describe('readVarBigInt', () => {
  it('reads small values', () => {
    expect(readVarBigInt(reader([0x96, 0x01]))).toBe(150n)
  })

  it('reads max uint64', () => {
    // All bits set: 10 bytes of 0xff..0xff 0x01
    const r = reader([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    expect(readVarBigInt(r)).toBe(0xffffffffffffffffn)
  })
})

describe('zigzag', () => {
  it('decodes signed numbers', () => {
    expect(zigzagDecode(0)).toBe(0)
    expect(zigzagDecode(1)).toBe(-1)
    expect(zigzagDecode(2)).toBe(1)
    expect(zigzagDecode(3)).toBe(-2)
  })

  it('decodes signed bigints', () => {
    expect(zigzagDecodeBigInt(0n)).toBe(0n)
    expect(zigzagDecodeBigInt(1n)).toBe(-1n)
    expect(zigzagDecodeBigInt(2n)).toBe(1n)
  })
})

describe('readTag', () => {
  it('splits field number and wire type', () => {
    // field 1, wire type 2 (LEN): tag = (1 << 3) | 2 = 0x0a
    expect(readTag(reader([0x0a]))).toEqual({ fieldNumber: 1, wireType: WIRE_LEN })
    // field 2, wire type 0 (VARINT): tag = 0x10
    expect(readTag(reader([0x10]))).toEqual({ fieldNumber: 2, wireType: WIRE_VARINT })
    // multi-byte: field 16, wire type 0: tag = 128 = 0x80 0x01
    expect(readTag(reader([0x80, 0x01]))).toEqual({ fieldNumber: 16, wireType: WIRE_VARINT })
  })
})

describe('fixed-width reads', () => {
  it('reads fixed32 little-endian', () => {
    expect(readFixed32(reader([0x01, 0x00, 0x00, 0x00]))).toBe(1)
    expect(readFixed32(reader([0xff, 0xff, 0xff, 0xff]))).toBe(0xffffffff)
  })

  it('reads sfixed32 little-endian', () => {
    expect(readSFixed32(reader([0xff, 0xff, 0xff, 0xff]))).toBe(-1)
  })

  it('reads fixed64 / sfixed64', () => {
    const max = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    expect(readFixed64(reader(max))).toBe(0xffffffffffffffffn)
    expect(readSFixed64(reader(max))).toBe(-1n)
  })

  it('reads float', () => {
    // 1.0 as float32 LE
    expect(readFloat(reader([0x00, 0x00, 0x80, 0x3f]))).toBe(1)
  })

  it('reads double', () => {
    // 1.0 as float64 LE
    expect(readDouble(reader([0, 0, 0, 0, 0, 0, 0xf0, 0x3f]))).toBe(1)
  })
})

describe('readBytes', () => {
  it('reads length-delimited bytes', () => {
    // length 3, then "abc"
    const r = reader([0x03, 0x61, 0x62, 0x63])
    const bytes = readBytes(r)
    expect(Array.from(bytes)).toEqual([0x61, 0x62, 0x63])
    expect(r.offset).toBe(4)
  })

  it('reads empty bytes', () => {
    const r = reader([0x00])
    expect(readBytes(r).byteLength).toBe(0)
  })
})

describe('skipField', () => {
  it('skips varints', () => {
    const r = reader([0x96, 0x01, 0xff])
    skipField(r, WIRE_VARINT)
    expect(r.offset).toBe(2)
  })

  it('skips i64', () => {
    const r = reader([1, 2, 3, 4, 5, 6, 7, 8, 9])
    skipField(r, WIRE_I64)
    expect(r.offset).toBe(8)
  })

  it('skips i32', () => {
    const r = reader([1, 2, 3, 4, 5])
    skipField(r, WIRE_I32)
    expect(r.offset).toBe(4)
  })

  it('skips length-delimited', () => {
    const r = reader([0x03, 0x61, 0x62, 0x63, 0xff])
    skipField(r, WIRE_LEN)
    expect(r.offset).toBe(4)
  })

  it('throws on unknown wire type', () => {
    expect(() => skipField(reader([0]), 7)).toThrow(/wire type/)
  })
})

describe('full message round-trip', () => {
  it('decodes a simple message field-by-field', () => {
    // Message: field 1 (varint) = 150, field 2 (string) = "abc"
    // Wire: 0x08 0x96 0x01 0x12 0x03 0x61 0x62 0x63
    const r = reader([0x08, 0x96, 0x01, 0x12, 0x03, 0x61, 0x62, 0x63])

    const t1 = readTag(r)
    expect(t1).toEqual({ fieldNumber: 1, wireType: WIRE_VARINT })
    expect(readVarint(r)).toBe(150)

    const t2 = readTag(r)
    expect(t2).toEqual({ fieldNumber: 2, wireType: WIRE_LEN })
    expect(new TextDecoder().decode(readBytes(r))).toBe('abc')

    expect(r.offset).toBe(r.view.byteLength)
  })
})
