// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'

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
 * `hyp mcp` stdio host smoke. Activates `@hypaware/ai-gateway` (for the
 * `ai_gateway_messages` dataset registration), seeds a two-row fixture into
 * the kernel-managed cache, boots `hyp mcp` over a stdio pipe, and drives a
 * real MCP session:
 *
 * - `tools/list` advertises the intrinsic `query_sql` tool;
 * - `tools/call query_sql` over the seeded cache returns the right rows;
 * - `resources/list` exposes the `ai_gateway_messages` dataset schema;
 * - **stdout is protocol-clean**: every line parses as JSON-RPC, proving
 *   the host never leaked human text onto the protocol channel
 *   (LLP 0034 §stdio-stdout-discipline);
 * - a `mcp.serve_start` log records the lifecycle (log-driven-development).
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
      smoke_step: 'mcp_activate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded } = await loadManifests([path.join(workspace, 'ai-gateway')])
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir, config: {} }))
      return activatePlugins({ plugins: entries, stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot })
    }
  )

  // Seed two ai_gateway_messages rows and settle them so `query_sql` reads
  // committed cache regardless of the tool's `auto` refresh timing.
  const tablePath = aiGatewayTablePath(kernel.storage)
  await kernel.storage.appendRows(tablePath, [...AI_GATEWAY_SCHEMA_COLUMNS], [
    fixtureRow({ message_id: 'm1', part_index: 0, role: 'user', part_type: 'text', content_text: 'hello' }),
    fixtureRow({ message_id: 'm2', part_index: 0, role: 'assistant', part_type: 'text', content_text: 'hi there' }),
  ])
  await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })

  // Drive a full MCP session over a stdio pipe: the Readable ends after the
  // last line, so `hyp mcp` sees EOF, stops serving, and exits 0.
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_sql', arguments: { sql: 'SELECT count(*) AS n FROM ai_gateway_messages' } } },
    { jsonrpc: '2.0', id: 4, method: 'resources/list' },
  ]
  const stdin = /** @type {any} */ (Readable.from(requests.map((r) => JSON.stringify(r) + '\n')))
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['mcp'], { stdout, stderr, stdin, kernel, registry, env: smokeEnv(harness) })
  expect.that('hyp mcp exits 0 on client EOF', code, (v) => v === 0)

  // stdout is the protocol channel: every non-empty line must be valid
  // JSON-RPC, nothing else.
  const lines = stdout.text().split('\n').filter((l) => l.trim().length > 0)
  /** @type {any[]} */
  let responses = []
  let parsedAll = true
  try {
    responses = lines.map((l) => JSON.parse(l))
  } catch {
    parsedAll = false
  }
  expect.that('stdout is protocol-clean (every line parses as JSON-RPC)', parsedAll, (v) => v === true)
  expect.that('every response carries jsonrpc 2.0', responses, (rows) => rows.length === 4 && rows.every((r) => r.jsonrpc === '2.0'))

  const byId = new Map(responses.map((r) => [r.id, r]))

  const init = byId.get(1)
  expect.that('initialize advertises serverInfo hypaware', init, (r) => r?.result?.serverInfo?.name === 'hypaware')

  const toolsList = byId.get(2)
  expect.that('tools/list advertises the intrinsic query_sql tool', toolsList, (r) =>
    Array.isArray(r?.result?.tools) && r.result.tools.some((/** @type {any} */ t) => t.name === 'query_sql'))
  expect.that('query_sql tool exposes an inputSchema requiring sql', toolsList, (r) => {
    const tool = r?.result?.tools?.find((/** @type {any} */ t) => t.name === 'query_sql')
    return tool?.inputSchema?.type === 'object' && (tool?.inputSchema?.required ?? []).includes('sql')
  })

  const call = byId.get(3)
  expect.that('tools/call query_sql is not an error', call, (r) => r?.result?.isError === false)
  expect.that('tools/call query_sql returns the seeded row count (2)', call, (r) => {
    const structured = r?.result?.structuredContent
    return Number(structured?.rows?.[0]?.n) === 2
  })

  const resources = byId.get(4)
  expect.that('resources/list exposes the ai_gateway_messages schema', resources, (r) =>
    Array.isArray(r?.result?.resources) && r.result.resources.some((/** @type {any} */ x) => x.uri === 'hypaware://dataset/ai_gateway_messages/schema'))

  // Lifecycle signal: the serve-start log proves the host path ran (not just
  // that some bytes came back).
  await obs.shutdown()
  const logs = await expect.logs()
  expect.that('mcp.serve_start log records the stdio host with >=1 tool', logs, (rows) =>
    rows.some((/** @type {any} */ l) =>
      (l.body === 'mcp.serve_start' || l.message === 'mcp.serve_start') &&
      (l.attributes?.tool_count ?? l.tool_count ?? 0) >= 1))
}

/**
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
    message_index: 0,
    part_index: 0,
    date: '2026-06-05',
    ...over,
    part_id: `${over.message_id}#${over.part_index ?? 0}`,
  }
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
