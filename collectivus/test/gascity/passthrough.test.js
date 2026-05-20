import { describe, expect, it } from 'vitest'
import { passthroughNormalize } from '../../src/gascity/passthrough.js'
import { GASCITY_GATEWAY_ID, GASCITY_MESSAGES_SCHEMA_VERSION } from '../../src/gascity/schema.js'

/** @type {import('../../src/gascity/types.d.ts').SessionContext} */
const ctx = {
  city: 'hyptown',
  sessionId: 'hy-1',
  template: 'desktop/refinery',
  rig: 'collectivus',
  alias: 'collectivus/refinery',
}

describe('passthroughNormalize', () => {
  it('emits one row with the entire envelope in raw_frame', () => {
    const envelope = { provider: 'gemini', uuid: 'u-1', timestamp: '2026-05-14T00:00:00Z', any: 'thing' }
    const rows = passthroughNormalize(envelope, ctx)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.schema_version).toBe(GASCITY_MESSAGES_SCHEMA_VERSION)
    expect(row.city).toBe('hyptown')
    expect(row.gascity_session_id).toBe('hy-1')
    expect(row.provider_session_id).toBe('hy-1')
    expect(row.provider_uuid).toBe('u-1')
    expect(row.provider).toBe('gemini')
    expect(row.gateway_id).toBe(GASCITY_GATEWAY_ID)
    expect(row.date).toBe('2026-05-14')
    expect(row.part_type).toBe('raw_frame')
    expect(row.part_index).toBe(0)
    expect(row.gascity_template).toBe('desktop/refinery')
    expect(row.gascity_rig).toBe('collectivus')
    expect(row.gascity_alias).toBe('collectivus/refinery')
    expect(row.raw_frame).toBe(envelope)
  })

  it('drops frames with no uuid since dedup requires one', () => {
    const rows = passthroughNormalize({ provider: 'gemini', timestamp: '2026-05-14T00:00:00Z' }, ctx)
    expect(rows).toEqual([])
  })

  it('falls through to provider="unknown" when no provider tag is present', () => {
    const rows = passthroughNormalize({ uuid: 'u-2', timestamp: '2026-05-14T00:00:00Z' }, ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe('unknown')
  })

  it('reads provider/timestamp from nested frame envelopes', () => {
    const rows = passthroughNormalize({
      frame: {
        provider: 'gemini',
        uuid: 'u-3',
        timestamp: '2026-05-14T12:34:56Z',
      },
    }, ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe('gemini')
    expect(rows[0].provider_uuid).toBe('u-3')
    expect(rows[0].message_created_at).toBe('2026-05-14T12:34:56Z')
  })

  it('uses an ISO string for the current time when no timestamp is present', () => {
    const before = Date.now()
    const rows = passthroughNormalize({ provider: 'x', uuid: 'u-4' }, ctx)
    const after = Date.now()
    const ts = rows[0].message_created_at
    expect(typeof ts).toBe('string')
    const t = new Date(/** @type {string} */ (ts)).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after)
  })
})
