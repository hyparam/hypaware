// @ts-check

/**
 * @import { TestContext } from 'node:test'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// A namespace import, not a named one: `registerHooks` is absent below
// Node 22.15 and a named import of a missing builtin export is a load-time
// SyntaxError, which would take the whole file down instead of skipping the
// one test that needs it.
import * as nodeModule from 'node:module'

import { verbToCommand } from '../../src/core/cli/verb_command.js'
import { argvToParams } from '../../src/core/cli/verb_codec.js'
import { CORE_VERBS } from '../../src/core/cli/core_verbs.js'
import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { queryGrepVerb } from '../../src/core/search/grep_verb.js'
import { GrepQueryError } from '../../src/core/search/matcher.js'
import { VerbUsageError } from '../../src/core/cli/verb_errors.js'
import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

const cmd = verbToCommand(queryGrepVerb)

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: true },
  { name: 'agent_id', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
]

let rowSeq = 0

/** @param {Record<string, unknown>} [over] */
function mkRow(over = {}) {
  rowSeq += 1
  const date = typeof over.date === 'string' ? over.date : '2026-08-10'
  return {
    session_id: 's1',
    conversation_id: null,
    agent_id: null,
    cwd: '/home/open-proj',
    content_text: null,
    date,
    part_id: `m${rowSeq}#0`,
    message_id: `m${rowSeq}`,
    message_created_at: new Date(`${date}T00:00:00Z`).getTime() + rowSeq * 1000,
    client_name: 'test',
    ...over,
  }
}

/** @param {Record<string, unknown>[][]} batches */
async function makeCtx(batches) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-grep-verb-'))
  const declaration = aiGatewayDatasetRegistration().cachePartitioning
  for (const batch of batches) {
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=test'], COLUMNS, batch, { declaration })
  }
  const storage = createQueryStorageService({ cacheRoot })
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: {},
    config: { version: 2 },
    query: {},
    storage,
    cwd: '/home/open-proj',
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

test('the tool schema is wire-compatible with the server grep_search', () => {
  assert.equal(queryGrepVerb.tool, 'grep_search')
  assert.equal(queryGrepVerb.name, 'query grep')
  assert.equal(queryGrepVerb.authClass, 'read')
  const props = queryGrepVerb.inputSchema.properties ?? {}
  assert.deepEqual(
    Object.keys(props).sort(),
    ['chain_id', 'from', 'include-local-only', 'limit', 'query', 'regex', 'session_id', 'to'],
  )
  assert.deepEqual(queryGrepVerb.inputSchema.required, ['query'])
  // The local-only override must never ride the wire uninvited: a schema
  // default is auto-filled into params, and the server's grep_search schema
  // does not know this name, so a default here breaks every --remote call.
  assert.equal(props['include-local-only'].default, undefined)
  // The coverage clause: zero hits must be explainable from the summary alone.
  assert.match(queryGrepVerb.summary, /Covers only these columns: content_text/)
  assert.match(queryGrepVerb.summary, /zero hits is not evidence/)
})

test('CORE_VERBS registers the grep verb beside sql', () => {
  assert.ok(CORE_VERBS.some((v) => v.tool === 'grep_search'))
  assert.ok(CORE_VERBS.some((v) => v.tool === 'query_sql'))
})

test('the codec maps dashed flags onto the snake_case wire names', () => {
  const parsed = argvToParams(queryGrepVerb.inputSchema, [
    'needle two', '--session-id', 's2', '--chain-id', 'a2', '--regex',
    '--from', '2026-08-01', '--to', '2026-08-31', '--limit', '5',
  ])
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.params, {
    query: 'needle two',
    session_id: 's2',
    chain_id: 'a2',
    regex: true,
    from: '2026-08-01',
    to: '2026-08-31',
    limit: 5,
  })
})

