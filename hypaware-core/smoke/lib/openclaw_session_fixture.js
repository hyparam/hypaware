// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Stage an OpenClaw v3 session JSONL file the way OpenClaw itself writes
 * one, for hermetic smoke flows.
 *
 * This lives in `smoke/lib` rather than inside a single flow because the
 * shape it encodes is the whole point: an OpenClaw `type: "message"` record
 * states only `id`, `parentId`, `timestamp`, and `type` on the record LINE,
 * and nests `role`, `content`, and (on an assistant turn) `model`,
 * `provider`, `api`, `stopReason`, and `usage` one level down under
 * `message`. #543 shipped green precisely because no hermetic smoke ever
 * wrote that shape: the reader took every field off the line, found none of
 * them, excluded every record fail-closed, and reported a clean "0 rows".
 * A fixture builder that any flow can reach keeps the next flow from
 * inventing a flatter, friendlier shape that would fail the same way.
 *
 * Mirrors `test/plugins/openclaw-backfill.test.js`'s `messageLine()` and
 * `test/plugins/openclaw-settlement.test.js`'s `sessionFileLine()`, which
 * build the same two-level shape for the traditional tier.
 *
 * @ref LLP 0158#decision [tests]: the two-level record shape the one reader
 * exists to know about, written by a smoke fixture rather than assumed
 */

/**
 * Build one `type: "message"` record line in the real two-level shape.
 *
 * `id`, `parentId`, and `timestamp` stay on the record line; everything
 * else the caller passes is the message envelope. `timestamp` is written at
 * both levels by default, which is what a real session file does. Pass
 * `messageTimestamp` to override the nested `message.timestamp` only, so a
 * caller can make the two levels state different values and observe which
 * one an envelope-first read actually picks; the record line's `timestamp`
 * is untouched either way.
 *
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
export function openclawMessageLine(fields) {
  const { id, timestamp, parentId, messageTimestamp, ...message } = fields
  const envelopeTimestamp = messageTimestamp !== undefined ? messageTimestamp : timestamp
  return {
    type: 'message',
    ...(id !== undefined ? { id } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    parentId: parentId ?? null,
    message: { ...message, ...(envelopeTimestamp !== undefined ? { timestamp: envelopeTimestamp } : {}) },
  }
}

/**
 * Write one `<homeDir>/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
 * with a `type: "session"` header line followed by `records`, each passed
 * through {@link openclawMessageLine}.
 *
 * `mtimeMs` is caller-controllable on purpose. Nothing in this flow needs
 * it, but the scheduled-sweep work (LLP 0173 T12) selects candidate session
 * files by recency and has to prove a file inside the quiesce window is
 * skipped, which is unprovable without setting an mtime the test chose.
 * Setting it here costs one `utimes` call and saves that work a fork.
 *
 * @param {{
 *   homeDir: string,
 *   agentId?: string,
 *   sessionId: string,
 *   header?: Record<string, unknown> | null,
 *   records?: Array<Record<string, unknown>>,
 *   mtimeMs?: number,
 * }} spec
 * @returns {Promise<{ agentsDir: string, agentId: string, sessionId: string, filePath: string }>}
 */
export async function writeOpenclawSessionFixture(spec) {
  const agentId = spec.agentId ?? 'main'
  const agentsDir = path.join(spec.homeDir, '.openclaw', 'agents')
  const sessionsDir = path.join(agentsDir, agentId, 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })
  const filePath = path.join(sessionsDir, `${spec.sessionId}.jsonl`)

  /** @type {string[]} */
  const lines = []
  if (spec.header !== null) {
    lines.push(JSON.stringify({
      type: 'session',
      version: 3,
      id: spec.sessionId,
      timestamp: '2026-05-20T10:00:00.000Z',
      ...spec.header,
    }))
  }
  for (const record of spec.records ?? []) lines.push(JSON.stringify(openclawMessageLine(record)))
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8')

  if (spec.mtimeMs !== undefined) {
    const when = new Date(spec.mtimeMs)
    await fs.utimes(filePath, when, when)
  }

  return { agentsDir, agentId, sessionId: spec.sessionId, filePath }
}

/**
 * Write the `<sessionId>.trajectory.jsonl` sibling OpenClaw records beside a
 * session, in the event shape a live trajectory holds (verified against
 * OpenClaw 2026.7.1-2): every line states `traceSchema`, `sessionId`,
 * `runId`, `type`, `ts`, and a per-type `data` object, and one run writes
 * `session.started`, `trace.metadata`, `context.compiled`,
 * `model.completed`, `session.ended` in that order.
 *
 * Here for the same reason the session fixture is: the shape is the point.
 * The sweep fills `system_text` and `tools` from `context.compiled` alone
 * (LLP 0265), and a flow that invented a flatter event stream would prove
 * only that it can read its own invention. Callers author runs, not events,
 * so no flow has to restate the ordering.
 *
 * `systemPrompt` is passed through as given: a string is a prompt the run
 * recorded in full, and the `{ truncated: true, ... }` stub is what OpenClaw
 * substitutes past its 32768-character field cap. `report` writes the
 * `trace.metadata` system-prompt report that describes a stubbed prompt.
 *
 * @ref LLP 0265#trajectory-reader [tests]: the per-run event shape the
 * trajectory reader exists to know about, written rather than assumed
 * @param {{
 *   homeDir: string,
 *   agentId?: string,
 *   sessionId: string,
 *   runs: Array<{
 *     runId?: string,
 *     compiledAt: string,
 *     endedAt?: string,
 *     systemPrompt?: unknown,
 *     tools?: unknown[],
 *     report?: { chars?: number, hash?: string },
 *   }>,
 * }} spec
 * @returns {Promise<{ filePath: string }>}
 */
export async function writeOpenclawTrajectoryFixture(spec) {
  const agentId = spec.agentId ?? 'main'
  const sessionsDir = path.join(spec.homeDir, '.openclaw', 'agents', agentId, 'sessions')
  await fs.mkdir(sessionsDir, { recursive: true })

  /** @type {string[]} */
  const lines = []
  /**
   * @param {string} type
   * @param {string} ts
   * @param {string} runId
   * @param {Record<string, unknown>} data
   */
  const push = (type, ts, runId, data) => {
    lines.push(JSON.stringify({
      traceSchema: 'openclaw-trajectory',
      schemaVersion: 1,
      traceId: spec.sessionId,
      source: 'runtime',
      type,
      ts,
      sessionId: spec.sessionId,
      sessionKey: `agent:${agentId}:${agentId}`,
      runId,
      workspaceDir: path.join(spec.homeDir, 'workspace'),
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      modelApi: 'anthropic-messages',
      data,
    }))
  }

  spec.runs.forEach((run, index) => {
    const runId = run.runId ?? `${spec.sessionId}-run-${index + 1}`
    push('session.started', run.compiledAt, runId, { trigger: 'user', agentId })
    if (run.report) {
      push('trace.metadata', run.compiledAt, runId, {
        prompting: {
          systemPromptReport: { source: 'run', sessionId: spec.sessionId, systemPrompt: run.report },
        },
      })
    }
    push('context.compiled', run.compiledAt, runId, {
      ...(run.systemPrompt !== undefined ? { systemPrompt: run.systemPrompt } : {}),
      ...(run.tools !== undefined ? { tools: run.tools } : {}),
      transport: 'auto',
    })
    if (run.endedAt) {
      push('model.completed', run.endedAt, runId, { aborted: false })
      push('session.ended', run.endedAt, runId, {})
    }
  })

  const filePath = path.join(sessionsDir, `${spec.sessionId}.trajectory.jsonl`)
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8')
  return { filePath }
}
