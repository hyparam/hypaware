// @ts-check

/**
 * The session-context file has two bounds, and they have to agree.
 *
 * The writer bounds it: `appendSessionContext` compacts to
 * `SESSION_CONTEXT_MAX_BYTES`, so every record inside that window is one the
 * writer deliberately kept. The reader bounds it again, independently, with a
 * tail window - and a tail window narrower than the writer's cap silently
 * discards records that are still on disk.
 *
 * On this path that is not a missing column. `resolveSessionUsagePolicy`
 * reads "no record" as `undetermined`, and the listener answers `undetermined`
 * by withholding the events AND deleting the session's spooled bodies unread.
 * So a quiet session (no hook-firing tool calls) whose neighbour is noisy
 * loses its content outright, without ever having been opted out.
 *
 * Scope: these tests pin the regime below the writer's cap, where the record
 * is on disk and only the reader's window decided whether it was seen. Above
 * the cap compaction deletes the record itself, by position, and the same
 * session is still suppressed; that is a writer-side design change (see
 * `SESSION_CONTEXT_READ_TAIL_BYTES`) and is deliberately not pinned here.
 *
 * @ref LLP 0254#policy-inline [tests]: the hook's record is load-bearing for
 *   this path's privacy verdict, so a reader that cannot see a record the
 *   writer kept turns a recorded session into a suppressed one
 * @ref LLP 0257#ingest [tests]: S10 - "no hook record" must mean the hook
 *   really did not record, not that the reader looked at too little of the file
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  SESSION_CONTEXT_MAX_BYTES,
  SESSION_CONTEXT_READ_TAIL_BYTES,
  appendSessionContext,
  createSessionContextReader,
  pickLatestMatching,
  readSessionContext,
} from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
import { createStartClaudeTelemetrySource } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import {
  claudeBodySpoolDir,
  ensureClaudeBodySpool,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'

/**
 * @import { AiGatewayProjectedExchange, StartedSource } from '../../hypaware-plugin-kernel-types.js'
 * @import { SessionContextRecord } from '../../hypaware-core/plugins-workspace/claude/src/types.js'
 */

const QUIET_SESSION = 'e53c128d-9f45-470f-86f1-d5b5f3766708'
const NOISY_SESSION = '7c1f0b2a-5d3e-4f18-9a6c-0b21d4e7f905'
const QUIET_CWD = '/Users/dev/code/quiet-repo'
const SYSTEM_TEXT = 'You are Claude Code, running in the quiet repo.'

/**
 * One hook record, the size the real hook writes: every column populated, so
 * a few thousand of them is all it takes to fill the file.
 *
 * @param {string} sessionId
 * @param {string} cwd
 * @param {number} seq
 * @returns {SessionContextRecord}
 */
function hookRecord(sessionId, cwd, seq) {
  return {
    session_id: sessionId,
    transcript_path: `/Users/dev/.claude/projects/${cwd.replaceAll('/', '-')}/${sessionId}.jsonl`,
    cwd,
    git_branch: 'feature/a-branch-name-of-an-ordinary-length',
    git_remote: 'https://github.com/acme/a-repository.git',
    head_sha: '9f2c1d7a4b6e8035c1a2f4d6b8e0a2c4d6f80135',
    repo_root: cwd,
    ts: new Date(Date.UTC(2026, 7, 18, 9, 0, 0) + seq * 1000).toISOString(),
  }
}

/**
 * Append the noisy neighbour's records straight onto the file, the way its
 * hook does: one line per SessionStart / CwdChanged / UserPromptSubmit /
 * PostToolUse-Bash. Stops short of the writer's own cap, so the quiet
 * session's record is still on disk when the reader goes looking.
 *
 * @param {string} filePath
 * @param {number} targetBytes
 */
async function floodWithNeighbour(filePath, targetBytes) {
  const lines = []
  let bytes = 0
  for (let seq = 0; bytes < targetBytes; seq++) {
    const line = JSON.stringify(hookRecord(NOISY_SESSION, '/Users/dev/code/busy-repo', seq)) + '\n'
    lines.push(line)
    bytes += Buffer.byteLength(line, 'utf8')
  }
  await fs.appendFile(filePath, lines.join(''), 'utf8')
}

/**
 * The status details of a started source, which the kernel type leaves
 * optional even though this listener always publishes them.
 *
 * @param {StartedSource} started
 * @returns {Promise<Record<string, any>>}
 */
async function statusDetails(started) {
  const status = started.status
  if (!status) throw new Error('the telemetry listener must publish status')
  return /** @type {Record<string, any>} */ ((await status()).details ?? {})
}

