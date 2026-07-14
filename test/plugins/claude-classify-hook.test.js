// @ts-check

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  isInteractiveClaudeSession,
  runClaudeClassifyHook,
} from '../../hypaware-core/plugins-workspace/claude/src/classify_hook.js'

/**
 * The Claude SessionStart classification hook (LLP 0106, task T8). On an
 * enrolled machine, an interactive session opened in an unclassified folder is
 * asked once (via injected SessionStart context) to classify it; every other
 * case passes through silently and the hook never throws or hangs.
 */

test('an unclassified interactive session gets a SessionStart additionalContext prompt', async () => {
  const stdout = makeBuf()
  const code = await runClaudeClassifyHook(
    ['classify-cwd'],
    ctx({ stdout, stdin: stdinFor({ session_id: 's1', cwd: '/work/fresh', source: 'startup' }) }),
    { evaluate: async ({ cwd }) => ({ prompt: true, reason: 'unclassified', cwd, enrolled: true, governed: false, promptText: `classify ${cwd}` }) }
  )
  assert.equal(code, 0)
  const out = JSON.parse(stdout.text())
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(out.hookSpecificOutput.additionalContext, 'classify /work/fresh')
})

test('a classified / unenrolled / non-interactive evaluation emits nothing', async () => {
  for (const reason of ['classified', 'unenrolled', 'non-interactive']) {
    const stdout = makeBuf()
    const code = await runClaudeClassifyHook(
      ['classify-cwd'],
      ctx({ stdout, stdin: stdinFor({ session_id: 's1', cwd: '/work/x', source: 'startup' }) }),
      { evaluate: async ({ cwd }) => ({ prompt: false, reason, cwd, enrolled: reason !== 'unenrolled', governed: reason === 'classified' }) }
    )
    assert.equal(code, 0)
    assert.equal(stdout.text(), '', `no output for reason=${reason}`)
  }
})

test('a session-start event with no cwd is a passthrough (no evaluation, no output)', async () => {
  const stdout = makeBuf()
  let evaluated = false
  const code = await runClaudeClassifyHook(
    ['classify-cwd'],
    ctx({ stdout, stdin: stdinFor({ session_id: 's1', source: 'startup' }) }),
    { evaluate: async () => { evaluated = true; return { prompt: true, reason: 'unclassified', cwd: '', enrolled: true, governed: false, promptText: 'x' } } }
  )
  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(evaluated, false, 'no cwd -> never evaluates')
})

test('malformed stdin never throws back into Claude', async () => {
  const stdout = makeBuf()
  const code = await runClaudeClassifyHook(
    ['classify-cwd'],
    ctx({ stdout, stdin: stdinFor('this is not json') }),
    { evaluate: async () => { throw new Error('should not be reached') } }
  )
  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
})

test('an evaluation that throws is swallowed with exit 0 and no output', async () => {
  const stdout = makeBuf()
  const code = await runClaudeClassifyHook(
    ['classify-cwd'],
    ctx({ stdout, stdin: stdinFor({ session_id: 's1', cwd: '/work/boom', source: 'startup' }) }),
    { evaluate: async () => { throw new Error('evaluate blew up') } }
  )
  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
})

test('--help prints usage and does not read stdin', async () => {
  const stdout = makeBuf()
  const code = await runClaudeClassifyHook(['classify-cwd', '--help'], ctx({ stdout, stdin: stdinFor('') }))
  assert.equal(code, 0)
  assert.match(stdout.text(), /usage: hyp claude-hook classify-cwd/)
})

test('isInteractiveClaudeSession: startup is interactive; compact / CI / escape-hatch are not', () => {
  assert.equal(isInteractiveClaudeSession({ source: 'startup' }, {}), true)
  assert.equal(isInteractiveClaudeSession({ source: 'resume' }, {}), true)
  assert.equal(isInteractiveClaudeSession({ source: 'compact' }, {}), false)
  assert.equal(isInteractiveClaudeSession({ source: 'startup' }, { CI: 'true' }), false)
  assert.equal(isInteractiveClaudeSession({ source: 'startup' }, { CI: 'false' }), true)
  assert.equal(isInteractiveClaudeSession({ source: 'startup' }, { HYP_HOOK_NONINTERACTIVE: '1' }), false)
})

/**
 * @param {{ stdout: ReturnType<typeof makeBuf>, stdin: NodeJS.ReadStream, env?: Record<string, string> }} opts
 */
function ctx(opts) {
  return /** @type {any} */ ({
    stdout: opts.stdout,
    stderr: makeBuf(),
    stdin: opts.stdin,
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
