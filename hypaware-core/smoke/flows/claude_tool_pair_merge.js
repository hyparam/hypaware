// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { createBackfillSweepDriver } from '../../../src/core/daemon/backfill_sweep.js'
import { runBackfillProvider } from '../../../src/core/commands/backfill.js'
import { createProjectedExchangeWriter } from '../../plugins-workspace/ai-gateway/src/exchange_writer.js'
import { loadSpooledBodies } from '../../plugins-workspace/claude/src/telemetry/bodies.js'
import { flattenClaudeTelemetryEvents } from '../../plugins-workspace/claude/src/telemetry/events.js'
import { projectClaudeTelemetryEvents } from '../../plugins-workspace/claude/src/telemetry/projection.js'

/**
 * One Claude tool call stored by both capture lanes, merged by maintenance.
 *
 * The OTEL lane projects a tool call and its result from spooled request and
 * response bodies and writes them through the gateway's live writer while no
 * transcript is on disk, so the flush cannot settle them and they commit
 * under fallback hashes, the call carrying the response's usage. The
 * transcript then lands, and the real backfill sweep writes the same call and
 * result under their native uuids. `hyp query maintain` runs the re-settle
 * rewrite with the dataset's key-matched merge (LLP 0620 #local).
 *
 * Asserted end to end:
 *  - before maintenance: four tool rows (two copies each of the call and the
 *    result), one usage carrier, 34 output tokens;
 *  - after: two tool rows under the native uuids, still 34 output tokens,
 *    no fallback marker left;
 *  - a second maintenance changes nothing;
 *  - telemetry: the flush's `ai_gateway.settle_miss` (no transcript) and the
 *    rewrite's `cache.resettle_pairs` with two merged keys.
 *
 * @ref LLP 0620#formats [tests]: the SQL counts and token sums for the repro session
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('claude_tool_pair_merge: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })
  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = [path.join(pluginsRoot, 'ai-gateway'), path.join(pluginsRoot, 'claude')]

  const fakeHome = path.join(harness.tmpDir, 'home')
  const projectsDir = path.join(fakeHome, '.claude', 'projects', 'some-repo')
  const spoolDir = path.join(harness.tmpDir, 'bodies')
  await fs.mkdir(spoolDir, { recursive: true })
  const sessionId = `pair-${harness.devRunId}`
  const toolId = 'toolu_01SmokePair'
  const callUuid = '5233b3fa-fd52-4c1e-9a44-6c0e8c0f1a2b'
  const resultUuid = '77ea6f90-90c5-47ab-9d20-1c4e6f9b3a55'
  const promptTs = new Date(Date.now() - 120_000)
  const callTs = new Date(promptTs.getTime() + 2_000)
  const resultTs = new Date(promptTs.getTime() + 3_000)
  const toolBlock = { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls -la' } }
  const resultBlock = { type: 'tool_result', tool_use_id: toolId, content: 'README.md\n' }

  const previousHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    await runRoot('kernel.boot', {
      [Attr.COMPONENT]: 'kernel', [Attr.OPERATION]: 'boot', [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'activate', [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok',
    }, async () => {
      const { loaded } = await loadManifests(pluginDirs)
      const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
      if (resolution.unsatisfied.length > 0) throw new Error('claude_tool_pair_merge: unsatisfied plugin requirements')
      const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
      const entries = resolution.order
        .map((name) => byName.get(name))
        .filter((l) => l !== undefined)
        .map((l) => ({ manifest: l.manifest, rootDir: l.rootDir, config: {} }))
      return activatePlugins({
        plugins: entries, stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel,
        tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
      })
    })
    const env = { ...process.env, HYP_HOME: harness.hypHome }

    // ----- 1. The OTEL lane, with no transcript on disk -----
    await runRoot('smoke.otel_lane', {
      [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: 'otel_lane', [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok',
    }, async () => {
      const responseRef = path.join(spoolDir, 'response.json')
      await fs.writeFile(responseRef, JSON.stringify({
        id: 'msg_smoke_pair', role: 'assistant', model: 'claude-sonnet-4-5', content: [toolBlock],
        stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 34 },
      }))
      const requestRef = path.join(spoolDir, 'request.json')
      await fs.writeFile(requestRef, JSON.stringify({
        model: 'claude-sonnet-4-5', system: 'you are claude code',
        messages: [
          { role: 'user', content: 'list the files' },
          { role: 'assistant', content: [toolBlock] },
          { role: 'user', content: [resultBlock] },
        ],
      }))
      const events = flattenClaudeTelemetryEvents({
        resourceLogs: [{
          resource: { attributes: kv({ 'service.name': 'claude-code' }) },
          scopeLogs: [{
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.322' },
            logRecords: [
              otelRecord(sessionId, 'api_response_body', { body_ref: responseRef, request_id: 'req_smoke_pair' }, callTs),
              otelRecord(sessionId, 'api_request_body', { body_ref: requestRef }, resultTs),
            ],
          }],
        }],
      })
      const { bodies } = await loadSpooledBodies(events, { spoolDir })
      const projections = projectClaudeTelemetryEvents(events, { clientName: 'claude', usageByRequestId: new Map(), spooledBodies: bodies })
      const writer = createProjectedExchangeWriter({ storage: kernel.storage })
      for (const projection of projections) await writer.record(projection)
    })

    const toolSql = `select part_id, part_type, output_tokens, JSON_EXTRACT(attributes, '$.gateway.identity_source') as marker from ai_gateway_messages where session_id = '${sessionId}' and part_type IN ('tool_call', 'tool_result') order by part_type, part_id`
    const totalsSql = `select count(*) as tool_rows, sum(COALESCE(output_tokens, 0)) as output_tokens from ai_gateway_messages where session_id = '${sessionId}' and part_type IN ('tool_call', 'tool_result')`

    const live = await queryRows({ sql: toolSql, kernel, registry, env, expect, label: 'after the live flush' })
    expect.that('live flush: the call and its result commit as fallbacks', live,
      (v) => v.length === 2 && v.every((/** @type {any} */ r) => r.marker === 'gateway_fallback'))

    // ----- 2. The transcript lands; the scheduled sweep writes native rows -----
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.writeFile(path.join(projectsDir, `${sessionId}.jsonl`), [
      { sessionId, uuid: 'u-prompt', parentUuid: null, type: 'user', message: { role: 'user', content: 'list the files' }, timestamp: promptTs.toISOString() },
      { sessionId, uuid: callUuid, parentUuid: 'u-prompt', type: 'assistant', requestId: 'req_smoke_pair',
        message: { id: 'msg_smoke_pair', role: 'assistant', model: 'claude-sonnet-4-5', content: [toolBlock], usage: { input_tokens: 12, output_tokens: 34 } },
        timestamp: callTs.toISOString() },
      { sessionId, uuid: resultUuid, parentUuid: callUuid, type: 'user', message: { role: 'user', content: [resultBlock] }, timestamp: resultTs.toISOString() },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')

    /** @type {Array<Promise<any>>} */
    const pendingRuns = []
    const sweep = createBackfillSweepDriver({
      backfills: kernel.backfills, backfillMaterializers: kernel.backfillMaterializers, storage: kernel.storage,
      query: kernel.query, env,
      config: /** @type {any} */ ({ version: 2, plugins: [{ name: '@hypaware/ai-gateway', config: { upstreams: [] } }, { name: '@hypaware/claude' }] }),
      runBackfill: (/** @type {any} */ args) => { const pending = runBackfillProvider(args); pendingRuns.push(pending); return pending },
    })
    await sweep.tick({ now: new Date(Date.UTC(2026, 0, 1)) })
    const sweepResults = await Promise.all(pendingRuns)
    expect.that('sweep: the claude provider wrote the native rows', sweepResults[0], (v) => v?.ok === true && v.rowsWritten >= 2)

    const both = await queryRows({ sql: totalsSql, kernel, registry, env, expect, label: 'both lanes' })
    expect.that('both lanes: four tool rows, 34 output tokens counted once', both[0],
      (v) => Number(v?.tool_rows) === 4 && Number(v?.output_tokens) === 34)

    // ----- 3. Maintenance merges each pair by its tool key -----
    for (const pass of [1, 2]) {
      const out = makeBuf()
      const err = makeBuf()
      const code = await dispatch(['query', 'maintain', '--force', '--compact-only'], { stdout: out, stderr: err, kernel, registry, env })
      expect.that(`maintain pass ${pass}: exited 0`, code, (v) => v === 0)
      const merged = await queryRows({ sql: toolSql, kernel, registry, env, expect, label: `after maintain ${pass}` })
      expect.that(`maintain pass ${pass}: one native row each for the call and the result`, merged, (v) =>
        v.length === 2 &&
        v.some((/** @type {any} */ r) => r.part_type === 'tool_call' && r.part_id === `${callUuid}#0` && Number(r.output_tokens) === 34) &&
        v.some((/** @type {any} */ r) => r.part_type === 'tool_result' && r.part_id === `${resultUuid}#0`) &&
        v.every((/** @type {any} */ r) => r.marker === null || r.marker === undefined))
      const totals = await queryRows({ sql: totalsSql, kernel, registry, env, expect, label: `totals after maintain ${pass}` })
      expect.that(`maintain pass ${pass}: two tool rows, 34 output tokens`, totals[0],
        (v) => Number(v?.tool_rows) === 2 && Number(v?.output_tokens) === 34)
    }

    // ----- 4. Telemetry -----
    await obs.shutdown()
    const logs = await expect.logs()
    expect.that('logs: the live flush counted its misses for want of a transcript', logs, (v) => v.some((/** @type {any} */ l) =>
      l.body === 'ai_gateway.settle_miss' && Number(l.attributes?.miss_no_transcript) >= 2))
    expect.that('logs: the first rewrite merged both keys', logs, (v) => v.some((/** @type {any} */ l) =>
      l.body === 'cache.resettle_pairs' && Number(l.attributes?.merged) === 2 && Number(l.attributes?.deferred) === 0))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

/** @param {Record<string, unknown>} attrs */
function kv(attrs) {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: String(value) } }))
}

