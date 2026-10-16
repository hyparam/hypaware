import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createExportRedactor, createRowRedactor } from '../../src/core/sinks/redaction.js'
import { parseConfigShape, defaultConfigPath } from '../../src/core/config/schema.js'
import { mergeConfigLayers } from '../../src/core/config/merge.js'
import { bootKernel } from '../../src/core/runtime/boot.js'
import { openIncrementalRows } from '../../src/core/sinks/incremental.js'
import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { createSinkWatermarkStore } from '../../src/core/sinks/watermarks.js'
import { createDatasetRolloutStore } from '../../hypaware-core/plugins-workspace/central/src/rollout.js'
import { readRequestBody } from '../helpers/request_body.js'

const MASK = '[REDACTED]'
const key = 'sk-proj-' + 'a'.repeat(40)

test('built-ins remove credentials from text, nested objects and JSON strings without changing identities or the input', () => {
  const row = {
    session_id: key, cwd: '/work', model: 'test', tokens: 17,
    content_text: `API_KEY=${key}\n${key}\n${key}`,
    tool_args: JSON.stringify({ nested: { password: 'proprietary-format', text: `prefix ${key}` } }),
    attributes: { authorization: 'private-value', items: [`Bearer ${'b'.repeat(32)}`] },
    raw_frame: { output: `postgres://alice:private@db.example/db ${key}` },
  }
  const before = structuredClone(row)
  const redacted = createRowRedactor()(row)
  assert.equal(redacted.session_id, key)
  assert.equal(redacted.cwd, '/work')
  assert.equal(redacted.tokens, 17)
  assert.equal(redacted.content_text, `API_KEY=${MASK}\n${MASK}\n${MASK}`)
  assert.deepEqual(JSON.parse(redacted.tool_args), { nested: { password: MASK, text: `prefix ${MASK}` } })
  assert.equal(redacted.attributes.authorization, MASK)
  assert.equal(redacted.raw_frame.output, `${MASK} ${MASK}`)
  assert.deepEqual(row, before)
  const clean = { content_text: 'ordinary prose', count: 1 }
  assert.equal(createRowRedactor()(clean), clean, 'unchanged rows are not copied')
})

test('private keys, including a truncated key, are masked without scanning past the redacted block', () => {
  const redact = createRowRedactor()
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY']) {
    assert.equal(redact({ body: `before -----BEGIN ${label}-----\nprivate\n-----END ${label}----- after` }).body, `before ${MASK} after`)
    assert.equal(redact({ body: `before -----BEGIN ${label}-----\nprivate` }).body, `before ${MASK}`)
  }
})

test('file contents and raw duplicates are masked, including split call/result rows and unknown read paths', () => {
  const redact = createRowRedactor()
  const call = { session_id: 's', tool_call_id: 'call', tool_name: 'Read', part_type: 'tool_call', tool_args: { file_path: '/work/.env.local' } }
  assert.equal(redact(call), call)
  const output = redact({ session_id: 's', tool_result_for: 'call', tool_name: 'Read', part_type: 'tool_result', content_text: 'custom-format-secret', raw_frame: { content: 'custom-format-secret' } })
  assert.equal(output.content_text, MASK)
  assert.equal(output.raw_frame.content, MASK)
  assert.equal(redact({ tool_name: 'functions.read_file', part_type: 'tool_result', content_text: 'unknown-file-output' }).content_text, MASK)
  const write = redact({ tool_name: 'write', part_type: 'tool_call', tool_args: JSON.stringify({ path: '/work/.aws/credentials', content: 'not-a-recognizable-token' }) })
  assert.equal(JSON.parse(write.tool_args).content, MASK)
  assert.equal(JSON.parse(write.tool_args).path, '/work/.aws/credentials')
  const normal = { tool_name: 'Read', part_type: 'tool_result', tool_args: { path: 'notes.md' }, content_text: 'ordinary notes' }
  assert.equal(redact(normal), normal)
  const template = { tool_name: 'read', tool_args: { path: '.env.example' }, content_text: 'example content' }
  assert.equal(redact(template), template)
  const raw = redact({ raw_frame: { state: { input: { filePath: '.env' }, output: 'private-raw-copy' } } })
  assert.equal(raw.raw_frame.state.output, MASK)
  redact({ tool_name: 'read', part_type: 'tool_call', tool_call_id: 'reused', tool_args: { path: 'notes.md' } })
  assert.equal(redact({ tool_name: 'read', part_type: 'tool_result', tool_result_for: 'reused', content_text: 'path not attributable' }).content_text, MASK)
})

