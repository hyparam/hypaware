// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createMcpServer } from '../../src/core/mcp/server.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { activatePlugins } from '../../src/core/runtime/loader.js'
import { loadManifests } from '../../src/core/manifest.js'

const WORKSPACE = path.resolve(import.meta.dirname, '..', '..', 'hypaware-core', 'plugins-workspace')

// The bundled plugins that register verbs; core registers `query_sql`.
const VERB_PLUGINS = ['grep', 'context-graph']

const EMPTY_SCHEMA = { type: 'object', properties: {} }

// An operator verb, as a plugin would register one. No bundled verb is
// operator-class today, so the operator row of the hint table is proved here.
const operatorVerb = {
  name: 'annotations wipe', tool: 'annotations_wipe', title: 'Wipe the annotations fixture',
  summary: 'operator fixture', authClass: 'operator', inputSchema: EMPTY_SCHEMA,
  operation: async () => ({ ok: true }), render: () => ({ stdout: '' }),
}
// A read verb registered with no title: it is listed under its tool name.
const untitledVerb = {
  name: 'annotations untitled', tool: 'annotations_untitled', summary: 'no title given',
  inputSchema: EMPTY_SCHEMA, operation: async () => ({ ok: true }), render: () => ({ stdout: '' }),
}

/**
 * Boot a kernel with the bundled verb plugins active plus the two fixture
 * verbs, the way `hyp mcp` sees it.
 */
async function bootKernel() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-mcp-annotations-'))
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(tmp, 'cache') })
  const { loaded, failed } = await loadManifests(VERB_PLUGINS.map((d) => path.join(WORKSPACE, d)))
  assert.deepEqual(failed, [])
  const plugins = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir, config: {} }))
  await activatePlugins({ plugins, stateRoot: path.join(tmp, 'state'), runId: 'mcp-annotations', runtime: kernel, tmpRoot: path.join(tmp, 'plugin-temp') })
  kernel.verbs.register(/** @type {any} */ (operatorVerb))
  kernel.verbs.register(/** @type {any} */ (untitledVerb))
  return { tmp, registry, kernel }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    text: () => chunks.join(''),
  }
}

/**
 * Drive `hyp mcp` over a stdio pipe and return its `tools/list` entries.
 *
 * @param {Awaited<ReturnType<typeof bootKernel>>} booted
 * @returns {Promise<any[]>}
 */
async function stdioTools({ tmp, registry, kernel }) {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]
  const stdin = /** @type {any} */ (Readable.from(requests.map((r) => JSON.stringify(r) + '\n')))
  const stdout = makeBuf()
  const stderr = makeBuf()
  const env = { ...process.env, HYP_HOME: path.join(tmp, 'hyp-home') }
  const code = await dispatch(['mcp'], { stdout, stderr, stdin, kernel, registry, env })
  assert.equal(code, 0, stderr.text())
  const responses = stdout.text().split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l))
  const list = responses.find((r) => r.id === 2)
  return list.result.tools
}

/**
 * The hermetic proof: every entry is titled, and its hints match the class of
 * the verb behind it.
 *
 * @param {any[]} tools
 * @param {(tool: string) => any} lookup
 */
function assertAnnotated(tools, lookup) {
  for (const entry of tools) {
    const verb = lookup(entry.name)
    assert.ok(verb, `${entry.name} resolves to a registered verb`)
    assert.equal(typeof entry.title, 'string', `${entry.name} has a title`)
    assert.ok(entry.title.length > 0, `${entry.name} title is non-empty`)
    assert.equal(entry.annotations.title, entry.title, `${entry.name} annotations.title matches title`)
    const authClass = verb.authClass ?? 'read'
    if (authClass === 'read') {
      assert.deepEqual(entry.annotations, { title: entry.title, readOnlyHint: true }, `${entry.name} is a read tool`)
    } else {
      assert.equal(authClass, 'operator')
      assert.deepEqual(entry.annotations, { title: entry.title, readOnlyHint: false, destructiveHint: true }, `${entry.name} is an operator tool`)
    }
  }
}

test('hyp mcp over stdio titles and annotates every listed tool by its auth class', async () => {
  const booted = await bootKernel()
  try {
    const tools = await stdioTools(booted)
    const byName = new Map(tools.map((t) => [t.name, t]))
    // Local stdio is local-user trust: the operator fixture is listed too.
    assert.deepEqual([...byName.keys()].sort(), ['annotations_untitled', 'annotations_wipe', 'graph_neighbors', 'grep_search', 'query_sql'])
    assertAnnotated(tools, (t) => booted.kernel.verbs.getByTool(t))

    assert.equal(byName.get('query_sql').title, 'Run a SQL query')
    assert.equal(byName.get('grep_search').title, 'Search session text')
    assert.equal(byName.get('graph_neighbors').title, 'Find related sessions')
    assert.equal(byName.get('annotations_wipe').title, 'Wipe the annotations fixture')
    assert.equal(byName.get('annotations_wipe').annotations.destructiveHint, true)
    // No title registered: the tool name stands in, in both places.
    assert.equal(byName.get('annotations_untitled').title, 'annotations_untitled')
    assert.equal(byName.get('annotations_untitled').annotations.title, 'annotations_untitled')
  } finally {
    await fs.rm(booted.tmp, { recursive: true, force: true })
  }
})

test('an http read principal sees the same titles and read hints, without operator tools', async () => {
  const booted = await bootKernel()
  try {
    const server = createMcpServer({
      verbs: booted.kernel.verbs,
      query: booted.kernel.query,
      runTool: (verb, params) => Promise.resolve(verb.operation(params, /** @type {any} */ ({}))),
      transport: 'http',
      allowOperator: false,
    })
    const r = /** @type {any} */ (await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    const tools = r.result.tools
    assert.deepEqual(tools.map((/** @type {any} */ t) => t.name).sort(), ['annotations_untitled', 'graph_neighbors', 'grep_search', 'query_sql'])
    assertAnnotated(tools, (t) => booted.kernel.verbs.getByTool(t))
    assert.equal(tools.find((/** @type {any} */ t) => t.name === 'annotations_untitled').title, 'annotations_untitled')
  } finally {
    await fs.rm(booted.tmp, { recursive: true, force: true })
  }
})

test('registration refuses a title that is not a non-empty string', async () => {
  const booted = await bootKernel()
  try {
    for (const title of ['', 42]) {
      assert.throws(
        () => booted.kernel.verbs.register(/** @type {any} */ ({ ...untitledVerb, name: 'annotations bad', tool: 'annotations_bad', title })),
        /title must be a non-empty string/,
      )
    }
  } finally {
    await fs.rm(booted.tmp, { recursive: true, force: true })
  }
})

test('a verb whose auth class has no hints is not listed', async () => {
  const stray = { ...untitledVerb, authClass: 'write' }
  const list = [stray]
  const verbs = {
    list: () => list,
    get: (/** @type {string} */ n) => list.find((v) => v.name === n),
    getByTool: (/** @type {string} */ t) => list.find((v) => v.tool === t),
    register() {},
  }
  const server = createMcpServer({
    verbs: /** @type {any} */ (verbs),
    query: /** @type {any} */ ({ listDatasets: () => [], getDataset: () => undefined, registerDataset() {} }),
    runTool: () => Promise.resolve({}),
    transport: 'stdio',
    allowOperator: true,
  })
  assert.deepEqual(server.listTools(), [])
})
