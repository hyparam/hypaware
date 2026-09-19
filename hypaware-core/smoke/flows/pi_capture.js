// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import extension from '../../../packages/pi-extension/index.js'
import { Attr, getLogger, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { buildPluginCatalog } from '../../../src/core/plugin_catalog.js'
import { detachClientFromDisk } from '../../../src/core/config/client_detach_disk.js'

/** @param {{ harness: any, expect: any }} args */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const log = getLogger('smoke')
  const prior = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR, HYP_PI_ENDPOINT: process.env.HYP_PI_ENDPOINT }
  process.env.PI_CODING_AGENT_DIR = path.join(harness.tmpDir, 'pi')
  const sessionsDir = path.join(harness.tmpDir, 'sessions')
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(harness.stateDir, 'cache') })
  const raw = JSON.parse(await fs.readFile(new URL('../fixtures/pi-session.json', import.meta.url), 'utf8'))
  raw.session.cwd = path.join(harness.tmpDir, 'project')
  raw.session.id = harness.devRunId
  /** @param {string} name @param {() => Promise<any>} fn */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, { [Attr.DEV_RUN_ID]: harness.devRunId, [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: name }, fn)
  /** @param {string[]} args */
  async function cli(args) {
    let output = ''
    let error = ''
    const code = await dispatch(args, { kernel, registry, env: process.env, stdout: { write(v) { output += v; return true } }, stderr: { write(v) { error += v; return true } } })
    expect.that(`CLI ${args[0]} succeeds`, { code, error }, v => v.code === 0 && !v.error)
    return JSON.parse(output)
  }
  try {
    const loaded = await step('activate', async () => {
      await fs.mkdir(raw.session.cwd, { recursive: true })
      await fs.mkdir(sessionsDir, { recursive: true })
      const loaded = await loadManifests([path.resolve(import.meta.dirname, '../../plugins-workspace/pi')])
      const activated = await activatePlugins({ plugins: loaded.loaded.map(p => ({ manifest: p.manifest, rootDir: p.rootDir, config: { listen_port: 0 } })), stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot: harness.tmpDir })
      expect.that('Pi activated', activated.results, r => r.length === 1 && r.every(p => p.ok))
      expect.that('No proxy required', kernel.capabilities.has('hypaware.ai-gateway'), v => !v)
      return loaded
    })
    const ctx = kernel.activationContexts.get('@hypaware/pi')
    if (!ctx) throw new Error('Pi context missing')
    await step('attach', async () => {
      await kernel.sources.start('pi', ctx)
      const status = await kernel.sources.started('pi')?.status?.()
      const port = Number(status?.details?.listen_port)
      ctx.config.listen_port = port
      process.env.HYP_PI_ENDPOINT = `http://127.0.0.1:${port}`
      const client = kernel.clients.getClient('pi')
      if (!client) throw new Error('Pi client missing')
      let output = ''
      await client.attach({ config: {}, json: true, stdout: { write(v) { output += v; return true } }, stderr: { write() { return true } } })
      const attached = JSON.parse(output)
      expect.that('managed extension installed', attached.status, v => v === 'ok')
    })
    await step('live', async () => {
      const hooks = new Map()
      extension({ on(name, fn) { hooks.set(name, fn) }, registerCommand() {} })
      let entries = []
      const context = { mode: 'print', sessionManager: { getSessionFile: () => '/fixture.jsonl', getHeader: () => raw.session, getLeafId: () => entries.at(-1)?.id ?? null, getEntry: id => entries.find(e => e.id === id) } }
      hooks.get('session_start')({}, context)
      entries = raw.entries
      hooks.get('turn_end')({}, context)
      await hooks.get('session_shutdown')({}, context)
      const rows = await cli(['query', 'sql', `select * from ai_gateway_messages where session_id = '${harness.devRunId}'`, '--refresh', 'always', '--format', 'json'])
      expect.that('live package writes all five parts', rows.length, v => v === 5)
      expect.that('tool link present', rows, r => r.some(row => row.tool_name === 'read' && row.tool_call_id === 'call-1'))
    })
    await step('recover', async () => {
      await fs.writeFile(path.join(sessionsDir, 'session.jsonl'), [raw.session, ...raw.entries].map(e => JSON.stringify(e)).join('\n') + '\n')
      for (let i = 0; i < 2; i++) await cli(['backfill', 'pi', '--since', '2000-01-01T00:00:00Z', '--json'])
      const rows = await cli(['query', 'sql', `select * from ai_gateway_messages where session_id = '${harness.devRunId}'`, '--refresh', 'always', '--format', 'json'])
      expect.that('recovery converges without duplicates', rows.length, v => v === 5)
      const usages = rows.map(r => typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes).map(a => a?.usage).filter(Boolean)
      expect.that('usage counted once', usages.reduce((n, u) => n + u.total_tokens, 0), v => v === 23)
    })
    await step('privacy', async () => {
      await fs.writeFile(path.join(raw.session.cwd, '.hypignore'), 'ignore\n')
      const response = await fetch(`${process.env.HYP_PI_ENDPOINT}/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...raw, session: { ...raw.session, id: 'ignored' } }) })
      expect.that('ignored directory dropped', response.status, v => v === 202)
      log.info('pi.smoke.privacy', { [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok' })
    })
    await step('detach', async () => {
      const descriptor = buildPluginCatalog(loaded.loaded).clientDescriptors.get('pi')
      if (!descriptor) throw new Error('Pi descriptor missing')
      const detached = await detachClientFromDisk({ descriptor, homeDir: harness.tmpDir, env: process.env })
      expect.that('managed extension removed', detached.changed, v => v === true)
      await kernel.sources.stop('pi')
    })
    await obs.shutdown()
    const logs = await expect.logs()
    expect.that('capture signal emitted', logs, values => values.some(e => e.body === 'pi.entries.recorded' && Number(e.attributes?.rows_written) === 5))
    expect.that('recovery signal emitted', logs, values => values.some(e => e.body === 'pi.backfill.scan'))
    const traces = await expect.traces()
    expect.that('run-specific steps traced', traces.filter(t => String(t.name).startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId).length, v => v === 6)
  } finally {
    await kernel.sources.stop('pi').catch(() => {})
    await obs.shutdown().catch(() => {})
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}
