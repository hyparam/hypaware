// @ts-check
// Synthetic fixtures pin the inspected Cursor wire contract; they are not
// evidence of upstream compatibility. Also used by deterministic reader tests.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function wire(...fields) {
  const integer = (input) => {
    let value = BigInt(input)
    const bytes = []
    do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n } while (value)
    return Buffer.from(bytes)
  }
  return Buffer.concat(fields.map(([key, value]) => {
    if (typeof value === 'number') return Buffer.concat([integer(key * 8), integer(value)])
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value)
    return Buffer.concat([integer(key * 8 + 2), integer(data.length), data])
  }))
}

/** @param {string} root @param {string} cwd @param {'cli' | 'editor'} [frontend] @param {{ id?: string, text?: string }} [options] */
export async function cursorNativeFixture(root, cwd, frontend = 'cli', options = {}) {
  const id = options.id ?? randomUUID()
  const directory = frontend === 'cli' ? path.join(root, createHash('md5').update(cwd).digest('hex'), id) : root
  await mkdir(directory, { recursive: true })
  const dbPath = path.join(directory, frontend === 'cli' ? 'store.db' : 'state.vscdb')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=1')
  if (frontend === 'cli') db.exec('CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)')
  else db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE IF NOT EXISTS composerHeaders(composerId TEXT PRIMARY KEY,recency INTEGER)')
  const put = (data) => {
    const hash = createHash('sha256').update(data).digest('hex')
    if (frontend === 'cli') db.prepare('INSERT OR REPLACE INTO blobs VALUES(?,?)').run(hash, data)
    else db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES(?,?)').run('agentKv:blob:' + hash, data)
    return Buffer.from(hash, 'hex')
  }
  const json = (value) => put(Buffer.from(JSON.stringify(value)))
  const text = options.text ?? 'Same text'
  const refs = [json({ role: 'system', content: [{ type: 'text', text: 'PRIVATE_SYSTEM_CONTEXT' }] }),
    json({ role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text }] }),
    json({ role: 'assistant', content: [{ type: 'text', text }] })]
  const steps = [put(wire([1, wire([1, text], [2, 1789070400000], [3, 1789070400010])])),
    put(wire([3, Buffer.from('PRIVATE_THINKING_NOT_PROTOBUF')]))]
  const tools = [
    { name: 'Read', variant: 8, input: { path: 'notes.txt' }, result: 'The probe value is MARIGOLD-42.\n', outcome: 1 },
    { name: 'Grep', variant: 5, input: { pattern: 'MARIGOLD', path: '.' }, result: 'notes.txt:1:MARIGOLD-42', outcome: 1 },
    { name: 'Glob', variant: 4, input: { glob_pattern: '*.txt' }, result: ['notes.txt'], outcome: 1 },
    { name: 'Shell', variant: 1, input: { command: 'pwd' }, result: { rejected: { reason: 'User denied' } }, outcome: 4 },
    { name: 'Shell', variant: 1, input: { command: 'pwd' }, result: { rejected: { reason: 'User denied' } }, outcome: 4 },
  ]
  for (const [index, tool] of tools.entries()) {
    const callId = 'native-call-' + index
    refs.push(json({ role: 'assistant', id: '1', content: [{ type: 'tool-call', toolCallId: callId, toolName: tool.name, args: tool.input }] }))
    refs.push(json({ role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: tool.name, result: tool.result }] }))
    steps.push(put(wire([2, wire([57, callId], [59, 1789070400010 + index], [60, 1789070400020 + index],
      [tool.variant, wire([1, wire()], [2, wire([tool.outcome, wire()])])])])) )
  }
  steps.push(put(wire([1, wire([1, text], [2, 1789070400100])])))
  const user = put(wire([1, 'Read and search notes.txt'], [2, 'native-user'], [25, 1789070400000]))
  const turn = put(wire([1, wire([1, user], ...steps.map((ref) => [2, ref]), [3, 'native-generation'])]))
  const state = wire(...refs.map((ref) => [1, ref]), [8, turn])
  const writeRoot = (value = state, status = 'completed') => {
    if (frontend === 'cli') db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('0', Buffer.from(JSON.stringify({ agentId: id, latestRootBlobId: put(value).toString('hex'), blobEncryptionKey: 'PRIVATE_KEY_NEVER_EXPORT' })).toString('hex'))
    else {
      db.prepare('INSERT OR REPLACE INTO composerHeaders VALUES(?,?)').run(id, Date.now())
      db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES(?,?)').run('composerData:' + id, JSON.stringify({ _v: 18, workspaceIdentifier: { uri: { path: cwd } }, conversationCheckpointLastUpdatedAt: Date.now(), status, conversationState: '~' + value.toString('base64') }))
    }
  }
  writeRoot()
  if (frontend === 'cli') await writeFile(path.join(directory, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd, updatedAtMs: Date.now() }))
  return { session: { id, cwd, dbPath, frontend, updatedAt: Date.now() }, db, state, refs, steps, user, put, writeRoot, close: () => db.close() }
}
