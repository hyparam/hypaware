import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collect } from 'squirreling'
import { parseQueryArgs, runQuery } from '../../src/cli/query.js'
import { ParquetWriter } from '../../src/gascity/parquet_writer.js'
import { GASCITY_GATEWAY_ID, GASCITY_MESSAGES_SCHEMA_VERSION } from '../../src/gascity/schema.js'
import { QUERY_CACHE_SCHEMA_VERSION } from '../../src/query/schema.js'
import { prepareReadOnlySql } from '../../src/query/sql.js'
import { executeSqlWithRandomSample, getRandomSamplePlan } from '../../src/query/random-sample.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/** @type {string} */
let tmpDir
/** @type {string} */
let sinkDir
/** @type {string} */
let configPath
/** @type {string | undefined} */
let originalHome

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-query-'))
  sinkDir = path.join(tmpDir, 'sink')
  configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    sink: { type: 'file', dir: sinkDir },
    query: { cache: { enabled: true } },
  }))
  // Pin `os.homedir()` to the test's tmp dir so `defaultGascityRoot()` lands
  // under it. The gascity source has no JSONL stage — its sink IS the parquet
  // store, so query-time discovery reads `<HOME>/.collectivus/sink/gascity_messages/`
  // directly.
  originalHome = process.env.HOME
  process.env.HOME = tmpDir
})

