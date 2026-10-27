// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runQuerySchema } from '../../src/core/commands/query.js'
import { createMcpServer } from '../../src/core/mcp/server.js'
import { createVerbRegistry } from '../../src/core/registry/verbs.js'

/** @import { DatasetSchema } from '../../hypaware-plugin-kernel-types.js' */

/** @type {DatasetSchema['columns']} */
const columns = [
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'tool_args', type: 'JSON', nullable: true },
]

/** @param {DatasetSchema['columns']} [cols] */
function context(cols = columns) {
  const stdout = { value: '', write(/** @type {string} */ s) { this.value += s; return true } }
  const stderr = { value: '', write(/** @type {string} */ s) { this.value += s; return true } }
  const ctx = /** @type {any} */ ({
    stdout, stderr,
    query: { getDataset: (/** @type {string} */ name) => name === 'ai_gateway_messages' ? { schema: { columns: cols } } : undefined },
    config: { version: 2, query: { remotes: { prod: { url: 'https://schema.example' } } } },
    env: { HYP_REMOTE_TOKEN_PROD: 'test-token' },
  })
  return { ctx, stdout, stderr }
}

test('schema preserves the default listing and exposes column metadata as JSON', async () => {
  const human = context()
  assert.equal(await runQuerySchema(['ai_gateway_messages'], human.ctx), 0)
  assert.match(human.stdout.value, /dataset: ai_gateway_messages\ncolumns: 3/)
  assert.match(human.stdout.value, /message_created_at  TIMESTAMP  NOT NULL/)
  const json = context()
  assert.equal(await runQuerySchema(['ai_gateway_messages', '--format', 'json'], json.ctx), 0)
  assert.deepEqual(JSON.parse(json.stdout.value), columns)
  assert.equal(json.stderr.value, '')
})

test('schema byte budget preserves valid JSON, reports withholding, and zero lifts the cap', async () => {
  const capped = context()
  assert.equal(await runQuerySchema(['ai_gateway_messages', '--format=json', '--max-bytes=1'], capped.ctx), 0)
  assert.equal(JSON.parse(capped.stdout.value).length, 1)
  assert.match(capped.stderr.value, /showing 1 of 3 rows/)
  const full = context()
  assert.equal(await runQuerySchema(['ai_gateway_messages', '--json', '--max-bytes', '0'], full.ctx), 0)
  assert.deepEqual(JSON.parse(full.stdout.value), columns)
})

test('schema output files contain every column despite display limits', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-schema-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'schema.json')
  const c = context()
  assert.equal(await runQuerySchema(['ai_gateway_messages', '--format', 'json', '--output', file,
    '--max-bytes', '1', '--max-cell', '1'], c.ctx), 0)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), columns)
  assert.match(c.stdout.value, /wrote 3 rows/)
  assert.equal(c.stderr.value, '')
})

for (const args of [['--format', 'bogus'], ['--max-bytes', '-1'], ['--max-cell', '1.5'], ['--org', 'acme'], ['--refresh', 'always']]) {
  test(`schema rejects invalid controls: ${args.join(' ')}`, async () => {
    const c = context()
    assert.equal(await runQuerySchema(['ai_gateway_messages', ...args], c.ctx), 2)
    assert.equal(c.stdout.value, '')
  })
}

test('unknown dataset does not return successful non-JSON output for --format json', async () => {
  const c = context()
  assert.equal(await runQuerySchema(['missing', '--format', 'json'], c.ctx), 1)
  assert.equal(c.stdout.value, '')
  assert.match(c.stderr.value, /unknown dataset/)
})

test('remote schema reads the real MCP resource rather than the local registry', async t => {
  const remoteColumns = [{ name: 'remote_column', type: 'STRING', nullable: true }]
  const server = createMcpServer({
    verbs: createVerbRegistry(), transport: 'http',
    query: /** @type {any} */ ({ getDataset: () => ({ schema: { columns: remoteColumns } }) }),
    runTool: async () => { throw new Error('must not execute SQL') },
  })
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const methods = []
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://schema.example/v1/mcp?org=acme')
    assert.equal(/** @type {any} */ (init?.headers).authorization, 'Bearer test-token')
    const request = JSON.parse(String(init?.body))
    methods.push(request.method)
    const response = await server.handleMessage(request)
    return response === null ? new Response(null, { status: 202 })
      : Response.json(response)
  }
  for (const remote of [['--remote', 'prod'], ['--remote'], ['--remote=']]) {
    for (const configuredDefault of [true, false]) {
      const c = context()
      c.ctx.query.getDataset = () => { throw new Error('must not read local schema') }
      if (configuredDefault) c.ctx.config.query.default_remote = 'prod'
      else {
        c.ctx.config.query.remotes.hypaware = { url: 'https://schema.example' }
        c.ctx.env.HYP_REMOTE_TOKEN_HYPAWARE = 'test-token'
      }
      methods.length = 0
      assert.equal(await runQuerySchema(['ai_gateway_messages', ...remote, '--org', 'acme', '--format', 'json'], c.ctx), 0, c.stderr.value)
      assert.deepEqual(JSON.parse(c.stdout.value), remoteColumns)
      assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'resources/read'])
    }
  }
  const trailing = context()
  trailing.ctx.config.query.default_remote = 'prod'
  assert.equal(await runQuerySchema(['ai_gateway_messages', '--org', 'acme', '--format', 'json', '--remote'], trailing.ctx), 0, trailing.stderr.value)
  assert.deepEqual(JSON.parse(trailing.stdout.value), remoteColumns)
})

for (const failure of ['missing', 'malformed', 'forbidden', 'oversized']) {
  test(`remote ${failure} schema fails without returning local columns`, async t => {
    const original = globalThis.fetch
    t.after(() => { globalThis.fetch = original })
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id, result: {} })
      if (failure === 'forbidden') return new Response(null, { status: 403 })
      if (failure === 'oversized') return new Response('x'.repeat(1_048_577))
      return Response.json({ jsonrpc: '2.0', id: request.id,
        ...(failure === 'missing' ? { error: { code: -32602, message: 'unknown resource' } }
          : { result: { contents: [{ uri: request.params.uri, text: '{}' }] } }) })
    }
    const c = context()
    assert.notEqual(await runQuerySchema(['ai_gateway_messages', '--remote', 'prod', '--format', 'json'], c.ctx), 0)
    assert.equal(c.stdout.value, '')
    assert.match(c.stderr.value, failure === 'missing' ? /unknown resource/
      : failure === 'malformed' ? /invalid dataset schema/
        : failure === 'forbidden' ? /403/ : /exceeds/)
  })
}
