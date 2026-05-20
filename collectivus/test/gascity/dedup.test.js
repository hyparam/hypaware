import { describe, expect, it } from 'vitest'
import { SessionDedup, UuidLruSet } from '../../src/gascity/dedup.js'

describe('UuidLruSet', () => {
  it('returns true on first observation and false on re-observation', () => {
    const set = new UuidLruSet()
    expect(set.observe('u-1')).toBe(true)
    expect(set.observe('u-1')).toBe(false)
  })

  it('evicts the oldest entry when limit is exceeded', () => {
    const set = new UuidLruSet(2)
    expect(set.observe('a')).toBe(true)
    expect(set.observe('b')).toBe(true)
    expect(set.observe('c')).toBe(true) // evicts 'a'
    expect(set.size).toBe(2)
    expect(set.observe('a')).toBe(true) // re-observed because it was evicted
  })

  it('promotes a re-observed uuid to most-recently-used', () => {
    const set = new UuidLruSet(2)
    set.observe('a')
    set.observe('b')
    set.observe('a') // promote 'a'
    set.observe('c') // evicts 'b' (oldest), keeps 'a' and 'c'
    expect(set.observe('a')).toBe(false) // still present
    expect(set.observe('b')).toBe(true) // was evicted
  })

  it('seed() accepts an iterable of uuids without throwing on duplicates', () => {
    const set = new UuidLruSet()
    set.seed(['a', 'b', 'a'])
    expect(set.size).toBe(2)
    expect(set.observe('a')).toBe(false)
    expect(set.observe('b')).toBe(false)
  })

  it('rejects non-positive limits', () => {
    expect(() => new UuidLruSet(0)).toThrow(/positive integer/)
    expect(() => new UuidLruSet(-5)).toThrow(/positive integer/)
    expect(() => new UuidLruSet(1.5)).toThrow(/positive integer/)
  })
})

describe('SessionDedup', () => {
  it('keys uuids per (city, sessionId)', () => {
    const dedup = new SessionDedup()
    expect(dedup.observe('hyptown', 's-1', 'u-1')).toBe(true)
    expect(dedup.observe('hyptown', 's-2', 'u-1')).toBe(true) // different session
    expect(dedup.observe('other', 's-1', 'u-1')).toBe(true) // different city
    expect(dedup.observe('hyptown', 's-1', 'u-1')).toBe(false) // re-observe
  })

  it('forgets dedup state when a session is retired', () => {
    const dedup = new SessionDedup()
    dedup.observe('hyptown', 's-1', 'u-1')
    dedup.forget('hyptown', 's-1')
    // Same uuid is treated as new after forget.
    expect(dedup.observe('hyptown', 's-1', 'u-1')).toBe(true)
  })

  it('seeds a session with known uuids', () => {
    const dedup = new SessionDedup()
    dedup.seed('hyptown', 's-1', ['u-1', 'u-2'])
    expect(dedup.observe('hyptown', 's-1', 'u-1')).toBe(false)
    expect(dedup.observe('hyptown', 's-1', 'u-2')).toBe(false)
    expect(dedup.observe('hyptown', 's-1', 'u-3')).toBe(true)
  })

  it('honors a custom limit', () => {
    const dedup = new SessionDedup({ limit: 1 })
    dedup.observe('hyptown', 's-1', 'a')
    dedup.observe('hyptown', 's-1', 'b') // evicts 'a'
    expect(dedup.observe('hyptown', 's-1', 'a')).toBe(true)
  })
})
