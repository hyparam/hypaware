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
  runReportFix,
  runReportGet,
  runReportList,
  runReportPublish,
} from '../../src/core/cli/report_commands.js'
import { PromptBackRequestedError, PromptCancelledError } from '../../src/core/cli/tui/index.js'

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

// `--org` was the last argv reader left in the file. `valueFlag()` drops a
// dash-leading value, so the gate blessed `--org -acme` and the request went
// out with no org at all; and `valueFlag()` reads the FIRST occurrence while
// the codec validates the LAST, so a repeated flag validated one org and sent
// another.
test('publish forwards a dash-leading --org rather than dropping it', async (t) => {
  const { file } = await tmpReportFile()
  const { calls } = stubServer(t, () => ({ status: 201, json: { report: { id: 'rpt-6', kind: 'k', period: 'p' } } }))
  const { ctx } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'k', '--period', 'p', '--org', '-acme'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.searchParams.get('org'), '-acme')
})

test('publish sends the --org the gate validated when the flag repeats', async (t) => {
  const { file } = await tmpReportFile()
  const { calls } = stubServer(t, () => ({ status: 201, json: { report: { id: 'rpt-7', kind: 'k', period: 'p' } } }))
  const { ctx } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'k', '--period', 'p', '--org', 'a', '--org', 'b'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.searchParams.get('org'), 'b')
})