test('hyp query grep finds a row and renders locators plus snippet', async () => {
  const { ctx, out, err } = await makeCtx([
    [mkRow({ content_text: 'alpha needle one' })],
    [mkRow({ date: '2026-08-12', session_id: 's2', content_text: 'the needle two' })],
  ])
  const code = await cmd.run(['needle'], ctx)
  assert.equal(code, 0)
  const stdout = out.join('')
  assert.match(stdout, /content_text/)
  assert.match(stdout, /the needle two/)
  assert.match(stdout, /s2/)
  assert.equal(err.join(''), '', 'nothing truncated, nothing withheld, nothing on stderr')
  // Newest first: the 2026-08-12 hit renders before the 2026-08-10 one.
  assert.ok(stdout.indexOf('2026-08-12') < stdout.indexOf('2026-08-10'))
})

test('table render escapes captured control bytes; json stays byte-exact (LLP 0225)', async () => {
  const { ctx, out } = await makeCtx([
    [mkRow({ content_text: 'evil needle[2Jline\ntwo' })],
  ])
  const code = await cmd.run(['needle'], ctx)
  assert.equal(code, 0)
  const table = out.join('')
  assert.ok(!table.includes(''), 'the ESC byte never reaches a human render')
  assert.match(table, /\\u001b/)
  out.length = 0
  const jsonCode = await cmd.run(['needle', '--format', 'json'], ctx)
  assert.equal(jsonCode, 0)
  const rows = JSON.parse(out.join(''))
  assert.ok(rows[0].snippet.includes(''), 'the machine copy keeps the raw bytes')
})

test('the limit produces the truncation notice on stderr', async () => {
  const { ctx, err } = await makeCtx([
    [mkRow({ content_text: 'needle a' })],
    [mkRow({ date: '2026-08-12', session_id: 's2', content_text: 'needle b' })],
  ])
  const code = await cmd.run(['needle', '--limit', '1'], ctx)
  assert.equal(code, 0)
  assert.match(err.join(''), /more matches exist beyond the limit/)
})

test('a limit above the ceiling clamps to it instead of dropping below the default', async () => {
  // 60 rows: more than the default 50, so a fallback-to-default and a clamp
  // to the ceiling are distinguishable. Falling back would answer a request
  // for more rows with fewer, then advise raising a limit already at 9999.
  const batch = []
  for (let i = 0; i < 60; i += 1) batch.push(mkRow({ content_text: `needle ${i}` }))
  const { ctx, out, err } = await makeCtx([batch])
  const code = await cmd.run(['needle', '--limit', '9999'], ctx)
  assert.equal(code, 0)
  const rendered = out.join('')
  assert.match(rendered, /needle 0\b/)
  assert.equal(rendered.split('\n').filter((line) => /content_text/.test(line)).length, 60)
  assert.equal(err.join(''), '', 'a clamped limit still covered every match, so nothing is truncated')
})

test('a limit the flag cannot use is refused, not quietly replaced', async () => {
  // Silently rewriting 0 to the default answered a request for FEWER rows
  // with 50 of them and exit 0: the same forged answer `dayBound` refuses,
  // reached through the numeric flag. The schema is also what an MCP caller
  // validates against, so `limit: 0` over the wire got 50 rows too.
  for (const bad of ['0', '-5', '2.5']) {
    const { ctx, out, err } = await makeCtx([[mkRow({ content_text: 'needle a' })]])
    const code = await cmd.run(['needle', '--limit', bad], ctx)
    assert.equal(code, 2, `--limit ${bad} is a usage error`)
    assert.match(err.join(''), /--limit expects a positive integer/)
    assert.equal(out.join(''), '')
  }
})

test('an absent limit still takes the default', async () => {
  const { ctx, out } = await makeCtx([[mkRow({ content_text: 'needle a' })]])
  const code = await cmd.run(['needle'], ctx)
  assert.equal(code, 0)
  assert.match(out.join(''), /needle a/)
})

test('at the ceiling the truncation notice stops advising a flag that cannot move', () => {
  // The clamp exists so a caller is never told to raise a limit it already
  // pinned; the notice has to keep that promise or the clamp only moves the
  // unfollowable advice one flag along.
  const atCeiling = queryGrepVerb.render(
    { hits: [], truncated: true, exhausted: true, limitCeilingReached: true },
    /** @type {any} */ ({ format: 'table', json: false, maxCell: 200, maxBytes: 32768 })
  )
  assert.match(atCeiling.stderr ?? '', /beyond the 1000-hit ceiling/)
  assert.doesNotMatch(atCeiling.stderr ?? '', /raise --limit/)
  const belowCeiling = queryGrepVerb.render(
    { hits: [], truncated: true, exhausted: true, limitCeilingReached: false },
    /** @type {any} */ ({ format: 'table', json: false, maxCell: 200, maxBytes: 32768 })
  )
  assert.match(belowCeiling.stderr ?? '', /raise --limit/)
})

