import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { detectPickerSources } from '../../src/core/cli/detect.js'
import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { createHypAwareCallback } from '../../hypaware-core/plugins-workspace/langgraph/src/recorder.js'
import { attachLangGraph, LANGGRAPH_MARKER } from '../../hypaware-core/plugins-workspace/langgraph/src/attach.js'
import { createPolicy } from '../../hypaware-core/plugins-workspace/langgraph/src/policy.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { publish, pendingSlots, readSlot, journalPath, encodeEvent, SLOT_COUNT } from '../../hypaware-core/plugins-workspace/langgraph/src/journal.js'
import { SessionProjection } from '../../hypaware-core/plugins-workspace/langgraph/src/projection.js'
import { validateLangGraphConfig } from '../../hypaware-core/plugins-workspace/langgraph/src/config.js'

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-langgraph-unit-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const env = { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_CONFIG: path.join(home, 'config.json') }
  await fs.writeFile(env.HYP_CONFIG, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/langgraph' }] }))
  return { home, env, stateDir: path.join(env.HYP_HOME, 'hypaware') }
}

test('LangGraph is visible in Customize, never detected, and explicitly composes without a gateway', async t => {
  const { env } = await fixture(t)
  const bundled = await discoverBundledPlugins()
  assert.ok(bundled.excluded.some(p => p.manifest.name === '@hypaware/langgraph'))
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  assert.ok(catalog.pickerDescriptors.has('langgraph'))
  assert.ok(catalog.clientDescriptors.get('langgraph')?.attachProbe)
  assert.equal((await detectPickerSources(catalog, env)).has('langgraph'), false)
  const config = composePickerConfig({ sources: ['langgraph'], descriptors: catalog.pickerDescriptors,
    exportChoice: 'keep-local', retentionDays: 30, hypHome: env.HYP_HOME })
  assert.deepEqual(config.plugins, [{ name: '@hypaware/langgraph' }])
})

test('attach is idempotent, dry-run leaves no file, and refuses foreign files', async t => {
  const { env } = await fixture(t)
  const preview = await attachLangGraph({ env, dryRun: true })
  await assert.rejects(fs.stat(preview.settingsPath), { code: 'ENOENT' })
  assert.equal((await attachLangGraph({ env })).changed, true)
  assert.equal((await attachLangGraph({ env })).changed, false)
  assert.ok((await fs.readFile(preview.settingsPath, 'utf8')).startsWith(LANGGRAPH_MARKER))
  const module = await import(pathToFileURL(preview.settingsPath).href)
  const recorder = module.createHypAwareCallback({ cwd: env.HOME, sessionId: 'custom-config' })
  await recorder.handleToolStart({ id: ['tool'] }, '{}', 'call', undefined, [], {}, 'tool', 'call')
  await recorder.handleToolEnd('done', 'call')
  assert.equal(recorder.status().queued, 1, 'managed import pins the custom installation policy path')
  await fs.writeFile(preview.settingsPath, 'foreign')
  await assert.rejects(attachLangGraph({ env }), /not HypAware-owned/)
})

test('privacy sees detach, session ignores, unreadable state and folder ignores immediately', async t => {
  const { env, home, stateDir } = await fixture(t)
  const policy = createPolicy(env, stateDir)
  assert.equal(policy.allows('s', home), true)
  const ignores = new SessionIgnoreSet(stateDir)
  ignores.add('s')
  assert.equal(policy.allows('s', home), false)
  ignores.delete('s')
  assert.equal(policy.allows('s', home), true)
  await fs.writeFile(path.join(home, '.hypignore'), 'ignore\n')
  assert.equal(policy.allows('s', home), false)
  await fs.writeFile(path.join(home, '.hypignore'), 'local-only\n')
  assert.equal(policy.allows('s', home), true)
  await fs.unlink(path.join(home, '.hypignore'))
  await fs.writeFile(env.HYP_CONFIG, JSON.stringify({ plugins: [{ name: '@hypaware/langgraph', recording: false }] }))
  assert.equal(policy.allows('s', home), false)
  await fs.writeFile(env.HYP_CONFIG, '{')
  assert.equal(policy.allows('s', home), false)
})

