// @ts-check

/**
 * @import { TestContext } from 'node:test'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { deriveReportsEndpoint } from '../../src/core/remote/credentials.js'
import {
  runReportDelete,
  runReportGet,
  runReportList,
  runReportPublish,
} from '../../src/core/cli/report_commands.js'

/* ---------- endpoint derivation ---------- */

test('deriveReportsEndpoint maps a base URL to <base>/v1/reports', () => {
  assert.equal(deriveReportsEndpoint('https://hyp.internal'), 'https://hyp.internal/v1/reports')
  assert.equal(deriveReportsEndpoint('https://hyp.internal/'), 'https://hyp.internal/v1/reports')
})

test('deriveReportsEndpoint strips a trailing /v1/mcp (the originally-documented form)', () => {
  assert.equal(deriveReportsEndpoint('https://hyp.internal/v1/mcp'), 'https://hyp.internal/v1/reports')
  assert.equal(deriveReportsEndpoint('https://hyp.internal/prefix/v1/mcp/'), 'https://hyp.internal/prefix/v1/reports')
})

test('deriveReportsEndpoint returns an unparseable URL unchanged', () => {
  assert.equal(deriveReportsEndpoint('not a url'), 'not a url')
})

/* ---------- harness ---------- */

/**
 * A fake reports-plane server installed as `globalThis.fetch`, recording
 * every request. `respond` maps (method, url) to a response description.
 *
 * @param {TestContext} t
 * @param {(method: string, url: URL) => { status: number, json?: any, body?: Uint8Array }} respond
 * @returns {{ calls: Array<{ method: string, url: URL, headers: Record<string, string>, body: Buffer | null }> }}
 */
function stubServer(t, respond) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  /** @type {Array<{ method: string, url: URL, headers: Record<string, string>, body: Buffer | null }>} */
  const calls = []
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    calls.push({
      method,
      url,
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: init.body ? Buffer.from(init.body) : null,
    })
    const out = respond(method, url)
    const bytes = out.body ?? new TextEncoder().encode(JSON.stringify(out.json ?? {}))
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })
  return { calls }
}

/** @param {Record<string, string | undefined>} [env] */
function ctxWith(env = {}) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: '/tmp/none', HYP_REMOTE_TOKEN_PROD: 'tok', ...env },
    config: { version: 2, query: { remotes: { prod: { url: 'https://hyp.internal' } }, default_remote: 'prod' } },
    stdin: { isTTY: false },
    stdout: { write: (/** @type {any} */ s) => out.push(typeof s === 'string' ? s : s.toString('utf8')) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

/** @param {string} [content] */
async function tmpReportFile(content = '# Weekly\n') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-report-test-'))
  const file = path.join(dir, 'report.md')
  await fs.writeFile(file, content)
  return { dir, file, content }
}

/* ---------- publish ---------- */

test('publish sends a single .md file with kind/period/title params and the content hash', async (t) => {
  const { file, content } = await tmpReportFile()
  const { calls } = stubServer(t, () => ({
    status: 201,
    json: { report: { id: 'rpt-1', kind: 'usage-review', period: '2026-W29', files: 1, bytes: content.length } },
  }))
  const { ctx, out } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'usage-review', '--period', '2026-W29', '--title', 'Weekly review'], ctx)
  assert.equal(code, 0)
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.method, 'POST')
  assert.equal(call.url.origin + call.url.pathname, 'https://hyp.internal/v1/reports')
  assert.equal(call.url.searchParams.get('kind'), 'usage-review')
  assert.equal(call.url.searchParams.get('period'), '2026-W29')
  assert.equal(call.url.searchParams.get('title'), 'Weekly review')
  assert.equal(call.url.searchParams.get('org'), null)
  assert.equal(call.headers['content-type'], 'text/markdown')
  assert.equal(call.headers.authorization, 'Bearer tok')
  assert.equal(call.headers['x-report-content-hash'], crypto.createHash('sha256').update(content).digest('hex'))
  assert.equal(call.body?.toString('utf8'), content)
  assert.match(out.join(''), /published usage-review\/2026-W29\/rpt-1/)
  assert.match(out.join(''), /hyp report get usage-review 2026-W29 rpt-1/)
})