test('zero hits over zero searched files says so instead of passing for a full search', async () => {
  const { ctx, err } = await makeCtx([])
  const code = await cmd.run(['needle'], ctx)
  assert.equal(code, 0)
  assert.match(err.join(''), /no ai_gateway_messages data files were searched/)
})

test('an interrupted walk reports the interruption, not an empty machine', async () => {
  // An abort before the first file is served whole leaves both file
  // counters at zero over a cache full of data, so the "searched nothing"
  // notice would tell the caller the exact opposite of what happened.
  const stopped = queryGrepVerb.render(
    { hits: [], truncated: false, exhausted: false, indexedFiles: 0, scannedFiles: 0 },
    /** @type {any} */ ({ format: 'table', json: false, maxCell: 200, maxBytes: 32768 })
  )
  assert.match(stopped.stderr ?? '', /stopped before covering every file/)
  assert.doesNotMatch(stopped.stderr ?? '', /nothing is recorded on this machine/)
})

test('a truncated AND interrupted search prints both notices, not the louder one', () => {
  // They mean different things and the skill doc teaches them as such: a
  // wider limit reaches the matches the limit cut, and nothing reaches the
  // files an aborted walk never opened. Rendering them as if-else let the
  // truncation line hide the one the caller cannot act on any other way.
  const both = queryGrepVerb.render(
    { hits: [], truncated: true, exhausted: false, indexedFiles: 2, scannedFiles: 1 },
    /** @type {any} */ ({ format: 'table', json: false, maxCell: 200, maxBytes: 32768 })
  )
  assert.match(both.stderr ?? '', /more matches exist beyond the limit/)
  assert.match(both.stderr ?? '', /stopped before covering every file/)
  // And an ordinary capped search still says one thing, because the service
  // reports `exhausted` for an abort only.
  const capped = queryGrepVerb.render(
    { hits: [], truncated: true, exhausted: true, indexedFiles: 2, scannedFiles: 1 },
    /** @type {any} */ ({ format: 'table', json: false, maxCell: 200, maxBytes: 32768 })
  )
  assert.doesNotMatch(capped.stderr ?? '', /stopped before covering every file/)
})

test('a pattern the search cannot use is a usage refusal, not a failed search', async () => {
  // Same class as the day flags: the caller typed it wrong. It exits 1
  // only because the refusal is raised three modules down in the shared
  // matcher, and a script that retries on 1 and reports on 2 answers a
  // typo with a retry loop that can never succeed.
  const { ctx, err } = await makeCtx([[mkRow({ content_text: 'needle a' })]])
  assert.equal(await cmd.run(['(', '--regex'], ctx), 2)
  assert.match(err.join(''), /not a valid regular expression/)
  assert.match(err.join(''), /^usage: /m)

  const { ctx: ctx2, err: err2 } = await makeCtx([[mkRow({ content_text: 'needle a' })]])
  assert.equal(await cmd.run(['x'.repeat(2000)], ctx2), 2)
  assert.match(err2.join(''), /at most 1024 characters/)

  // A search that really fails is still 1: the two codes have to stay apart.
  const { ctx: ctx3 } = await makeCtx([[mkRow({ content_text: 'needle a' })]])
  ctx3.storage.discoverCachePartitions = () => Promise.reject(new Error('cache is busy'))
  assert.equal(await cmd.run(['needle'], ctx3), 1)
})

test('zero hits over a searched cache stays quiet', async () => {
  const { ctx, err } = await makeCtx([[mkRow({ content_text: 'nothing to see' })]])
  const code = await cmd.run(['needle'], ctx)
  assert.equal(code, 0)
  assert.equal(err.join(''), '', 'files were searched, so the empty answer is the honest one')
})