afterEach(function() {
  vi.restoreAllMocks()
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Resolve the gascity sink root for the current test (mirrors
 * `defaultGascityRoot()`).
 *
 * @returns {string}
 */
function gascitySinkRoot() {
  return path.join(tmpDir, '.collectivus', 'sink', 'gascity_messages')
}

/**
 * Write one or more fixture sessions of gascity rows through the real
 * `ParquetWriter` so the resulting on-disk layout matches what the daemon
 * produces.
 *
 * @param {Array<{
 *   city: string,
 *   sessionId: string,
 *   template?: string,
 *   rig?: string,
 *   alias?: string,
 *   rows: Array<Partial<import('../../src/gascity/normalizers/types.d.ts').NormalizedRow> & { provider_uuid: string }>,
 * }>} sessions
 * @returns {Promise<void>}
 */
async function writeGascityFixtures(sessions) {
  const sinkRoot = gascitySinkRoot()
  fs.mkdirSync(sinkRoot, { recursive: true })
  const writer = new ParquetWriter({
    sinkRoot,
    stderr: { write() {} },
    flushIntervalMs: 60_000_000,
  })
  for (const session of sessions) {
    /** @type {import('../../src/gascity/types.d.ts').SessionContext} */
    const ctx = {
      city: session.city,
      sessionId: session.sessionId,
      template: session.template,
      rig: session.rig,
      alias: session.alias,
    }
    const rows = session.rows.map((overrides) => makeGascityRow({
      city: session.city,
      gascity_session_id: session.sessionId,
      gascity_template: session.template,
      gascity_rig: session.rig,
      gascity_alias: session.alias,
      provider_session_id: session.sessionId,
      ...overrides,
    }))
    await writer.append(ctx, rows)
  }
  await writer.flushAll()
  await writer.stop()
}

/**
 * @param {Partial<import('../../src/gascity/normalizers/types.d.ts').NormalizedRow> & { provider_uuid: string, city?: string, gascity_session_id?: string, provider_session_id?: string }} overrides
 * @returns {import('../../src/gascity/normalizers/types.d.ts').NormalizedRow}
 */
function makeGascityRow(overrides) {
  return /** @type {import('../../src/gascity/normalizers/types.d.ts').NormalizedRow} */ ({
    schema_version: GASCITY_MESSAGES_SCHEMA_VERSION,
    city: overrides.city ?? 'hyptown',
    gascity_session_id: overrides.gascity_session_id ?? 'hy-1',
    gascity_template: undefined,
    gascity_rig: undefined,
    gascity_alias: undefined,
    gateway_id: GASCITY_GATEWAY_ID,
    provider: 'claude',
    provider_session_id: overrides.provider_session_id ?? overrides.gascity_session_id ?? 'hy-1',
    date: '2026-05-14',
    message_id: undefined,
    part_index: 0,
    part_type: 'text',
    cwd: undefined,
    git_branch: undefined,
    permission_mode: undefined,
    is_sidechain: undefined,
    entrypoint: undefined,
    client_version: undefined,
    prompt_id: undefined,
    request_id: undefined,
    parent_uuid: undefined,
    source_tool_assistant_uuid: undefined,
    message_created_at: '2026-05-14T00:00:00Z',
    conversation_started_at: undefined,
    model: undefined,
    stop_reason: undefined,
    stop_details: undefined,
    input_tokens: undefined,
    output_tokens: undefined,
    cache_creation_input_tokens: undefined,
    cache_read_input_tokens: undefined,
    ephemeral_1h_input_tokens: undefined,
    ephemeral_5m_input_tokens: undefined,
    service_tier: undefined,
    inference_geo: undefined,
    speed: undefined,
    content_text: undefined,
    thinking_signature: undefined,
    tool_name: undefined,
    tool_call_id: undefined,
    tool_args: undefined,
    caller_type: undefined,
    tool_result_for: undefined,
    is_error: undefined,
    attachment_type: undefined,
    hook_event: undefined,
    attributes: undefined,
    raw_frame: undefined,
    ...overrides,
  })
}

/**
 * @param {string} gatewayId
 * @param {'logs' | 'traces' | 'metrics' | 'proxy'} signal
 * @param {string} date
 * @param {Record<string, unknown>[]} rows
 * @returns {string}
 */
function writeJsonl(gatewayId, signal, date, rows) {
  const dir = path.join(sinkDir, gatewayId, signal)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${date}.jsonl`)
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return filePath
}

/**
 * @param {string} date
 * @param {string} content
 * @returns {Record<string, unknown>}
 */
function proxyExchange(date, content) {
  return {
    exchange_id: `ex-${date}`,
    kind: 'exchange',
    ts_start: `${date}T10:00:00.000Z`,
    ts_end: `${date}T10:00:00.250Z`,
    duration_ms: 250,
    upstream: 'anthropic',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content }],
      }),
    },
    response: { status: 200, headers: {}, body: '{}' },
    stream_event_count: 0,
  }
}

function writeAllSignals() {
  writeJsonl('gw1', 'logs', '2026-05-11', [
    {
      serviceName: 'svc-a',
      timestamp: '2026-05-11T10:00:00.000Z',
      severityNumber: 17,
      severityText: 'ERROR',
      body: 'boom',
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    },
  ])
  writeJsonl('gw1', 'traces', '2026-05-11', [
    {
      serviceName: 'svc-a',
      traceId: 'trace-1',
      spanId: 'span-1',
      name: 'GET /slow',
      startTimestamp: '2026-05-11T10:00:00.000Z',
      endTimestamp: '2026-05-11T10:00:01.250Z',
      durationMs: 1250,
      status: { code: 2 },
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    },
  ])
  writeJsonl('gw1', 'metrics', '2026-05-11', [
    {
      serviceName: 'svc-a',
      metricName: 'latency.ms',
      metricType: 'gauge',
      timestamp: '2026-05-11T10:00:00.000Z',
      value: 12.5,
      valueType: 'double',
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    },
  ])
  writeJsonl('gw1', 'proxy', '2026-05-11', [
    {
      exchange_id: 'ex-1',
      kind: 'exchange',
      ts_start: '2026-05-11T10:00:00.000Z',
      ts_end: '2026-05-11T10:00:00.250Z',
      duration_ms: 250,
      upstream: 'anthropic',
      request: { method: 'POST', path: '/v1/messages', headers: {}, body: '{}' },
      response: { status: 500, headers: {}, body: 'err' },
      stream_event_count: 1,
    },
    { exchange_id: 'ex-1', kind: 'stream_event', t_ms: 10, event: 'message', data: '{"text":"hi"}' },
  ])
}

/**
 * @param {string} dataset
 * @param {string} gatewayId
 * @param {string} date
 * @returns {string}
 */
function cacheCursorPath(dataset, gatewayId, date) {
  return path.join(
    sinkDir,
    '.collectivus-query',
    'cache',
    'datasets',
    dataset,
    `gateway_id=${gatewayId}`,
    `date=${date}`,
    'cursor.json'
  )
}

/**
 * @param {string} cursorPath
 * @returns {Record<string, any>}
 */
function readCursor(cursorPath) {
  return JSON.parse(fs.readFileSync(cursorPath, 'utf8'))
}

/**
 * @param {string} sql
 * @returns {number | undefined}
 */
function preparedTopLevelLimit(sql) {
  let { statement } = prepareReadOnlySql(sql, 100)
  while (statement.type === 'with') statement = statement.query
  return statement.limit
}

describe('ctvs query result limits', function() {
  it('defaults and clamps top-level SQL result limits to 100', function() {
    expect(preparedTopLevelLimit('select * from logs')).toBe(100)
    expect(preparedTopLevelLimit('select * from logs limit 500')).toBe(100)
    expect(preparedTopLevelLimit('select * from logs limit 20')).toBe(20)
    expect(preparedTopLevelLimit('with recent as (select * from logs limit 500) select * from recent')).toBe(100)
  })

  it('rejects --limit values above the hard cap', function() {
    expect(parseQueryArgs(['logs', '--limit', '100']).error).toBeUndefined()
    expect(parseQueryArgs(['logs', '--limit', '101']).error).toBe('--limit must be an integer between 1 and 100')
  })
})

describe('ctvs query random sampling', function() {
  it('detects top-level ORDER BY RANDOM() LIMIT queries', function() {
    const plan = getRandomSamplePlan(prepareReadOnlySql('select * from logs order by random() limit 10', 100).statement)
    expect(plan?.limit).toBe(10)
  })

  it('reservoir-samples ORDER BY RANDOM() LIMIT without sorting the full result', async function() {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.7)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.1)

    const rows = Array.from({ length: 5 }, (_, id) => ({ id }))
    const result = await collect(executeSqlWithRandomSample({
      tables: { logs: rows },
      query: 'select * from logs order by random() limit 2',
    }))

    expect(result).toHaveLength(2)
    expect(result.map((row) => row.id).sort()).toEqual([2, 4])
  })
})

describe('ctvs query', function() {
  it('refreshes local JSONL into partitioned query-cache Iceberg tables with cursors', async function() {
    writeAllSignals()
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(['refresh', '--all', '--config', configPath], { stdout, stderr })
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    // proxy now materialises a single `proxy_messages` partition (was
    // proxy_exchanges + proxy_stream_events) so the per-source partition count
    // drops from 5 to 4 for the same JSONL fixtures.
    expect(stdout.value()).toMatch(/Done\. 4 file\(s\) written/)

    const proxyCursorPath = cacheCursorPath('proxy_messages', 'gw1', '2026-05-11')
    expect(fs.existsSync(proxyCursorPath)).toBe(true)
    const cursor = readCursor(proxyCursorPath)
    expect(cursor).toMatchObject({
      cache_schema_version: QUERY_CACHE_SCHEMA_VERSION,
      kind: 'builtin',
      dataset: 'proxy_messages',
      gateway_id: 'gw1',
      date: '2026-05-11',
    })
    expect(fs.readdirSync(path.join(cursor.table_path, 'metadata')).some((entry) => /\.metadata\.json$/.test(entry))).toBe(true)
  })

  it('refreshes only explicit JSONL files by default', async function() {
    writeAllSignals()
    const logPath = path.join(sinkDir, 'gw1', 'logs', '2026-05-11.jsonl')
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(['refresh', logPath, '--config', configPath], { stdout, stderr })
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toMatch(/Done\. 1 file\(s\) written/)

    expect(fs.existsSync(cacheCursorPath('logs', 'gw1', '2026-05-11'))).toBe(true)
    expect(fs.existsSync(cacheCursorPath('traces', 'gw1', '2026-05-11'))).toBe(false)
    expect(fs.existsSync(cacheCursorPath('metrics', 'gw1', '2026-05-11'))).toBe(false)
    expect(fs.existsSync(cacheCursorPath('proxy_messages', 'gw1', '2026-05-11'))).toBe(false)
  })

  it('refreshes large JSONL sources across multiple bounded batches', async function() {
    const rows = Array.from({ length: 5_001 }, (_, i) => ({
      serviceName: 'svc-a',
      timestamp: '2026-05-11T10:00:00.000Z',
      body: `line-${i}`,
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    }))
    writeJsonl('gw1', 'logs', '2026-05-11', rows)

    const stdout = memo()
    const stderr = memo()
    expect(await runQuery(['refresh', '--all', '--config', configPath], { stdout, stderr })).toBe(0)
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toMatch(/5001 rows/)

    const cursor = readCursor(cacheCursorPath('logs', 'gw1', '2026-05-11'))
    expect(cursor.row_count).toBe(5_001)

    const sqlOut = memo()
    expect(await runQuery([
      'sql',
      'select count(*) as n from logs',
      '--config', configPath,
      '--format', 'json',
    ], { stdout: sqlOut, stderr: memo() })).toBe(0)
    expect(JSON.parse(sqlOut.value())).toEqual([{ n: 5_001 }])
  })

  it('requires source files or --all for explicit refresh', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(['refresh', '--config', configPath], { stdout, stderr })
    expect(code).toBe(2)
    expect(stdout.value()).toBe('')
    expect(stderr.value()).toMatch(/refresh requires one or more JSONL files/)

    const datasetStdout = memo()
    const datasetStderr = memo()
    expect(await runQuery(['refresh', 'logs', '--config', configPath], {
      stdout: datasetStdout,
      stderr: datasetStderr,
    })).toBe(2)
    expect(datasetStdout.value()).toBe('')
    expect(datasetStderr.value()).toMatch(/pass --all to refresh all logs sources/)
  })

  it('does not auto-refresh by default and prints the refresh command', async function() {
    writeJsonl('gw1', 'logs', '2026-05-11', [
      { serviceName: 'svc-a', timestamp: '2026-05-11T10:00:00.000Z', body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(['logs', '--config', configPath], { stdout, stderr })
    expect(code).toBe(1)
    expect(stdout.value()).toBe('')
    expect(stderr.value()).toMatch(/query cache is missing/)
    expect(stderr.value()).toMatch(/Run: ctvs query refresh .*\/gw1\/logs\/2026-05-11\.jsonl --config/)
  })

  it('supports --refresh always for sql and rejects arbitrary file paths', async function() {
    writeJsonl('gw1', 'logs', '2026-05-11', [
      { serviceName: 'svc-a', timestamp: '2026-05-11T10:00:00.000Z', body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery([
      'sql',
      'select gateway_id, serviceName, body from logs',
      '--config', configPath,
      '--refresh', 'always',
    ], { stdout, stderr })
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toMatch(/gw1\s+svc-a\s+hi/)

    const badOut = memo()
    const badErr = memo()
    const badCode = await runQuery([
      'sql',
      'select * from "/tmp/not-allowed.parquet"',
      '--config', configPath,
    ], { stdout: badOut, stderr: badErr })
    expect(badCode).toBe(2)
    expect(badErr.value()).toMatch(/unknown query table "\/tmp\/not-allowed\.parquet"/)
  })

  it('returns no more than 100 rows for custom SQL output', async function() {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      serviceName: 'svc-a',
      timestamp: new Date(Date.UTC(2026, 4, 11, 10, 0, i)).toISOString(),
      body: `line-${String(i).padStart(3, '0')}`,
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    }))
    writeJsonl('gw1', 'logs', '2026-05-11', rows)
    expect(await runQuery(['refresh', '--all', '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)

    const defaultOut = memo()
    expect(await runQuery([
      'sql',
      'select body from logs order by body',
      '--config', configPath,
      '--format', 'json',
    ], { stdout: defaultOut, stderr: memo() })).toBe(0)
    expect(JSON.parse(defaultOut.value())).toHaveLength(100)

    const clampedOut = memo()
    expect(await runQuery([
      'sql',
      'select body from logs order by body limit 140',
      '--config', configPath,
      '--format', 'json',
    ], { stdout: clampedOut, stderr: memo() })).toBe(0)
    expect(JSON.parse(clampedOut.value())).toHaveLength(100)

    const lowerOut = memo()
    expect(await runQuery([
      'sql',
      'select body from logs order by body limit 12',
      '--config', configPath,
      '--format', 'json',
    ], { stdout: lowerOut, stderr: memo() })).toBe(0)
    expect(JSON.parse(lowerOut.value())).toHaveLength(12)
  })

  it('queries proxy_messages across selected date partitions', async function() {
    writeJsonl('gw1', 'proxy', '2026-05-14', [proxyExchange('2026-05-14', 'day one')])
    writeJsonl('gw1', 'proxy', '2026-05-15', [proxyExchange('2026-05-15', 'day two')])
    writeJsonl('gw1', 'proxy', '2026-05-16', [proxyExchange('2026-05-16', 'day three')])

    const stdout = memo()
    const stderr = memo()
    const code = await runQuery([
      'sql',
      'select date, count(*) as n from proxy_messages group by date order by date',
      '--config', configPath,
      '--format', 'json',
      '--refresh', 'always',
      '--date', '2026-05-14',
      '--date', '2026-05-15',
    ], { stdout, stderr })

    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    expect(JSON.parse(stdout.value())).toEqual([
      { date: '2026-05-14', n: 1 },
      { date: '2026-05-15', n: 1 },
    ])
    expect(fs.existsSync(cacheCursorPath('proxy_messages', 'gw1', '2026-05-16'))).toBe(false)
  })

  it('surfaces cache-only partitions whose source JSONL was drained', async function() {
    writeAllSignals()
    expect(await runQuery(['refresh', '--all', '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)

    // Simulate a drain: remove the source JSONLs but keep the cache cursors and tables.
    for (const signal of /** @type {const} */ (['logs', 'traces', 'metrics', 'proxy'])) {
      fs.unlinkSync(path.join(sinkDir, 'gw1', signal, '2026-05-11.jsonl'))
    }

    // status: each dataset should still show the cached row, with 0 sources.
    const statusOut = memo()
    expect(await runQuery(['status', '--config', configPath, '--format', 'json'], { stdout: statusOut, stderr: memo() })).toBe(0)
    /** @type {Array<{ dataset: string, sources: number, fresh: number, stale: number, rows: number }>} */
    const statusRows = JSON.parse(statusOut.value())
    const proxyMessages = statusRows.find((r) => r.dataset === 'proxy_messages')
    // The test JSONL has no extractable assistant messages (request.body is
    // `{}`), so the cached `proxy_messages` partition has zero data rows. The
    // partition itself is still fresh and present, which is what we assert.
    expect(proxyMessages).toMatchObject({ sources: 0, fresh: 1, stale: 0 })
    const logsRow = statusRows.find((r) => r.dataset === 'logs')
    expect(logsRow).toMatchObject({ sources: 0, fresh: 1, stale: 0, rows: 1 })

    // catalog: cached_rows should reflect drained partitions.
    const catalogOut = memo()
    expect(await runQuery(['catalog', '--config', configPath, '--format', 'json'], { stdout: catalogOut, stderr: memo() })).toBe(0)
    /** @type {Array<{ dataset: string, cached_rows: number, source_partitions: number }>} */
    const catalog = JSON.parse(catalogOut.value())
    const catalogProxy = catalog.find((r) => r.dataset === 'proxy_messages')
    expect(catalogProxy).toMatchObject({ source_partitions: 0 })

    // sql: the drained logs partition is queryable.
    const sqlOut = memo()
    const sqlErr = memo()
    expect(await runQuery([
      'sql',
      'select gateway_id, body from logs',
      '--config', configPath,
    ], { stdout: sqlOut, stderr: sqlErr })).toBe(0)
    expect(sqlErr.value()).toBe('')
    expect(sqlOut.value()).toMatch(/gw1\s+boom/)

    // doctor: still reports ok with the drained partitions counted.
    const doctorOut = memo()
    expect(await runQuery(['doctor', '--config', configPath], { stdout: doctorOut, stderr: memo() })).toBe(0)
    expect(doctorOut.value()).toMatch(/cache_freshness\s+ok/)
  })

  it('warns when a drained source reappears with a different size', async function() {
    writeAllSignals()
    expect(await runQuery(['refresh', '--all', '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)

    // Drain logs only, then later re-create with different content (different size).
    fs.unlinkSync(path.join(sinkDir, 'gw1', 'logs', '2026-05-11.jsonl'))
    // While drained: query should succeed.
    expect(await runQuery(['sql', 'select count(*) as n from logs', '--config', configPath], {
      stdout: memo(), stderr: memo(),
    })).toBe(0)

    // Source reappears with different content — staleness should be reported.
    writeJsonl('gw1', 'logs', '2026-05-11', [
      { serviceName: 'svc-a', timestamp: '2026-05-11T10:00:00.000Z', body: 'different', resource: {}, scope: { attributes: {} }, attributes: {} },
      { serviceName: 'svc-b', timestamp: '2026-05-11T10:00:01.000Z', body: 'second', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(['sql', 'select count(*) as n from logs', '--config', configPath], { stdout, stderr })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/\b1\b/)
    expect(stderr.value()).toMatch(/warning: query cache last refreshed at /)
    expect(stderr.value()).toMatch(/source size changed|source mtime changed/)
  })

  it('runs high-level metrics, proxy, tail, and schema commands', async function() {
    writeAllSignals()
    expect(await runQuery(['refresh', '--all', '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)

    const metricsOut = memo()
    expect(await runQuery(['metrics', 'list', '--config', configPath], { stdout: metricsOut, stderr: memo() })).toBe(0)
    expect(metricsOut.value()).toMatch(/latency\.ms/)

    // `proxy_messages` is empty for this fixture (no extractable assistant
    // content) so we just check the command returns a clean exit with the
    // expected header row. Bead 5 will swap in a fixture that produces real
    // message rows and assert against `proxy get <conversation-id>` output.
    const proxyOut = memo()
    expect(await runQuery(['proxy', '--config', configPath], { stdout: proxyOut, stderr: memo() })).toBe(0)
    expect(proxyOut.value()).toMatch(/conversation_id/)

    const tailOut = memo()
    expect(await runQuery(['logs', 'tail', '--config', configPath], { stdout: tailOut, stderr: memo() })).toBe(0)
    expect(tailOut.value()).toMatch(/boom/)

    const schemaOut = memo()
    expect(await runQuery(['schema', 'logs', '--format', 'json'], { stdout: schemaOut, stderr: memo() })).toBe(0)
    /** @type {Array<{ name: string }>} */
    const schema = JSON.parse(schemaOut.value())
    expect(schema.map((column) => column.name)).toContain('gateway_id')
    expect(schema.map((column) => column.name)).toContain('date')
  })
})

describe('ctvs query freshness gate', function() {
  describe('parseQueryArgs --strict-freshness', function() {
    it('defaults strictFreshness to false', function() {
      const parsed = parseQueryArgs([])
      expect(parsed.error).toBeUndefined()
      expect(parsed.strictFreshness).toBe(false)
    })

    it('sets strictFreshness=true when --strict-freshness is passed', function() {
      const parsed = parseQueryArgs(['logs', '--strict-freshness'])
      expect(parsed.error).toBeUndefined()
      expect(parsed.strictFreshness).toBe(true)
    })

    it('treats --strict-freshness as a boolean flag (does not consume the next argv)', function() {
      const parsed = parseQueryArgs(['--strict-freshness', '--config', '/tmp/cfg.json'])
      expect(parsed.error).toBeUndefined()
      expect(parsed.strictFreshness).toBe(true)
      expect(parsed.configPath).toBe('/tmp/cfg.json')
    })

    it('accepts repeated date filters for multi-day scopes', function() {
      const parsed = parseQueryArgs(['proxy', '--date', '2026-05-14', '--date', '2026-05-15'])
      expect(parsed.error).toBeUndefined()
      expect(parsed.date).toBeUndefined()
      expect(parsed.dates).toEqual(['2026-05-14', '2026-05-15'])
    })
  })

  /**
   * @param {string} body
   * @returns {Record<string, unknown>}
   */
  function logRow(body) {
    return {
      serviceName: 'svc-a',
      timestamp: '2026-05-11T10:00:00.000Z',
      severityNumber: 9,
      severityText: 'INFO',
      body,
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    }
  }

  /**
   * Write JSONL, refresh into cache tables, then mutate JSONL so its size
   * differs from the recorded source_size — making the logs partition stale.
   * @returns {Promise<void>}
   */
  async function makeStaleLogs() {
    writeJsonl('gw1', 'logs', '2026-05-11', [logRow('a')])
    expect(await runQuery(['refresh', '--all', '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)
    writeJsonl('gw1', 'logs', '2026-05-11', [logRow('a'), logRow('bb-longer-body')])
  }

  describe('ensureCacheReady (via runQuery)', function() {
    it('fresh cache → query runs with empty stderr', async function() {
      writeJsonl('gw1', 'logs', '2026-05-11', [logRow('hi')])
      expect(await runQuery(['refresh', '--all', '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)

      const stdout = memo()
      const stderr = memo()
      const code = await runQuery(['logs', '--config', configPath], { stdout, stderr })
      expect(code).toBe(0)
      expect(stderr.value()).toBe('')
      expect(stdout.value()).toMatch(/\bhi\b/)
    })

    it('stale cache, default → query runs and stderr warning is emitted', async function() {
      await makeStaleLogs()
      const stdout = memo()
      const stderr = memo()
      const code = await runQuery(['logs', '--config', configPath], { stdout, stderr })
      expect(code).toBe(0)
      expect(stdout.value()).toMatch(/\ba\b/)
      expect(stderr.value()).toMatch(/^warning: query cache last refreshed at .+; 1 partition\(s\) differ from source \[logs\/gw1\/2026-05-11/)
      expect(stderr.value()).toMatch(/run 'ctvs query refresh .*\/gw1\/logs\/2026-05-11\.jsonl --config .*' to refresh/)
    })

    it('stale cache + --strict-freshness → exit 1, error message, empty stdout', async function() {
      await makeStaleLogs()
      const stdout = memo()
      const stderr = memo()
      const code = await runQuery(['logs', '--config', configPath, '--strict-freshness'], { stdout, stderr })
      expect(code).toBe(1)
      expect(stdout.value()).toBe('')
      expect(stderr.value()).toMatch(/^error: query cache is stale for logs\/gw1\/2026-05-11/)
      expect(stderr.value()).toMatch(/--strict-freshness set/)
      expect(stderr.value()).toMatch(/Run: ctvs query refresh .*\/gw1\/logs\/2026-05-11\.jsonl --config /)
    })

    it('missing cache → exit 1 regardless of --strict-freshness', async function() {
      writeJsonl('gw1', 'logs', '2026-05-11', [logRow('hi')])

      const defaultStdout = memo()
      const defaultStderr = memo()
      expect(await runQuery(['logs', '--config', configPath], { stdout: defaultStdout, stderr: defaultStderr })).toBe(1)
      expect(defaultStdout.value()).toBe('')
      expect(defaultStderr.value()).toMatch(/error: query cache is missing for logs\/gw1\/2026-05-11/)

      const strictStdout = memo()
      const strictStderr = memo()
      expect(await runQuery(['logs', '--config', configPath, '--strict-freshness'], { stdout: strictStdout, stderr: strictStderr })).toBe(1)
      expect(strictStdout.value()).toBe('')
      expect(strictStderr.value()).toMatch(/error: query cache is missing for logs\/gw1\/2026-05-11/)
      // Missing path stays the "missing" error — --strict-freshness never converts it to a "stale" message.
      expect(strictStderr.value()).not.toMatch(/--strict-freshness set/)
    })

    it('--refresh always + stale source → refresh succeeds, no stale warning', async function() {
      await makeStaleLogs()
      const stdout = memo()
      const stderr = memo()
      const code = await runQuery(['logs', '--config', configPath, '--refresh', 'always'], { stdout, stderr })
      expect(code).toBe(0)
      expect(stderr.value()).toBe('')
      // The refreshed cache now contains the appended row, proving the source was re-read.
      expect(stdout.value()).toMatch(/bb-longer-body/)
    })
  })

  describe('warning stdout/stderr separation across --format modes', function() {
    /** @type {('table' | 'json' | 'jsonl' | 'markdown')[]} */
    const formats = ['table', 'json', 'jsonl', 'markdown']
    for (const format of formats) {
      it(`${format}: warning lands on stderr; stdout is unchanged by the warning`, async function() {
        await makeStaleLogs()
        const stdout = memo()
        const stderr = memo()
        const code = await runQuery(['logs', '--config', configPath, '--format', format], { stdout, stderr })
        expect(code).toBe(0)

        // Warning on stderr.
        expect(stderr.value()).toMatch(/warning: query cache last refreshed at /)
        // Warning never bleeds into stdout.
        expect(stdout.value()).not.toMatch(/warning:/)

        // Format-specific stdout shape (proves the warning didn't corrupt the leading bytes).
        switch (format) {
        case 'table':
          // Column header row appears at the start of stdout.
          expect(stdout.value()).toMatch(/^gateway_id\s+date\s+timestamp/)
          break
        case 'json': {
          const rows = JSON.parse(stdout.value())
          expect(Array.isArray(rows)).toBe(true)
          // Cache still holds the single pre-mutation row.
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({ gateway_id: 'gw1', body: 'a' })
          break
        }
        case 'jsonl': {
          const lines = stdout.value().trimEnd().split('\n').filter(Boolean)
          expect(lines).toHaveLength(1)
          for (const line of lines) {
            const row = JSON.parse(line)
            expect(row).toMatchObject({ gateway_id: 'gw1' })
          }
          break
        }
        case 'markdown':
          expect(stdout.value().startsWith('| gateway_id |')).toBe(true)
          break
        }
      })
    }
  })
})

describe('ctvs query gascity_messages', function() {
  it('exposes the dataset in catalog and schema', async function() {
    await writeGascityFixtures([
      {
        city: 'hyptown',
        sessionId: 'hy-1',
        template: 'hypcity-overrides.mayor',
        rig: 'collectivus',
        rows: [
          { provider_uuid: 'u-1', content_text: 'hi' },
          { provider_uuid: 'u-2', part_index: 1, part_type: 'text', content_text: 'world' },
        ],
      },
    ])

    const catalogOut = memo()
    const catalogCode = await runQuery(['catalog', '--config', configPath, '--format', 'json'], { stdout: catalogOut, stderr: memo() })
    expect(catalogCode).toBe(0)
    /** @type {Array<{ dataset: string, source_signal: string, columns: number, source_partitions: number }>} */
    const catalog = JSON.parse(catalogOut.value())
    const gascity = catalog.find((row) => row.dataset === 'gascity_messages')
    expect(gascity).toBeDefined()
    expect(gascity).toMatchObject({ source_signal: 'gascity', source_partitions: 1 })
    expect(gascity?.columns).toBeGreaterThan(40)

    const schemaOut = memo()
    const schemaCode = await runQuery(['schema', 'gascity_messages', '--format', 'json'], { stdout: schemaOut, stderr: memo() })
    expect(schemaCode).toBe(0)
    /** @type {Array<{ name: string }>} */
    const schema = JSON.parse(schemaOut.value())
    const names = schema.map((column) => column.name)
    for (const required of ['city', 'gascity_session_id', 'gascity_template', 'gascity_rig', 'gateway_id', 'date', 'message_created_at', 'part_type']) {
      expect(names).toContain(required)
    }
  })

  it('runs SELECT count(*) and SELECT * SQL against the gascity parquet sink', async function() {
    await writeGascityFixtures([
      {
        city: 'hyptown',
        sessionId: 'hy-1',
        template: 'hypcity-overrides.mayor',
        rig: 'collectivus',
        rows: [
          { provider_uuid: 'u-1', part_type: 'text', content_text: 'hi' },
          { provider_uuid: 'u-2', part_index: 1, part_type: 'tool_use', tool_name: 'Bash', tool_call_id: 'tc-1' },
        ],
      },
      {
        city: 'hyptown',
        sessionId: 'hy-2',
        template: 'hypcity-overrides.refinery',
        rig: 'collectivus',
        rows: [
          { provider_uuid: 'u-3', part_type: 'text', content_text: 'merge' },
        ],
      },
    ])

    const countOut = memo()
    const countCode = await runQuery(
      ['sql', 'select count(*) as n from gascity_messages', '--config', configPath, '--format', 'json'],
      { stdout: countOut, stderr: memo() }
    )
    expect(countCode).toBe(0)
    /** @type {Array<{ n: number }>} */
    const countRows = JSON.parse(countOut.value())
    expect(countRows[0].n).toBe(3)

    const filterOut = memo()
    const filterCode = await runQuery(
      [
        'sql',
        'select gascity_template, count(*) as n from gascity_messages where part_type = \'text\' group by gascity_template order by gascity_template',
        '--config', configPath,
        '--format', 'json',
      ],
      { stdout: filterOut, stderr: memo() }
    )
    expect(filterCode).toBe(0)
    /** @type {Array<{ gascity_template: string, n: number }>} */
    const grouped = JSON.parse(filterOut.value())
    expect(grouped).toEqual([
      { gascity_template: 'hypcity-overrides.mayor', n: 1 },
      { gascity_template: 'hypcity-overrides.refinery', n: 1 },
    ])
  })

  it('queries gascity_messages even when the query cache is disabled', async function() {
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      sink: { type: 'file', dir: sinkDir },
      query: { cache: { enabled: false } },
    }))
    await writeGascityFixtures([
      {
        city: 'hyptown',
        sessionId: 'hy-1',
        template: 'hypcity-overrides.mayor',
        rows: [{ provider_uuid: 'u-1', content_text: 'cache-free' }],
      },
    ])

    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(
      ['sql', 'select count(*) as n from gascity_messages', '--config', configPath, '--format', 'json'],
      { stdout, stderr }
    )
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    /** @type {Array<{ n: number }>} */
    const rows = JSON.parse(stdout.value())
    expect(rows[0].n).toBe(1)
  })

  it('refresh treats gascity_messages as already-fresh (no-op)', async function() {
    await writeGascityFixtures([
      {
        city: 'hyptown',
        sessionId: 'hy-1',
        template: 'mayor',
        rows: [{ provider_uuid: 'u-1', content_text: 'hi' }],
      },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(
      ['refresh', '--all', 'gascity_messages', '--config', configPath],
      { stdout, stderr }
    )
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toMatch(/Done\. 0 file\(s\) written, 1 fresh, 0 row\(s\)\./)
  })

  it('UNION ALL with proxy_messages selects shared columns from both sources', async function() {
    // Set up proxy_messages partition so the JSONL → cache refresh path runs.
    writeJsonl('gw1', 'proxy', '2026-05-14', [
      {
        exchange_id: 'ex-1',
        kind: 'exchange',
        ts_start: '2026-05-14T10:00:00.000Z',
        ts_end: '2026-05-14T10:00:00.250Z',
        duration_ms: 250,
        upstream: 'anthropic',
        request: {
          method: 'POST',
          path: '/v1/messages',
          headers: {},
          body: JSON.stringify({
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        },
        response: { status: 200, headers: {}, body: '{}' },
        stream_event_count: 0,
      },
    ])
    expect(await runQuery(['refresh', '--all', '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)
    await writeGascityFixtures([
      {
        city: 'hyptown',
        sessionId: 'hy-1',
        template: 'hypcity-overrides.mayor',
        rows: [{ provider_uuid: 'u-1', content_text: 'gascity says hi' }],
      },
    ])

    const stdout = memo()
    const stderr = memo()
    // Gascity has `part_type` instead of `role`; this query unions on the
    // columns both tables actually carry (provider, content_text) — a real
    // operator question that needs both sources.
    const code = await runQuery([
      'sql',
      `select source, provider, content_text from (
         select 'proxy' as source, provider, content_text from proxy_messages where role = 'user'
         union all
         select 'gascity' as source, provider, content_text from gascity_messages where part_type = 'text'
       ) order by source, content_text`,
      '--config', configPath,
      '--format', 'json',
    ], { stdout, stderr })
    expect(code).toBe(0)
    /** @type {Array<{ source: string, provider: string, content_text: string }>} */
    const rows = JSON.parse(stdout.value())
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.find((r) => r.source === 'gascity' && r.content_text === 'gascity says hi')).toBeDefined()
    expect(rows.find((r) => r.source === 'proxy' && r.content_text === 'hello')).toBeDefined()
  })

  it('--gateway-id only matches the gascity-scribe constant', async function() {
    await writeGascityFixtures([
      {
        city: 'hyptown',
        sessionId: 'hy-1',
        template: 'mayor',
        rows: [{ provider_uuid: 'u-1', content_text: 'hi' }],
      },
    ])

    const matchOut = memo()
    const matchCode = await runQuery(
      ['sql', 'select count(*) as n from gascity_messages', '--config', configPath, '--gateway-id', GASCITY_GATEWAY_ID, '--format', 'json'],
      { stdout: matchOut, stderr: memo() }
    )
    expect(matchCode).toBe(0)
    expect(JSON.parse(matchOut.value())[0].n).toBe(1)

    const missOut = memo()
    const missCode = await runQuery(
      ['sql', 'select count(*) as n from gascity_messages', '--config', configPath, '--gateway-id', 'nope', '--format', 'json'],
      { stdout: missOut, stderr: memo() }
    )
    expect(missCode).toBe(0)
    expect(JSON.parse(missOut.value())[0].n).toBe(0)
  })
})
