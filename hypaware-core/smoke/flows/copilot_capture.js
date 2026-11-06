// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { runBackfillProvider } from '../../../src/core/commands/backfill.js'
import { copilotFixture } from '../fixtures/copilot.js'

/** @param {{ harness: any, expect: any }} args */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const root = path.join(harness.tmpDir, 'Code')
  const config = { version: /** @type {2} */ (2), plugins: [{ name: '@hypaware/copilot', config: { user_data_dirs: [root] } }] }
  process.env.HYP_CONFIG = path.join(harness.hypHome, 'hypaware-config.json')
  await fs.writeFile(process.env.HYP_CONFIG, JSON.stringify(config))
  const fixtures = []
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(harness.stateDir, 'cache') })
  /** @param {string} name @param {() => Promise<any>} fn */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, { [Attr.DEV_RUN_ID]: harness.devRunId, [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: name }, fn)
  /** @param {string[]} args */
  async function cli(args) {
    let output = ''
    let error = ''
    const code = await dispatch(args, { kernel, registry, env: process.env, stdout: { write(v) {
      output += v
      return true
    } }, stderr: { write(v) {
      error += v
      return true
    } } })
    expect.that(`CLI ${args[0]} succeeds`, { code, error }, v => v.code === 0 && !v.error)
    return JSON.parse(output)
  }
  const runner = { env: process.env, config, storage: kernel.storage, query: kernel.query, backfills: kernel.backfills, backfillMaterializers: kernel.backfillMaterializers }
  /** @param {boolean} [sweep] */
  const recover = (sweep = true) => runBackfillProvider({ ctx: runner, provider: 'copilot', dryRun: false, sweep, devRunId: harness.devRunId })
  try {
    await step('activate_attach', async () => {
      for (const harnessName of ['local', 'agent-host']) fixtures.push(await copilotFixture({ root, cwd: path.join(harness.tmpDir, harnessName), id: 'session-' + harnessName, harness: harnessName, copilotHome: process.env.COPILOT_HOME ?? path.join(process.env.HOME ?? path.join(harness.tmpDir, 'home'), '.copilot') }))
      for (const [index, fixture] of fixtures.entries()) {
        const insert = fixture.db.prepare('INSERT OR REPLACE INTO span_attributes VALUES (?, ?, ?)')
        insert.run('chat-0', 'gen_ai.system_instructions', JSON.stringify([{ type: 'text', content: 'Fixture system instruction' }]))
        insert.run('chat-0', 'gen_ai.tool.definitions', JSON.stringify([{ type: 'function', name: 'read_file', parameters: { type: 'object' } }]))
        if (index === 0) insert.run('chat-0', 'copilot_chat.reasoning_content', 'Fixture visible reasoning')
        else {
          const row = fixture.db.prepare('SELECT value FROM span_attributes WHERE span_id = ? AND key = ?').get('chat-0', 'gen_ai.output.messages')
          const output = JSON.parse(String(row.value))
          output[0].parts.unshift({ type: 'reasoning', content: 'Fixture visible reasoning' })
          insert.run('chat-0', 'gen_ai.output.messages', JSON.stringify(output))
        }
      }
      const loaded = await loadManifests([path.resolve(import.meta.dirname, '../../plugins-workspace/copilot')])
      const activated = await activatePlugins({ plugins: loaded.loaded.map(p => ({ manifest: p.manifest, rootDir: p.rootDir, config: config.plugins[0].config })), stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot: harness.tmpDir })
      expect.that('Copilot activates without a proxy', activated.results, values => values.length === 1 && values.every(v => v.ok))
      const ctx = kernel.activationContexts.get('@hypaware/copilot')
      if (!ctx) throw new Error('Copilot activation missing')
      await kernel.sources.start('copilot', ctx)
      await cli(['client', 'attach', 'copilot', '--json'])
      expect.that('No gateway listener required', kernel.capabilities.has('hypaware.ai-gateway'), value => !value)
    })
    await step('source_query', async () => {
      const imported = await recover()
      expect.that('Both harnesses import terminal content', imported, value => value.ok && value.rowsWritten === 16)
      const rows = await cli(['query', 'sql', 'select * from ai_gateway_messages', '--refresh', 'always', '--format', 'json', '--max-bytes', '0'])
      expect.that('Repeated identical submissions survive', rows.filter(r => r.role === 'user').length, value => value === 4)
      expect.that('Tool arguments and results survive', rows, values => values.filter(r => r.tool_call_id === 'call-1').length === 4 && values.filter(r => r.part_type === 'tool_result' && r.content_text === 'fixture contents').length === 2)
      const usages = rows.map(r => typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes).map(a => a?.usage).filter(Boolean)
      expect.that('One-carrier net usage', usages, values => values.length === 4 && values.reduce((n, u) => n + u.input_tokens, 0) === 60 && values.reduce((n, u) => n + u.output_tokens, 0) === 12)
      expect.that('System context and visible reasoning survive', rows, values => values.filter(r => r.role === 'system' && r.content_text === 'Fixture system instruction').length === 2 && values.filter(r => r.part_type === 'reasoning' && r.content_text === 'Fixture visible reasoning').length === 2)
      expect.that('Both harnesses attributable', new Set(rows.map(r => r.entrypoint)).size, value => value === 2)
      expect.that('Completed-span status available', await kernel.sources.started('copilot')?.status?.(), value => value?.state === 'ready' && value.details?.read === 10)
    })
    await step('replay_late_parent', async () => {
      expect.that('Unchanged sweep avoids materialization', await recover(), value => value.rowsWritten === 0 && value.scanned === 0)
      expect.that('Manual replay idempotent', await recover(false), value => value.rowsWritten === 0)
      fixtures[0].insert({ span_id: 'late-parent', operation_name: 'invoke_agent', start_time_ms: Date.now() - 100000, end_time_ms: Date.now() }, { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'late completion' }] }] })
      expect.that('Old parent completes late', await recover(), value => value.rowsWritten === 1)
    })
    await step('source_export', async () => {
      await fs.writeFile(path.join(harness.tmpDir, 'agent-host', '.hypignore'), 'local-only\n')
      const forwarded = []
      let dropped = 0
      for (const partition of await kernel.storage.discoverCachePartitions()) {
        for await (const entry of kernel.storage.readRowsSince(partition.path, {})) {
          if (entry.dropped) dropped++
          else forwarded.push(entry.row)
        }
      }
      expect.that('Local-only content withheld from shared export seam', { forwarded, dropped }, value => value.forwarded.length === 9 && value.dropped === 8 && value.forwarded.every(r => r.entrypoint === 'vscode_copilot_local'))
      const local = await cli(['query', 'sql', 'select count(*) as n from ai_gateway_messages', '--include-local-only', '--refresh', 'always', '--format', 'json'])
      expect.that('Local-only remains locally queryable', Number(local[0].n), value => value === 17)
    })
    await step('privacy_detach', async () => {
      await cli(['session', 'ignore', 'session-local', '--json'])
      fixtures[0].insert({ span_id: 'excluded', operation_name: 'invoke_agent' }, { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'excluded content' }] }] })
      expect.that('Session ignore blocks source write', await recover(), value => value.rowsWritten === 0)
      await cli(['client', 'detach', 'copilot', '--json'])
      fixtures[1].insert({ span_id: 'detached', operation_name: 'invoke_agent' }, { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'detached content' }] }] })
      expect.that('Detach blocks recovery', await recover(false), value => value.rowsWritten === 0)
      await kernel.sources.stop('copilot')
    })
    await obs.shutdown()
    const logs = await expect.logs()
    expect.that('Run-specific selection/read/policy counts emitted', logs, values => values.some(e => e.body === 'copilot.recovery.scan' && e.attributes?.read === 10 && e.attributes?.stores === 2) && values.some(e => e.body === 'copilot.recovery.scan' && e.attributes?.unchanged === 10))
    expect.that('Diagnostics contain no synthetic message/tool content', logs.filter(e => String(e.body).startsWith('copilot.')), values => !JSON.stringify(values).includes('Repeat this prompt') && !JSON.stringify(values).includes('fixture contents'))
    const traces = await expect.traces()
    expect.that('Run-specific smoke steps traced', traces.filter(t => String(t.name).startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId).length, value => value === 5)
  } finally {
    await kernel.sources.stop('copilot').catch(() => {})
    for (const fixture of fixtures) fixture.close()
    await obs.shutdown().catch(() => {})
  }
}