test('a malformed --from is refused rather than answering zero hits', async () => {
  const { ctx, out, err } = await makeCtx([[mkRow({ content_text: 'needle a' })]])
  // The window is compared lexicographically, so `2026-8-1` would prune
  // every real day and render an empty, unexplained answer.
  const code = await cmd.run(['needle', '--from', '2026-8-1'], ctx)
  // Exit 2, the usage code, not 1: a script retries on 1 (the cache was
  // busy) and reports on 2 (the command was wrong), so a typo answering 1
  // is answered by a retry loop that can never succeed.
  assert.equal(code, 2)
  assert.match(err.join(''), /--from expects a day as YYYY-MM-DD \(got 2026-8-1\)/)
  assert.match(err.join(''), /^usage: hyp query grep/m, 'a usage refusal prints the usage line')
  assert.equal(out.join(''), '')
})

test('an inverted --from/--to window is refused rather than forging an empty answer', async () => {
  const { ctx, out, err } = await makeCtx([[mkRow({ content_text: 'needle a' })]])
  // Both days are well-formed, so the shape check above cannot catch this:
  // the window simply selects nothing, and every file is pruned. Without
  // the cross-field check that renders as a silent zero, which is exactly
  // the "nothing is recorded" the coverage clause works to make honest.
  const code = await cmd.run(['needle', '--from', '2026-08-20', '--to', '2026-08-01'], ctx)
  assert.equal(code, 2)
  assert.match(err.join(''), /--from 2026-08-20 is after --to 2026-08-01/)
  assert.equal(out.join(''), '')
})

test('a well-ordered window still runs, including the single-day case', async () => {
  const { ctx, out } = await makeCtx([
    [mkRow({ date: '2026-08-10', content_text: 'needle old' })],
    [mkRow({ date: '2026-08-12', content_text: 'needle new' })],
  ])
  const code = await cmd.run(['needle', '--from', '2026-08-12', '--to', '2026-08-12'], ctx)
  assert.equal(code, 0, 'from === to is a one-day window, not an inverted one')
  assert.match(out.join(''), /needle new/)
  assert.doesNotMatch(out.join(''), /needle old/)
})

test('the snippet renders last so a long match cannot shove the locators out of column', async () => {
  const { ctx, out } = await makeCtx([
    [mkRow({ content_text: `needle ${'x'.repeat(200)}` })],
    [mkRow({ date: '2026-08-12', content_text: 'needle short' })],
  ])
  const code = await cmd.run(['needle', '--format', 'jsonl'], ctx)
  assert.equal(code, 0)
  const first = JSON.parse(out.join('').split('\n')[0])
  assert.deepEqual(Object.keys(first), ['date', 'session_id', 'column', 'message_id', 'part_id', 'snippet'])
})

test('a render of a bare server-shaped result works without local fields', () => {
  const rendered = queryGrepVerb.render(
    {
      hits: [{
        date: '2026-08-12', sessionId: 's2', agentId: null, conversationId: null,
        partId: 'p1', messageId: 'm1', messageCreatedAt: '2026-08-12T00:00:00Z',
        matches: [{ column: 'content_text', snippet: '...the needle two...' }],
      }],
      truncated: false,
      exhausted: false,
    },
    /** @type {any} */ ({ format: 'table', json: false, output: undefined, maxCell: 200, maxBytes: 32768 })
  )
  assert.match(rendered.stdout ?? '', /the needle two/)
  assert.match(rendered.stderr ?? '', /stopped before covering every file/)
})

/**
 * Install a fake MCP-over-HTTP server as `globalThis.fetch`, the
 * verb-remote idiom, returning a server-shaped grep result.
 *
 * @param {TestContext} t
 * @param {any} structuredContent
 */
function stubServer(t, structuredContent) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
    const req = JSON.parse(init.body)
    const json = (/** @type {any} */ obj, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (/** @type {string} */ k) => (k.toLowerCase() === 'content-type' ? 'application/json' : k.toLowerCase() === 'mcp-session-id' ? 'sess-1' : null) },
      text: async () => JSON.stringify(obj),
    })
    if (req.method === 'initialize') return json({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'srv' } } })
    if (req.method === 'notifications/initialized') return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' }
    if (req.method === 'tools/call') {
      stubServer.lastCall = req.params
      return json({ jsonrpc: '2.0', id: req.id, result: { structuredContent, isError: false } })
    }
    return json({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no' } })
  })
}
/** @type {any} */
stubServer.lastCall = null