// The gate accepts any string for --title, so a title whose first character
// is '-' is valid input. Reading it back with `valueFlag()` dropped it and
// published untitled, exit 0, with nothing on stderr to say so.
test('publish carries a --title that starts with a dash', async (t) => {
  const { file } = await tmpReportFile()
  const { calls } = stubServer(t, () => ({ status: 201, json: { report: { id: 'rpt-4', kind: 'k', period: 'p' } } }))
  const { ctx } = ctxWith()
  const code = await runReportPublish([file, '--kind', 'k', '--period', 'p', '--title', '-Q3 rollup'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.searchParams.get('title'), '-Q3 rollup')
})

test('publish accepts the inline --flag=value form the gate parses', async (t) => {
  const { file } = await tmpReportFile()
  const { calls } = stubServer(t, () => ({ status: 201, json: { report: { id: 'rpt-5', kind: 'k', period: 'p' } } }))
  const { ctx } = ctxWith()
  const code = await runReportPublish([file, '--kind=k', '--period=p', '--title=Weekly'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.searchParams.get('kind'), 'k')
  assert.equal(calls[0].url.searchParams.get('period'), 'p')
  assert.equal(calls[0].url.searchParams.get('title'), 'Weekly')
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

// Same class as the --title drop above: a dash-leading filter value the gate
// blessed reached the server as no filter at all, so the caller got the
// default listing and exit 0 instead of the server's refusal.
test('list forwards a dash-leading filter value instead of dropping it', async (t) => {
  const { calls } = stubServer(t, () => ({ status: 200, json: { reports: [] } }))
  const { ctx } = ctxWith()
  const code = await runReportList(['--limit', '-5'], ctx)
  assert.equal(code, 0)
  assert.equal(calls[0].url.searchParams.get('limit'), '-5')
})

test('list prints each report\'s recommendations, by id and page, under its line', async (t) => {
  stubServer(t, () => ({
    status: 200,
    json: { reports: [
      {
        id: 'rpt-b', kind: 'usage-review', period: '2026-W29', title: 'Weekly', bytes: 1200, publishedAt: '2026-07-20T10:00:00.000Z',
        recommendations: [
          // A server that reads the page's opening at publish (server LLP 0416).
          { id: 'rec-0123456789abcdef', page: 'recommendation-batch-the-retries', title: 'Batch the retries', summary: 'Every retry is its own call. One queue fixes it.' },
          // A report that predates that, or a page with no heading: id and page alone.
          { id: 'rec-fedcba9876543210', page: 'recommendation-tenant-check' },
        ],
      },
      { id: 'rpt-a', kind: 'usage-review', period: '2026-W28', bytes: 900, publishedAt: '2026-07-13T10:00:00.000Z' },
    ] },
  }))
  const { ctx, out } = ctxWith()
  const code = await runReportList([], ctx)
  assert.equal(code, 0)
  const lines = out.join('').split('\n').filter(Boolean)
  assert.deepEqual(lines, [
    '  2026-07-20T10:00:00.000Z\tusage-review/2026-W29\trpt-b\t1200 bytes\tWeekly',
    '      rec-0123456789abcdef\trecommendation-batch-the-retries\tBatch the retries',
    '          Every retry is its own call. One queue fixes it.',
    '      rec-fedcba9876543210\trecommendation-tenant-check',
    '  2026-07-13T10:00:00.000Z\tusage-review/2026-W28\trpt-a\t900 bytes',
  ])
})

test('list escapes server text for the terminal; --json stays byte-exact (LLP 0225)', async (t) => {
  // Every listed field is remote-authored, and the listing is what pairs a
  // title with the id a reader pastes into `hyp report fix`: a `\r` plus SGR
  // in a title could repaint the line to show that title beside another id.
  const hostile = 'Weekly\r\u001b[31mrec-aaaaaaaaaaaaaaaa\u001b[0m'
  stubServer(t, () => ({
    status: 200,
    json: { reports: [{
      id: 'rpt-b', kind: 'usage-review', period: '2026-W29', title: hostile, bytes: 1200, publishedAt: '2026-07-20T10:00:00.000Z',
      recommendations: [
        { id: 'rec-0123456789abcdef', page: 'recommendation-x', title: 'Batch\u001b[2Kthe retries', summary: 'One queue.\u0007' },
      ],
    }] },
  }))
  {
    const { ctx, out } = ctxWith()
    assert.equal(await runReportList([], ctx), 0)
    const text = out.join('')
    assert.ok(!text.includes('\u001b') && !text.includes('\r') && !text.includes('\u0007'))
    assert.match(text, /Weekly\\r\\u001b\[31mrec-aaaaaaaaaaaaaaaa/)
    assert.match(text, /Batch\\u001b\[2Kthe retries/)
    assert.match(text, /One queue\.\\u0007/)
  }
  // The machine render keeps the captured bytes.
  {
    const { ctx, out } = ctxWith()
    assert.equal(await runReportList(['--json'], ctx), 0)
    assert.equal(JSON.parse(out.join(''))[0].title, hostile)
  }
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

// The target selects which server the credential and the request go to, so
// reading it out of raw argv rather than the gate is the same class as the
// `--org` repeat: `valueFlag()` takes the FIRST occurrence, the codec keeps
// the LAST, so the gate validated one server and the call went to another.
// On `report delete` that is a destructive call against an unblessed scope.
test('list resolves the --remote the gate validated when the flag repeats', async (t) => {
  const { calls } = stubServer(t, () => ({ status: 200, json: { reports: [] } }))
  const { ctx } = ctxWith({ HYP_REMOTE_TOKEN_BACKUP: 'tok-backup' })
  ctx.config.query.remotes.backup = { url: 'https://backup.internal' }
  const code = await runReportList(['--remote', 'prod', '--remote', 'backup'], ctx)
  assert.equal(code, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.origin, 'https://backup.internal')
  assert.equal(calls[0].headers.authorization, 'Bearer tok-backup')
})

// A dash-leading target is a token the gate blessed, so it must reach the
// registry lookup and be named in the refusal, not be dropped into a generic
// "expects a target name" that never says which token was rejected.
test('list names a dash-leading --remote in the refusal', async (t) => {
  const { calls } = stubServer(t, () => ({ status: 200, json: { reports: [] } }))
  const { ctx, err } = ctxWith()
  const code = await runReportList(['--remote', '-staging'], ctx)
  assert.equal(code, 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /unknown remote target '-staging'/)
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

// `valueFlag()` takes the FIRST occurrence of a flag; the codec keeps the LAST.
// So the gate validated one path and the bytes landed at another, exit 0 with
// `saved N bytes to <the other file>` on stderr. Same class as the `--org`
// repeat above.
test('get writes to the --output the gate validated when the flag repeats', async (t) => {
  const body = new TextEncoder().encode('binary-ish')
  stubServer(t, () => ({ status: 200, body }))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-report-out-'))
  const first = path.join(dir, 'first.png')
  const last = path.join(dir, 'last.png')
  const { ctx } = ctxWith()
  const code = await runReportGet(['k', 'p', 'rpt-1', '--output', first, '--output', last], ctx)
  assert.equal(code, 0)
  assert.equal(await fs.readFile(last, 'utf8'), 'binary-ish')
  await assert.rejects(fs.access(first))
})

test('get reports an unknown report from the server error body', async (t) => {
  stubServer(t, () => ({ status: 404, json: { error: 'unknown_report' } }))
  const { ctx, err } = ctxWith()
  const code = await runReportGet(['k', 'p', 'rpt-x'], ctx)
  assert.equal(code, 1)
  assert.match(err.join(''), /HTTP 404: unknown_report/)
})

/* ---------- fix ---------- */

// `hyp report fix` launches through the seams `hyp ask` uses (status probe,
// PATH probe, spawn, prompt), so the tests inject all four and check what
// reaches them: which id was resolved, which page was fetched, and what the
// client was started with.
// @ref LLP 0414#id-is-the-handle [tests]: a bare id resolves to its report and page with nothing else in hand

const REC = 'rec-0123456789abcdef'
const REPORT = { id: 'rpt-b', kind: 'usage-review', period: '2026-W29', title: 'Weekly', bytes: 1200, publishedAt: '2026-07-20T10:00:00.000Z' }
const PAGE = '# Batch the retries\n\nEvery retry is its own call.\n'

/** The citations a server attaches at publish (server LLP 0419), as the record lists them. */
const CITED = {
  evidence: [
    { sessionId: 'sess-1', chainId: null, messageId: 'msg-1', toolCallId: null, day: '2026-07-14', note: 'three retries of one edit in a row' },
    { sessionId: 'sess-2', chainId: 'agent-7', messageId: 'msg-9', toolCallId: 'call-3', day: '2026-07-15', note: 'the retried call itself' },
  ],
  basis: [
    { agent: 'coordinator', query: "SELECT COUNT(*) FROM ai_gateway_messages WHERE tool_name = 'edit'" },
    { agent: 'subagent-2', query: 'SELECT session_id FROM ai_gateway_messages LIMIT 5' },
  ],
}

/**
 * A reports plane holding one report with one recommendation. `md` false
 * publishes the page as HTML only; `opening` lists the page's title and
 * thesis on the record, as a server that reads them at publish does;
 * `cited` attaches `CITED` to the entry on both the listing and the resolve
 * route, as a server that verified them does.
 *
 * @param {TestContext} t
 * @param {{ md?: boolean, opening?: boolean, cited?: boolean }} [opts]
 */
function stubFixServer(t, { md = true, opening = false, cited = false } = {}) {
  const listed = {
    ...(opening
      ? { id: REC, page: 'recommendation-batch-the-retries', title: 'Batch the retries', summary: 'Every retry is its own call. One queue fixes it.' }
      : { id: REC, page: 'recommendation-batch-the-retries' }),
    ...(cited ? CITED : {}),
  }
  return stubServer(t, (method, url) => {
    const p = url.pathname
    if (p === '/v1/reports') return { status: 200, json: { reports: [{ ...REPORT, recommendations: [listed] }] } }
    if (p === `/v1/reports/_recommendations/${REC}`) return { status: 200, json: { recommendation: { id: REC, page: 'recommendation-batch-the-retries', ...(cited ? CITED : {}) }, report: REPORT } }
    if (p.startsWith('/v1/reports/_recommendations/')) return { status: 404, json: { error: 'unknown_recommendation' } }
    if (p === '/v1/reports/usage-review/2026-W29/rpt-b/recommendation-batch-the-retries.md') {
      return md ? { status: 200, body: new TextEncoder().encode(PAGE) } : { status: 404, json: { error: 'not_found' } }
    }
    if (p === '/v1/reports/usage-review/2026-W29/rpt-b/recommendation-batch-the-retries.html') {
      return { status: 200, body: new TextEncoder().encode('<h1>Batch the <em>retries</em></h1>') }
    }
    return { status: 404, json: { error: 'not_found' } }
  })
}

/**
 * The injected seams: one attached client, a recording spawn, and a scripted prompt.
 * @param {{ launchers?: any[], pick?: (spec: any) => Promise<string | number> }} [opts]
 */
function fixDeps({ launchers = [{ client: 'claude', label: 'Claude Code', bin: 'claude', binPath: '/bin/claude', args: ['{prompt}'] }], pick = async () => { throw new Error('unexpected prompt') } } = {}) {
  /** @type {any[]} */ const launches = []
  /** @type {any[]} */ const prompts = []
  return {
    launches,
    prompts,
    deps: /** @type {any} */ ({
      collectStatus: async () => ({ clients: [{ name: 'claude', attached: true }, { name: 'codex', attached: true }] }),
      resolveLaunchers: async () => launchers,
      launchClient: async (/** @type {any} */ args) => { launches.push(args); return { ok: true, code: 0 } },
      select: async (/** @type {any} */ spec) => { prompts.push(spec); return pick(spec) },
    }),
  }
}

test('fix <id> resolves the id, checks the page exists, and starts the client here with the read command', async (t) => {
  const { calls } = stubFixServer(t)
  const { ctx, out } = ctxWith()
  ctx.cwd = '/work/repo'
  const { deps, launches } = fixDeps()
  const code = await runReportFix([REC], ctx, deps)
  assert.equal(code, 0)
  assert.deepEqual(calls.map((c) => c.url.pathname), [
    `/v1/reports/_recommendations/${REC}`,
    '/v1/reports/usage-review/2026-W29/rpt-b/recommendation-batch-the-retries.md',
  ])
  assert.equal(launches.length, 1)
  assert.equal(launches[0].cwd, '/work/repo')
  assert.equal(launches[0].launcher.client, 'claude')
  assert.match(launches[0].prompt, new RegExp('^Run `hyp report get ' + REC + '` and read its output\\.'))
  assert.match(launches[0].prompt, /"Batch the retries"/)
  assert.match(launches[0].prompt, /usage-review\/2026-W29, "Weekly"/)
  assert.doesNotMatch(launches[0].prompt, /hyp query sql/, 'no basis, so no re-run hint')
  assert.match(out.join(''), /Starting Claude Code on "Batch the retries"/)
})

// @ref LLP 0414#page-is-the-brief [tests]: nothing is written under HYP_HOME; the client is pointed at the same read a session makes on its own
test('fix writes nothing to disk and carries the target flags into the read command', async (t) => {
  stubFixServer(t, { cited: true })
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-fix-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const { ctx } = ctxWith({ HYP_HOME: hypHome })
  const { deps, launches } = fixDeps()
  assert.equal(await runReportFix([REC, '--org', 'acme', '--remote', 'prod'], ctx, deps), 0)
  assert.deepEqual(await fs.readdir(hypHome), [])
  assert.match(launches[0].prompt, new RegExp('^Run `hyp report get ' + REC + ' --org acme --remote prod` and read its output\\.'))
  assert.match(launches[0].prompt, /Re-run the queries with `hyp query sql`/)
})

test('fix falls back to the HTML page when the report has no Markdown one', async (t) => {
  const { calls } = stubFixServer(t, { md: false })
  const { ctx } = ctxWith()
  const { deps, launches } = fixDeps()
  assert.equal(await runReportFix([REC], ctx, deps), 0)
  assert.equal(calls.at(-1)?.url.pathname, '/v1/reports/usage-review/2026-W29/rpt-b/recommendation-batch-the-retries.html')
  assert.match(launches[0].prompt, /"Batch the retries"/)
})

// @ref LLP 0414#page-is-the-brief [tests]: `hyp report get <rec-id>` is the one read of a recommendation, citations under the page
test('get <rec-id> prints the page with the record\'s evidence and basis under it', async (t) => {
  const { calls } = stubFixServer(t, { cited: true })
  const { ctx, out } = ctxWith()
  assert.equal(await runReportGet([REC], ctx), 0)
  assert.deepEqual(calls.map((c) => c.url.pathname), [
    `/v1/reports/_recommendations/${REC}`,
    '/v1/reports/usage-review/2026-W29/rpt-b/recommendation-batch-the-retries.md',
  ])
  const printed = out.join('')
  assert.ok(printed.startsWith(PAGE), 'the page comes first, unchanged')
  const tail = printed.slice(PAGE.length)
  assert.match(tail, /^\n---\n\n## Citations from the report record\n/)
  assert.match(tail, /### Evidence\n[\s\S]*\n1\. three retries of one edit in a row \(session sess-1, message msg-1, 2026-07-14\)\n2\. the retried call itself \(session sess-2, chain agent-7, message msg-9, tool call call-3, 2026-07-15\)\n/)
  assert.match(tail, /### Basis\n[\s\S]*Run by coordinator:\n\n```sql\nSELECT COUNT\(\*\) FROM ai_gateway_messages WHERE tool_name = 'edit'\n```\n/)
  assert.match(tail, /Run by subagent-2:\n\n```sql\nSELECT session_id FROM ai_gateway_messages LIMIT 5\n```\n/)
})

test('get <rec-id> prints the bare page when the record carries no citations, and saves with --output', async (t) => {
  stubFixServer(t)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-get-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  {
    const { ctx, out } = ctxWith()
    assert.equal(await runReportGet([REC], ctx), 0)
    assert.equal(out.join(''), PAGE)
  }
  {
    const { ctx, err } = ctxWith()
    const output = path.join(dir, 'rec.md')
    assert.equal(await runReportGet([REC, '--output', output], ctx), 0)
    assert.equal(await fs.readFile(output, 'utf8'), PAGE)
    assert.match(err.join(''), /saved \d+ bytes to /)
  }
})

test('get <rec-id> on an HTML-only page keeps the output HTML: the citations sit in one escaped <pre>', async (t) => {
  stubFixServer(t, { md: false, cited: true })
  const { ctx, out } = ctxWith()
  assert.equal(await runReportGet([REC], ctx), 0)
  const printed = out.join('')
  assert.ok(printed.startsWith('<h1>Batch the <em>retries</em></h1>\n<pre>'))
  assert.match(printed, /## Citations from the report record/)
  assert.match(printed, /<\/pre>\n$/)
  assert.doesNotMatch(printed.slice(printed.indexOf('<pre>') + 5), /<(?!\/pre>)/, 'nothing inside the pre opens a tag')
})

test('get <rec-id> refuses extra positionals and reports an unknown id like fix does', async (t) => {
  stubFixServer(t)
  {
    const { ctx, err } = ctxWith()
    assert.equal(await runReportGet([REC, 'extra'], ctx), 2)
    assert.match(err.join(''), /is a recommendation id and takes no other positional/)
  }
  {
    const { ctx, err } = ctxWith()
    assert.equal(await runReportGet(['rec-ffffffffffffffff'], ctx), 1)
    assert.match(err.join(''), /hyp report get: no recommendation 'rec-ffffffffffffffff' in this org/)
  }
})

test('fix with an unknown id exits 1 and points at the listing, before any launch', async (t) => {
  stubFixServer(t)
  const { ctx, err } = ctxWith()
  const { deps, launches } = fixDeps()
  assert.equal(await runReportFix(['rec-ffffffffffffffff'], ctx, deps), 1)
  assert.match(err.join(''), /no recommendation 'rec-ffffffffffffffff' in this org - list them with 'hyp report list'/)
  assert.equal(launches.length, 0)
})

test('fix refuses a token that is not a recommendation id without a round trip', async (t) => {
  const { calls } = stubFixServer(t)
  const { ctx, err } = ctxWith()
  assert.equal(await runReportFix(['rpt-b'], ctx, fixDeps().deps), 2)
  assert.match(err.join(''), /'rpt-b' is not a recommendation id/)
  assert.equal(calls.length, 0)
})

test('fix with no id and no terminal is a usage error', async (t) => {
  const { calls } = stubFixServer(t)
  const { ctx, err } = ctxWith()
  assert.equal(await runReportFix([], ctx, fixDeps().deps), 2)
  assert.match(err.join(''), /usage: hyp report fix <id>/)
  assert.equal(calls.length, 0)
})

// @ref LLP 0414#listing-is-the-picker [tests]: the reports first, newest as listed, then the picked report's recommendations
test('fix with no id on a terminal asks which report, then which of its recommendations, and starts the picked one', async (t) => {
  const { calls } = stubFixServer(t)
  const { ctx } = ctxWith()
  ctx.stdin.isTTY = true
  ctx.stdout.isTTY = true
  const { deps, launches, prompts } = fixDeps({ pick: async (/** @type {any} */ spec) => spec.options[0].value })
  assert.equal(await runReportFix(['--kind', 'usage-review'], ctx, deps), 0)
  assert.equal(calls[0].url.pathname, '/v1/reports')
  assert.equal(calls[0].url.searchParams.get('kind'), 'usage-review')
  assert.equal(prompts.length, 2)
  assert.equal(prompts[0].title, 'Which report?')
  assert.deepEqual(prompts[0].options, [{ value: '0', label: 'Weekly', summary: '2026-07-20  usage-review/2026-W29  1 recommendation' }])
  assert.equal(prompts[1].title, 'Which recommendation should be fixed?')
  assert.equal(prompts[1].allowBack, true)
  assert.deepEqual(prompts[1].options, [{ value: REC, label: 'batch the retries', summary: REC }])
  assert.equal(launches.length, 1)
  assert.match(launches[0].prompt, /"Batch the retries"/)
})

test('fix labels the recommendation rows by the page title and the thesis\'s first sentence when the server sends them', async (t) => {
  stubFixServer(t, { opening: true })
  const { ctx } = ctxWith()
  ctx.stdin.isTTY = true
  ctx.stdout.isTTY = true
  const { deps, launches, prompts } = fixDeps({ pick: async (/** @type {any} */ spec) => spec.options[0].value })
  assert.equal(await runReportFix([], ctx, deps), 0)
  assert.deepEqual(prompts[1].options, [{ value: REC, label: 'Batch the retries', summary: 'Every retry is its own call.' }])
  assert.equal(launches.length, 1)
})

test('fix lists reports in the order the server returns them, skips one with nothing to fix, and back returns to the report list', async (t) => {
  const older = { id: 'rpt-a', kind: 'usage-review', period: '2026-W28', bytes: 900, publishedAt: '2026-07-13T10:00:00.000Z' }
  const empty = { id: 'rpt-c', kind: 'usage-review', period: '2026-W30', title: 'Nothing here', bytes: 100, publishedAt: '2026-07-27T10:00:00.000Z', recommendations: [] }
  const OLD_REC = 'rec-fedcba9876543210'
  stubServer(t, (method, url) => {
    const p = url.pathname
    if (p === '/v1/reports') {
      return { status: 200, json: { reports: [
        empty,
        { ...REPORT, recommendations: [{ id: REC, page: 'recommendation-batch-the-retries' }] },
        { ...older, recommendations: [{ id: OLD_REC, page: 'recommendation-tenant-check', title: 'Tenant check' }] },
      ] } }
    }
    if (p === '/v1/reports/usage-review/2026-W28/rpt-a/recommendation-tenant-check.md') return { status: 200, body: new TextEncoder().encode('# Tenant check\n') }
    return { status: 404, json: { error: 'not_found' } }
  })
  const { ctx } = ctxWith()
  ctx.stdin.isTTY = true
  ctx.stdout.isTTY = true
  // Pick the newest report, back out of its recommendations, pick the
  // older report, then its one recommendation.
  const script = [
    (/** @type {any} */ spec) => spec.options[0].value,
    () => { throw new PromptBackRequestedError() },
    (/** @type {any} */ spec) => spec.options[1].value,
    (/** @type {any} */ spec) => spec.options[0].value,
  ]
  const { deps, launches, prompts } = fixDeps({ pick: async (spec) => script.shift()?.(spec) })
  assert.equal(await runReportFix([], ctx, deps), 0)
  assert.deepEqual(prompts.map((p) => p.title), ['Which report?', 'Which recommendation should be fixed?', 'Which report?', 'Which recommendation should be fixed?'])
  assert.deepEqual(prompts[0].options.map((/** @type {any} */ o) => o.label), ['Weekly', 'usage-review/2026-W28'], 'the empty report is not offered; an untitled one is named by kind and period')
  assert.equal(prompts[2].default, '0', 'the cursor returns to the report that was backed out of')
  assert.deepEqual(prompts[3].options, [{ value: OLD_REC, label: 'Tenant check', summary: OLD_REC }])
  assert.equal(launches.length, 1)
  assert.match(launches[0].prompt, new RegExp('`hyp report get ' + OLD_REC + '`'))
  assert.match(launches[0].prompt, /usage-review\/2026-W28/)
})

test('fix does not offer a listed recommendation whose id is not one, so nothing of the server\'s choosing reaches the launch command', async (t) => {
  // The picked id is pasted into the command the client is told to run, so
  // a listing that names a row with shell text rather than an id would put
  // that text on a command line. Such a row is not a recommendation this
  // verb can act on.
  const hostileId = 'rec-x; rm -rf ~'
  stubServer(t, (method, url) => {
    if (url.pathname === '/v1/reports') {
      return { status: 200, json: { reports: [{
        ...REPORT,
        recommendations: [{ id: hostileId, page: 'recommendation-x' }],
      }] } }
    }
    return { status: 200, body: new TextEncoder().encode(PAGE) }
  })
  const { ctx, out } = ctxWith()
  ctx.stdin.isTTY = true
  ctx.stdout.isTTY = true
  const { deps, launches, prompts } = fixDeps({ pick: async (/** @type {any} */ spec) => spec.options[0].value })
  assert.equal(await runReportFix([], ctx, deps), 0)
  assert.match(out.join(''), /no recommendations to fix/)
  assert.equal(prompts.length, 0)
  assert.equal(launches.length, 0)
})

test('fix: a cancelled pick starts nothing and succeeds', async (t) => {
  stubFixServer(t)
  const { ctx, out } = ctxWith()
  ctx.stdin.isTTY = true
  ctx.stdout.isTTY = true
  const { deps, launches } = fixDeps({ pick: async () => { throw new PromptCancelledError() } })
  assert.equal(await runReportFix([], ctx, deps), 0)
  assert.match(out.join(''), /Nothing started/)
  assert.equal(launches.length, 0)
})

test('fix asks which client only when more than one could start, and only on a terminal', async (t) => {
  stubFixServer(t)
  const two = [
    { client: 'claude', label: 'Claude Code', bin: 'claude', binPath: '/bin/claude', args: ['{prompt}'] },
    { client: 'codex', label: 'Codex', bin: 'codex', binPath: '/bin/codex', args: ['{prompt}'] },
  ]
  // Piped with an id: no prompt is possible, the first launcher is taken.
  {
    const { ctx } = ctxWith()
    const { deps, launches, prompts } = fixDeps({ launchers: two })
    assert.equal(await runReportFix([REC], ctx, deps), 0)
    assert.equal(prompts.length, 0)
    assert.equal(launches[0].launcher.client, 'claude')
  }
  // On a terminal the client is asked for, and the answer is honoured.
  {
    const { ctx } = ctxWith()
    ctx.stdin.isTTY = true
    ctx.stdout.isTTY = true
    const { deps, launches, prompts } = fixDeps({ launchers: two, pick: async () => 'codex' })
    assert.equal(await runReportFix([REC], ctx, deps), 0)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0].title, /Which client/)
    assert.equal(launches[0].launcher.client, 'codex')
  }
})

test('fix with nothing launchable exits 1 with a runnable attach hint, before fetching the page', async (t) => {
  const { calls } = stubFixServer(t)
  const { ctx, err } = ctxWith()
  const { deps, launches } = fixDeps({ launchers: [] })
  assert.equal(await runReportFix([REC], ctx, deps), 1)
  assert.match(err.join(''), /no attached client can be started here/)
  assert.match(err.join(''), /hyp client attach claude/)
  assert.equal(launches.length, 0)
  assert.deepEqual(calls.map((c) => c.url.pathname), [`/v1/reports/_recommendations/${REC}`])
})

test('fix reports a spawn failure as exit 1', async (t) => {
  stubFixServer(t)
  const { ctx, err } = ctxWith()
  const { deps } = fixDeps()
  deps.launchClient = async () => ({ ok: false, error: 'ENOENT' })
  assert.equal(await runReportFix([REC], ctx, deps), 1)
  assert.match(err.join(''), /could not start claude: ENOENT/)
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