/** @param {string} prefix */
function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-sesscontext-${prefix}-`))
}

test('the read window is never narrower than the window the writer keeps', () => {
  assert.ok(
    SESSION_CONTEXT_READ_TAIL_BYTES >= SESSION_CONTEXT_MAX_BYTES,
    'a reader that sees less than a compacted file cannot see records the writer kept'
  )
})

test('a live session survives a noisy neighbour filling the file below the compaction cap', async () => {
  const home = await tmpDir('evict')
  try {
    const stateFile = path.join(home, 'session-context.jsonl')
    await appendSessionContext(stateFile, hookRecord(QUIET_SESSION, QUIET_CWD, 0))
    // Three quarters of the writer's cap: past any narrower reader window, but
    // short of the compaction that would legitimately evict the record.
    await floodWithNeighbour(stateFile, Math.floor(SESSION_CONTEXT_MAX_BYTES * 0.75))

    const stat = await fs.stat(stateFile)
    assert.ok(
      stat.size <= SESSION_CONTEXT_MAX_BYTES,
      'precondition: the writer has not compacted, so the record is still on disk'
    )
    const onDisk = await fs.readFile(stateFile, 'utf8')
    assert.ok(onDisk.includes(QUIET_SESSION), 'precondition: the quiet session is still in the file')

    const records = await readSessionContext(stateFile)
    const picked = pickLatestMatching(records, { sessionId: QUIET_SESSION })
    assert.ok(picked, 'the reader dropped a record the writer is still holding')
    assert.equal(picked.cwd, QUIET_CWD)

    // The cached reader the listener actually uses takes the same window.
    const cached = createSessionContextReader(stateFile)
    assert.ok(pickLatestMatching(await cached(), { sessionId: QUIET_SESSION }))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('the listener records the evicted session rather than deleting its bodies unread', async () => {
  const home = await tmpDir('listener')
  try {
    const stateFile = path.join(home, 'session-context.jsonl')
    const quietCwd = path.join(home, 'quiet-repo')
    await fs.mkdir(quietCwd, { recursive: true })
    await appendSessionContext(stateFile, hookRecord(QUIET_SESSION, quietCwd, 0))
    await floodWithNeighbour(stateFile, Math.floor(SESSION_CONTEXT_MAX_BYTES * 0.75))

    const spoolDir = await ensureClaudeBodySpool(claudeBodySpoolDir(home))
    const bodyRef = path.join(spoolDir, 'req-quiet.json')
    await fs.writeFile(
      bodyRef,
      JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        system: SYSTEM_TEXT,
        messages: [{ role: 'user', content: 'Read notes.txt.' }],
      })
    )

    /** @type {AiGatewayProjectedExchange[]} */
    const recorded = []
    const noop = () => {}
    const start = createStartClaudeTelemetrySource({
      gateway: /** @type {any} */ ({
        recordProjectedExchange: async (/** @type {AiGatewayProjectedExchange} */ projection) => {
          recorded.push(projection)
          return { rowsWritten: projection.messages.length, rowsSkipped: 0 }
        },
      }),
      clientName: 'claude',
      stateFile,
    })
    const ctx = /** @type {any} */ ({
      config: { telemetry: { listen_host: '127.0.0.1', listen_port: 0 } },
      env: { HYP_HOME: home },
      log: { info: noop, warn: noop, error: noop, debug: noop },
      storage: { cacheTablePath: () => path.join(home, 'events'), appendRows: async () => {} },
    })

    const started = await start(ctx)
    try {
      const port = (await statusDetails(started)).listen_port
      const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(logsEnvelope(bodyRef)),
      })
      assert.equal(response.status, 200)
      await response.text()

      assert.equal(recorded.length, 1, 'the quiet session must be recorded, not withheld')
      assert.equal(recorded[0].cwd, quietCwd, 'the row carries the cwd the hook recorded')
      assert.equal(
        recorded[0].system_text,
        SYSTEM_TEXT,
        'the spooled body was read into the row rather than deleted unread'
      )
      const details = await statusDetails(started)
      assert.equal(details.events_undetermined, 0)
      assert.equal(details.bodies_dropped, 0)
    } finally {
      await started.stop()
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/**
 * One turn of the quiet session, in the envelope Claude Code's exporter sends.
 *
 * @param {string} bodyRef
 */
function logsEnvelope(bodyRef) {
  const requestId = 'req_011Ce8sjpb8Uzvot2JMvFkKe'
  return {
    resourceLogs: [
      {
        resource: { attributes: kv({ 'service.name': 'claude-code' }) },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.233' },
            logRecords: [
              logRecord('user_prompt', {
                prompt_length: '15',
                prompt: 'Read notes.txt.',
                'message.uuid': '4bd39765-f83f-4a6f-bfc4-81b88f6ac446',
              }, '2026-08-18T09:30:24.450Z'),
              logRecord('api_request_body', {
                request_id: requestId,
                body_ref: bodyRef,
              }, '2026-08-18T09:30:25.000Z'),
              logRecord('api_request', {
                model: 'claude-haiku-4-5-20251001',
                input_tokens: 73,
                output_tokens: 113,
                request_id: requestId,
              }, '2026-08-18T09:30:31.009Z'),
              logRecord('assistant_response', {
                response_length: 21,
                response: 'This is a quiet repo.',
                request_id: requestId,
                'message.uuid': '1e54d1be-9919-4b2a-97e2-3292ba55ce0e',
                model: 'claude-haiku-4-5-20251001',
              }, '2026-08-18T09:30:31.010Z'),
            ],
          },
        ],
      },
    ],
  }
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {string} timestamp
 */
function logRecord(name, attrs, timestamp) {
  return {
    timeUnixNano: String(BigInt(Date.parse(timestamp)) * 1_000_000n),
    body: { stringValue: `claude_code.${name}` },
    attributes: kv({
      'session.id': QUIET_SESSION,
      'app.version': '2.1.233',
      'event.name': name,
      'event.timestamp': timestamp,
      ...attrs,
    }),
  }
}

/** @param {Record<string, unknown>} attrs */
function kv(attrs) {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key, value: { intValue: value } }
        : { key, value: { doubleValue: value } }
    }
    if (typeof value === 'boolean') return { key, value: { boolValue: value } }
    return { key, value: { stringValue: String(value) } }
  })
}
