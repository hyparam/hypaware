// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { runClaudeSessionContextHook } from '../../hypaware-core/plugins-workspace/claude/src/hook_command.js'

function hookKernelAndRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  registry.register({
    name: 'claude-hook session-context',
    summary: 'Internal Claude Code hook',
    usage: 'hyp claude-hook session-context --state-file <path>',
    hidden: true,
    run: runClaudeSessionContextHook,
  })
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { kernel, registry }
}

test('Claude session-context hook exits 0 without --state-file', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { kernel, registry: hookRegistry } = hookKernelAndRegistry()

  const code = await dispatch(
    ['claude-hook', 'session-context'],
    {
      stdout,
      stderr,
      stdin: stdinFor(''),
      env: { ...process.env, HYP_HOME: hypHome },
      registry: hookRegistry,
      kernel,
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')
})

test('Claude session-context hook appends one JSONL record per event to --state-file', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stateFile = path.join(hypHome, 'session-context.jsonl')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { kernel, registry: hookRegistry } = hookKernelAndRegistry()

  const code = await dispatch(
    ['claude-hook', 'session-context', '--state-file', stateFile],
    {
      stdout,
      stderr,
      stdin: stdinFor({
        session_id: 'sess-hook',
        cwd: '/tmp/not-a-git-repo',
        transcript_path: '/tmp/sess-hook.jsonl',
        hook_event_name: 'SessionStart',
      }),
      env: { ...process.env, HYP_HOME: hypHome },
      registry: hookRegistry,
      kernel,
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')

  const contents = await fs.readFile(stateFile, 'utf8')
  const lines = contents.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.session_id, 'sess-hook')
  assert.equal(record.cwd, '/tmp/not-a-git-repo')
  assert.equal(record.transcript_path, '/tmp/sess-hook.jsonl')
  assert.equal(typeof record.ts, 'string')
})

test('Claude session-context hook ignores events without session context', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stateFile = path.join(hypHome, 'session-context.jsonl')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { kernel, registry: hookRegistry } = hookKernelAndRegistry()

  const code = await dispatch(
    ['claude-hook', 'session-context', '--state-file', stateFile],
    {
      stdout,
      stderr,
      stdin: stdinFor({ cwd: '/tmp/not-a-git-repo' }),
      env: { ...process.env, HYP_HOME: hypHome },
      registry: hookRegistry,
      kernel,
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')
  await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' })
})

test('legacy Claude session-context hook --port writes the default plugin state file', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-legacy-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { kernel, registry: hookRegistry } = hookKernelAndRegistry()

  const code = await dispatch(
    ['claude-hook', 'session-context', '--port', '4388'],
    {
      stdout,
      stderr,
      stdin: stdinFor({
        session_id: 'sess-legacy',
        cwd: '/tmp/not-a-git-repo',
        transcript_path: '/tmp/sess-legacy.jsonl',
      }),
      env: { ...process.env, HYP_HOME: hypHome },
      registry: hookRegistry,
      kernel,
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')

  const stateFile = path.join(
    hypHome,
    'hypaware',
    'plugins',
    '@hypaware',
    'claude',
    'session-context.jsonl'
  )
  const contents = await fs.readFile(stateFile, 'utf8')
  const lines = contents.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.session_id, 'sess-legacy')
  assert.equal(record.cwd, '/tmp/not-a-git-repo')
  assert.equal(record.transcript_path, '/tmp/sess-legacy.jsonl')
})

test('hidden Claude hook command is omitted from top-level help', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.equal(stdout.text().includes('claude-hook'), false)
})

test('dispatch surfaces boot-path sink materialization warnings', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-sink-warning-'))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/local-fs' }],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
      },
    },
  }))

  const registry = createCommandRegistry()
  registry.register({
    name: 'noop',
    summary: 'Test command',
    usage: 'hyp noop',
    async run() { return 0 },
  })
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['noop'], {
    stdout,
    stderr,
    registry,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.match(
    stderr.text(),
    /warning: sink 'local' not materialized \[sink_plugin_not_active\]/
  )
})

test('attach accepts a positional client name', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['attach', 'codex', '--dry-run'], {
    stdout,
    stderr,
    registry,
    kernel,
    env: { ...process.env, HYP_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-attach-')) },
  })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.deepEqual(calls, [
    { action: 'attach', client: 'codex', dryRun: true, json: false },
  ])
})

test('unattach alias routes a positional client through the core disk undo', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const stdout = makeBuf()
  const stderr = makeBuf()
  // Isolate HOME/CODEX_HOME so the disk-driven detach targets a temp tree
  // (no marker present → a clean no-op) rather than the developer's files.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-unattach-'))

  const code = await dispatch(['unattach', 'claude', '--json'], {
    stdout,
    stderr,
    registry,
    kernel,
    env: { ...process.env, HOME: home, CODEX_HOME: home, HYP_HOME: home },
  })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  // Detach no longer dispatches to a per-adapter hook — it is the single
  // core disk-driven undo (LLP 0045 §Part 3), so the fake client's
  // detach() is never called.
  assert.deepEqual(calls, [])
  const out = JSON.parse(stdout.text().trim())
  assert.equal(out.action, 'detach')
  assert.equal(out.client, 'claude')
})

test('attach rejects conflicting positional and flag client names', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['attach', 'codex', '--client', 'claude'], {
    stdout,
    stderr,
    registry,
    kernel,
    env: { ...process.env, HYP_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-attach-conflict-')) },
  })

  assert.equal(code, 2)
  assert.equal(stdout.text(), '')
  assert.match(stderr.text(), /client specified multiple times \(codex, claude\)/)
  assert.deepEqual(calls, [])
})

function fakeClientKernel() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  /** @type {Array<{ action: 'attach'|'detach', client: string, dryRun: boolean, json: boolean }>} */
  const calls = []
  const clients = new Map(
    ['claude', 'codex'].map((name) => [
      name,
      {
        name,
        defaultUpstream: name === 'claude' ? 'anthropic' : 'openai',
        async attach(ctx) {
          calls.push({
            action: 'attach',
            client: name,
            dryRun: ctx.dryRun === true,
            json: ctx.json === true,
          })
        },
        async detach(ctx) {
          calls.push({
            action: 'detach',
            client: name,
            dryRun: ctx.dryRun === true,
            json: ctx.json === true,
          })
        },
      },
    ])
  )

  // Fake an `hypaware.ai-gateway@2.0.0` surface — that's the range
  // the CLI dispatcher requires after the phase-1 capability bump,
  // and the test's `dispatch(['attach', ...])` call resolves against
  // it before it ever reaches the client hooks above.
  kernel.capabilities.provide('test', 'hypaware.ai-gateway', '2.0.0', {
    registerUpstreamPreset() {},
    registerClient() {},
    registerExchangeProjector() {},
    localEndpoint() {
      return 'http://127.0.0.1:4388'
    },
    getClient(name) {
      return clients.get(name)
    },
    listClients() {
      return Array.from(clients.values())
    },
  })

  return { registry, kernel, calls }
}

function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * @param {unknown} value
 * @returns {NodeJS.ReadStream}
 */
function stdinFor(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return /** @type {NodeJS.ReadStream} */ (Readable.from([body]))
}