test('--remote calls the server grep_search with the wire params and renders its result', async (t) => {
  stubServer(t, {
    hits: [{
      date: '2026-08-12', sessionId: 'remote-s', agentId: null, conversationId: null,
      partId: 'p9', messageId: 'm9', messageCreatedAt: '2026-08-12T01:00:00Z',
      matches: [{ column: 'content_text', snippet: '...remote needle...' }],
    }],
    truncated: true,
    exhausted: false,
  })
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: '/tmp/none', HYP_REMOTE_TOKEN_PROD: 'tok' },
    config: { version: 2, query: { remotes: { prod: { url: 'https://hyp.internal/mcp' } } } },
    query: {}, storage: {},
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  const code = await cmd.run(['remote needle', '--session-id', 'remote-s', '--remote', 'prod'], ctx)
  assert.equal(code, 0)
  assert.equal(stubServer.lastCall.name, 'grep_search')
  assert.deepEqual(stubServer.lastCall.arguments, {
    query: 'remote needle',
    session_id: 'remote-s',
    limit: 50,
  }, 'only wire params travel; include-local-only never rides uninvited')
  assert.match(out.join(''), /remote needle/)
  assert.match(err.join(''), /more matches exist beyond the limit/)
})

// The injected-backend seam (LLP 0314 / LLP 0353). These drive
// `operation` directly with a stubbed context, because the harness above
// goes through the projected command, whose `buildOperationContext` never
// sets `search`: that whole suite is the proof the default path is
// unchanged, and none of it is edited here.

/**
 * A context whose local plane throws on ANY access. A supplied backend
 * means the verb must not load or touch the cache service at all, and a
 * plain `{}` storage would let a regression that still reached for it pass.
 *
 * @param {(args: any) => Promise<any>} search
 */
function injectedCtx(search) {
  const forbidden = () => { throw new Error('the local plane was consulted despite an injected backend') }
  return /** @type {any} */ ({
    env: {},
    config: { version: 2 },
    query: {},
    storage: new Proxy({}, { get: forbidden, set: forbidden, has: forbidden, ownKeys: forbidden }),
    get refresh() { return forbidden() },
    get callerCwd() { return forbidden() },
    search,
  })
}

/** A bare server-shaped answer: none of the local extras. */
const BARE = { hits: [], truncated: false, exhausted: true }

test('an injected backend receives exactly the seam shape, and never the host wiring', async () => {
  /** @type {any[]} */ const seen = []
  const ctx = injectedCtx(async (args) => { seen.push(args); return BARE })
  await queryGrepVerb.operation({
    query: 'needle',
    regex: true,
    session_id: 's2',
    chain_id: 'a2',
    from: '2026-08-01',
    to: '2026-08-31',
    limit: 9999,
    'include-local-only': true,
  }, ctx)
  // Exactly these keys: `storage`, `refresh` and `callerCwd` are this
  // host's wiring, and a backend that had to accept and ignore them would
  // be implementing a contract that lies about what it needs.
  assert.deepEqual(Object.keys(seen[0]).sort(), [
    'chainId', 'from', 'includeLocalOnly', 'limit', 'query', 'regex', 'sessionId', 'to',
  ])
  assert.deepEqual(seen[0], {
    query: 'needle',
    regex: true,
    sessionId: 's2',
    chainId: 'a2',
    from: '2026-08-01',
    to: '2026-08-31',
    // Clamped by the verb, before the seam: a backend never has to
    // re-default or re-cap, and both planes page identically.
    limit: 1000,
    includeLocalOnly: true,
  })

  // The absent cases: the default limit, no window, and the local-only
  // override off rather than missing.
  await queryGrepVerb.operation({ query: 'needle' }, ctx)
  assert.deepEqual(seen[1], {
    query: 'needle',
    regex: false,
    sessionId: undefined,
    chainId: undefined,
    from: undefined,
    to: undefined,
    limit: 50,
    includeLocalOnly: false,
  })
})

