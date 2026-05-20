import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { parseArgs, runClaudeHook } from '../../src/cli/claude-hook.js'

/**
 * @param {unknown} value
 * @returns {Readable}
 */
function stdinFor(value) {
  return Readable.from([JSON.stringify(value)])
}

describe('parseArgs', function() {
  it('parses the internal session-context command', function() {
    expect(parseArgs(['session-context', '--port', '8787'])).toEqual({ port: 8787 })
  })
})

describe('runClaudeHook', function() {
  it('posts session context to the local proxy endpoint', async function() {
    /** @type {Array<{ url: string, init: RequestInit }>} */
    const calls = []
    const code = await runClaudeHook(['session-context', '--port', '8787'], {
      stdin: /** @type {any} */ (stdinFor({
        session_id: 'sess-hook',
        cwd: '/tmp/not-a-git-repo',
        hook_event_name: 'SessionStart',
      })),
      fetch(url, init) {
        calls.push({ url: String(url), init: /** @type {RequestInit} */ (init ?? {}) })
        return Promise.resolve(/** @type {Response} */ ({}))
      },
    })

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:8787/_collectivus/session-context')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      session_id: 'sess-hook',
      cwd: '/tmp/not-a-git-repo',
    })
  })

  it('does nothing when hook input has no session id', async function() {
    /** @type {string[]} */
    const calls = []
    const code = await runClaudeHook(['session-context', '--port', '8787'], {
      stdin: /** @type {any} */ (stdinFor({ cwd: '/repo' })),
      fetch(url) {
        calls.push(String(url))
        return Promise.resolve(/** @type {Response} */ ({}))
      },
    })

    expect(code).toBe(0)
    expect(calls).toEqual([])
  })
})
