// @ts-check

/**
 * Regression: `claude_telemetry_events` rows from a `local-only` directory
 * must not forward.
 *
 * The ingest gate (LLP 0254 #policy-inline) deliberately KEEPS `local-only`
 * events: that class is recorded locally and withheld at the export and query
 * seams, not dropped at capture. The export seam derives its verdict from the
 * row's own `cwd` (LLP 0070 #enforce), so a behavioral row that carries no
 * `cwd` is unfilterable there and forwards to a fleet server under the
 * dataset's `claude_telemetry` signal.
 *
 * These tests pin the two halves of the fix: the row builder stamps the cwd
 * the ingest verdict was resolved from, and the shared export read withholds
 * on it.
 *
 * @ref LLP 0070#derive [tests]: the export verdict is derived from the row's
 *   own `cwd`, so a dataset that forwards has to carry one
 * @ref LLP 0254#policy-inline [constrained-by]: `local-only` is kept at ingest,
 *   which is exactly why the export seam has to be able to see it
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import {
  CLAUDE_TELEMETRY_EVENT_COLUMNS,
  TELEMETRY_EVENTS_DATASET,
  claudeTelemetryDatasetRegistration,
  claudeTelemetryEventRows,
  claudeTelemetryTablePath,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/events_dataset.js'

/**
 * @import { ClaudeTelemetryEvent } from '../../hypaware-core/plugins-workspace/claude/src/types.js'
 * @import { ResolveResult, UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

const LOCAL_ONLY_SESSION = 'aa11f0f0-0000-4000-8000-000000000001'
const FULL_SESSION = 'bb22f0f0-0000-4000-8000-000000000002'

const LOCAL_ONLY_CWD = '/w/client-x'
const FULL_CWD = '/w/org-repo'

/** @type {Record<string, 'ignore' | 'local-only' | 'full'>} */
const CLASSES = { [LOCAL_ONLY_CWD]: 'local-only' }

/**
 * A resolver over a fixed cwd->class map; anything unmapped is `full`.
 *
 * @returns {UsagePolicyResolver}
 */
function fakeResolver() {
  /** @type {(cwd: string) => ResolveResult} */
  const resolve = (cwd) => ({ class: CLASSES[cwd] ?? 'full', governedBy: null, declared: null })
  return { resolve, isIgnored: (cwd) => resolve(cwd).class === 'ignore' }
}

/** The cwd map the SessionStart hook's records would supply at ingest. */
const CWD_BY_SESSION = /** @type {Record<string, string>} */ ({
  [LOCAL_ONLY_SESSION]: LOCAL_ONLY_CWD,
  [FULL_SESSION]: FULL_CWD,
})

/** @param {string} sessionId */
function cwdFor(sessionId) {
  return CWD_BY_SESSION[sessionId]
}

/**
 * @param {string} name
 * @param {string | undefined} sessionId
 * @param {Record<string, unknown>} [attrs]
 * @returns {ClaudeTelemetryEvent}
 */
function event(name, sessionId, attrs = {}) {
  return {
    name,
    timestamp: '2026-08-18T09:00:00.000Z',
    attributes: {
      'event.name': name,
      ...(sessionId === undefined ? {} : { 'session.id': sessionId }),
      ...attrs,
    },
  }
}

test('the dataset declares a cwd column, the only key the export seam can withhold on', () => {
  const registration = claudeTelemetryDatasetRegistration()
  assert.ok(
    registration.schema.columns.some((c) => c.name === 'cwd'),
    'claude_telemetry_events forwards under a source signal, so its rows need the cwd the export filter reads'
  )
})

test('a row carries the cwd its ingest verdict was resolved from', () => {
  const rows = claudeTelemetryEventRows(
    [
      event('tool_decision', LOCAL_ONLY_SESSION, { tool_name: 'Read', decision: 'accept' }),
      event('tool_decision', FULL_SESSION, { tool_name: 'Bash', decision: 'reject' }),
      event('mcp_server_connection', undefined, { server_name: 'some-mcp' }),
    ],
    { cwdFor }
  )
  assert.equal(rows.length, 3)
  assert.equal(rows[0].cwd, LOCAL_ONLY_CWD)
  assert.equal(rows[1].cwd, FULL_CWD)
  assert.equal(rows[2].cwd, null, 'an event naming no session has no cwd to resolve, so it reads null (full by construction)')
  const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes)
  assert.equal(attrs.cwd, undefined, 'cwd is a typed column, not an attribute the event carried')
})

test('a session the lookup holds no record for stamps a null cwd', () => {
  // Unreachable from the listener: an unknown session is `undetermined` at
  // the ingest gate and its events are withheld before any row is built.
  // Pinned anyway because null is the fail-open value at both seams.
  const rows = claudeTelemetryEventRows(
    [event('tool_decision', LOCAL_ONLY_SESSION, { tool_name: 'Read' })],
    { cwdFor: () => undefined }
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].cwd, null)
})

test('export seam: a local-only session\'s behavioral rows are withheld, a full session\'s forward', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-events-local-only-'))
  try {
    const storage = createQueryStorageService({ cacheRoot, usagePolicyResolver: fakeResolver() })
    const rows = claudeTelemetryEventRows(
      [
        event('tool_decision', LOCAL_ONLY_SESSION, { tool_name: 'Read', decision: 'accept' }),
        event('api_request', LOCAL_ONLY_SESSION, { cost_usd: '0.0047732' }),
        event('tool_decision', FULL_SESSION, { tool_name: 'Bash', decision: 'reject' }),
      ],
      { cwdFor }
    )
    const tablePath = claudeTelemetryTablePath(storage)
    await storage.appendRows(tablePath, [...CLAUDE_TELEMETRY_EVENT_COLUMNS], rows)
    await storage.flushTable(tablePath, { force: true })

    /** @type {Record<string, unknown>[]} */
    const shipped = []
    let dropped = 0
    for (const part of await storage.discoverCachePartitions({ datasets: [TELEMETRY_EVENTS_DATASET] })) {
      for await (const entry of storage.readRowsSince(part.path, {})) {
        if (entry.dropped) dropped += 1
        else shipped.push(entry.row)
      }
    }

    assert.equal(dropped, 2, 'both local-only rows are dropped from the export payload')
    assert.deepEqual(
      shipped.map((r) => r.session_id),
      [FULL_SESSION],
      'only the full-class session forwards'
    )
    assert.equal(shipped[0].cwd, FULL_CWD)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
