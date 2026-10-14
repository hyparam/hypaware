// @ts-check

// The recommendation tool contracts are data the server binds by name
// (LLP 0494#remote-contracts). These pins hold the shapes hypaware-server
// LLP 0596#tools-shapes and #annotations settle, so a drift on either side
// fails here rather than on a live `/v1/mcp`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

import { REMOTE_TOOL_CONTRACTS } from '../../src/core/mcp/contracts.js'
import { RECOMMENDATION_STATES } from '../../src/core/cli/command_args.js'
import { toJsonSchema, validateToolArguments } from '../../src/core/cli/verb_codec.js'
import { createVerbRegistry } from '../../src/core/registry/verbs.js'

/**
 * @import { RemoteToolContract, VerbInputProperty } from '../../hypaware-plugin-kernel-types.js'
 */

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'hypaware.js')

/**
 * @param {string} tool
 * @returns {RemoteToolContract}
 */
function contract(tool) {
  const found = REMOTE_TOOL_CONTRACTS.find((c) => c.tool === tool)
  assert.ok(found, `no contract for ${tool}`)
  return found
}

/**
 * Every object and array reachable from `value`, with its path.
 *
 * @param {unknown} value
 * @param {string} at
 * @returns {Array<[string, object]>}
 */
function objectsIn(value, at) {
  if (!value || typeof value !== 'object') return []
  /** @type {Array<[string, object]>} */
  const out = [[at, value]]
  for (const [key, child] of Object.entries(value)) out.push(...objectsIn(child, `${at}.${key}`))
  return out
}

/**
 * Whether `value` is an instance of the JSON Schema scalar `type`.
 *
 * @param {string} type
 * @param {unknown} value
 */
function isOfType(type, value) {
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number'
  return typeof value === type
}

test('the array and everything in it is frozen', () => {
  for (const [at, obj] of objectsIn(REMOTE_TOOL_CONTRACTS, 'REMOTE_TOOL_CONTRACTS')) {
    assert.ok(Object.isFrozen(obj), `${at} is not frozen`)
  }
  assert.throws(() => { /** @type {any} */ (REMOTE_TOOL_CONTRACTS).push({}) }, TypeError)
  assert.throws(() => { /** @type {any} */ (contract('list_recommendations').inputSchema.properties.status.default).push('applied') }, TypeError)
})

test('the read entries, in order, with unique names', () => {
  const tools = REMOTE_TOOL_CONTRACTS.map((c) => c.tool)
  assert.deepEqual(tools, ['list_recommendations', 'get_recommendation'])
  assert.equal(new Set(tools).size, tools.length)
})

test('titles are the ones hypaware-server LLP 0596#annotations tabulates', () => {
  assert.equal(contract('list_recommendations').title, 'List recommendations')
  assert.equal(contract('get_recommendation').title, 'Read a recommendation')
})

test('each entry is a read with no scope, a summary and its CLI equivalent', () => {
  for (const c of REMOTE_TOOL_CONTRACTS) {
    assert.deepEqual(Object.keys(c).sort(), ['authClass', 'cli', 'inputSchema', 'summary', 'title', 'tool'], c.tool)
    assert.equal(c.authClass, 'read', c.tool)
    assert.equal(c.scope, undefined, c.tool)
    assert.ok(c.summary.length > 0, c.tool)
  }
  assert.equal(contract('list_recommendations').cli, 'hyp report list --recommendations')
  assert.equal(contract('get_recommendation').cli, 'hyp report get <rec-id>')
})

test('list_recommendations says counts are not an org total', () => {
  assert.match(contract('list_recommendations').summary, /not an org total/)
})

test('each schema is a well-formed JSON Schema object', () => {
  for (const c of REMOTE_TOOL_CONTRACTS) {
    const schema = c.inputSchema
    assert.equal(schema.type, 'object', c.tool)
    assert.equal(schema.positional, undefined, `${c.tool}: positional is a CLI hint`)
    for (const name of schema.required ?? []) {
      assert.ok(Object.hasOwn(schema.properties, name), `${c.tool}: required '${name}' is not a property`)
    }
    for (const [name, prop] of Object.entries(schema.properties)) {
      const where = `${c.tool}.${name}`
      assert.ok(['string', 'integer', 'number', 'boolean', 'array'].includes(prop.type), where)
      assert.equal(prop.greedy, undefined, `${where}: greedy is a CLI hint`)
      assert.equal(typeof prop.description, 'string', where)
      if (prop.type === 'array') assert.ok(prop.items, `${where}: an array names its items`)
      if (prop.minimum !== undefined && prop.maximum !== undefined) assert.ok(prop.minimum <= prop.maximum, where)
      if (prop.default !== undefined) {
        if (prop.type === 'array') {
          assert.ok(Array.isArray(prop.default), where)
          for (const v of /** @type {unknown[]} */ (prop.default)) {
            assert.ok(isOfType(/** @type {NonNullable<VerbInputProperty['items']>} */ (prop.items).type, v), where)
            if (prop.items?.enum) assert.ok(prop.items.enum.includes(/** @type {string} */ (v)), where)
          }
        } else {
          assert.ok(isOfType(prop.type, prop.default), where)
        }
      }
    }
    // The advertised projection is the authored schema: nothing CLI-only to strip.
    assert.deepEqual(toJsonSchema(schema), JSON.parse(JSON.stringify(schema)), c.tool)
  }
})

