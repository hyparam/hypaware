// @ts-check

/**
 * @import { TestContext } from 'node:test'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { verbToCommand } from '../../src/core/cli/verb_command.js'
import { argvToParams } from '../../src/core/cli/verb_codec.js'
import { CORE_VERBS } from '../../src/core/cli/core_verbs.js'
import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { queryGrepVerb } from '../../src/core/search/grep_verb.js'
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
