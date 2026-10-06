// @ts-check

/**
 * `hyp client detach X` stops recording X with the daemon running, and
 * `hyp client attach X` resumes it (LLP 0466).
 *
 * Each test boots a "daemon" view of the config (the copy the sweep was
 * started with, which never learns about the detach), then runs the real
 * `hyp client detach` command against the local config, then drives the real
 * provider through the kernel's sweep runner. The detach is visible only on
 * disk, which is the point: the runner must read the switch fresh.
 *
 * @ref LLP 0466#runner-gate [tests]
 * @ref LLP 0466#fresh-read [tests]
 *
 * @import { BackfillContribution, CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import { createCodexBackfillProvider } from '../../hypaware-core/plugins-workspace/codex/src/backfill.js'
import { createCursorBackfillProvider } from '../../hypaware-core/plugins-workspace/cursor/src/recovery.js'
import { cursorNativeFixture } from '../../hypaware-core/smoke/lib/cursor_native_fixture.js'
import { runBackfillProvider } from '../../src/core/commands/backfill.js'
import { runAttach, runDetach } from '../../src/core/commands/clients.js'
import { createBackfillMaterializerRegistry, createBackfillRegistry } from '../../src/core/registry/backfills.js'

const PLUGINS = ['@hypaware/ai-gateway', '@hypaware/claude', '@hypaware/claude-desktop', '@hypaware/codex', '@hypaware/cursor']

async function stage() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'detach-stops-recording-'))
  const hypHome = path.join(root, '.hypaware')
  await fsp.mkdir(hypHome, { recursive: true })
  const config = { version: 2, plugins: PLUGINS.map((name) => ({ name })) }
  await fsp.writeFile(path.join(hypHome, 'hypaware-config.json'), JSON.stringify(config, null, 2) + '\n')
  const env = { HOME: root, HYP_HOME: hypHome }
  return {
    root,
    env,
    /** The config the daemon booted on; a later detach never reaches it. */
    bootConfig: /** @type {any} */ (structuredClone(config)),
    readLocal: async () => JSON.parse(await fsp.readFile(path.join(hypHome, 'hypaware-config.json'), 'utf8')),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

/**
 * @param {{ env: Record<string, string> }} s
 * @param {Record<string, unknown>} [extra]
 */
function cliCtx(s, extra = {}) {
  let out = ''
  let err = ''
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: s.env,
    config: {},
    plugins: [],
    stdout: { write: (/** @type {string} */ chunk) => { out += chunk; return true } },
    stderr: { write: (/** @type {string} */ chunk) => { err += chunk; return true } },
    capabilities: { has: () => false },
    ...extra,
  }))
  return { ctx, out: () => out, err: () => err }
}

/**
 * A client registry whose adapters write nothing, so `hyp client attach`
 * reaches its success exit without a gateway.
 */
function stubClients() {
  return {
    /** @param {string} name */
    getClient: (name) => ({ name, requiresEndpoint: false, attach: async () => {} }),
    listClients: () => [],
  }
}

/**
 * The sweep path: the real runner, the real gateway materializer, a storage
 * that records what was appended, and the boot-time config.
 *
 * @param {{ env: Record<string, string>, root: string, bootConfig: any }} s
 * @param {BackfillContribution} provider
 */
function stageSweep(s, provider) {
  const backfills = createBackfillRegistry()
  backfills.register(provider)
  const materializers = createBackfillMaterializerRegistry()
  materializers.register(aiGatewayBackfillMaterializer())
  /** @type {Record<string, unknown>[]} */
  const appended = []
  const storage = {
    cacheRoot: path.join(s.root, 'cache'),
    /** @param {string} dataset @param {string[]} segs */
    cacheTablePath: (dataset, segs) => path.join(s.root, 'cache', dataset, ...segs),
    /** @param {string} _tablePath @param {unknown} _columns @param {Record<string, unknown>[]} rows */
    async appendRows(_tablePath, _columns, rows) { appended.push(...rows) },
    async flushTable() {},
  }
  const query = {
    /** @param {string} name */
    getDataset(name) {
      return name === 'ai_gateway_messages' ? { name, plugin: '@hypaware/ai-gateway', schema: { columns: [] } } : undefined
    },
    registerDataset() {},
    listDatasets() { return [] },
  }
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: s.env,
    config: s.bootConfig,
    stdout: { write: () => true },
    stderr: { write: () => true },
    backfills,
    backfillMaterializers: materializers,
    query,
    storage,
  }))
  return {
    /** One scheduled sweep run; returns the session ids it recorded. */
    async tick() {
      appended.length = 0
      const result = await runBackfillProvider({ ctx, provider: provider.name, dryRun: false, sweep: true })
      assert.equal(result.ok, true)
      return [...new Set(appended.map((row) => String(row.session_id)))].sort()
    },
  }
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {string} entrypoint
 */
