// @ts-check

/**
 * Shared harness for the crush poll source tests: per-project `crush.db`
 * files with the v0.99.0 schema, a `projects.json` index under a
 * `CRUSH_GLOBAL_DATA` dir, and a fake ctx that runs the REAL ai_gateway
 * materializer over a storage that keeps committed rows. Synthetic rows only.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../src/core/backfill/scan_util.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createCrushDb, tmpDir } from './crush_db_fixture.js'
import { createFakeStorage } from './goose_source_fixture.js'

/**
 * @param {{ projects: string[], config?: Record<string, unknown>,
 *   hooks?: Parameters<typeof createFakeStorage>[0] }} opts
 */
export async function createCrushHarness(opts) {
  const dir = await tmpDir()
  const globalDir = path.join(dir, 'global')
  await fs.mkdir(globalDir, { recursive: true })
  const indexPath = path.join(globalDir, 'projects.json')
  /** @type {string[]} */
  const projectDirs = []
  /** @type {string[]} */
  const dbPaths = []
  for (const name of opts.projects) {
    const projectDir = path.join(dir, name)
    projectDirs.push(projectDir)
    dbPaths.push(await createCrushDb(projectDir))
  }
  /** @param {string[]} dataDirs */
  const writeIndex = async (dataDirs) => {
    await fs.writeFile(indexPath, JSON.stringify({ projects: dataDirs.map(d => ({ data_dir: d })) }))
  }
  await writeIndex(projectDirs.map(p => path.join(p, '.crush')))

  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const logs = []
  const log = {
    debug(/** @type {string} */ message, /** @type {any} */ fields) { logs.push({ level: 'debug', message, fields }) },
    info(/** @type {string} */ message, /** @type {any} */ fields) { logs.push({ level: 'info', message, fields }) },
    warn(/** @type {string} */ message, /** @type {any} */ fields) { logs.push({ level: 'warn', message, fields }) },
    error(/** @type {string} */ message, /** @type {any} */ fields) { logs.push({ level: 'error', message, fields }) },
  }
  const fake = createFakeStorage(opts.hooks)
  const materializers = new Map([[PROJECTED_EXCHANGE_KIND, aiGatewayBackfillMaterializer()]])
  const ctx = /** @type {any} */ ({
    config: { ...opts.config },
    env: { HOME: dir, HYP_HOME: dir, CRUSH_GLOBAL_DATA: globalDir },
    paths: { rootDir: dir, stateDir: dir, cacheDir: dir, tempDir: dir },
    log,
    storage: fake.storage,
    query: {
      getDataset(/** @type {string} */ name) {
        if (name !== AI_GATEWAY_MESSAGES_DATASET) return undefined
        return { name, plugin: '@hypaware/ai-gateway', schema: { columns: AI_GATEWAY_MESSAGE_COLUMNS } }
      },
    },
    backfillMaterializers: { get(/** @type {string} */ kind) { return materializers.get(kind) } },
  })
  return { dir, globalDir, indexPath, projectDirs, dbPaths, ctx, logs, writeIndex, ...fake }
}

/**
 * The `crush.poll` info logs, optionally only those with one `poll_status`.
 *
 * @param {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} logs
 * @param {string} [status]
 */
export function crushPollLogs(logs, status) {
  return logs.filter(entry => entry.message === 'crush.poll' && entry.level === 'info'
    && (status === undefined || entry.fields?.poll_status === status))
}