test('the argument refusals run before the seam, so a typo never reaches the backend', async () => {
  let calls = 0
  const ctx = injectedCtx(async () => { calls += 1; return BARE })
  await assert.rejects(
    async () => { await queryGrepVerb.operation({ query: 'needle', from: '2026-8-1' }, ctx) },
    VerbUsageError,
  )
  await assert.rejects(
    async () => { await queryGrepVerb.operation({ query: 'needle', from: '2026-08-20', to: '2026-08-01' }, ctx) },
    VerbUsageError,
  )
  assert.equal(calls, 0, 'a cross-field or shape refusal is true for any data plane')
})

test('with a backend supplied the local plane is never consulted', async () => {
  // `injectedCtx` makes storage/refresh/callerCwd throw on any access, so
  // this fails loudly if the operation still reaches for the cache service.
  // Merely LOADING that service touches no context field, so the proxy
  // cannot see it; the child probe below is what pins the import's place.
  const ctx = injectedCtx(async () => ({
    hits: [{
      date: '2026-08-12', sessionId: 'srv-s', agentId: null, conversationId: null,
      partId: 'p1', messageId: 'm1', messageCreatedAt: '2026-08-12T00:00:00Z',
      matches: [{ column: 'content_text', snippet: '...injected needle...' }],
    }],
    truncated: false,
    exhausted: true,
  }))
  const result = /** @type {any} */ (await queryGrepVerb.operation({ query: 'needle' }, ctx))
  assert.equal(result.hits.length, 1)
  const rendered = queryGrepVerb.render(result, /** @type {any} */ ({ format: 'table', json: false, maxCell: 200, maxBytes: 32768 }))
  assert.match(rendered.stdout ?? '', /injected needle/)
})

test('a bare result gets the clamp fact appended and does not forge "nothing is recorded"', async () => {
  // The file counters are the local service's own; an injected backend
  // leaves them `undefined`, and the render's guard is a strict `=== 0`,
  // so the "nothing is recorded on this machine yet" line correctly stays
  // silent for a server-shaped empty answer. This pins that behavior; the
  // guard needs no change.
  const ctx = injectedCtx(async () => BARE)
  const atCeiling = /** @type {any} */ (await queryGrepVerb.operation({ query: 'needle', limit: 1000 }, ctx))
  assert.equal(atCeiling.limitCeilingReached, true)
  const below = /** @type {any} */ (await queryGrepVerb.operation({ query: 'needle' }, ctx))
  assert.equal(below.limitCeilingReached, false)
  assert.equal(below.indexedFiles, undefined)
  assert.equal(below.scannedFiles, undefined)
  const rendered = queryGrepVerb.render(below, /** @type {any} */ ({ format: 'table', json: false, maxCell: 200, maxBytes: 32768 }))
  assert.doesNotMatch(rendered.stderr ?? '', /nothing is recorded on this machine/)
  assert.equal(rendered.stderr ?? '', '', 'an exhausted, untruncated empty answer says nothing')
})

test("a backend's own refusal is the caller's usage error; anything else is a failed search", async () => {
  // A serving backend gates regex to its operator and refuses an
  // `includeLocalOnly` it has no local plane to honor. Both are the
  // caller typing something this host cannot serve, so both must reach
  // the caller as exit 2 through the same channel the local matcher uses.
  const refusing = injectedCtx(async () => { throw new GrepQueryError('regex mode is operator-only here') })
  await assert.rejects(
    async () => { await queryGrepVerb.operation({ query: 'needle', regex: true }, refusing) },
    (err) => {
      assert.ok(err instanceof VerbUsageError)
      assert.match(/** @type {Error} */ (err).message, /operator-only/)
      return true
    },
  )
  // A backend that simply failed is still exit 1: the two codes have to
  // stay apart, or a script retries a refusal it can never satisfy.
  const failing = injectedCtx(async () => { throw new Error('the archive is unreachable') })
  await assert.rejects(
    async () => { await queryGrepVerb.operation({ query: 'needle' }, failing) },
    (err) => {
      assert.ok(!(err instanceof VerbUsageError))
      assert.match(/** @type {Error} */ (err).message, /archive is unreachable/)
      return true
    },
  )
})

