// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'
import { loadTranscriptIndex, matchKey } from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'
import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'

/**
 * Flush-time settlement (LLP 0024): a fallback row whose transcript line
 * has since landed is upgraded to native uuid identity, and the upgraded
 * row collapses onto the uuid twin a replay already committed.
 */

test('enricher upgrades a fallback row to native transcript identity', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-up', [
      jsonlRow({
        sessionId: 'sess-up', uuid: 'u-assist', parentUuid: 'u-prompt', agentId: 'ag1', isSidechain: true,
        type: 'assistant',
        message: { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text: 'the answer is 42' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })

    const row = fallbackRow({
      session_id: 'sess-up',
      role: 'assistant',
      agent_id: 'ag1',
      content_text: 'the answer is 42',
      match_key: matchKey('assistant', [{ type: 'text', text: 'the answer is 42' }]),
    })

    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.notEqual(out, row, 'upgraded row must be a new object so the dispatcher detects the change')
    assert.equal(out.message_id, 'u-assist')
    assert.equal(out.provider_uuid, 'u-assist')
    assert.equal(out.part_id, 'u-assist#0')
    assert.equal(out.parent_uuid, 'u-prompt')
    assert.equal(out.is_sidechain, true)
    assert.equal(out.agent_id, 'ag1')
    const attrs = /** @type {any} */ (out.attributes)
    assert.equal(attrs?.gateway?.identity_source, undefined, 'fallback marker is cleared')
    assert.equal(attrs?.claude?.match_key, undefined, 'spent match_key is removed')
  } finally {
    await env.cleanup()
  }
})

test('enricher leaves a row unchanged when no transcript line matches', async () => {
  const env = await stageEnv()
  try {
    // Transcript exists but holds different content.
    await writeTranscript(env, 'sess-miss', [
      jsonlRow({
        sessionId: 'sess-miss', uuid: 'u-other', parentUuid: null, type: 'assistant',
        message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'something else' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })
    const row = fallbackRow({
      session_id: 'sess-miss', role: 'assistant', content_text: 'unmatched',
      match_key: matchKey('assistant', [{ type: 'text', text: 'unmatched' }]),
    })

    const [out] = await enricher.settle([row], settleCtx())
    assert.equal(out, row, 'a miss returns the original row reference unchanged')
  } finally {
    await env.cleanup()
  }
})

test('transcript index cache reuses unchanged files and invalidates on append', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-cache', [
      jsonlRow({
        sessionId: 'sess-cache', uuid: 'u-1', parentUuid: null, type: 'assistant',
        message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'one' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    const transcriptPath = path.join(env.homeDir, '.claude', 'projects', 'repo', 'sess-cache.jsonl')
    const opts = {
      projectsDir: path.join(env.homeDir, '.claude', 'projects'),
      sessionId: 'sess-cache',
      transcriptPath,
    }
    const first = await loadTranscriptIndex(opts)
    const unchanged = await loadTranscriptIndex(opts)
    assert.equal(unchanged, first, 'an unchanged transcript reuses its parsed index')

    await fs.appendFile(transcriptPath, `${jsonlRow({
      sessionId: 'sess-cache', uuid: 'u-2', parentUuid: 'u-1', type: 'assistant',
      message: { id: 'm-2', role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      timestamp: '2026-05-22T10:00:02.000Z',
    })}\n`, 'utf8')
    const appended = await loadTranscriptIndex(opts)
    assert.notEqual(appended, first, 'an append invalidates the cached index')
    assert.equal(appended.byUuid.get('u-2')?.provider_uuid, 'u-2')

    await fs.writeFile(transcriptPath, `${jsonlRow({
      sessionId: 'sess-cache', uuid: 'u-3', parentUuid: null, type: 'assistant',
      message: { id: 'm-3', role: 'assistant', content: [{ type: 'text', text: 'three' }] },
      timestamp: '2026-05-22T10:00:03.000Z',
    })}\n`, 'utf8')
    const truncated = await loadTranscriptIndex(opts)
    assert.equal(truncated.byUuid.has('u-2'), false, 'truncation discards stale cached entries')
    assert.equal(truncated.byUuid.get('u-3')?.provider_uuid, 'u-3')

    await fs.rename(transcriptPath, `${transcriptPath}.rotated`)
    await fs.writeFile(transcriptPath, `${jsonlRow({
      sessionId: 'sess-cache', uuid: 'u-4', parentUuid: null, type: 'assistant',
      message: { id: 'm-4', role: 'assistant', content: [{ type: 'text', text: 'four' }] },
      timestamp: '2026-05-22T10:00:04.000Z',
    })}\n`, 'utf8')
    const rotated = await loadTranscriptIndex(opts)
    assert.equal(rotated.byUuid.has('u-3'), false, 'inode replacement discards the old file')
    assert.equal(rotated.byUuid.get('u-4')?.provider_uuid, 'u-4')
  } finally {
    await env.cleanup()
  }
})

test('dataset settleBatch is a pure no-op when the batch has no fallback rows', async () => {
  const state = createGatewayState()
  let scanned = false
  const ctx = settleCtx({
    discoverCachePartitions: async () => { scanned = true; return [] },
    readRows: async function* () {},
  })
  const registration = aiGatewayDatasetRegistration(state)
  const rows = [uuidRow({ message_id: 'u-1', part_index: 0 })]
  const out = await /** @type {any} */ (registration).settleBatch(rows, ctx)
  assert.equal(out, rows, 'no fallback rows → returns the batch untouched')
  assert.equal(scanned, false, 'no storage scan when there is nothing to settle')
})

test('settleBatch dispatches to the enricher and dedupes the upgraded row against committed part_ids', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-dd', [
      jsonlRow({
        sessionId: 'sess-dd', uuid: 'u-dup', parentUuid: null, type: 'assistant',
        message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'dup me' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    const state = createGatewayState()
    const api = createAiGatewayApi(state)
    api.registerSettlementEnricher(createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile }))
    const registration = aiGatewayDatasetRegistration(state)

    // The uuid twin (u-dup#0) is already committed; the fallback row will
    // upgrade to that same part_id and must be dropped.
    const ctx = settleCtx({
      discoverCachePartitions: async () => [{ path: '/p', rowCount: 1 }],
      readRows: async function* () { yield { part_id: 'u-dup#0', message_id: 'u-dup', part_index: 0 } },
    })

    const fb = fallbackRow({
      session_id: 'sess-dd', role: 'assistant', content_text: 'dup me',
      match_key: matchKey('assistant', [{ type: 'text', text: 'dup me' }]),
    })
    const out = await /** @type {any} */ (registration).settleBatch([fb], ctx)
    assert.equal(out.length, 0, 'upgraded fallback collapses onto the committed uuid row')
  } finally {
    await env.cleanup()
  }
})