test('publish reports a 200 dedup hit as already published', async (t) => {
  const { file } = await tmpReportFile()
  stubServer(t, () => ({ status: 200, json: { report: { id: 'rpt-old', kind: 'k', period: 'p' } } }))
  const { ctx, out } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'k', '--period', 'p'], ctx)
  assert.equal(code, 0)
  assert.match(out.join(''), /already published as k\/p\/rpt-old/)
})

test('publish packs a folder as a gzipped ustar bundle', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-report-bundle-'))
  await fs.writeFile(path.join(dir, 'report.html'), '<h1>hi</h1>')
  await fs.mkdir(path.join(dir, 'assets'))
  await fs.writeFile(path.join(dir, 'assets', 'style.css'), 'h1{}')
  const { calls } = stubServer(t, () => ({ status: 201, json: { report: { id: 'rpt-2', kind: 'k', period: 'p', files: 2, bytes: 15 } } }))
  const { ctx } = ctxWith()
  const code = await runReportPublish([dir, '--kind', 'k', '--period', 'p'], ctx)
  assert.equal(code, 0)
  const call = calls[0]
  assert.equal(call.headers['content-type'], 'application/gzip')
  const tar = zlib.gunzipSync(/** @type {Buffer} */ (call.body))
  assert.equal(tar.subarray(257, 262).toString('ascii'), 'ustar')
  const names = tar.toString('latin1')
  assert.match(names, /report\.html/)
  assert.match(names, /style\.css/)
  assert.equal(call.headers['x-report-content-hash'], crypto.createHash('sha256').update(/** @type {Buffer} */ (call.body)).digest('hex'))
})

test('publish rejects a folder without an entry document before any upload', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-report-noentry-'))
  await fs.writeFile(path.join(dir, 'notes.md'), 'not an entry doc')
  const { calls } = stubServer(t, () => ({ status: 500 }))
  const { ctx, err } = ctxWith()
  const code = await runReportPublish([dir, '--kind', 'k', '--period', 'p'], ctx)
  assert.equal(code, 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /must contain report\.html or report\.md/)
})

test('publish rejects an invalid kind before any network call', async (t) => {
  const { file } = await tmpReportFile()
  const { calls } = stubServer(t, () => ({ status: 500 }))
  const { ctx, err } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'Usage_Review', '--period', '2026-W29'], ctx)
  assert.equal(code, 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /kind must match/)
})

test('publish rejects a single file that is neither .html nor .md', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-report-ext-'))
  const file = path.join(dir, 'report.pdf')
  await fs.writeFile(file, 'pdfish')
  const { calls } = stubServer(t, () => ({ status: 500 }))
  const { ctx, err } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'k', '--period', 'p'], ctx)
  assert.equal(code, 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /must be \.html or \.md/)
})

test('publish surfaces the quota error with its make-room guidance', async (t) => {
  const { file } = await tmpReportFile()
  stubServer(t, () => ({ status: 507, json: { error: 'report_quota_exceeded' } }))
  const { ctx, err } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'k', '--period', 'p'], ctx)
  assert.equal(code, 1)
  assert.match(err.join(''), /report quota is full/)
  assert.match(err.join(''), /nothing is auto-pruned/)
})

test('publish forwards an explicit --org (the admin-token form)', async (t) => {
  const { file } = await tmpReportFile()
  const { calls } = stubServer(t, () => ({ status: 201, json: { report: { id: 'rpt-3', kind: 'k', period: 'p' } } }))
  const { ctx } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'k', '--period', 'p', '--org', 'acme'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.searchParams.get('org'), 'acme')
})

/* ---------- list ---------- */

