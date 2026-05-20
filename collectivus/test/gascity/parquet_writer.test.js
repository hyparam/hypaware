import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { ParquetWriter } from '../../src/gascity/parquet_writer.js'
import { GASCITY_GATEWAY_ID, GASCITY_MESSAGES_SCHEMA_VERSION } from '../../src/gascity/schema.js'

/**
 * Build the row shape the writer expects. The writer treats `provider_uuid`
 * and the non-nullable schema columns as required; the helper fills sensible
 * defaults so individual tests only set the fields they care about.
 *
 * @param {Partial<import('../../src/gascity/normalizers/types.d.ts').NormalizedRow> & { provider_uuid: string }} overrides
 * @returns {import('../../src/gascity/normalizers/types.d.ts').NormalizedRow}
 */
function makeRow(overrides) {
  return /** @type {import('../../src/gascity/normalizers/types.d.ts').NormalizedRow} */ ({
    schema_version: GASCITY_MESSAGES_SCHEMA_VERSION,
    city: 'hyptown',
    gascity_session_id: 'hy-1',
    gascity_template: 'desktop/refinery',
    gascity_rig: 'collectivus',
    gascity_alias: null,
    gateway_id: GASCITY_GATEWAY_ID,
    provider: 'claude',
    provider_session_id: 'hy-1',
    date: '2026-05-14',
    provider_uuid: overrides.provider_uuid,
    message_id: null,
    part_index: 0,
    part_type: 'text',
    cwd: null,
    git_branch: null,
    permission_mode: null,
    is_sidechain: null,
    entrypoint: null,
    client_version: null,
    prompt_id: null,
    request_id: null,
    parent_uuid: null,
    source_tool_assistant_uuid: null,
    message_created_at: '2026-05-14T00:00:00Z',
    conversation_started_at: null,
    model: null,
    stop_reason: null,
    stop_details: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ephemeral_1h_input_tokens: null,
    ephemeral_5m_input_tokens: null,
    service_tier: null,
    inference_geo: null,
    speed: null,
    content_text: null,
    thinking_signature: null,
    tool_name: null,
    tool_call_id: null,
    tool_args: null,
    caller_type: null,
    tool_result_for: null,
    is_error: null,
    attachment_type: null,
    hook_event: null,
    attributes: null,
    raw_frame: null,
    ...overrides,
  })
}

const ctx = /** @type {import('../../src/gascity/types.d.ts').SessionContext} */ ({
  city: 'hyptown',
  sessionId: 'hy-1',
  template: 'desktop/refinery',
  rig: 'collectivus',
  alias: undefined,
})

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memoStream() {
  let buf = ''
  return { write: (s) => { buf += s }, value: () => buf }
}