test('custom regexes are global, preserve JSON representation and do not replace structural identities', async () => {
  const redactor = createExportRedactor({ custom_patterns: [{ pattern: 'internal-[a-z]+', flags: 'i' }] })
  try {
    const result = await redactor.redact({ id: 'internal-id', content_text: 'internal-alpha INTERNAL-BETA', tool_args: '{"text":"internal-gamma"}' })
    assert.equal(result.id, 'internal-id')
    assert.equal(result.content_text, `${MASK} ${MASK}`)
    assert.equal(JSON.parse(result.tool_args).text, MASK)
    const clean = { id: 'same', org: 'internal-org', content_text: 'plain' }
    assert.equal(await redactor.redact(clean), clean, 'worker returns no copy for unchanged rows')
  } finally { await redactor.close() }
})

test('pathological custom regexes time out without blocking the main event loop or returning raw content', async () => {
  const redactor = createExportRedactor({ custom_patterns: [{ pattern: '(a+)+$' }] })
  let responsive = false
  const timer = setTimeout(() => { responsive = true }, 25)
  try {
    await assert.rejects(redactor.redact({ content_text: 'a'.repeat(40) + '!' }), /redaction timed out/)
    assert.equal(responsive, true)
  } finally { clearTimeout(timer); await redactor.close() }
})

test('redaction config rejects invalid expressions and bounds without echoing configured secrets', () => {
  for (const redaction of [null, [], { typo: [] }, { custom_patterns: ['x'] }, { custom_patterns: [{ pattern: '' }] }, { custom_patterns: [{ pattern: '(' }] }, { custom_patterns: [{ pattern: 'private[', flags: 'i' }] }, { custom_patterns: [{ pattern: 'x', flags: 'ii' }] }, { custom_patterns: [{ pattern: 'x', flags: 'y' }] }, { custom_patterns: [{ pattern: 'x', replacement: 'raw' }] }, { custom_patterns: Array(33).fill({ pattern: 'x' }) }, { custom_patterns: [{ pattern: 'x'.repeat(2049) }] }]) {
    const result = parseConfigShape({ version: 2, redaction })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.errors.every(error => error.pointer.startsWith('/redaction')))
      assert.equal(JSON.stringify(result.errors).includes('private['), false)
    }
  }
  const config = { version: 2, redaction: { custom_patterns: [{ pattern: 'org-[0-9]+', flags: 'i' }] } }
  assert.deepEqual(parseConfigShape(config), { ok: true, config })
})

test('central and local regexes add together instead of replacing central protections', () => {
  const central = { version: /** @type {const} */ (2), redaction: { custom_patterns: [{ pattern: 'central-secret' }] } }
  const local = { version: /** @type {const} */ (2), redaction: { custom_patterns: [{ pattern: 'local-secret' }] } }
  assert.deepEqual(mergeConfigLayers(central, local).effective.redaction?.custom_patterns, [...central.redaction.custom_patterns, ...local.redaction.custom_patterns])
  assert.deepEqual(mergeConfigLayers(central, { version: 2, redaction: {} }).effective.redaction, central.redaction)
})

