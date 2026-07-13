// @ts-check

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  isInteractiveCodexSession,
  runCodexClassifyHook,
} from '../../hypaware-core/plugins-workspace/codex/src/classify_hook.js'

/**
 * Codex's degraded classification prompt (LLP 0106, task T8). Codex has no
 * SessionStart context-injection hook, so the prompt degrades to a firm
 * first-prompt nag emitted as plain text - but the decision, the copy, and the
 * verbs are the shared core ones. Inert / never-throws on every non-prompt case.
 */

test('an unclassified interactive session prints a plain-text classification nag', async () => {
  const stdout = makeBuf()
  const code = await runCodexClassifyHook(
    ['classify-cwd'],
    ctx({ stdout, stdin: stdinFor({ cwd: '/work/fresh' }) }),
    { evaluate: async ({ cwd }) => ({ prompt: true, reason: 'unclassified', cwd, enrolled: true, governed: false, promptText: `classify ${cwd} via hyp ignore` }) }
  )
  assert.equal(code, 0)
  const text = stdout.text()
  assert.match(text, /\[HypAware\]/)
  assert.match(text, /classify \/work\/fresh via hyp ignore/)
  // Plain text, not Claude's JSON hookSpecificOutput envelope.
  assert.equal(text.includes('hookSpecificOutput'), false)
})

test('no prompt -> no output', async () => {
  const stdout = makeBuf()
  const code = await runCodexClassifyHook(
    ['classify-cwd'],
    ctx({ stdout, stdin: stdinFor({ cwd: '/work/x' }) }),
    { evaluate: async ({ cwd }) => ({ prompt: false, reason: 'unenrolled', cwd, enrolled: false, governed: false }) }
  )
  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
})

test('falls back to ctx.cwd when no event cwd is piped', async () => {
  const stdout = makeBuf()
  /** @type {string | undefined} */
  let seenCwd
  const code = await runCodexClassifyHook(
    ['classify-cwd'],
    ctx({ stdout, stdin: stdinFor(''), cwd: '/work/from-ctx' }),
    { evaluate: async ({ cwd }) => { seenCwd = cwd; return { prompt: false, reason: 'classified', cwd, enrolled: true, governed: true } } }
  )
  assert.equal(code, 0)
  assert.equal(seenCwd, '/work/from-ctx')
})

test('an evaluation that throws is swallowed with exit 0', async () => {
  const stdout = makeBuf()
  const code = await runCodexClassifyHook(
    ['classify-cwd'],
    ctx({ stdout, stdin: stdinFor({ cwd: '/work/boom' }) }),
    { evaluate: async () => { throw new Error('boom') } }
  )
  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
})

test('isInteractiveCodexSession honors CI and the escape hatch', () => {
  assert.equal(isInteractiveCodexSession({}), true)
  assert.equal(isInteractiveCodexSession({ CI: 'true' }), false)
  assert.equal(isInteractiveCodexSession({ CI: '0' }), true)
  assert.equal(isInteractiveCodexSession({ HYP_HOOK_NONINTERACTIVE: 'yes' }), false)
})

/**
 * @param {{ stdout: ReturnType<typeof makeBuf>, stdin: NodeJS.ReadStream, cwd?: string, env?: Record<string, string> }} opts
 */
function ctx(opts) {
  return /** @type {any} */ ({
    stdout: opts.stdout,
    stderr: makeBuf(),
    stdin: opts.stdin,
    cwd: opts.cwd,
    env: opts.env ?? {},
  })
}

/** @param {string | Record<string, unknown>} value */
function stdinFor(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return /** @type {NodeJS.ReadStream} */ (Readable.from([body]))
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) { chunks.push(typeof chunk === 'string' ? chunk : String(chunk)); return true },
    text() { return chunks.join('') },
  }
}