async function writeClaudeTranscript(root, sessionId, entrypoint) {
  const dir = path.join(root, '.claude', 'projects', 'repo-a')
  await fsp.mkdir(dir, { recursive: true })
  const rows = [
    { sessionId, uuid: `${sessionId}-u`, parentUuid: null, type: 'user', entrypoint, cwd: '/work/a', message: { role: 'user', content: 'hello' }, timestamp: new Date(Date.now() - 60000).toISOString() },
    { sessionId, uuid: `${sessionId}-a`, parentUuid: `${sessionId}-u`, type: 'assistant', entrypoint, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, timestamp: new Date(Date.now() - 55000).toISOString() },
  ]
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

/**
 * @param {string} root
 * @param {string} sessionId
 */
async function writeCodexRollout(root, sessionId) {
  const day = new Date()
  const rel = path.join(String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
  const dir = path.join(root, '.codex', 'sessions', rel)
  await fsp.mkdir(dir, { recursive: true })
  const at = new Date(Date.now() - 60000).toISOString()
  const lines = [
    { type: 'session_meta', timestamp: at, payload: { id: sessionId, timestamp: at, cwd: '/work/repo', originator: 'codex_cli_rs', cli_version: '0.133.0' } },
    { type: 'turn_context', timestamp: at, payload: { turn_id: 't-1', cwd: '/work/repo', model: 'gpt-5.5' } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
  ]
  await fsp.writeFile(path.join(dir, `rollout-${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

test('Claude Code: a session after detach does not reach the cache; attach resumes', async () => {
  const s = await stage()
  try {
    const sweep = stageSweep(s, createClaudeBackfillProvider({ homeDir: s.root, stateFile: path.join(s.root, 'ctx.jsonl') }))
    await writeClaudeTranscript(s.root, 'before', 'cli')
    assert.deepEqual(await sweep.tick(), ['before'])

    const cli = cliCtx(s)
    assert.equal(await runDetach(['claude'], cli.ctx), 0, cli.err())
    assert.match(cli.out(), /HypAware stopped recording claude/)
    assert.match(cli.out(), /hyp privacy purge/)
    assert.equal((await s.readLocal()).plugins.find((/** @type {any} */ p) => p.name === '@hypaware/claude').recording, false)

    // A new Code session, and one with no entrypoint (unclaimed sessions
    // fall to the scanning client, which is detached).
    await writeClaudeTranscript(s.root, 'during', 'cli')
    await writeClaudeTranscript(s.root, 'unclaimed', '')
    assert.deepEqual(await sweep.tick(), [])

    const again = cliCtx(s, { clients: stubClients() })
    assert.equal(await runAttach(['claude'], again.ctx), 0, again.err())
    assert.match(again.out(), /recording claude again/)
    assert.equal((await s.readLocal()).plugins.find((/** @type {any} */ p) => p.name === '@hypaware/claude').recording, undefined)
    await writeClaudeTranscript(s.root, 'after', 'cli')
    assert.ok((await sweep.tick()).includes('after'))
  } finally {
    await s.cleanup()
  }
})

test('Claude Desktop: detach stops its sessions in the shared tree, Claude Code keeps recording', async () => {
  const s = await stage()
  try {
    const sweep = stageSweep(s, createClaudeBackfillProvider({ homeDir: s.root, stateFile: path.join(s.root, 'ctx.jsonl') }))
    const cli = cliCtx(s)
    assert.equal(await runDetach(['claude-desktop'], cli.ctx), 0, cli.err())
    assert.match(cli.out(), /HypAware stopped recording claude-desktop/)

    await writeClaudeTranscript(s.root, 'desktop-during', 'claude-desktop')
    await writeClaudeTranscript(s.root, 'code-during', 'cli')
    assert.deepEqual(await sweep.tick(), ['code-during'])

    // Desktop has no settings to write: attach is the switch alone.
    const again = cliCtx(s)
    assert.equal(await runAttach(['claude-desktop'], again.ctx), 0, again.err())
    await writeClaudeTranscript(s.root, 'desktop-after', 'claude-desktop')
    assert.ok((await sweep.tick()).includes('desktop-after'))
  } finally {
    await s.cleanup()
  }
})

test('Claude Code detached while Claude Desktop records: Desktop keeps its lane', async () => {
  const s = await stage()
  try {
    const sweep = stageSweep(s, createClaudeBackfillProvider({ homeDir: s.root, stateFile: path.join(s.root, 'ctx.jsonl') }))
    assert.equal(await runDetach(['claude'], cliCtx(s).ctx), 0)
    await writeClaudeTranscript(s.root, 'desktop-during', 'claude-desktop')
    await writeClaudeTranscript(s.root, 'code-during', 'cli')
    assert.deepEqual(await sweep.tick(), ['desktop-during'])
  } finally {
    await s.cleanup()
  }
})

test('Codex: a rollout after detach does not reach the cache; attach resumes', async () => {
  const s = await stage()
  try {
    const sweep = stageSweep(s, createCodexBackfillProvider({ homeDir: s.root }))
    await writeCodexRollout(s.root, 'before')
    assert.deepEqual(await sweep.tick(), ['before'])

    const cli = cliCtx(s)
    assert.equal(await runDetach(['codex'], cli.ctx), 0, cli.err())
    assert.match(cli.out(), /HypAware stopped recording codex/)
    await writeCodexRollout(s.root, 'during')
    assert.deepEqual(await sweep.tick(), [])

    const again = cliCtx(s, { clients: stubClients() })
    assert.equal(await runAttach(['codex'], again.ctx), 0, again.err())
    await writeCodexRollout(s.root, 'after')
    assert.ok((await sweep.tick()).includes('after'))
  } finally {
    await s.cleanup()
  }
})

test('Cursor: a session after detach does not reach the cache; attach resumes', async () => {
  const s = await stage()
  const cwd = path.join(s.root, 'workspace')
  await fsp.mkdir(cwd)
  await fsp.writeFile(path.join(cwd, 'notes.txt'), 'notes\n')
  const f = await cursorNativeFixture(path.join(s.root, 'native'), cwd, 'cli')
  try {
    const provider = createCursorBackfillProvider({ editorDb: path.join(s.root, 'absent'), cliRoot: path.join(s.root, 'native') })
    const sweep = stageSweep(s, provider)

    const cli = cliCtx(s)
    assert.equal(await runDetach(['cursor'], cli.ctx), 0, cli.err())
    assert.match(cli.out(), /HypAware stopped recording cursor/)
    assert.deepEqual(await sweep.tick(), [])

    const again = cliCtx(s, { clients: stubClients() })
    assert.equal(await runAttach(['cursor'], again.ctx), 0, again.err())
    assert.deepEqual(await sweep.tick(), [f.session.id])
  } finally {
    f.close()
    await s.cleanup()
  }
})

test('detach refuses whole when the org config requires the client', async () => {
  const s = await stage()
  try {
    const controlDir = path.join(s.env.HYP_HOME, 'hypaware', 'config-control')
    await fsp.mkdir(controlDir, { recursive: true })
    await fsp.writeFile(path.join(controlDir, 'seed.json'), JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex' }] }))
    const before = await s.readLocal()
    const cli = cliCtx(s)
    assert.equal(await runDetach(['codex'], cli.ctx), 1)
    assert.match(cli.err(), /organization's HypAware policy requires codex/)
    assert.deepEqual(await s.readLocal(), before)
  } finally {
    await s.cleanup()
  }
})

test('a refused detach skips --purge and keeps the local CA', async () => {
  const s = await stage()
  // Never let a regression reach the macOS keychain or launchd from a test.
  const platform = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(process, 'platform'))
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    const controlDir = path.join(s.env.HYP_HOME, 'hypaware', 'config-control')
    await fsp.mkdir(controlDir, { recursive: true })
    await fsp.writeFile(path.join(controlDir, 'seed.json'), JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex' }] }))
    const caKey = path.join(s.env.HYP_HOME, 'hypaware', 'tls', 'ca-key.pem')
    await fsp.mkdir(path.dirname(caKey), { recursive: true })
    await fsp.writeFile(caKey, 'key')
    const cli = cliCtx(s)
    assert.equal(await runDetach(['codex', '--purge'], cli.ctx), 1)
    assert.match(cli.err(), /Skipped --purge/)
    assert.equal(await fsp.readFile(caKey, 'utf8'), 'key')
  } finally {
    Object.defineProperty(process, 'platform', platform)
    await s.cleanup()
  }
})

test('attach all resumes Claude Desktop, which registers no adapter', async () => {
  const s = await stage()
  try {
    assert.equal(await runDetach(['claude-desktop'], cliCtx(s).ctx), 0)
    const clients = {
      /** @param {string} name */
      getClient: (name) => (name === 'codex' ? { name, requiresEndpoint: false, attach: async () => {} } : undefined),
      listClients: () => [{ name: 'codex' }],
    }
    const cli = cliCtx(s, { clients })
    assert.equal(await runAttach(['all'], cli.ctx), 0, cli.err())
    assert.match(cli.out(), /recording claude-desktop again/)
    const entry = (await s.readLocal()).plugins.find((/** @type {any} */ p) => p.name === '@hypaware/claude-desktop')
    assert.equal(entry.recording, undefined)
  } finally {
    await s.cleanup()
  }
})

test('attach fails when the org config turns recording off', async () => {
  const s = await stage()
  try {
    const controlDir = path.join(s.env.HYP_HOME, 'hypaware', 'config-control')
    await fsp.mkdir(controlDir, { recursive: true })
    await fsp.writeFile(path.join(controlDir, 'seed.json'), JSON.stringify({
      version: 2, plugins: [{ name: '@hypaware/claude-desktop', recording: false }],
    }))
    const cli = cliCtx(s, { clients: { getClient: () => undefined, listClients: () => [] } })
    assert.equal(await runAttach(['claude-desktop', '--json'], cli.ctx), 1)
    const payload = JSON.parse(cli.out())
    assert.equal(payload.status, 'failed')
    assert.equal(payload.error_kind, 'central_managed')
  } finally {
    await s.cleanup()
  }
})