test('session ignores are seen even when the exclusion directory signature does not change', async t => {
  const { env, home, stateDir } = await fixture(t)
  const ignores = new SessionIgnoreSet(stateDir)
  ignores.add('other')
  const policy = createPolicy(env, stateDir)
  assert.equal(policy.allows('s', home), true)
  // Rapid atomic marker writes can leave ino, mtime and ctime unchanged.
  const frozen = fsSync.statSync(ignores.directory)
  const statSync = fsSync.statSync
  t.mock.method(fsSync, 'statSync', (file, ...rest) => file === ignores.directory ? frozen : statSync(file, ...rest))
  ignores.add('s')
  assert.equal(policy.allows('s', home), false)
  ignores.delete('s')
  assert.equal(policy.allows('s', home), true)
})

test('an unreadable folder fails closed instead of reading as having no .hypignore', async t => {
  if (process.getuid?.() === 0) return t.skip('root reads through directory permissions')
  const { env, home, stateDir } = await fixture(t)
  const locked = path.join(home, 'locked')
  await fs.mkdir(locked)
  await fs.writeFile(path.join(locked, '.hypignore'), 'ignore\n')
  const policy = createPolicy(env, stateDir)
  await fs.chmod(locked, 0o000)
  try {
    assert.equal(policy.allows('s', locked), false)
  } finally {
    await fs.chmod(locked, 0o700)
  }
  await fs.unlink(path.join(locked, '.hypignore'))
  assert.equal(policy.allows('s', locked), true)
})

test('journal bounds bytes and capacity across concurrent producers; published events survive a new reader', async t => {
  const { stateDir } = await fixture(t)
  const directory = journalPath(stateDir)
  const event = { version: 1, projection: { session_id: 's', cwd: '/example', messages: [] } }
  await Promise.all(Array.from({ length: 16 }, () => publish(directory, event)))
  const slots = await pendingSlots(directory)
  assert.equal(slots.length, 16)
  assert.deepEqual(await readSlot(directory, slots[0]), event.projection)
  for (let i = 0; i < SLOT_COUNT; i++) await fs.mkdir(path.join(directory, String(i).padStart(3, '0')), { recursive: true })
  await assert.rejects(publish(directory, event), /queue_full/)
  assert.throws(() => encodeEvent({ value: 'x'.repeat(512 * 1024) }), /event_limit/)
  const circular = {}; circular.self = circular
  assert.throws(() => encodeEvent(circular), /event_limit/)
})

test('checkpoint assistant history is not re-billed; distinct new responses keep distinct identities', () => {
  const project = new SessionProjection('s', { cwd: '/example' }, {})
  const old = { role: 'ai', id: 'old', content: 'old output', usage: { input_tokens: 50, output_tokens: 10 } }
  const start = project.modelStart([old, { role: 'human', id: 'h', content: 'next' }], {}, {}, 'one')
  assert.equal(start.projection.messages.length, 1)
  const a = project.modelEnd(start, [{ ...old, id: 'new' }])
  const b = project.modelEnd(project.modelStart([], {}, {}, 'two'), [{ ...old, id: 'new' }])
  assert.notEqual(a.messages.at(-1).message_id, b.messages[0].message_id)
})

test('callback failures never fail an agent, and active memory stays bounded', async t => {
  const { env, home } = await fixture(t)
  const callback = createHypAwareCallback({ env, cwd: home, sessionId: 's' })
  for (let i = 0; i < 65; i++) await callback.handleToolStart({ id: ['tool'] }, '{}', String(i), undefined, undefined, {}, 'tool', String(i))
  assert.equal(callback.status().active_callbacks, 64)
  assert.equal(callback.status().lastError, 'active_limit')
  await callback.handleToolEnd('x'.repeat(600 * 1024), '0')
  assert.equal(callback.status().lastError, 'event_limit')
  callback.handleChainStart({}, {}, 'root', undefined)
  await callback.handleChainEnd({}, 'root')
  assert.equal(callback.status().active_callbacks, 0)
})

test('config validates supported settings and rejects misspellings', () => {
  assert.equal(validateLangGraphConfig({ listen_port: 4323 }).ok, true)
  assert.equal(validateLangGraphConfig({ listen_port: 0 }).ok, false)
  assert.equal(validateLangGraphConfig({ unexpected: true }).ok, false)
})

