import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadClaudeContextLookup } from '../../src/cli/claude-transcripts.js'

/** @type {string} */
let tmpDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-claude-transcripts-'))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} project
 * @param {string} file
 * @param {Record<string, unknown>[]} rows
 * @returns {void}
 */
function writeTranscript(project, file, rows) {
  const dir = path.join(tmpDir, project)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

describe('loadClaudeContextLookup', function() {
  it('indexes only local context fields and returns the nearest row for a session timestamp', async function() {
    writeTranscript('-repo', 'sess.jsonl', [
      {
        type: 'user',
        sessionId: 'sess-1',
        timestamp: '2026-05-13T10:00:00.000Z',
        cwd: '/repo/old',
        gitBranch: 'old',
        version: '2.1.140',
        message: { role: 'user', content: 'not retained by lookup' },
      },
      {
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-05-13T10:10:00.000Z',
        cwd: '/repo/new',
        gitBranch: 'main',
        version: '2.1.141',
        toolUseResult: { stdout: 'not retained either' },
      },
    ])

    const lookup = await loadClaudeContextLookup({ projectsDir: tmpDir })
    expect(lookup('sess-1', '2026-05-13T10:09:00.000Z')).toEqual({
      cwd: '/repo/new',
      git_branch: 'main',
      claude_version: '2.1.141',
    })
    expect(lookup('missing', '2026-05-13T10:09:00.000Z')).toBeUndefined()
  })

  it('matches transcript frames by Anthropic message id and by role/content', async function() {
    writeTranscript('-repo', 'sess.jsonl', [
      {
        type: 'user',
        sessionId: 'sess-1',
        uuid: 'uuid-user',
        parentUuid: null,
        timestamp: '2026-05-13T10:00:00.000Z',
        cwd: '/repo',
        gitBranch: 'main',
        version: '2.1.141',
        userType: 'external',
        entrypoint: 'cli',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        sessionId: 'sess-1',
        uuid: 'uuid-assistant',
        parentUuid: 'uuid-user',
        requestId: 'req-abc',
        timestamp: '2026-05-13T10:00:01.000Z',
        cwd: '/repo',
        gitBranch: 'main',
        version: '2.1.141',
        userType: 'external',
        entrypoint: 'cli',
        message: {
          id: 'msg-abc',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi back' }],
        },
      },
    ])

    const lookup = await loadClaudeContextLookup({ projectsDir: tmpDir })
    expect(lookup.matchMessage?.('sess-1', { role: 'user', content: 'hello' }, '2026-05-13T10:00:00.100Z')).toMatchObject({
      provider_uuid: 'uuid-user',
      provider_type: 'user',
      entrypoint: 'cli',
      client_version: '2.1.141',
      user_type: 'external',
    })
    expect(lookup.matchMessage?.('sess-1', { id: 'msg-abc', role: 'assistant', content: 'ignored for id match' }, '2026-05-13T10:00:01.100Z')).toMatchObject({
      provider_uuid: 'uuid-assistant',
      parent_uuid: 'uuid-user',
      request_id: 'req-abc',
      provider_type: 'assistant',
    })
  })
})
