// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { getLogger, installObservability, runRoot, Attr } from '../../../src/core/observability/index.js'
import { createAutomaticCodexProviderRepair, runCodexRepair } from '../../plugins-workspace/codex/src/provider_repair.js'
import { createCodexBackfillProvider } from '../../plugins-workspace/codex/src/backfill.js'

/**
 * Hermetic command workflow. Native config parsing and inference are verified
 * separately by scripts/check-codex-saved-provider.js with real binaries.
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const home = await fs.realpath(harness.tmpDir)
  const codexHome = path.join(home, 'codex')
  const directory = path.join(codexHome, 'sessions', '2026')
  await fs.mkdir(directory, { recursive: true })
  const id = randomUUID()
  const file = path.join(directory, `rollout-fixture-${id}.jsonl`)
  const config = '# Synthetic smoke config\n'
  await fs.writeFile(path.join(codexHome, 'config.toml'), config)
  const original = [
    { type: 'session_meta', payload: { id, model_provider: 'hypaware', cwd: home } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic smoke history' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  await fs.writeFile(file, original)
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, title TEXT)')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, file, 'hypaware', 'Synthetic title')
  const deps = {
    assertStopped: async () => {},
    readConfig: async () => ({ sqliteHome: codexHome, configHash: createHash('sha256').update(await fs.readFile(path.join(codexHome, 'config.toml'))).digest('hex') }),
  }
  const command = async (step, args) => runRoot('smoke.step.' + step, {
    [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: step, [Attr.DEV_RUN_ID]: harness.devRunId,
    component: 'smoke', operation: 'codex.repair', status: 'ok',
  }, async () => {
    let stdout = ''
    let stderr = ''
    const code = await runCodexRepair([...args, '--json'], /** @type {any} */ ({
      env: { ...process.env, CODEX_HOME: codexHome }, cwd: home,
      stdout: { write: value => { stdout += value } }, stderr: { write: value => { stderr += value } },
    }), deps)
    expect.that(`${step}: exit 0`, code, value => value === 0)
    expect.that(`${step}: stderr empty`, stderr, value => value === '')
    return JSON.parse(stdout)
  })
  try {
    const preview = await command('preview', ['--dry-run'])
    expect.that('preview: one affected thread', preview, value => value.dry_run && value.repaired_threads === 1)
    expect.that('preview: history untouched', await fs.readFile(file, 'utf8'), value => value === original)
    const result = await command('repair', [])
    expect.that('repair: native metadata updated', db.prepare('SELECT model_provider FROM threads WHERE id = ?').get(id)?.model_provider, value => value === 'openai')
    expect.that('repair: title retained', db.prepare('SELECT title FROM threads WHERE id = ?').get(id)?.title, value => value === 'Synthetic title')
    expect.that('repair: backup retained', await fs.readFile(path.join(result.backup_path, '0.rollout'), 'utf8'), value => value === original)
    expect.that('rerun: zero changed threads', await command('rerun', []), value => value.repaired_threads === 0)
    await command('restore', ['--restore', result.backup_path])
    expect.that('restore: exact history returned', await fs.readFile(file, 'utf8'), value => value === original)
    expect.that('restore: native metadata returned', db.prepare('SELECT model_provider FROM threads WHERE id = ?').get(id)?.model_provider, value => value === 'hypaware')
    let clientRunning = true
    const stateDir = path.join(home, 'plugin-state')
    const createProvider = () => createCodexBackfillProvider({
      homeDir: home, codexHome,
      repairSavedProviders: createAutomaticCodexProviderRepair({ codexHome, stateDir, env: {}, cwd: home }, {
        readConfig: deps.readConfig,
        assertStopped: async () => { if (clientRunning) throw Object.assign(new Error('Synthetic running client'), { code: 'CODEX_RUNNING' }) },
      }),
    })
    const sweep = async (step, provider) => runRoot('smoke.step.' + step, {
      [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: step, [Attr.DEV_RUN_ID]: harness.devRunId,
      component: 'smoke', operation: 'codex.upgrade', status: 'ok',
    }, async () => {
      for await (const item of provider.run({ sweep: true, dryRun: false, env: {}, cacheRoot: home,
        log: getLogger('smoke.codex-upgrade'), storage: /** @type {any} */ ({}),
      })) void item
    })
    const provider = createProvider()
    await sweep('upgrade_deferred', provider)
    expect.that('upgrade: running client preserves history', await fs.readFile(file, 'utf8'), value => value === original)
    clientRunning = false
    await sweep('upgrade_repaired', provider)
    const receipt = JSON.parse(await fs.readFile(path.join(stateDir, 'codex-provider-repair.json'), 'utf8'))
    expect.that('upgrade: completion persisted', receipt, value => value.status === 'complete' && value.repaired_threads === 1)
    expect.that('upgrade: native metadata updated', db.prepare('SELECT model_provider FROM threads WHERE id = ?').get(id)?.model_provider, value => value === 'openai')
    expect.that('upgrade: original history backed up', await fs.readFile(path.join(receipt.backup_path, '0.rollout'), 'utf8'), value => value === original)
    const backups = await fs.readdir(path.join(codexHome, 'hypaware-provider-repair'))
    await sweep('upgrade_restart', createProvider())
    expect.that('upgrade: restart creates no further backup', await fs.readdir(path.join(codexHome, 'hypaware-provider-repair')), value => JSON.stringify(value) === JSON.stringify(backups))
    await obs.shutdown()
    const traces = await expect.traces()
    const logs = await expect.logs()
    expect.that('telemetry: all command spans succeeded', traces.filter(row => row.name === 'codex.provider_repair'), rows => rows.length === 4 && rows.every(row => row.attributes.status === 'ok'))
    expect.that('telemetry: all steps carry the run identity', traces.filter(row => String(row.name).startsWith('smoke.step.')), rows => rows.length === 7 && rows.every(row => row.attributes[Attr.DEV_RUN_ID] === harness.devRunId))
    expect.that('telemetry: completion counts recorded', logs.filter(row => row.body === 'codex.provider_repair.complete'), rows => rows.length === 4 && rows.every(row => row.attributes.status === 'ok'))
    expect.that('telemetry: automatic upgrade lifecycle recorded', traces.filter(row => row.name === 'codex.provider_repair.automatic').map(row => `${row.attributes.status}:${row.attributes.reason}`).sort(), rows => JSON.stringify(rows) === JSON.stringify(['ok:complete', 'skipped:already_complete', 'skipped:client_running']))
    expect.that('telemetry: automatic deferral and completion logged', logs.filter(row => row.body === 'codex.provider_repair.automatic'), rows => rows.length === 2 && rows.some(row => row.attributes.status === 'skipped' && row.attributes.reason === 'client_running') && rows.some(row => row.attributes.status === 'ok' && row.attributes.affected_threads === 1))
  } finally {
    db.close()
    await obs.shutdown()
  }
}