test('root continuation retains ordering and model errors have a normal error row without usage', () => {
  const project = new SessionProjection('s', { cwd: '/example' }, {})
  const first = project.modelEnd(project.modelStart([{ role: 'human', id: 'h', content: 'hello' }], {}),
    [{ role: 'ai', content: 'reply' }])
  const last = first.messages.at(-1)
  project.resetRun()
  const state = project.modelStart([{ role: 'human', id: 'h', content: 'hello' },
    { role: 'human', id: 'h2', content: 'next' }], {})
  assert.equal(state.projection.messages.length, 1)
  assert.deepEqual(state.projection.messages[0].previous_message_id, [last.message_id])
  assert.ok(state.projection.messages[0].message_index > last.message_index)
  const failed = project.modelError(state).messages.at(-1)
  assert.equal(failed.content[0].type, 'error')
  assert.equal(failed.attributes?.usage, undefined)
})

test('stale staging never reclaims a live writer or an oversized unknown owner', async t => {
  const { stateDir } = await fixture(t)
  const directory = journalPath(stateDir)
  const slot = path.join(directory, '000')
  await fs.mkdir(slot, { recursive: true })
  await fs.writeFile(path.join(slot, 'owner'), String(process.pid))
  const old = new Date(Date.now() - 2 * 86400000)
  await fs.utimes(slot, old, old)
  assert.equal(await readSlot(directory, '000'), undefined)
  assert.ok((await fs.stat(slot)).isDirectory())
  await fs.writeFile(path.join(slot, 'owner'), '9'.repeat(4096))
  await fs.utimes(slot, old, old)
  assert.equal(await readSlot(directory, '000'), undefined)
  assert.ok((await fs.stat(slot)).isDirectory())
})

test('parallel models keep their own offered tools and model on correlated tool results', () => {
  const project = new SessionProjection('s', { cwd: '/example' }, {})
  const firstTools = [{ name: 'first-tool' }]
  const secondTools = [{ name: 'second-tool' }]
  const first = project.modelStart([], { ls_model_name: 'first', ls_provider: 'openai' }, { tools: firstTools }, 'first-run')
  const second = project.modelStart([], { ls_model_name: 'second', ls_provider: 'anthropic' }, { tools: secondTools }, 'second-run')
  project.modelEnd(first, [{ role: 'ai', tool_calls: [{ id: 'call-first', name: 'first-tool', args: {} }] }])
  project.modelEnd(second, [{ role: 'ai', tool_calls: [{ id: 'call-second', name: 'second-tool', args: {} }] }])
  const result = project.toolEnd({}, 'tool-run', 'call-first', 'first-tool', {}, 'done')
  assert.equal(result.model, 'first')
  assert.equal(result.provider, 'openai')
  assert.deepEqual(result.tools, firstTools)
})

test('tool correlation is bounded and an evicted call does not borrow another model', () => {
  const project = new SessionProjection('s', { cwd: '/example' }, {})
  for (let i = 0; i < 65; i++) {
    const state = project.modelStart([], { ls_model_name: `model-${i}` }, {}, `run-${i}`)
    project.modelEnd(state, [{ role: 'ai', tool_calls: [{ id: `call-${i}`, name: 'tool', args: {} }] }])
  }
  assert.equal(project.toolContexts.size, 64)
  const result = project.toolEnd({}, 'tool-run', 'call-0', 'tool', {}, 'done')
  assert.equal(result.model, undefined)
  assert.equal(result.messages.length, 1)
  project.resetRun()
  assert.equal(project.toolContexts.size, 0)
})

test('journal reads retain complete events when the filesystem returns short reads', async t => {
  const { stateDir } = await fixture(t)
  const directory = journalPath(stateDir)
  const event = { version: 1, projection: { session_id: 's', cwd: '/example', messages: [] } }
  await publish(directory, event)
  const [slot] = await pendingSlots(directory)
  const open = fs.open.bind(fs)
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args)
    const read = handle.read.bind(handle)
    t.mock.method(handle, 'read', (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 7), position))
    return handle
  })
  assert.deepEqual(await readSlot(directory, slot), event.projection)
})