// --- helpers ---------------------------------------------------------

// @ref LLP 0030#decision: the settlement enricher groups fallback rows by
// session_id (Claude conversation_id is null), so the row fixtures carry the
// session in session_id, not conversation_id.
/** @param {Partial<Record<string, unknown>> & { match_key: string }} f */
function fallbackRow(f) {
  return {
    message_id: 'fallbackhash16ab',
    part_id: 'fallbackhash16ab#0',
    part_index: 0,
    role: f.role,
    session_id: f.session_id,
    conversation_id: null,
    ...(f.agent_id ? { agent_id: f.agent_id } : {}),
    client_name: 'claude',
    content_text: f.content_text,
    attributes: { gateway: { identity_source: 'gateway_fallback' }, claude: { match_key: f.match_key } },
  }
}

/** @param {{ message_id: string, part_index: number }} u */
function uuidRow(u) {
  return {
    message_id: u.message_id,
    part_id: `${u.message_id}#${u.part_index}`,
    part_index: u.part_index,
    role: 'assistant',
    session_id: 's',
    conversation_id: null,
    client_name: 'claude',
    attributes: { gateway: { exchange_id: 'ex' } },
  }
}

/** @param {{ discoverCachePartitions?: Function, readRows?: Function }} [storage] */
function settleCtx(storage) {
  return /** @type {any} */ ({ storage: storage ?? {} })
}

/** @returns {Promise<{ homeDir: string, stateFile: string, cleanup: () => Promise<void> }>} */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-settle-'))
  const stateDir = path.join(homeDir, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  return {
    homeDir,
    stateFile: path.join(stateDir, 'session-context.jsonl'),
    cleanup: async () => { await fs.rm(homeDir, { recursive: true, force: true }) },
  }
}

/** @param {{ homeDir: string }} env @param {string} sessionId @param {string[]} lines */
async function writeTranscript(env, sessionId, lines) {
  const dir = path.join(env.homeDir, '.claude', 'projects', 'repo')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

/** @param {Record<string, unknown>} obj */
function jsonlRow(obj) {
  return JSON.stringify(obj)
}
