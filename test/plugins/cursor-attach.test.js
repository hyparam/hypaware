// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { attachCursorHooks, cursorHooksPath, CURSOR_EVENTS } from '../../hypaware-core/plugins-workspace/cursor/src/attach.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'
import { runClaudeClassifyHook } from '../../hypaware-core/plugins-workspace/claude/src/classify_hook.js'
import { runClaudeSessionContextHook } from '../../hypaware-core/plugins-workspace/claude/src/hook_command.js'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'

/** @type {any} */
const descriptor = { name: 'cursor', plugin: '@hypaware/cursor', attachProbe: { format: 'json', settings_file: '.cursor/hooks.json', marker_key: '_hypaware' } }

test('native hook attach/dry run/upgrade/disk detach preserve unrelated config and user edits', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hooks-'))
  const opts = { homeDir: home, endpoint: 'http://127.0.0.1:4321', version: '1.0.0', env: { CURSOR_HOME: '/wrong', CURSOR_CONFIG_DIR: '/also-wrong', XDG_CONFIG_HOME: '/wrong-too' } }
  const file = cursorHooksPath(opts)
  try {
    assert.equal(file, path.join(home, '.cursor/hooks.json'))
    assert.equal((await attachCursorHooks({ ...opts, dryRun: true })).changed, true)
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
    const original = { version: 1, custom: 'preserve', hooks: { stop: [{ command: 'echo user', timeout: 10 }] } }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(original))
    await attachCursorHooks(opts)
    assert.equal((await attachCursorHooks(opts)).changed, false)
    assert.equal((await probeClientAttachFromDescriptor({ descriptor, ...opts })).attached, true)
    let installed = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(installed.hooks.afterAgentThought, undefined)
    assert.equal(installed._hypaware.managed.hook_entries.length, CURSOR_EVENTS.length)
    assert.equal(installed.hooks.stop[0].command, 'echo user')
    await attachCursorHooks({ ...opts, endpoint: 'http://127.0.0.1:5321', version: '1.0.1' })
    installed = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(installed.hooks.stop.length, 2)
    installed.hooks.afterAgentResponse[0].command = 'echo edited by user'
    await fs.writeFile(file, JSON.stringify(installed))
    assert.equal((await detachClientFromDisk({ descriptor, ...opts })).changed, true)
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
      ...original, hooks: { ...original.hooks, afterAgentResponse: [{ type: 'command', command: 'echo edited by user', timeout: 3, failClosed: false }] },
    })
    assert.equal((await detachClientFromDisk({ descriptor, ...opts })).changed, false)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('invalid shared config and foreign markers are refused without a write', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-refuse-'))
  const opts = { homeDir, endpoint: 'http://127.0.0.1:4321', version: '1' }
  const file = cursorHooksPath(opts)
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (const body of ['bad json', '[]', '{"version":2}', '{"hooks":[]}', '{"hooks":{"stop":{}}}', '{"_hypaware":{}}']) {
      await fs.writeFile(file, body)
      await assert.rejects(attachCursorHooks(opts))
      assert.equal(await fs.readFile(file, 'utf8'), body)
    }
  } finally { await fs.rm(homeDir, { recursive: true, force: true }) }
})

test('inherited Claude hooks neither record context, sweep spool, nor inject classification', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-claude-'))
  const stateFile = path.join(home, 'context.jsonl')
  let effects = 0
  const makeContext = () => ({ env: { CURSOR_VERSION: '3.19.19' }, stdout: { write() { effects++ } },
    stdin: Readable.from([JSON.stringify({ session_id: 'cursor-conversation', cwd: home, source: 'startup' })]),
  })
  try {
    await runClaudeSessionContextHook(['--state-file', stateFile], /** @type {any} */ (makeContext()), { sweepSpool: /** @type {any} */ (() => { effects++ }) })
    await runClaudeClassifyHook([], /** @type {any} */ (makeContext()), { evaluate: /** @type {any} */ (() => {
      effects++
      return { prompt: true, promptText: 'wrong client' }
    }) })
    assert.equal(effects, 0)
    await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' })
    // The binary's skip deliberately spares --help, so the handler must too.
    let usage = ''
    await runClaudeSessionContextHook(['--help'], /** @type {any} */ ({
      env: { CURSOR_VERSION: '3.19.19' }, stdout: { write(v) { usage += v } },
    }), { sweepSpool: /** @type {any} */ (() => { effects++ }) })
    assert.match(usage, /usage: hyp claude-hook session-context/)
    assert.equal(effects, 0)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('inherited Claude hook executables exit quietly before loading an absent or broken configuration', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-claude-bin-'))
  try {
    for (const config of ['{"version":2,"plugins":[]}', 'invalid json']) {
      await fs.writeFile(path.join(home, 'hypaware-config.json'), config)
      for (const command of ['session-context', 'classify-cwd']) {
        const result = spawnSync(process.execPath, [new URL('../../bin/hypaware.js', import.meta.url).pathname,
          'claude-hook', command, '--state-file', path.join(home, 'context.jsonl')], {
          env: { ...process.env, CURSOR_VERSION: '2026.09.08-6caf4ff', HYP_HOME: home, HYP_CONFIG: '' },
          input: '{"session_id":"cursor","cwd":"/probe"}', encoding: 'utf8', timeout: 15000,
        })
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, '')
        assert.equal(result.stderr, '')
      }
    }
    assert.deepEqual((await fs.readdir(home)).sort(), ['hypaware-config.json'])
    await fs.writeFile(path.join(home, 'hypaware-config.json'), '{"version":2,"plugins":[]}')
    for (const [version, command] of [['', 'session-context'], ['3.19.19', 'not-a-hook']]) {
      const result = spawnSync(process.execPath, [new URL('../../bin/hypaware.js', import.meta.url).pathname,
        'claude-hook', command], {
        env: { ...process.env, CURSOR_VERSION: version, HYP_HOME: home, HYP_CONFIG: '' },
        input: '{}', encoding: 'utf8', timeout: 15000,
      })
      assert.equal(result.status, 2, 'other invocations still reach ordinary dispatch')
    }
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('generated hook commands survive the real CLI JSONC comment-stripping parser', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-jsonc-'))
  try {
    await attachCursorHooks({ homeDir, endpoint: 'http://127.0.0.1:4321', version: '1' })
    const body = await fs.readFile(cursorHooksPath({ homeDir }), 'utf8')
    // Cursor CLI 2026.09.08 HooksConfigLoader.parseJSONC strips comments
    // before JSON.parse, including slash pairs inside quoted command strings.
    const parsed = JSON.parse(body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))
    assert.equal(parsed.hooks.sessionEnd.length, 1)
    assert.match(parsed.hooks.sessionEnd[0].command, /'127\.0\.0\.1:4321'$/)
    assert.equal(body.includes('http://'), false)
  } finally { await fs.rm(homeDir, { recursive: true, force: true }) }
})