/**
 * @param {string} sessionId
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {Date} at
 */
function otelRecord(sessionId, name, attrs, at) {
  return {
    timeUnixNano: String(BigInt(at.getTime()) * 1_000_000n),
    body: { stringValue: `claude_code.${name}` },
    attributes: kv({
      'session.id': sessionId, 'app.version': '2.1.322', 'app.entrypoint': 'cli',
      'event.name': name, 'event.timestamp': at.toISOString(), ...attrs,
    }),
  }
}

/**
 * @param {{ sql: string, kernel: any, registry: any, env: any, expect: any, label: string }} args
 * @returns {Promise<any[]>}
 */
async function queryRows({ sql, kernel, registry, env, expect, label }) {
  const out = makeBuf()
  const err = makeBuf()
  const code = await dispatch(['query', 'sql', sql, '--refresh', 'always', '--format', 'json'], { stdout: out, stderr: err, kernel, registry, env })
  expect.that(`query (${label}) exited 0`, code, (v) => v === 0)
  try {
    return JSON.parse(out.text())
  } catch (e) {
    expect.that(`query (${label}) returned JSON: ${err.text()}`, false, (v) => v === true)
    return []
  }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) { chunks.push(typeof chunk === 'string' ? chunk : String(chunk)); return true },
    text() { return chunks.join('') },
  }
}
