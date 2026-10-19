// @ts-check
// Synthetic VS Code 1.142 schema-v1 fixtures. Schema and field provenance:
// microsoft/vscode d956e8a6ac5d904486557eea07e1d6bd62a4d36f
// src/vs/platform/otel/node/sqlite/otelSqliteStore.ts and extension counterpart.
// Metadata: storageMain.ts, chatSessionOperationLog.ts, agentHost/sessionDataService.ts.
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export const COPILOT_SCHEMA = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (1);
CREATE TABLE spans (
span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT,
name TEXT NOT NULL, start_time_ms INTEGER NOT NULL, end_time_ms INTEGER NOT NULL,
status_code INTEGER NOT NULL DEFAULT 0, status_message TEXT,
operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
request_model TEXT, response_model TEXT,
input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
tool_name TEXT, tool_call_id TEXT, tool_type TEXT,
chat_session_id TEXT, turn_index INTEGER, ttft_ms REAL);
CREATE TABLE span_attributes (span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT, PRIMARY KEY(span_id, key));
CREATE TABLE span_events (id INTEGER PRIMARY KEY AUTOINCREMENT, span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE, name TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, attributes TEXT);
CREATE INDEX idx_spans_conversation ON spans(conversation_id);
CREATE INDEX idx_spans_chat_session ON spans(chat_session_id);
CREATE INDEX idx_spans_trace ON spans(trace_id);
`

/** @param {{ root: string, cwd: string, id: string, harness: string, now?: number, copilotHome?: string }} opts */
export async function copilotFixture({ root, cwd, id, harness, now = Date.now(), copilotHome = path.join(path.dirname(root), '.copilot') }) {
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(path.join(cwd, 'fixture.txt'), 'fixture contents')
  const local = harness === 'local'
  const file = local ? path.join(root, 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db') : path.join(root, 'agent-host', 'otel', 'agent-host-traces.db')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA wal_autocheckpoint = 0')
  db.exec(COPILOT_SCHEMA)
  let metadata
  let sessionFile
  if (local) {
    const workspace = path.join(root, 'User', 'workspaceStorage', 'fixture')
    await fs.mkdir(path.join(workspace, 'chatSessions'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(cwd).href }))
    sessionFile = path.join(workspace, 'chatSessions', id + '.jsonl')
    await fs.writeFile(sessionFile, JSON.stringify({ kind: 0, v: { version: 3, sessionId: id, requests: [], workingDirectory: pathToFileURL(cwd).href } }) + '\n')
  } else {
    const native = path.join(copilotHome, 'session-state', id)
    await fs.mkdir(native, { recursive: true })
    await fs.writeFile(path.join(native, 'events.jsonl'), JSON.stringify({ type: 'session.start', id: 'start-' + id, timestamp: new Date(now).toISOString(), data: { context: { cwd } } }) + '\n')
    const dir = path.join(root, 'agentSessionData', 'host-' + id)
    await fs.mkdir(dir, { recursive: true })
    metadata = new DatabaseSync(path.join(dir, 'session.db'))
    metadata.exec('CREATE TABLE session_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE turn_workspace_transition (turn_id TEXT PRIMARY KEY, transition TEXT NOT NULL)')
    metadata.prepare('INSERT INTO session_metadata VALUES (?, ?)').run('copilot.workingDirectory', pathToFileURL(cwd).href)
    metadata.prepare('INSERT INTO session_metadata VALUES (?, ?)').run('copilot.workingDirectories', JSON.stringify([pathToFileURL(cwd).href]))
  }
  /** @param {Record<string, any>} span @param {Record<string, any>} [attrs] */
  function insert(span, attrs = {}) {
    const value = { span_id: span.span_id, trace_id: 'trace-' + id, conversation_id: id, name: span.operation_name || 'vscode.agent_host.session', start_time_ms: now, end_time_ms: (span.start_time_ms ?? now) + 10, status_code: 1, provider_name: 'github', response_model: 'fixture-model', ...span }
    const keys = Object.keys(value)
    db.exec('BEGIN')
    try {
      db.prepare(`INSERT OR REPLACE INTO spans (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(value))
      for (const [key, attr] of Object.entries(attrs)) db.prepare('INSERT OR REPLACE INTO span_attributes VALUES (?, ?, ?)').run(value.span_id, key, typeof attr === 'string' ? attr : JSON.stringify(attr))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  if (!local) insert({ span_id: 'host-link' }, { 'vscode.agent_host.session.uri': 'copilotcli:/host-' + id })
  for (let i = 0; i < 2; i++) {
    insert({ span_id: 'invoke-' + i, operation_name: 'invoke_agent', input_tokens: 999, output_tokens: 999, start_time_ms: now + i * 100 }, {
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'Repeat this prompt' }] }],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'duplicate aggregate' }] }],
    })
    insert({ span_id: 'chat-' + i, parent_span_id: 'invoke-' + i, operation_name: 'chat', start_time_ms: now + i * 100, input_tokens: 20, output_tokens: 3, cached_tokens: 5 }, {
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'duplicated model history must not be fetched' }] }],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'Repeated answer' }, ...(i === 0 ? [{ type: 'tool_call', id: 'call-1', name: 'read_file', arguments: local ? JSON.stringify({ filePath: path.join(cwd, 'fixture.txt') }) : { filePath: path.join(cwd, 'fixture.txt') } }] : [])] }],
      'gen_ai.response.id': 'response-' + i,
    })
  }
  insert({ span_id: 'tool-1', operation_name: 'execute_tool', parent_span_id: 'chat-0', tool_name: 'read_file', tool_call_id: 'call-1' }, { 'gen_ai.tool.call.arguments': JSON.stringify({ filePath: path.join(cwd, 'fixture.txt') }), 'gen_ai.tool.call.result': 'fixture contents' })
  let closed = false
  return { db, file, metadata, sessionFile, insert, close() {
    if (!closed) {
      closed = true
      db.close()
      metadata?.close()
    }
  } }
}
