// @ts-check

import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'
import { loadTranscript, loadTranscriptFile, matchKey } from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'
import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
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

test('enricher upgrades a fallback row whose transcript lives in a Desktop 3p sandbox tree', async () => {
  const env = await stageEnv()
  try {
    // Claude Code running inside Claude Desktop writes its transcript into the
    // per-session sandbox home under the 3p container, never into the shared
    // `~/.claude/projects` tree settlement scans by default.
    await writeDesktop3pTranscript(env, 'sess-3p', [
      jsonlRow({
        sessionId: 'sess-3p', uuid: 'u-desktop', parentUuid: 'u-prompt', type: 'assistant',
        message: { id: 'msg_d', role: 'assistant', content: [{ type: 'text', text: 'desktop answer' }] },
        timestamp: '2026-09-07T18:56:17.632Z',
      }),
    ])
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })

    const row = fallbackRow({
      session_id: 'sess-3p',
      role: 'assistant',
      content_text: 'desktop answer',
      match_key: matchKey('assistant', [{ type: 'text', text: 'desktop answer' }]),
    })

    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.notEqual(out, row, 'the 3p-sandbox transcript line must upgrade the fallback row')
    assert.equal(out.message_id, 'u-desktop')
    assert.equal(out.part_id, 'u-desktop#0', 'upgraded part_id is what collapses onto the sweep row')
    assert.equal(out.parent_uuid, 'u-prompt')
  } finally {
    await env.cleanup()
  }
})

test('settleBatch collapses an attached-Desktop wire row onto the sweep uuid row it duplicates', async () => {
  const env = await stageEnv()
  try {
    // The production shape of issue #1747: the wire lane wrote a 16-hex hash
    // row for a turn whose transcript sits under the Desktop 3p container, and
    // the transcript sweep already committed the uuid copy of that same turn.
    await writeDesktop3pTranscript(env, 'sess-3p-dup', [
      jsonlRow({
        sessionId: 'sess-3p-dup', uuid: 'u-3p-dup', parentUuid: null, type: 'assistant',
        message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'counted twice' }] },
        timestamp: '2026-09-07T18:56:17.632Z',
      }),
    ])
    const state = createGatewayState()
    const api = createAiGatewayApi(state)
    api.registerSettlementEnricher(createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile }))
    const registration = aiGatewayDatasetRegistration(state)

    const ctx = settleCtx({
      discoverCachePartitions: async () => [{ path: '/p', rowCount: 1 }],
      readRows: async function* () { yield { part_id: 'u-3p-dup#0', message_id: 'u-3p-dup', part_index: 0 } },
    })

    const fb = fallbackRow({
      session_id: 'sess-3p-dup', role: 'assistant', content_text: 'counted twice',
      match_key: matchKey('assistant', [{ type: 'text', text: 'counted twice' }]),
    })
    const out = await /** @type {any} */ (registration).settleBatch([fb], ctx)
    assert.equal(out.length, 0, 'the Desktop wire copy collapses instead of double-counting the turn')
  } finally {
    await env.cleanup()
  }
})

test('a session group with no match_key row never resolves a transcript', async () => {
  const env = await stageEnv()
  try {
    // `planSettleSelection` admits pure null-cwd rows (the #258 race) alongside
    // fallback rows, and those never read the transcript index. Resolving one
    // for them is not free: with `homeDir` passed, a shared-tree miss sweeps
    // the Desktop container, whose per-session sandbox homes grow with every
    // conversation.
    let loads = 0
    const transcriptLoader = { load: async () => { loads += 1; return [] } }
    const enricher = createClaudeSettlementEnricher({
      homeDir: env.homeDir, stateFile: env.stateFile, transcriptLoader,
    })

    const nullCwd = {
      message_id: 'u-native', part_id: 'u-native#0', part_index: 0, role: 'assistant',
      session_id: 'sess-nullcwd', conversation_id: null, client_name: 'claude', cwd: null,
      attributes: { gateway: { exchange_id: 'ex' } },
    }
    await enricher.settle([nullCwd], settleCtx())
    assert.equal(loads, 0, 'a null-cwd-only group must not resolve a transcript it never reads')

    await enricher.settle([fallbackRow({
      session_id: 'sess-fb', role: 'assistant', content_text: 'x',
      match_key: matchKey('assistant', [{ type: 'text', text: 'x' }]),
    })], settleCtx())
    assert.equal(loads, 1, 'a group that does carry a match_key still resolves its transcript')
  } finally {
    await env.cleanup()
  }
})