test('booted config reaches every export reader, preserves local data and watermarks, and cannot be bypassed by projection', async t => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-redaction-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [], redaction: { custom_patterns: [{ pattern: 'company-[a-z]+' }] } }))
  const boot = await bootKernel({ hypHome, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }, bootProfile: { activate: [] } })
  const storage = boot.runtime.storage
  const table = storage.cacheTablePath('ai_gateway_messages', ['source=unknown'])
  const columns = ['id', 'session_id', 'content_text', 'part_type', 'tool_name', 'tool_args', 'tool_call_id', 'tool_result_for', 'raw_frame', 'cwd'].map(name => ({ name, type: /** @type {const} */ ('STRING'), nullable: true }))
  const rows = [
    { id: '1', session_id: 's', content_text: `${key} company-alpha`, cwd: '/work' },
    { id: '2', session_id: 's', content_text: 'file call', part_type: 'tool_call', tool_name: 'read', tool_call_id: 'read-1', tool_args: '{"path":".env"}', cwd: '/work' },
    { id: '3', session_id: 's', content_text: 'unrecognizable-private-value', part_type: 'tool_result', tool_name: 'read', tool_result_for: 'read-1', cwd: '/work' },
  ]
  await storage.appendRows(table, columns, rows)
  await storage.flushTable(table, { reason: 'manual' })
  const local = await Array.fromAsync(storage.readRows(table))
  assert.equal(local[0].content_text, rows[0].content_text)
  const exported = await Array.fromAsync(storage.readRowsSince(table, { columns: ['id', 'content_text'] }))
  assert.deepEqual(exported.map(entry => entry.row), [{ id: '1', content_text: `${MASK} ${MASK}` }, { id: '2', content_text: MASK }, { id: '3', content_text: MASK }])
  assert.ok(exported.every(entry => entry.after.seq))
  const last = exported.at(-1)
  assert.ok(last)
  assert.equal((await Array.fromAsync(storage.readRowsSince(table, { since: last.after, includeLegacy: false }))).length, 0)
  // Blob destinations consume this same stream through the incremental reader.
  const incremental = await openIncrementalRows(storage, { dataset: 'ai_gateway_messages', tablePath: table, partition: {} }, undefined)
  assert.equal((await Array.fromAsync(incremental.rows))[0].content_text, `${MASK} ${MASK}`)
  // The request destination must send the redacted payload, not a fresh raw read.
  const posted = []
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://synthetic', identity: {} }),
    identityClient: /** @type {any} */ ({ async getCurrentJwt() { return 'synthetic' }, async refresh() {} }),
    storage,
    watermarks: createSinkWatermarkStore({ stateDir: path.join(hypHome, 'sink-state') }),
    rollouts: createDatasetRolloutStore({ paths: { stateDir: path.join(hypHome, 'sink-state'), rootDir: hypHome, cacheDir: hypHome, tempDir: hypHome }, instanceName: 'central' }),
    query: /** @type {any} */ ({ getDataset() { return { sourceSignal: 'logs' } } }),
    log: /** @type {any} */ ({ debug() {}, info() {}, warn() {}, error() {} }),
    fetchFn: /** @type {any} */ (async (url, options) => {
      posted.push(await readRequestBody(options.body))
      return new Response('', { status: 202 })
    }),
  })
  const result = await sink.exportBatch({ batchId: 'redaction-test', partitions: [{ dataset: 'ai_gateway_messages', tablePath: table, partition: {} }] }, { format: 'native', schedule: '* * * * *' })
  await sink.close()
  assert.equal(result.status, 'exported')
  assert.ok(posted.length)
  assert.equal(posted.join('').includes(key), false)
  assert.equal(posted.join('').includes('company-alpha'), false)
  assert.equal((await Array.fromAsync(storage.readRows(table)))[0].content_text, rows[0].content_text)
})

test('oversized rows fail closed rather than skipping scanning', () => {
  assert.throws(() => createRowRedactor()({ content_text: 'x'.repeat(9 * 1024 * 1024) }), /redaction row exceeds/)
})
