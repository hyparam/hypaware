import { describe, expect, it } from 'vitest'
import {
  GASCITY_MESSAGES_COLUMNS,
  GASCITY_MESSAGES_COLUMNS_BY_NAME,
  GASCITY_MESSAGES_SCHEMA_VERSION,
  coerceCell,
  rowsToColumnData,
} from '../../src/gascity/schema.js'

describe('gascity_messages schema', () => {
  it('ships a stable column order', () => {
    // First ten columns are the partition-/identity-defining ones the writer
    // relies on for path composition and dedup. If this test fails, the
    // schema reordered in a way that requires a schema_version bump.
    expect(GASCITY_MESSAGES_COLUMNS.slice(0, 10).map((c) => c.name)).toEqual([
      'schema_version',
      'city',
      'gascity_session_id',
      'gascity_template',
      'gascity_rig',
      'gascity_alias',
      'gateway_id',
      'provider',
      'provider_session_id',
      'date',
    ])
  })

  it('declares the columns the bead spec requires', () => {
    const names = new Set(GASCITY_MESSAGES_COLUMNS.map((c) => c.name))
    // Gascity-gained fields the epic enumerates.
    for (const required of [
      'gascity_template', 'gascity_rig', 'gascity_alias', 'gateway_id',
      'permission_mode', 'is_sidechain', 'entrypoint', 'client_version',
      'prompt_id', 'request_id', 'parent_uuid', 'source_tool_assistant_uuid',
      'caller_type', 'attachment_type', 'hook_event',
    ]) {
      expect(names.has(required), `missing column ${required}`).toBe(true)
    }
    // Wire-contract columns the normalizer emits.
    for (const required of [
      'conversation_started_at', 'cwd', 'git_branch',
      'message_id', 'message_created_at', 'part_index', 'part_type',
      'content_text', 'tool_name', 'tool_call_id', 'tool_args',
      'tool_result_for', 'is_error', 'thinking_signature', 'attributes',
    ]) {
      expect(names.has(required), `missing column ${required}`).toBe(true)
    }
    // Token usage with cache breakdown.
    for (const required of [
      'input_tokens', 'output_tokens', 'cache_read_input_tokens',
      'cache_creation_input_tokens', 'ephemeral_5m_input_tokens',
      'ephemeral_1h_input_tokens',
    ]) {
      expect(names.has(required), `missing column ${required}`).toBe(true)
    }
    // Escape hatch.
    expect(names.has('raw_frame')).toBe(true)
  })

  it('builds a by-name lookup that matches the column array', () => {
    expect(GASCITY_MESSAGES_COLUMNS_BY_NAME.size).toBe(GASCITY_MESSAGES_COLUMNS.length)
    for (const col of GASCITY_MESSAGES_COLUMNS) {
      expect(GASCITY_MESSAGES_COLUMNS_BY_NAME.get(col.name)).toBe(col)
    }
  })

  it('exports a positive schema_version', () => {
    expect(GASCITY_MESSAGES_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(GASCITY_MESSAGES_SCHEMA_VERSION)).toBe(true)
  })

  describe('coerceCell', () => {
    it('rejects null for non-nullable columns', () => {
      const spec = GASCITY_MESSAGES_COLUMNS_BY_NAME.get('gateway_id')
      expect(spec?.nullable).toBe(false)
      expect(() => coerceCell(/** @type {import('../../src/upload/upload.d.ts').ColumnSpec} */ (spec), null))
        .toThrow(/required column "gateway_id"/)
    })

    it('passes through null for nullable columns', () => {
      const spec = GASCITY_MESSAGES_COLUMNS_BY_NAME.get('model')
      expect(coerceCell(/** @type {import('../../src/upload/upload.d.ts').ColumnSpec} */ (spec), null))
        .toBeUndefined()
    })

    it('coerces TIMESTAMP from strings and numbers to Date', () => {
      const spec = GASCITY_MESSAGES_COLUMNS_BY_NAME.get('message_created_at')
      const fromStr = coerceCell(/** @type {import('../../src/upload/upload.d.ts').ColumnSpec} */ (spec), '2026-05-14T00:00:00Z')
      expect(fromStr).toBeInstanceOf(Date)
      const fromNum = coerceCell(/** @type {import('../../src/upload/upload.d.ts').ColumnSpec} */ (spec), 1715644800000)
      expect(fromNum).toBeInstanceOf(Date)
    })

    it('coerces INT64 from number/bigint/string to bigint', () => {
      const spec = GASCITY_MESSAGES_COLUMNS_BY_NAME.get('input_tokens')
      expect(coerceCell(/** @type {import('../../src/upload/upload.d.ts').ColumnSpec} */ (spec), 42)).toBe(42n)
      expect(coerceCell(/** @type {import('../../src/upload/upload.d.ts').ColumnSpec} */ (spec), '42')).toBe(42n)
      expect(coerceCell(/** @type {import('../../src/upload/upload.d.ts').ColumnSpec} */ (spec), 42n)).toBe(42n)
    })
  })

  describe('rowsToColumnData', () => {
    it('emits one column entry per schema column in declared order', () => {
      const data = rowsToColumnData([])
      expect(data.map((c) => c.name)).toEqual(GASCITY_MESSAGES_COLUMNS.map((c) => c.name))
      for (const col of data) expect(col.data).toEqual([])
    })

    it('coerces row values column-by-column', () => {
      const row = {
        schema_version: GASCITY_MESSAGES_SCHEMA_VERSION,
        city: 'hyptown',
        gascity_session_id: 'hy-1',
        gateway_id: 'gascity-scribe',
        provider: 'claude',
        provider_session_id: 'hy-1',
        date: '2026-05-14',
        provider_uuid: 'u-1',
        part_index: 0,
        part_type: 'text',
        message_created_at: '2026-05-14T00:00:00Z',
        content_text: 'hi',
        input_tokens: 12,
      }
      const data = rowsToColumnData([row])
      const byName = new Map(data.map((c) => [c.name, c]))
      expect(byName.get('provider')?.data).toEqual(['claude'])
      expect(byName.get('part_index')?.data).toEqual([0])
      expect(byName.get('content_text')?.data).toEqual(['hi'])
      expect(byName.get('message_created_at')?.data[0]).toBeInstanceOf(Date)
      expect(byName.get('input_tokens')?.data).toEqual([12n])
      expect(byName.get('model')?.data).toEqual([undefined])
    })
  })
})
