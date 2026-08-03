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
