// @ts-check

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cmdFileSpawnPlan, isCmdFile } from '../../src/core/util/cmd_file.js'

test('isCmdFile names exactly what only cmd.exe can run', () => {
  assert.equal(isCmdFile('C:\\apps\\claude.CMD'), true)
  assert.equal(isCmdFile('C:\\apps\\claude.cmd'), true)
  assert.equal(isCmdFile('C:\\apps\\legacy.BAT'), true)
  assert.equal(isCmdFile('C:\\apps\\claude.EXE'), false)
  assert.equal(isCmdFile('C:\\apps\\claude.exe'), false)
  assert.equal(isCmdFile('/usr/local/bin/claude'), false)
  assert.equal(isCmdFile('claude'), false)
})

test('cmdFileSpawnPlan hands ComSpec one quoted line under /d /s /c, Node quoting off', () => {
  const plan = cmdFileSpawnPlan('C:\\apps\\claude.cmd', ['hello world'], { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' })
  assert.equal(plan.command, 'C:\\WINDOWS\\system32\\cmd.exe')
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.match(plan.args[3], /^".*"$/)
  assert.match(plan.args[3], /claude\.cmd/)
  assert.deepEqual(plan.options, { windowsVerbatimArguments: true })
  // An env without ComSpec falls back to the calling process's own, and a
  // bare name is left for cmd.exe to resolve over PATH and PATHEXT.
  const bare = cmdFileSpawnPlan('opencode', ['export', 'ses_1'], {})
  assert.equal(bare.command, process.env.ComSpec ?? 'cmd.exe')
  assert.match(bare.args[3], /^"opencode /)
})

test('every cmd metacharacter in an argument is caret-escaped, twice for the script re-parse', () => {
  const plan = cmdFileSpawnPlan('c.cmd', ['pct %PATH% & echo pwned | x > y'], {})
  const line = plan.args[3]
  // No metacharacter survives bare: each is preceded by its caret(s).
  assert.doesNotMatch(line, /[^^][&|><]/)
  assert.doesNotMatch(line, /[^^]%/)
  // Double-escaped: the script's own `%*` is parsed again as batch text.
  assert.match(line, /\^\^\^&/)
})

test('a line break collapses to a space: cmd ends a command at one, quoted or not', () => {
  const plan = cmdFileSpawnPlan('c.cmd', ['line one\nline two\r\nline three'], {})
  assert.doesNotMatch(plan.args[3], /[\r\n]/)
  // The words stay in order on the one line (the spaces between them are
  // caret-escaped like any other cmd metacharacter).
  assert.match(plan.args[3], /line.+one.+line.+two.+line.+three/)
})

test('a NUL byte is refused outright, never truncated where an attacker chose', () => {
  assert.throws(() => cmdFileSpawnPlan('c.cmd', ['before\0after'], {}), /NUL/)
  assert.throws(() => cmdFileSpawnPlan('c\0.cmd', [], {}), /NUL/)
})

// The escaping contract is only real against cmd.exe itself: an npm-style
// shim re-expands `%*` into a fresh batch parse, the layer where a missed
// escape turns into expansion or execution.
test('the escaped line survives an npm-style shim byte for byte, and injects nothing', {
  skip: process.platform !== 'win32' && 'drives a real cmd.exe, so win32 only',
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cmd-file-'))
  try {
    const captureJs = path.join(dir, 'capture.cjs')
    await fs.writeFile(captureJs, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))\n")
    // A space in the shim's own path, and `%*` re-expanded, as npm writes it.
    const shim = path.join(dir, 'fake client.cmd')
    const argvFile = path.join(dir, 'argv.json')
    await fs.writeFile(shim, `@ECHO OFF\r\n"${process.execPath}" "${captureJs}" "${argvFile}" %*\r\n`)
    const cases = [
      'plain',
      'has spaces and  double  spaces',
      'ends with backslash\\',
      'quote " in the middle',
      'backslash-quote \\" pair',
      'pct %PATH% and %USERNAME% and 50% done',
      'bang !PATH! delayed',
      'amp & echo pwned > pwned.txt',
      'pipe | findstr x && echo also',
      'caret ^ and ^^ carets',
      'parens (a) and ,;= separators',
      'star * and ? glob',
      'Question: which sessions touched auth? (50% & "done")',
    ]
    const plan = cmdFileSpawnPlan(shim, cases)
    const code = await new Promise((resolve, reject) => {
      const child = spawn(plan.command, plan.args, { ...plan.options, stdio: 'ignore' })
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(await fs.readFile(argvFile, 'utf8')), cases)
    // The injection probe stayed text: nothing executed the `>` redirect.
    await assert.rejects(fs.access(path.join(dir, 'pwned.txt')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