describe('ParquetWriter', () => {
  /** @type {string} */
  let sinkRoot
  beforeEach(async () => {
    sinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-writer-'))
  })
  afterEach(async () => {
    await fs.rm(sinkRoot, { recursive: true, force: true })
  })

  it('flushes when the row threshold is reached and writes a readable parquet', async () => {
    const writer = new ParquetWriter({
      sinkRoot,
      stderr: memoStream(),
      flushRows: 2,
      flushIntervalMs: 60_000, // long enough that only the threshold triggers
    })
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-1' })])
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-2' })])
    await writer.flushAll() // drain pending writes deterministically
    await writer.stop()

    const partDir = await fs.readdir(path.join(sinkRoot, `date=${today()}`, 'city=hyptown'))
    expect(partDir).toEqual(['part-hy-1-0.parquet'])

    const buf = await fs.readFile(path.join(sinkRoot, `date=${today()}`, 'city=hyptown', 'part-hy-1-0.parquet'))
    const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const rows = /** @type {Array<Record<string, unknown>>} */ (await parquetReadObjects({ file, compressors }))
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.provider_uuid)).toEqual(['u-1', 'u-2'])

    const cursor = JSON.parse(await fs.readFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'hy-1.json'),
      'utf8'
    ))
    expect(cursor.last_uuid).toBe('u-2')
    expect(cursor.flushed_count).toBe(2)
    expect(cursor.schema_version).toBe(GASCITY_MESSAGES_SCHEMA_VERSION)
    expect(cursor.retired).toBe(false)
  })

  it('drops duplicate (provider_session_id, provider_uuid) rows before they reach disk', async () => {
    const writer = new ParquetWriter({ sinkRoot, stderr: memoStream(), flushRows: 5, flushIntervalMs: 60_000 })
    await writer.append(ctx, [
      makeRow({ provider_uuid: 'u-1' }),
      makeRow({ provider_uuid: 'u-2' }),
    ])
    await writer.append(ctx, [
      makeRow({ provider_uuid: 'u-1' }), // duplicate of an in-buffer row
      makeRow({ provider_uuid: 'u-3' }),
    ])
    await writer.flushAll()
    await writer.stop()

    const buf = await fs.readFile(path.join(sinkRoot, `date=${today()}`, 'city=hyptown', 'part-hy-1-0.parquet'))
    const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const rows = /** @type {Array<Record<string, unknown>>} */ (await parquetReadObjects({ file, compressors }))
    expect(rows.map((r) => r.provider_uuid)).toEqual(['u-1', 'u-2', 'u-3'])
  })

  it('keeps separate buffers per (city, session)', async () => {
    const writer = new ParquetWriter({ sinkRoot, stderr: memoStream(), flushRows: 1, flushIntervalMs: 60_000 })
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-1' })])
    await writer.append(
      /** @type {import('../../src/gascity/types.d.ts').SessionContext} */ ({ ...ctx, sessionId: 'hy-2' }),
      [makeRow({ provider_session_id: 'hy-2', gascity_session_id: 'hy-2', provider_uuid: 'u-1' })]
    )
    await writer.flushAll()
    await writer.stop()

    const partDir = await fs.readdir(path.join(sinkRoot, `date=${today()}`, 'city=hyptown'))
    expect(partDir.sort()).toEqual(['part-hy-1-0.parquet', 'part-hy-2-0.parquet'])
  })

  it('keeps slashed session ids inside the parquet filename', async () => {
    const writer = new ParquetWriter({ sinkRoot, stderr: memoStream(), flushRows: 1, flushIntervalMs: 60_000 })
    await writer.append(
      /** @type {import('../../src/gascity/types.d.ts').SessionContext} */ ({
        ...ctx,
        sessionId: 'azworld/gastown.worker',
      }),
      [makeRow({
        provider_session_id: 'azworld/gastown.worker',
        gascity_session_id: 'azworld/gastown.worker',
        provider_uuid: 'u-1',
      })]
    )
    await writer.flushAll()
    await writer.stop()

    const partDir = await fs.readdir(path.join(sinkRoot, `date=${today()}`, 'city=hyptown'))
    expect(partDir).toEqual(['part-azworld%2Fgastown.worker-0.parquet'])
  })

  it('increments the per-day counter across flushes', async () => {
    const writer = new ParquetWriter({ sinkRoot, stderr: memoStream(), flushRows: 1, flushIntervalMs: 60_000 })
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-1' })])
    await writer.flushAll()
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-2' })])
    await writer.flushAll()
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-3' })])
    await writer.flushAll()
    await writer.stop()

    const partDir = await fs.readdir(path.join(sinkRoot, `date=${today()}`, 'city=hyptown'))
    expect(partDir.sort()).toEqual([
      'part-hy-1-0.parquet',
      'part-hy-1-1.parquet',
      'part-hy-1-2.parquet',
    ])
  })

  it('marks the cursor retired when a session is retired and flushes pending rows', async () => {
    const writer = new ParquetWriter({ sinkRoot, stderr: memoStream(), flushRows: 1000, flushIntervalMs: 60_000 })
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-1' })])
    await writer.retireSession('hyptown', 'hy-1')
    await writer.stop()

    const partDir = await fs.readdir(path.join(sinkRoot, `date=${today()}`, 'city=hyptown'))
    expect(partDir).toEqual(['part-hy-1-0.parquet'])

    const cursor = JSON.parse(await fs.readFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'hy-1.json'),
      'utf8'
    ))
    expect(cursor.retired).toBe(true)
    expect(cursor.last_uuid).toBe('u-1')
  })

  it('retireSession marks the cursor even when nothing was ever appended', async () => {
    const writer = new ParquetWriter({ sinkRoot, stderr: memoStream() })
    await writer.retireSession('hyptown', 'hy-1')
    await writer.stop()

    const cursor = JSON.parse(await fs.readFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'hy-1.json'),
      'utf8'
    ))
    expect(cursor.retired).toBe(true)
    expect(cursor.last_uuid).toBeUndefined()
  })

  it('resumes flushed_count and dedup awareness from an existing cursor', async () => {
    // Pre-stage a cursor as if a previous daemon had already flushed two rows.
    await fs.mkdir(path.join(sinkRoot, '.cursors', 'hyptown'), { recursive: true })
    await fs.writeFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'hy-1.json'),
      JSON.stringify({
        last_uuid: 'u-1',
        last_seq: 2,
        flushed_count: 2,
        retired: false,
        schema_version: GASCITY_MESSAGES_SCHEMA_VERSION,
      }) + '\n',
      'utf8'
    )

    const writer = new ParquetWriter({ sinkRoot, stderr: memoStream(), flushRows: 1, flushIntervalMs: 60_000 })
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-2' })])
    await writer.flushAll()
    await writer.stop()

    const cursor = JSON.parse(await fs.readFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'hy-1.json'),
      'utf8'
    ))
    expect(cursor.flushed_count).toBe(3) // 2 prior + 1 new
    expect(cursor.last_uuid).toBe('u-2')
  })

  it('does not write a partial parquet when the encoder throws', async () => {
    const writer = new ParquetWriter({
      sinkRoot,
      stderr: memoStream(),
      flushRows: 1,
      flushIntervalMs: 60_000,
      parquetWriteBuffer: () => { throw new Error('disk full') },
    })
    await writer.append(ctx, [makeRow({ provider_uuid: 'u-1' })])
    await writer.flushAll()

    const partDir = path.join(sinkRoot, `date=${today()}`, 'city=hyptown')
    /** @type {string[]} */
    let entries = []
    try { entries = await fs.readdir(partDir) } catch { /* not created */ }
    expect(entries).toEqual([])

    // Cursor file should also not have been written on failure.
    await expect(fs.access(path.join(sinkRoot, '.cursors', 'hyptown', 'hy-1.json')))
      .rejects.toThrow()

    await writer.stop()
  })

  it('getLastFlushedUuid reads from disk for sessions without an in-memory buffer', async () => {
    await fs.mkdir(path.join(sinkRoot, '.cursors', 'hyptown'), { recursive: true })
    await fs.writeFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'hy-9.json'),
      JSON.stringify({ last_uuid: 'u-last', retired: false }) + '\n',
      'utf8'
    )
    const writer = new ParquetWriter({ sinkRoot, stderr: memoStream() })
    expect(await writer.getLastFlushedUuid('hyptown', 'hy-9')).toBe('u-last')
    await writer.stop()
  })

  it('drops rows that do not carry a provider_uuid and logs once per drop', async () => {
    const stderr = memoStream()
    const writer = new ParquetWriter({ sinkRoot, stderr, flushRows: 5, flushIntervalMs: 60_000 })
    // Build a row missing provider_uuid; cast through unknown to bypass the
    // type-check (the writer must defensively reject this at runtime).
    const bad = /** @type {import('../../src/gascity/normalizers/types.d.ts').NormalizedRow} */ (
      /** @type {unknown} */ ({
        schema_version: GASCITY_MESSAGES_SCHEMA_VERSION,
        city: 'hyptown',
        provider_session_id: 'hy-1',
        provider: 'claude',
        message_created_at: '2026-05-14T00:00:00Z',
        part_index: 0,
        part_type: 'text',
      })
    )
    await writer.append(ctx, [bad])
    await writer.flushAll()
    await writer.stop()

    expect(stderr.value()).toMatch(/writer_drop_no_uuid/)

    // No parquet should exist.
    const partDir = path.join(sinkRoot, `date=${today()}`, 'city=hyptown')
    /** @type {string[]} */
    let entries = []
    try { entries = await fs.readdir(partDir) } catch { /* not created */ }
    expect(entries).toEqual([])
  })
})

/**
 * @returns {string}
 */
function today() {
  return new Date().toISOString().slice(0, 10)
}