test('list_recommendations input matches hypaware-server LLP 0596#tools-shapes', () => {
  const { properties, required } = contract('list_recommendations').inputSchema
  assert.deepEqual(Object.keys(properties).sort(), ['before', 'kind', 'limit', 'period', 'status'])
  assert.equal(required, undefined)
  assert.deepEqual(properties.status.items, { type: 'string', enum: ['open', 'in_progress', 'applied', 'dismissed'] })
  assert.deepEqual(properties.status.items?.enum, RECOMMENDATION_STATES)
  assert.deepEqual(properties.status.default, ['open'])
  assert.equal(properties.limit.type, 'integer')
  assert.equal(properties.limit.minimum, 1)
  assert.equal(properties.limit.maximum, 100)
  assert.equal(properties.limit.default, 20)
  for (const name of ['kind', 'period', 'before']) assert.equal(properties[name].type, 'string', name)
})

test('get_recommendation input matches hypaware-server LLP 0596#tools-shapes', () => {
  const { properties, required } = contract('get_recommendation').inputSchema
  assert.deepEqual(Object.keys(properties).sort(), ['id', 'include_evidence'])
  assert.deepEqual(required, ['id'])
  assert.equal(properties.id.type, 'string')
  assert.equal(properties.include_evidence.type, 'boolean')
  assert.equal(properties.include_evidence.default, false)
})

// The codec enforces neither `items.enum` nor `maximum`; the server's bound
// operation validates `status` and `limit`, so only defaults and `required`
// are pinned here.
test('the shared codec applies the defaults and refuses a missing id', () => {
  const list = validateToolArguments(contract('list_recommendations').inputSchema, {})
  assert.deepEqual(list, { ok: true, params: { status: ['open'], limit: 20 } })
  const get = validateToolArguments(contract('get_recommendation').inputSchema, { id: 'hyprec-0123456789abcdef' })
  assert.deepEqual(get, { ok: true, params: { id: 'hyprec-0123456789abcdef', include_evidence: false } })
  assert.equal(validateToolArguments(contract('get_recommendation').inputSchema, {}).ok, false)
})

test('a contract registers as a verb once an operation is bound to it by name', () => {
  const verbs = createVerbRegistry()
  for (const c of REMOTE_TOOL_CONTRACTS) {
    verbs.register({
      name: `contract ${c.tool}`,
      tool: c.tool,
      summary: c.summary,
      inputSchema: c.inputSchema,
      authClass: c.authClass,
      operation: async () => ({}),
      render: () => ({ stdout: '' }),
    })
  }
  for (const c of REMOTE_TOOL_CONTRACTS) assert.equal(verbs.getByTool(c.tool)?.summary, c.summary)
})

test('booting a stdio host registers no tool from the module', { timeout: 60_000 }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-mcp-contracts-'))
  t.after(() => fs.rm(tmp, { recursive: true, force: true }))
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    cwd: tmp,
    env: { PATH: process.env.PATH ?? '', HOME: tmp, HYP_HOME: path.join(tmp, 'hyp') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { err += chunk })
  const exited = new Promise((resolve) => child.on('close', resolve))
  child.stdin.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contracts-test', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    '',
  ].join('\n'))
  const code = await exited
  assert.equal(code, 0, err)

  const listed = out.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 2)
  assert.ok(listed?.result?.tools, `no tools/list result: ${out} ${err}`)
  /** @type {string[]} */
  const names = listed.result.tools.map((/** @type {{ name: string }} */ tool) => tool.name)
  assert.ok(names.length > 0, 'the host lists its own tools')
  for (const c of REMOTE_TOOL_CONTRACTS) assert.ok(!names.includes(c.tool), `${c.tool} is listed`)
})
