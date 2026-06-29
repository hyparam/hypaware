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
import {
  AI_GATEWAY_SCHEMA_COLUMNS,
  aiGatewayTablePath,
} from '../../plugins-workspace/ai-gateway/src/dataset.js'

/**
 * Context-graph T0 projection smoke. Activates `@hypaware/ai-gateway` (for
 * its dataset registration + cache declaration) and
 * `@hypaware/context-graph`, seeds a small `ai_gateway_messages` fixture
 * with two file-touching tool calls, runs `hyp graph project`, and asserts:
 *
 * - `select count(*) from node` = 7 (Session, App, Model, 2× Tool, 2× File)
 * - `select count(*) from edge` = 6 (via, used_model, 2× used, 2× touched)
 * - node_type breakdown matches the fixture
 * - re-running `graph project` leaves the counts unchanged (idempotent)
 * - a `graph.project` span carries the write counts: the internal signal
 *   that the projection path (not just the CLI wrapper) actually ran
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const workspace = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'context_graph_activate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded } = await loadManifests([
        path.join(workspace, 'ai-gateway'),
        path.join(workspace, 'context-graph'),
      ])
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir, config: {} }))
      return activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
    }
  )

  // Seed a small ai_gateway_messages fixture: two tool calls touching two
  // files, plus a text part: all in one conversation, same app/model.
  const tablePath = aiGatewayTablePath(kernel.storage)
  await kernel.storage.appendRows(tablePath, [...AI_GATEWAY_SCHEMA_COLUMNS], [
    fixtureRow({ message_id: 'm1', message_index: 0, role: 'assistant', part_type: 'tool_call', tool_name: 'Read', tool_call_id: 'tc1', tool_args: { file_path: '/repo/auth.py' } }),
    fixtureRow({ message_id: 'm2', message_index: 1, role: 'assistant', part_type: 'tool_call', tool_name: 'Edit', tool_call_id: 'tc2', tool_args: { file_path: '/repo/proxy.py' } }),
    fixtureRow({ message_id: 'm3', message_index: 2, role: 'user', part_type: 'text', content_text: 'hello' }),
  ])

  // Run the projection.
  const project1 = await dispatchOk(['graph', 'project'], { kernel, registry, harness, expect, label: 'first' })
  expect.that('graph project: first run printed a summary', project1, (v) => typeof v === 'string' && v.includes('node(s)'))

  const nodeCount1 = await sqlCount('node')
  const edgeCount1 = await sqlCount('edge')
  expect.that('node count after first projection is 7', nodeCount1, (v) => v === 7)
  expect.that('edge count after first projection is 6', edgeCount1, (v) => v === 6)

  const byType = await runSql("select node_type, count(*) as n from node group by node_type")
  /** @type {Record<string, number>} */
  const counts = {}
  for (const row of byType) counts[String(row.node_type)] = numeric(row.n)
  expect.that('node_type breakdown matches fixture', counts, (v) =>
    v.Session === 1 && v.App === 1 && v.Model === 1 && v.Tool === 2 && v.File === 2
  )

  const usedEdges = await runSql(
    "select t.natural_key as tool from edge e join node t on e.dst_id = t.node_id where e.edge_type = 'used'"
  )
  const tools = usedEdges.map((r) => String(r.tool)).sort()
  expect.that("used edges link the session to Read and Edit", tools, (v) =>
    Array.isArray(v) && v.length === 2 && v[0] === 'Edit' && v[1] === 'Read'
  )

  // Re-run: idempotent (deterministic ids + pre-write dedup → no new rows).
  const project2 = await dispatchOk(['graph', 'project'], { kernel, registry, harness, expect, label: 'second' })
  expect.that('graph project: second run wrote 0 new nodes', project2, (v) => typeof v === 'string' && v.includes('wrote 0 new node(s)'))

  const nodeCount2 = await sqlCount('node')
  const edgeCount2 = await sqlCount('edge')
  expect.that('node count unchanged after re-projection (idempotent)', nodeCount2, (v) => v === 7)
  expect.that('edge count unchanged after re-projection (idempotent)', edgeCount2, (v) => v === 6)

  // Dedup compaction: a clean graph has nothing to merge, and the
  // command round-trips through the real plugin registration.
  const compact1 = await dispatchOk(['graph', 'compact'], { kernel, registry, harness, expect, label: 'compact' })
  expect.that(
    'graph compact: nothing to merge on a clean graph',
    compact1,
    (v) => typeof v === 'string' && v.includes('merged 0 duplicate row(s)')
  )
  const nodeCount3 = await sqlCount('node')
  expect.that('node count unchanged after compaction', nodeCount3, (v) => v === 7)

  // The internal signal: assert the projection path emitted its span with
  // the same counts the SQL assertions saw, per the log-driven-development
  // policy (a silent span break should fail this smoke, not pass it).
  await obs.shutdown()
  const traces = await expect.traces()
  const projectSpans = traces.filter((/** @type {any} */ t) => t.name === 'graph.project')
  expect.that(
    'traces: graph.project span for the writing run records 7 nodes / 6 edges, status ok',
    projectSpans,
    (/** @type {any[]} */ rows) => rows.some((t) =>
      t.attributes?.nodes_written === 7 &&
      t.attributes?.edges_written === 6 &&
      t.attributes?.status === 'ok'
    )
  )
  expect.that(
    'traces: graph.project span for the idempotent re-run wrote nothing',
    projectSpans,
    (/** @type {any[]} */ rows) => rows.some((t) =>
      t.attributes?.nodes_written === 0 && t.attributes?.edges_written === 0
    )
  )
  expect.that(
    'traces: graph.compact span emitted with nothing skipped',
    traces.filter((/** @type {any} */ t) => t.name === 'graph.compact'),
    (/** @type {any[]} */ rows) => rows.length >= 1 && rows.every((t) => t.attributes?.partitions_skipped === 0)
  )

  /**
   * @param {string} dataset
   * @returns {Promise<number>}
   */
  async function sqlCount(dataset) {
    const rows = await runSql(`select count(*) as n from ${dataset}`)
    return numeric(rows?.[0]?.n)
  }

  /**
   * @param {string} sql
   * @returns {Promise<any[]>}
   */
  async function runSql(sql) {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(['query', 'sql', sql, '--refresh', 'always', '--format', 'json'], {
      stdout,
      stderr,
      kernel,
      registry,
      env: smokeEnv(harness),
    })
    expect.that(`query sql exited 0: ${sql}`, code, (v) => v === 0)
    expect.that(`query sql had no stderr: ${sql}`, stderr.text(), (v) => v.length === 0)
    return JSON.parse(stdout.text())
  }
}