test('list renders the index newest first and passes filters through', async (t) => {
  const { calls } = stubServer(t, () => ({
    status: 200,
    json: { reports: [
      { id: 'rpt-b', kind: 'usage-review', period: '2026-W29', title: 'Weekly', bytes: 1200, publishedAt: '2026-07-20T10:00:00.000Z' },
      { id: 'rpt-a', kind: 'usage-review', period: '2026-W28', title: '', bytes: 900, publishedAt: '2026-07-13T10:00:00.000Z' },
    ] },
  }))
  const { ctx, out } = ctxWith()
  const code = await runReportList(['--kind', 'usage-review', '--limit', '10'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.searchParams.get('kind'), 'usage-review')
  assert.equal(calls[0].url.searchParams.get('limit'), '10')
  const text = out.join('')
  assert.match(text, /usage-review\/2026-W29\trpt-b\t1200 bytes\tWeekly/)
  assert.match(text, /usage-review\/2026-W28\trpt-a\t900 bytes/)
})

test('list --json prints the raw records', async (t) => {
  const reports = [{ id: 'rpt-a', kind: 'k', period: 'p', bytes: 1, publishedAt: 'x' }]
  stubServer(t, () => ({ status: 200, json: { reports } }))
  const { ctx, out } = ctxWith()
  const code = await runReportList(['--json'], ctx)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join('')), reports)
})

test('list with no reports points at publish', async (t) => {
  stubServer(t, () => ({ status: 200, json: { reports: [] } }))
  const { ctx, out } = ctxWith()
  const code = await runReportList([], ctx)
  assert.equal(code, 0)
  assert.match(out.join(''), /no reports published/)
})

test('an unknown remote target is rejected before any network call', async (t) => {
  const { calls } = stubServer(t, () => ({ status: 200, json: { reports: [] } }))
  const { ctx, err } = ctxWith()
  const code = await runReportList(['--remote', 'staging'], ctx)
  assert.equal(code, 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /unknown remote target 'staging'/)
})

test('a 401 on an env-override token explains that re-login cannot fix it', async (t) => {
  stubServer(t, () => ({ status: 401, json: { error: 'unauthorized' } }))
  const { ctx, err } = ctxWith()
  const code = await runReportList([], ctx)
  assert.equal(code, 1)
  assert.match(err.join(''), /re-login cannot fix an env override/)
})

/* ---------- get ---------- */

test('get fetches the entry document to stdout', async (t) => {
  const body = new TextEncoder().encode('<h1>report</h1>')
  const { calls } = stubServer(t, () => ({ status: 200, body }))
  const { ctx, out } = ctxWith()
  const code = await runReportGet(['usage-review', '2026-W29', 'rpt-1'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.pathname, '/v1/reports/usage-review/2026-W29/rpt-1/')
  assert.equal(out.join(''), '<h1>report</h1>')
})

test('get fetches a named artifact and saves it with --output', async (t) => {
  const body = new TextEncoder().encode('binary-ish')
  const { calls } = stubServer(t, () => ({ status: 200, body }))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-report-out-'))
  const outFile = path.join(dir, 'chart.png')
  const { ctx, out, err } = ctxWith()
  const code = await runReportGet(['k', 'p', 'rpt-1', 'assets/chart.png', '--output', outFile], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.pathname, '/v1/reports/k/p/rpt-1/assets/chart.png')
  assert.equal(await fs.readFile(outFile, 'utf8'), 'binary-ish')
  assert.equal(out.join(''), '')
  assert.match(err.join(''), /saved 10 bytes/)
})

test('get reports an unknown report from the server error body', async (t) => {
  stubServer(t, () => ({ status: 404, json: { error: 'unknown_report' } }))
  const { ctx, err } = ctxWith()
  const code = await runReportGet(['k', 'p', 'rpt-x'], ctx)
  assert.equal(code, 1)
  assert.match(err.join(''), /HTTP 404: unknown_report/)
})

/* ---------- delete ---------- */

test('delete refuses without --yes when stdin is not a TTY', async (t) => {
  const { calls } = stubServer(t, () => ({ status: 200, json: { status: 'deleted' } }))
  const { ctx, err } = ctxWith()
  const code = await runReportDelete(['k', 'p', 'rpt-1'], ctx)
  assert.equal(code, 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /pass --yes/)
})

test('delete with --yes issues the DELETE and confirms', async (t) => {
  const { calls } = stubServer(t, () => ({ status: 200, json: { status: 'deleted' } }))
  const { ctx, out } = ctxWith()
  const code = await runReportDelete(['k', 'p', 'rpt-1', '--yes'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].method, 'DELETE')
  assert.equal(calls[0].url.pathname, '/v1/reports/k/p/rpt-1')
  assert.match(out.join(''), /deleted k\/p\/rpt-1/)
})