test('a backend answering with the wrong shape is a failed search, not an empty archive', async () => {
  // The render falls back field by field, so a misnamed or missing `hits`
  // would otherwise reach the caller as a clean zero-row table with exit 0,
  // and the zero-files line that guards against a forged "nothing is
  // stored" cannot fire for a server-shaped result. Exit 1 keeps a broken
  // backend distinguishable from an archive with nothing in it.
  const misnamed = injectedCtx(async () => ({ results: [], truncated: false, exhausted: true }))
  await assert.rejects(
    async () => { await queryGrepVerb.operation({ query: 'needle' }, misnamed) },
    (err) => {
      assert.ok(!(err instanceof VerbUsageError))
      assert.match(/** @type {Error} */ (err).message, /no hits array/)
      return true
    },
  )
  const nothing = injectedCtx(async () => undefined)
  await assert.rejects(
    async () => { await queryGrepVerb.operation({ query: 'needle' }, nothing) },
    /no hits array/,
  )
  // Hits alone are not the whole answer. `truncated` and `exhausted` are
  // required booleans, and the render tests each with a strict comparison,
  // so a backend that stopped at its deadline and omitted `exhausted`
  // would hand the caller a partial answer with no notice and exit 0 -
  // the same forgery as a missing `hits`, reached one field along.
  const noFacts = injectedCtx(async () => ({ hits: [], truncated: false }))
  await assert.rejects(
    async () => { await queryGrepVerb.operation({ query: 'needle' }, noFacts) },
    /truncated\/exhausted/,
  )
  const notBooleans = injectedCtx(async () => ({ hits: [], truncated: 'no', exhausted: 1 }))
  await assert.rejects(
    async () => { await queryGrepVerb.operation({ query: 'needle' }, notBooleans) },
    /truncated\/exhausted/,
  )
})

/**
 * The child probe for the load-order pin below. Records every module the
 * injected path pulls in, then fails if the local search stack is among
 * them. `--input-type=module` so the top-level `await` and the load hook
 * both work; the verb's specifier arrives by env so the source stays a
 * plain string.
 */
const NO_LOCAL_LOAD_PROBE = `
  import assert from 'node:assert/strict'
  import { registerHooks } from 'node:module'
  const loaded = []
  registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context) } })
  const { queryGrepVerb } = await import(process.env.HYP_TEST_GREP_VERB_MODULE)
  await queryGrepVerb.operation(
    { query: 'needle' },
    { search: async () => ({ hits: [], truncated: false, exhausted: true }) },
  )
  assert.ok(
    !loaded.some((url) => url.endsWith('/search/grep_service.js')),
    'grep_service.js was loaded on the injected path: the dynamic import escaped buildLocalBackend',
  )
`

test('an injecting host never loads the local search stack', (t) => {
  // The throwing proxy above catches a local plane that is CONSULTED; it
  // cannot catch one that is merely LOADED, because importing a module
  // touches no context field. Hoisting the `await import` back out of
  // `buildLocalBackend` leaves every case above green while costing an
  // injecting host the load-time win LLP 0353#default-resolution buys, and
  // that win is half the reason the import sits in the fallback branch.
  //
  // Which modules a process has loaded is a property of the whole process,
  // and the suite above has already pulled in `grep_service.js` through the
  // projected command, so the probe needs a process of its own.
  if (typeof nodeModule.registerHooks !== 'function') {
    // Node's synchronous load hook lands in 22.15; the package floor is
    // 22.12, so an older supported runtime skips rather than fails. Both CI
    // matrix legs are well past it.
    return t.skip('node:module registerHooks is unavailable on this runtime')
  }
  const verbModule = new URL('../../src/core/search/grep_verb.js', import.meta.url).href
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', NO_LOCAL_LOAD_PROBE], {
    encoding: 'utf8',
    // A wedged child (a loader inherited through NODE_OPTIONS, a future
    // registerHooks regression) must fail this one test, not sit until the
    // CI job's own 5-minute timeout kills the whole run. The probe costs
    // tens of milliseconds, so this is pure headroom.
    timeout: 30000,
    env: { ...process.env, HYP_TEST_GREP_VERB_MODULE: verbModule },
  })
  // A spawn that never ran, or one the timeout killed, leaves `status` and
  // `stderr` both null, so the assertion below would fail with an empty
  // message and `run.error` - the only value naming the cause - discarded.
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
})