/**
 * @param {string[]} argv
 * @param {{ kernel: any, registry: any, harness: any, expect: any, label: string }} ctx
 * @returns {Promise<string>}
 */
async function dispatchOk(argv, ctx) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(argv, { stdout, stderr, kernel: ctx.kernel, registry: ctx.registry, env: smokeEnv(ctx.harness) })
  ctx.expect.that(`dispatch ${argv.join(' ')} (${ctx.label}) exited 0`, code, (v) => v === 0)
  ctx.expect.that(`dispatch ${argv.join(' ')} (${ctx.label}) had no stderr`, stderr.text(), (v) => v.length === 0)
  return stdout.text()
}

/**
 * Build a full ai_gateway_messages row from a partial, defaulting every
 * non-nullable column. `session_id` and `date` are required by the dataset's
 * cache partitioning declaration (schema v6; the graph Session anchor keys on
 * `session_id`, and `conversation_id` is now a nullable thread identity).
 *
 * @param {Record<string, unknown>} over
 * @returns {Record<string, unknown>}
 */
function fixtureRow(over) {
  const ts = '2026-06-05T12:00:00.000Z'
  return {
    gateway_id: 'gw-smoke',
    schema_version: 1,
    session_id: 'conv-1',
    conversation_id: 'conv-1',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    client_name: 'claude',
    cwd: '/repo',
    git_branch: 'main',
    user_id: 'u1',
    conversation_started_at: ts,
    message_created_at: ts,
    part_index: 0,
    date: '2026-06-05',
    ...over,
    part_id: `${over.message_id}#${over.part_index ?? 0}`,
  }
}

/** @param {unknown} v */
function numeric(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v)
  return NaN
}

/** @param {{ hypHome: string }} harness */
function smokeEnv(harness) {
  return { ...process.env, HYP_HOME: harness.hypHome }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