// A session-context record's `transcript_path` is written by the hook and can
// go stale: the file is gone, or was never written where the hook said. The
// direct read then yields nothing, and nothing must not end the lookup, or
// every fallback row in the session keeps its gateway hash id.
test('enricher falls through to the session scan when a stale transcript_path reads empty', async () => {
  const env = await stageEnv()
  try {
    // The real transcript for the session is where the normal lookup finds it.
    await writeTranscript(env, 'sess-stale', [
      jsonlRow({
        sessionId: 'sess-stale', uuid: 'u-recovered', parentUuid: 'u-prompt', type: 'assistant',
        message: { id: 'msg_r', role: 'assistant', content: [{ type: 'text', text: 'recovered answer' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    // ...but the hook recorded a path that no longer exists.
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-stale',
      transcript_path: path.join(env.homeDir, 'gone', 'sess-stale.jsonl'),
      git_branch: undefined,
      cwd: '/work/repo',
      ts: '2026-05-22T10:00:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })

    const row = fallbackRow({
      session_id: 'sess-stale', role: 'assistant', content_text: 'recovered answer',
      match_key: matchKey('assistant', [{ type: 'text', text: 'recovered answer' }]),
    })

    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.equal(out.message_id, 'u-recovered', 'a dead transcript_path degrades to the session-id lookup')
    assert.equal(out.part_id, 'u-recovered#0')
  } finally {
    await env.cleanup()
  }
})

// The other half: a `transcript_path` that does read stays the direct, cheap
// read. A projects-wide walk per exchange is what that path exists to avoid,
// and a walk would also let a same-session file elsewhere in the tree
// overwrite the content-key match.
test('a valid transcript_path still takes the direct read with no projects-wide walk', async () => {
  const env = await stageEnv()
  try {
    const hookedDir = path.join(env.homeDir, 'hooked')
    await fs.mkdir(hookedDir, { recursive: true })
    const transcriptPath = path.join(hookedDir, 'sess-direct.jsonl')
    await fs.writeFile(transcriptPath, jsonlRow({
      sessionId: 'sess-direct', uuid: 'u-direct', parentUuid: null, type: 'assistant',
      message: { id: 'msg_d', role: 'assistant', content: [{ type: 'text', text: 'direct answer' }] },
      timestamp: '2026-05-22T10:00:01.000Z',
    }) + '\n', 'utf8')
    // Same session id, same content, LATER timestamp: were the scan to run,
    // this line would win the content-key index and the row would carry
    // u-decoy.
    await writeTranscript(env, 'sess-direct', [
      jsonlRow({
        sessionId: 'sess-direct', uuid: 'u-decoy', parentUuid: null, type: 'assistant',
        message: { id: 'msg_x', role: 'assistant', content: [{ type: 'text', text: 'direct answer' }] },
        timestamp: '2026-05-22T10:00:09.000Z',
      }),
    ])
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-direct',
      transcript_path: transcriptPath,
      git_branch: undefined,
      cwd: '/work/repo',
      ts: '2026-05-22T10:00:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })

    const row = fallbackRow({
      session_id: 'sess-direct', role: 'assistant', content_text: 'direct answer',
      match_key: matchKey('assistant', [{ type: 'text', text: 'direct answer' }]),
    })

    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))
    assert.equal(out.message_id, 'u-direct', 'the hook-named file is the one that settles the row')

    // And the resolver reads that file alone: no walk of the projects tree.
    /** @type {string[]} */
    const reads = []
    const entries = await loadTranscript(
      {
        projectsDir: path.join(env.homeDir, '.claude', 'projects'),
        sessionId: 'sess-direct',
        transcriptPath,
        homeDir: env.homeDir,
      },
      async (filePath, collected) => {
        reads.push(filePath)
        for (const entry of await loadTranscriptFile(filePath)) collected.push(entry)
      }
    )
    assert.deepEqual(reads, [transcriptPath], 'only the hook-named file is read')
    assert.equal(entries.length, 1)
  } finally {
    await env.cleanup()
  }
})

// Issue #1794. `spawned_by_tool_use_id` is the one sidechain attribute the
// live projector can miss and nothing else recovers: the sidecar
// `agent-<id>.meta.json` is written by the CLI a moment after the exchange
// finalizes, so a subagent's opening exchange projects without it. Transcript
// identity re-settles here, and once the settled row is committed under its
// native `part_id` the backfill lane's copy (which does carry the attribute)
// is skipped by the materializer's pre-write `part_id` dedupe - so the
// attribute is lost for good unless settlement re-derives it.
test('settlement stamps spawned_by_tool_use_id from a sidecar written after projection', async () => {
  const env = await stageEnv()
  try {
    const transcriptPath = await writeTranscript(env, 'sess-spawn', [
      jsonlRow({
        sessionId: 'sess-spawn', uuid: 'u-sub', parentUuid: null, agentId: 'ag1', isSidechain: true,
        type: 'assistant',
        message: { id: 'msg_s', role: 'assistant', content: [{ type: 'text', text: 'subagent answer' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    // The sidecar lands after the live projection did, which is why the row
    // below carries no `claude.spawned_by_tool_use_id`.
    await writeAgentMeta(env, 'sess-spawn', 'ag1', 'toolu_parent')
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-spawn',
      transcript_path: transcriptPath,
      git_branch: undefined,
      cwd: '/work/repo',
      ts: '2026-05-22T10:00:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })

    const row = fallbackRow({
      session_id: 'sess-spawn', role: 'assistant', agent_id: 'ag1', content_text: 'subagent answer',
      match_key: matchKey('assistant', [{ type: 'text', text: 'subagent answer' }]),
    })

    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.equal(out.message_id, 'u-sub', 'identity still settles')
    const attrs = /** @type {any} */ (out.attributes)
    assert.equal(attrs?.claude?.spawned_by_tool_use_id, 'toolu_parent')
  } finally {
    await env.cleanup()
  }
})

// The production shape of issue #1794: an attached Desktop runs each
// conversation in its own sandbox home, so the hook-recorded `transcript_path`
// never resolves on the host and the sidecar lives beside the sandboxed
// transcript. The provenance must settle wherever the identity settled.
test('settlement stamps spawned_by_tool_use_id from a Desktop 3p sandbox sidecar', async () => {
  const env = await stageEnv()
  try {
    await writeDesktop3pTranscript(env, 'sess-3p-spawn', [
      jsonlRow({
        sessionId: 'sess-3p-spawn', uuid: 'u-3p-sub', parentUuid: null, agentId: 'ag9', isSidechain: true,
        type: 'assistant',
        message: { id: 'msg_3p', role: 'assistant', content: [{ type: 'text', text: 'sandboxed answer' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    await writeDesktop3pAgentMeta(env, 'sess-3p-spawn', 'ag9', 'toolu_3p_parent')
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-3p-spawn',
      // The path the in-container hook reported: meaningless on the host.
      transcript_path: path.join(env.homeDir, 'sandbox', 'sess-3p-spawn.jsonl'),
      git_branch: undefined,
      cwd: '/work/repo',
      ts: '2026-05-22T10:00:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })

    const row = fallbackRow({
      session_id: 'sess-3p-spawn', role: 'assistant', agent_id: 'ag9', content_text: 'sandboxed answer',
      match_key: matchKey('assistant', [{ type: 'text', text: 'sandboxed answer' }]),
    })

    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.equal(out.message_id, 'u-3p-sub', 'identity still settles from the sandbox tree')
    assert.equal(/** @type {any} */ (out.attributes)?.claude?.spawned_by_tool_use_id, 'toolu_3p_parent')
  } finally {
    await env.cleanup()
  }
})

// A row that already carries the attribute (the live projector won the race)
// keeps the value it was projected with, never the sidecar's.
test('settlement leaves an already-stamped spawned_by_tool_use_id alone', async () => {
  const env = await stageEnv()
  try {
    const transcriptPath = await writeTranscript(env, 'sess-kept', [
      jsonlRow({
        sessionId: 'sess-kept', uuid: 'u-kept', parentUuid: null, agentId: 'ag1', isSidechain: true,
        type: 'assistant',
        message: { id: 'msg_k', role: 'assistant', content: [{ type: 'text', text: 'kept answer' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    await writeAgentMeta(env, 'sess-kept', 'ag1', 'toolu_sidecar')
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-kept',
      transcript_path: transcriptPath,
      git_branch: undefined,
      cwd: '/work/repo',
      ts: '2026-05-22T10:00:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })

    const row = fallbackRow({
      session_id: 'sess-kept', role: 'assistant', agent_id: 'ag1', content_text: 'kept answer',
      match_key: matchKey('assistant', [{ type: 'text', text: 'kept answer' }]),
    })
    row.attributes = {
      gateway: { identity_source: 'gateway_fallback' },
      claude: { match_key: row.attributes.claude.match_key, spawned_by_tool_use_id: 'toolu_live' },
    }

    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))
    assert.equal(/** @type {any} */ (out.attributes)?.claude?.spawned_by_tool_use_id, 'toolu_live')
  } finally {
    await env.cleanup()
  }
})

// The cost guard. A settle batch with no sidechain row must read no sidecar
// directory: `@hypaware/claude` is default-bundled and this pass also runs as
// the hourly maintenance re-settle over committed fallback rows, most of which
// are main-loop traffic that will never match.
test('settlement reads no sidecar directory for a batch with no sidechain row', async () => {
  const env = await stageEnv()
  try {
    const transcriptPath = await writeTranscript(env, 'sess-main', [
      jsonlRow({
        sessionId: 'sess-main', uuid: 'u-main', parentUuid: null, type: 'assistant',
        message: { id: 'msg_m', role: 'assistant', content: [{ type: 'text', text: 'main answer' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    await writeAgentMeta(env, 'sess-main', 'ag1', 'toolu_unused')
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-main',
      transcript_path: transcriptPath,
      git_branch: undefined,
      cwd: '/work/repo',
      ts: '2026-05-22T10:00:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile })
    const row = fallbackRow({
      session_id: 'sess-main', role: 'assistant', content_text: 'main answer',
      match_key: matchKey('assistant', [{ type: 'text', text: 'main answer' }]),
    })

    // Parsing a sidecar is the one file read only an agent-meta lookup makes:
    // the transcript resolver walks the same directories for subagent JSONL
    // but never opens a `.meta.json`.
    const real = fsSync.readFileSync
    let sidecarReads = 0
    try {
      // @ts-expect-error instrumented for the duration of the settle call
      fsSync.readFileSync = (file, opts) => {
        if (String(file).endsWith('.meta.json')) sidecarReads += 1
        return real(file, opts)
      }
      const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))
      assert.equal(out.message_id, 'u-main')
    } finally {
      fsSync.readFileSync = real
    }
    assert.equal(sidecarReads, 0, 'no agent-meta lookup for a batch with no sidechain row')
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

/**
 * @param {{ homeDir: string }} env @param {string} sessionId @param {string[]} lines
 * @returns {Promise<string>} the transcript path, the value the hook records
 */
async function writeTranscript(env, sessionId, lines) {
  const dir = path.join(env.homeDir, '.claude', 'projects', 'repo')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8')
  return filePath
}

/**
 * Write the subagent sidecar Claude Code drops beside a session's transcript:
 * `<transcriptDir>/<sessionId>/subagents/agent-<agentId>.meta.json`.
 *
 * @param {{ homeDir: string }} env @param {string} sessionId @param {string} agentId @param {string} toolUseId
 */
async function writeAgentMeta(env, sessionId, agentId, toolUseId) {
  const dir = path.join(env.homeDir, '.claude', 'projects', 'repo', sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId }), 'utf8')
}

/**
 * The sidecar mirror of {@link writeDesktop3pTranscript}: an in-container
 * subagent's `agent-<id>.meta.json` sits beside its sandboxed transcript, not
 * under `<homeDir>/.claude/projects`.
 *
 * @param {{ homeDir: string }} env @param {string} sessionId @param {string} agentId @param {string} toolUseId
 */
async function writeDesktop3pAgentMeta(env, sessionId, agentId, toolUseId) {
  const dir = path.join(desktop3pProjectsDir(env), sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId }), 'utf8')
}

/**
 * Stage a transcript in the Desktop 3p container's per-session sandbox home,
 * the sibling-container layout from LLP 0133#attribution. Deliberately NOT
 * under `<homeDir>/.claude/projects`: an attached Desktop writes nothing
 * there, which is the case this file's 3p tests exist for.
 *
 * @param {{ homeDir: string }} env @param {string} sessionId @param {string[]} lines
 */
async function writeDesktop3pTranscript(env, sessionId, lines) {
  const dir = desktop3pProjectsDir(env)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

/** @param {{ homeDir: string }} env */
function desktop3pProjectsDir(env) {
  return path.join(
    env.homeDir, 'Library', 'Application Support', 'Claude-3p',
    'local-agent-mode-sessions', '423c4275', '00000000', 'local_abc123',
    '.claude', 'projects', 'sandbox-outputs'
  )
}

/** @param {Record<string, unknown>} obj */
function jsonlRow(obj) {
  return JSON.stringify(obj)
}
