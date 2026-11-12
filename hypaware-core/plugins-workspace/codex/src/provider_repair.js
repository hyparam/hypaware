// @ts-check

import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import * as zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { atomicWriteFile, fsyncDirectory } from '../../../../src/core/util/fs_atomic.js'
import { parseRolloutSessionMeta, ROLLOUT_META_PREFIX_BYTES } from '../../../../src/core/codex/rollout_session_meta.js'
import { withCodexServer } from './app_server.js'
import { defaultConfigPath } from './config-file.js'
import { getLogger, withSpan } from '../../../../src/core/observability/index.js'

/** @import { CommandRunContext, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js' */

const execFileAsync = promisify(execFile)
const BACKUP_ROOT = 'hypaware-provider-repair'
const MAX_FILES = 100_000
const MAX_AFFECTED = 10_000
const MAX_DATABASES = 16
const HEADER_BYTES = 16 * ROLLOUT_META_PREFIX_BYTES
const AUTO_MAX_BYTES = 1024 * 1024 * 1024

/**
 * The scheduled transcript sweep calls this only after releasing the gateway.
 * A receipt prevents history scans after success, including after restarts.
 * @ref LLP 0602#automatic: defer active clients and reuse the backed-up offline repair once after upgrade
 * @param {{ codexHome: string, stateDir: string, env: NodeJS.ProcessEnv, cwd: string }} options
 * @param {{ assertStopped?: typeof assertCodexStopped, readConfig?: typeof readCodexRepairConfig }} [deps]
 */
export function createAutomaticCodexProviderRepair(options, deps = {}) {
  const receiptPath = path.join(options.stateDir, 'codex-provider-repair.json')
  const checkStopped = deps.assertStopped ?? assertCodexStopped
  let complete = false
  let running = false
  let failed = false
  let lastStatus = ''
  /** @param {PluginLogger} log @param {AbortSignal} [parentSignal] */
  return async (log, parentSignal) => {
    if (complete || running || failed || parentSignal?.aborted) return
    running = true
    try {
      await withSpan('codex.provider_repair.automatic', { component: 'plugin.codex', operation: 'provider.repair.auto' }, async span => {
        try {
          const home = await fs.realpath(options.codexHome)
          try {
            const stat = await fs.lstat(receiptPath)
            if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid automatic Codex repair receipt')
            const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'))
            if (receipt.version === 1 && receipt.status === 'complete' && receipt.codexHome === home) {
              complete = true
              span.setAttribute('status', 'skipped')
              span.setAttribute('reason', 'already_complete')
              return
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error }
          // No history discovery, backups or native config subprocess while a
          // customer is using Codex. Retry on the next scheduled sweep.
          await checkStopped()
          const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(parentSignal ? [parentSignal] : [])])
          const config = await (deps.readConfig ?? readCodexRepairConfig)({
            codexHome: home, binary: await codexRepairBinary(), env: options.env, cwd: options.cwd,
          })
          const stopped = async () => {
            signal.throwIfAborted()
            await checkStopped()
            if (await digest(path.join(home, 'config.toml'), signal) !== config.configHash) throw new Error('Codex configuration changed; repair refused')
          }
          const result = await repairCodexProviders({ codexHome: home, sqliteHome: config.sqliteHome, assertStopped: stopped, signal, maxBytes: AUTO_MAX_BYTES })
          await atomicWriteFile(receiptPath, JSON.stringify({ version: 1, codexHome: home, ...result, status: 'complete' }) + '\n', { mode: 0o600, dirMode: 0o700, fsync: true })
          complete = true
          span.setAttribute('status', 'ok')
          span.setAttribute('reason', 'complete')
          span.setAttribute('affected_threads', result.repaired_threads)
          span.setAttribute('missing_rollouts', result.missing_rollouts)
          log.info('codex.provider_repair.automatic', {
            component: 'plugin.codex', operation: 'provider.repair.auto', status: 'ok', reason: 'complete', affected_threads: result.repaired_threads,
            missing_rollouts: result.missing_rollouts,
          })
        } catch (error) {
          const deferred = error.code === 'CODEX_RUNNING'
          const status = deferred ? 'skipped' : 'failed'
          const reason = deferred ? 'client_running' : 'repair_refused'
          // Repeated failed publications could otherwise leave a new full
          // backup every sweep. A restart or the manual command can retry.
          failed = !deferred
          span.setAttribute('status', status)
          span.setAttribute('reason', reason)
          if (reason !== lastStatus) {
            // Native errors, paths and configuration never enter daemon logs.
            const attrs = { component: 'plugin.codex', operation: 'provider.repair.auto', status, reason,
              command: 'hyp codex repair' }
            if (deferred) log.info('codex.provider_repair.automatic', attrs)
            else log.warn('codex.provider_repair.automatic', attrs)
          }
          lastStatus = reason
        }
      })
    } finally { running = false }
  }
}

/**
 * Offline migration shared by the explicit command and one-time upgrade path.
 * @ref LLP 0602#repair: preserve native OpenAI routing while normalizing the legacy provider identity
 * @param {{ codexHome: string, sqliteHome?: string, dryRun?: boolean, assertStopped?: () => Promise<void>, onStep?: (step: string) => Promise<void>, signal?: AbortSignal, maxBytes?: number }} options
 */
export async function repairCodexProviders(options) {
  options.signal?.throwIfAborted()
  const home = await fs.realpath(options.codexHome)
  const sqliteHome = await fs.realpath(options.sqliteHome ?? home)
  const assertStopped = options.assertStopped ?? assertCodexStopped
  if (!options.dryRun) {
    await assertStopped()
    await refuseIncompleteRepair(path.join(home, BACKUP_ROOT))
  }
  const files = await discoverRollouts(home, options.signal)
  const { databases, missing } = await discoverDatabases(home, sqliteHome, files, options.signal)
  const threads = new Set(files.map(file => file.id))
  for (const database of databases) for (const row of database.rows) threads.add(row.id)
  if (options.dryRun || threads.size === 0) {
    return { status: 'ok', dry_run: options.dryRun === true, repaired_threads: threads.size, rollout_files: files.length, databases: databases.length, missing_rollouts: missing }
  }

  if (options.maxBytes !== undefined) {
    let bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    for (const database of databases) {
      bytes += (await fs.stat(database.path)).size
      try { bytes += (await fs.stat(database.path + '-wal')).size } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (bytes > options.maxBytes) throw new Error('History exceeds the automatic repair budget; run hyp codex repair manually')
  }
  options.signal?.throwIfAborted()

  await fs.mkdir(path.join(home, BACKUP_ROOT), { recursive: true, mode: 0o700 })
  if (await fs.realpath(path.join(home, BACKUP_ROOT)) !== path.join(home, BACKUP_ROOT)) throw new Error('Symlinked Codex repair backup directory is not supported')
  const lockPath = path.join(home, BACKUP_ROOT, 'lock')
  const lock = await acquireLock(lockPath)
  const opened = []
  const staged = []
  let manifest
  let backupDir
  let publishing = false
  try {
    await assertStopped()
    await refuseIncompleteRepair(path.join(home, BACKUP_ROOT))
    backupDir = await fs.mkdtemp(path.join(home, BACKUP_ROOT, 'backup-'))
    await fs.chmod(backupDir, 0o700)
    const savedFiles = []
    // All originals and every replacement are durable before publishing one.
    for (const [index, file] of files.entries()) {
      options.signal?.throwIfAborted()
      const backup = `${index}.rollout`
      await fs.copyFile(file.path, path.join(backupDir, backup))
      await fs.chmod(path.join(backupDir, backup), 0o600)
      await syncFile(path.join(backupDir, backup))
      const before = await digest(path.join(backupDir, backup), options.signal)
      const replacement = `${file.path}.hypaware-${randomUUID()}.tmp`
      staged.push(replacement)
      await rewriteHeader(path.join(backupDir, backup), replacement, file.compressed, file.id, file.mode, options.signal)
      const after = await digest(replacement, options.signal)
      if (await digest(file.path, options.signal) !== before) throw new Error('A Codex rollout changed during backup; close all clients and retry')
      savedFiles.push({ path: path.relative(home, file.path), backup, id: file.id, before, after })
    }
    const savedDatabases = []
    const { DatabaseSync } = await import('node:sqlite')
    for (const [index, database] of databases.entries()) {
      options.signal?.throwIfAborted()
      const backup = `database-${index}.sqlite`
      const db = new DatabaseSync(database.path)
      opened.push({ db, rows: database.rows, committed: false })
      db.exec('PRAGMA busy_timeout = 1000')
      // VACUUM INTO includes committed WAL frames; copying the main file alone
      // can produce a backup that omits the very rows being repaired.
      db.prepare('VACUUM INTO ?').run(path.join(backupDir, backup))
      await fs.chmod(path.join(backupDir, backup), 0o600)
      await syncFile(path.join(backupDir, backup))
      savedDatabases.push({ path: path.basename(database.path), backup, sha256: await digest(path.join(backupDir, backup)), rows: database.rows })
      db.exec('BEGIN IMMEDIATE')
      verifyRows(db, database.rows, 'hypaware')
    }
    manifest = { version: 1, status: 'prepared', codexHome: home, sqliteHome, files: savedFiles, databases: savedDatabases }
    await saveManifest(backupDir, manifest)
    await fsyncDirectory(path.dirname(backupDir))
    await fsyncDirectory(home)
    await assertStopped()
    manifest.status = 'applying'
    publishing = true
    await saveManifest(backupDir, manifest)
    for (const [index, file] of savedFiles.entries()) {
      options.signal?.throwIfAborted()
      const target = path.join(home, file.path)
      if (await digest(target, options.signal) !== file.before) throw new Error('A Codex rollout changed before repair; close all clients and retry')
      await fs.rename(staged[index], target)
      await fsyncDirectory(path.dirname(target))
    }
    await options.onStep?.('rollouts_replaced')
    options.signal?.throwIfAborted()
    await assertStopped()
    for (const entry of opened) {
      const update = entry.db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND rollout_path = ? AND model_provider = ?')
      for (const row of entry.rows) {
        if (update.run('openai', row.id, row.rollout_path, 'hypaware').changes !== 1) throw new Error('Codex thread metadata changed during repair')
      }
    }
    for (const entry of opened) {
      entry.db.exec('COMMIT')
      entry.committed = true
    }
    manifest.status = 'complete'
    await saveManifest(backupDir, manifest)
    return { status: 'ok', dry_run: false, repaired_threads: threads.size, rollout_files: files.length, databases: databases.length, missing_rollouts: missing, backup_path: backupDir }
  } catch (error) {
    for (const entry of opened) {
      if (entry.db.isTransaction) entry.db.exec('ROLLBACK')
      if (entry.committed) reverseRows(entry.db, entry.rows)
    }
    // Nothing was published yet, so the full copies protect nothing.
    if (!publishing && backupDir) await fs.rm(backupDir, { recursive: true, force: true })
    else if (manifest && backupDir) {
      await restoreFiles(home, backupDir, manifest.files)
      manifest.status = 'rolled_back'
      await saveManifest(backupDir, manifest)
    }
    throw error
  } finally {
    for (const entry of opened) entry.db.close()
    for (const file of staged) await fs.rm(file, { force: true })
    await lock.close()
    await fs.rm(lockPath, { force: true })
  }
}

/**
 * Restore only the changed provider cells and unchanged repaired rollouts.
 * Later conversation content is never overwritten by a blanket DB restore.
 * @param {{ codexHome: string, sqliteHome?: string, backupPath: string, assertStopped?: () => Promise<void> }} options
 */
export async function restoreCodexProviders(options) {
  await (options.assertStopped ?? assertCodexStopped)()
  const home = await fs.realpath(options.codexHome)
  const sqliteHome = await fs.realpath(options.sqliteHome ?? home)
  const backupDir = await fs.realpath(options.backupPath)
  if (path.dirname(backupDir) !== path.join(home, BACKUP_ROOT) || !path.basename(backupDir).startsWith('backup-')) throw new Error('Backup must belong to this Codex home')
  const stat = await fs.stat(path.join(backupDir, 'manifest.json'))
  if (stat.size > 8 * 1024 * 1024) throw new Error('Repair manifest exceeds its budget')
  const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1 || manifest.codexHome !== home || manifest.sqliteHome !== sqliteHome
      || !Array.isArray(manifest.files) || manifest.files.length > MAX_AFFECTED
      || !Array.isArray(manifest.databases) || manifest.databases.length > MAX_DATABASES) throw new Error('Invalid repair manifest')
  const lockPath = path.join(home, BACKUP_ROOT, 'lock')
  const lock = await acquireLock(lockPath)
  const opened = []
  try {
    await verifyRestoreFiles(home, backupDir, manifest.files)
    const { DatabaseSync } = await import('node:sqlite')
    for (const database of manifest.databases) {
      if (!/^state_\d+\.sqlite$/.test(database.path) || !/^database-\d+\.sqlite$/.test(database.backup)
          || !Array.isArray(database.rows) || database.rows.length > MAX_AFFECTED) throw new Error('Invalid database backup')
      if (await digest(path.join(backupDir, database.backup)) !== database.sha256) throw new Error('Database backup was modified')
      if ((await fs.lstat(path.join(sqliteHome, database.path))).isSymbolicLink()) throw new Error('Symlinked Codex state database is not supported')
      const original = new DatabaseSync(path.join(backupDir, database.backup), { readOnly: true })
      try { verifyRows(original, database.rows, 'hypaware') } finally { original.close() }
      const db = new DatabaseSync(path.join(sqliteHome, database.path))
      opened.push(db)
      db.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE')
      const select = db.prepare('SELECT model_provider, rollout_path FROM threads WHERE id = ?')
      for (const row of database.rows) {
        const current = select.get(row.id)
        if (!current || current.rollout_path !== row.rollout_path || (current.model_provider !== 'openai' && current.model_provider !== 'hypaware')) throw new Error('Codex metadata changed since repair; restore refused')
      }
    }
    manifest.status = 'restoring'
    await saveManifest(backupDir, manifest)
    await (options.assertStopped ?? assertCodexStopped)()
    await restoreFiles(home, backupDir, manifest.files)
    for (const [index, db] of opened.entries()) {
      reverseRows(db, manifest.databases[index].rows)
      db.exec('COMMIT')
    }
    manifest.status = 'restored'
    await saveManifest(backupDir, manifest)
    return { status: 'ok', restored_files: manifest.files.length, backup_path: backupDir }
  } finally {
    for (const db of opened) {
      if (db.isTransaction) db.exec('ROLLBACK')
      db.close()
    }
    await lock.close()
    await fs.rm(lockPath, { force: true })
  }
}

/** Read config through Codex's TOML parser in an isolated, credential-free home.
 * @param {{ codexHome: string, binary: string, env: NodeJS.ProcessEnv, cwd: string, restoring?: boolean }} options
 */
export async function readCodexRepairConfig(options) {
  const configPath = path.join(options.codexHome, 'config.toml')
  const stat = await fs.stat(configPath)
  if (stat.size > 1024 * 1024) throw new Error('Codex config exceeds the repair budget')
  const content = await fs.readFile(configPath, 'utf8')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-repair-config-'))
  try {
    await fs.writeFile(path.join(root, 'config.toml'), content, { mode: 0o600 })
    const config = await withCodexServer(options.binary, {
      cwd: root,
      env: { PATH: options.env.PATH, SystemRoot: options.env.SystemRoot, HOME: root, USERPROFILE: root, CODEX_HOME: root,
        CODEX_SQLITE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, APPDATA: root, LOCALAPPDATA: root },
      overrides: ['-c', `sqlite_home=${JSON.stringify(root)}`, '-c', `log_dir=${JSON.stringify(root)}`, '-c', 'cli_auth_credentials_store="file"'],
    }, async request => {
      const read = await request('config/read', { includeLayers: true })
      const requirements = await request('configRequirements/read', {})
      if (read.error || requirements.error) throw new Error('Codex could not validate repair configuration')
      const raw = read.result.config
      if (!options.restoring) validateCodexRepairRoute(raw, requirements.result.requirements)
      const location = read.result.layers?.find(layer => layer.config?.sqlite_home && layer.config.sqlite_home !== root)?.config.sqlite_home
        ?? options.env.CODEX_SQLITE_HOME ?? options.codexHome
      return { sqliteHome: path.resolve(options.cwd, location), configHash: createHash('sha256').update(content).digest('hex') }
    })
    if (await digest(configPath) !== config.configHash) throw new Error('Codex config changed during validation; retry')
    return config
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}

/** @param {any} config @param {any} requirements */
export function validateCodexRepairRoute(config, requirements) {
  const alias = config.model_providers?.hypaware
  const allowed = new Set(['name', 'wire_api', 'requires_openai_auth', 'supports_websockets', 'supports_standalone_web_search'])
  if ((config.model_provider ?? 'openai') !== 'openai' || config.profile || config.experimental_thread_store
      || config.openai_base_url || config.model_providers?.openai
      || (requirements?.model_provider && requirements.model_provider !== 'openai')
      // Codex's OpenAI-specific endpoint/auth behavior also depends on this
      // exact name, as it does for the compatibility writer in LLP 0432.
      || !alias || alias.name !== 'OpenAI' || alias.wire_api !== 'responses'
      || alias.requires_openai_auth !== true || alias.supports_websockets !== true || alias.supports_standalone_web_search === true
      || Object.entries(alias).some(([key, value]) => value !== null && value !== undefined && !allowed.has(key))) {
    throw new Error('Repair requires the default OpenAI provider and the unchanged HypAware compatibility alias; custom routes and profiles need an explicit separate migration')
  }
}

/** @returns {Promise<void>} */
export async function assertCodexStopped() {
  const windows = process.platform === 'win32'
  const { stdout } = await execFileAsync(windows ? 'tasklist' : 'ps', windows ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
  if (stdout.split('\n').some(line => /^(codex|codex-cli|chatgpt)(\.exe)?$/i.test(path.basename(windows ? line.split(',')[0].replaceAll('"', '') : line.trim())))) {
    throw Object.assign(new Error('Close Codex Desktop and all Codex CLI sessions before repairing saved chats'), { code: 'CODEX_RUNNING' })
  }
}

async function discoverRollouts(home, signal) {
  const affected = []
  let visited = 0
  async function walk(directory) {
    let entries
    try { entries = await fs.opendir(directory) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for await (const entry of entries) {
      signal?.throwIfAborted()
      if (++visited > MAX_FILES) throw new Error('Codex history exceeds the repair scan budget')
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Symlinked Codex history is not supported by repair')
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) {
        const meta = await readHeader(file, entry.name.endsWith('.zst'), signal)
        if (meta?.provider !== 'hypaware') continue
        if (affected.length >= MAX_AFFECTED) throw new Error('Too many affected rollouts for one repair')
        const stat = await fs.lstat(file)
        affected.push({ path: file, id: meta.id, compressed: entry.name.endsWith('.zst'), mode: stat.mode & 0o777, bytes: stat.size })
      }
    }
  }
  for (const root of ['sessions', 'archived_sessions']) await walk(path.join(home, root))
  return affected
}

async function discoverDatabases(home, directory, files, signal) {
  const databases = []
  const byPath = new Map(files.map(file => [file.path, file.id]))
  const { DatabaseSync } = await import('node:sqlite')
  const entries = await fs.opendir(directory)
  let visited = 0
  let rowCount = 0
  let missing = 0
  for await (const entry of entries) {
    signal?.throwIfAborted()
    if (++visited > MAX_FILES) throw new Error('Codex state exceeds the discovery budget')
    if (!/^state_\d+\.sqlite$/.test(entry.name)) continue
    if (!entry.isFile()) throw new Error('Symlinked Codex state databases are not supported')
    const file = path.join(directory, entry.name)
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 1000; PRAGMA query_only = ON')
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name))
      if (!['id', 'rollout_path', 'model_provider'].every(name => columns.has(name))) throw new Error('Unsupported Codex thread database schema')
      const rows = db.prepare('SELECT id, rollout_path FROM threads WHERE model_provider = ? LIMIT ?').all('hypaware', MAX_AFFECTED + 1)
      rowCount += rows.length
      if (rowCount > MAX_AFFECTED) throw new Error('Too many affected Codex metadata rows')
      if (!rows.length) continue
      if (databases.length >= MAX_DATABASES) throw new Error('Too many Codex state databases')
      const kept = []
      for (const row of rows) {
        if (typeof row.id !== 'string' || typeof row.rollout_path !== 'string') throw new Error('Unsupported Codex metadata identity')
        const match = byPath.get(row.rollout_path) === row.id || byPath.get(row.rollout_path + '.zst') === row.id
        // A previously replaced header can coexist with stale DB metadata.
        if (!match) {
          const target = await existingRollout(confinedRolloutPath(home, row.rollout_path))
          // A chat whose file was deleted has nothing to repair or back up, so
          // its cell is left as it is rather than refusing every other chat.
          if (!target) {
            missing++
            continue
          }
          const header = await readHeader(target, target.endsWith('.zst'), signal)
          if (header?.id !== row.id || header.provider !== 'openai') throw new Error('A legacy Codex metadata row has no matching repairable rollout')
        }
        kept.push(row)
      }
      if (kept.length) databases.push({ path: file, rows: kept })
    } finally { db.close() }
  }
  return { databases, missing }
}

/**
 * @param {string} target
 * @returns {Promise<string | undefined>} the rollout, possibly compressed since, or undefined when it no longer exists
 */
async function existingRollout(target) {
  for (const candidate of [target, target + '.zst']) {
    try {
      if (await fs.realpath(candidate) !== candidate) throw new Error('Symlinked Codex rollout is not supported')
      return candidate
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // A dangling link also reports ENOENT and stays refused.
      try { await fs.lstat(candidate) } catch (absent) {
        if (absent.code === 'ENOENT') continue
        throw absent
      }
      throw new Error('Symlinked Codex rollout is not supported')
    }
  }
}

function decoded(file, compressed, signal) {
  const source = createReadStream(file, { signal })
  if (!compressed) return source
  if (typeof zlib.createZstdDecompress !== 'function') {
    source.destroy()
    throw new Error('Repairing compressed Codex history requires a Node.js version with Zstandard support')
  }
  const decoder = zlib.createZstdDecompress()
  source.on('error', error => decoder.destroy(error))
  decoder.once('close', () => source.destroy())
  return source.pipe(decoder)
}

/**
 * @returns {Promise<{ id: string, provider: unknown } | undefined>} undefined when the file has no complete session header
 */
async function readHeader(file, compressed, signal) {
  const stream = decoded(file, compressed, signal)
  let prefix = Buffer.alloc(0)
  try {
    for await (const chunk of stream) {
      prefix = Buffer.concat([prefix, chunk])
      const newline = prefix.indexOf(10)
      if (newline < 0 && prefix.length < HEADER_BYTES) continue
      if (newline < 0 || newline > HEADER_BYTES) throw new Error('Codex rollout header exceeds the repair budget or is incomplete')
      const line = prefix.subarray(0, newline).toString('utf8')
      const parsed = parseRolloutSessionMeta(line)
      if (!parsed?.threadId) return
      return { id: parsed.threadId, provider: JSON.parse(line).payload.model_provider }
    }
  } finally { stream.destroy() }
}

async function rewriteHeader(source, target, compressed, id, mode, signal) {
  async function* transform() {
    const stream = decoded(source, compressed, signal)
    let prefix = Buffer.alloc(0)
    let replaced = false
    for await (const chunk of stream) {
      if (replaced) {
        yield chunk
        continue
      }
      prefix = Buffer.concat([prefix, chunk])
      const newline = prefix.indexOf(10)
      if (newline < 0 && prefix.length < HEADER_BYTES) continue
      if (newline < 0 || newline > HEADER_BYTES) throw new Error('Invalid Codex rollout header during repair')
      const row = JSON.parse(prefix.subarray(0, newline).toString('utf8'))
      if (parseRolloutSessionMeta(JSON.stringify(row))?.threadId !== id || row.payload.model_provider !== 'hypaware') throw new Error('Codex rollout identity changed before repair')
      row.payload.model_provider = 'openai'
      yield Buffer.from(JSON.stringify(row) + (prefix[newline - 1] === 13 ? '\r\n' : '\n'))
      yield prefix.subarray(newline + 1)
      prefix = Buffer.alloc(0)
      replaced = true
    }
    if (!replaced) throw new Error('Empty Codex rollout during repair')
  }
  const output = createWriteStream(target, { flags: 'wx', mode })
  if (compressed) await pipeline(transform(), zlib.createZstdCompress(), output, { signal })
  else await pipeline(transform(), output, { signal })
  await fs.chmod(target, mode)
  await syncFile(target)
}

async function digest(file, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

function confinedRolloutPath(home, relative) {
  const target = path.resolve(home, relative)
  if (!['sessions', 'archived_sessions'].some(root => target.startsWith(path.join(home, root) + path.sep))) throw new Error('Rollout path is outside this Codex home')
  return target
}

async function verifyRestoreFiles(home, backupDir, files) {
  for (const file of files) {
    const target = confinedRolloutPath(home, file.path)
    if (!/^\d+\.rollout$/.test(file.backup) || await fs.realpath(target) !== target) throw new Error('Invalid rollout backup path')
    if (await digest(path.join(backupDir, file.backup)) !== file.before) throw new Error('Rollout backup was modified')
    if (![file.before, file.after].includes(await digest(target))) throw new Error('A chat changed since repair; restore refused to preserve new content')
  }
}

async function restoreFiles(home, backupDir, files) {
  await verifyRestoreFiles(home, backupDir, files)
  for (const file of files) {
    const target = confinedRolloutPath(home, file.path)
    if (await digest(target) === file.before) continue
    const temporary = `${target}.hypaware-${randomUUID()}.tmp`
    try {
      await fs.copyFile(path.join(backupDir, file.backup), temporary)
      await fs.chmod(temporary, (await fs.stat(target)).mode & 0o777)
      await syncFile(temporary)
      await fs.rename(temporary, target)
      await fsyncDirectory(path.dirname(target))
    } finally { await fs.rm(temporary, { force: true }) }
  }
}

function verifyRows(db, rows, provider) {
  const select = db.prepare('SELECT rollout_path, model_provider FROM threads WHERE id = ?')
  for (const row of rows) {
    const current = select.get(row.id)
    if (!current || current.rollout_path !== row.rollout_path || current.model_provider !== provider) throw new Error('Codex thread metadata changed before repair')
  }
}

function reverseRows(db, rows) {
  const update = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND rollout_path = ? AND model_provider = ?')
  for (const row of rows) update.run('hypaware', row.id, row.rollout_path, 'openai')
}

async function saveManifest(directory, manifest) {
  const content = JSON.stringify(manifest, null, 2) + '\n'
  if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('Repair manifest exceeds its budget')
  await atomicWriteFile(path.join(directory, 'manifest.json'), content, { mode: 0o600, fsync: true })
}

async function syncFile(file) {
  // Windows refuses FlushFileBuffers on a read-only handle (EPERM).
  const handle = await fs.open(file, process.platform === 'win32' ? 'r+' : 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function acquireLock(file) {
  try {
    const handle = await fs.open(file, 'wx', 0o600)
    await handle.writeFile(String(process.pid))
    await handle.sync()
    return handle
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number(await fs.readFile(file, 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid Codex repair lock')
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') {
        await fs.rm(file)
        return acquireLock(file)
      }
      throw error
    }
    throw new Error('Another Codex repair is running')
  }
}

async function refuseIncompleteRepair(directory) {
  let entries
  try { entries = await fs.opendir(directory) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  let count = 0
  for await (const entry of entries) {
    if (++count > MAX_FILES) throw new Error('Too many repair backups to inspect')
    if (!entry.isDirectory() || !entry.name.startsWith('backup-')) continue
    const file = path.join(directory, entry.name, 'manifest.json')
    let manifest
    try {
      if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('Repair manifest exceeds its budget')
      manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (['prepared', 'applying', 'restoring'].includes(manifest.status)) {
      throw new Error(`An interrupted repair needs restoration first: hyp codex repair --restore ${path.dirname(file)}`)
    }
  }
}

/**
 * @param {string[]} argv @param {CommandRunContext} ctx
 * @param {{ assertStopped?: typeof assertCodexStopped, readConfig?: typeof readCodexRepairConfig }} [deps]
 */
export async function runCodexRepair(argv, ctx, deps = {}) {
  const usage = 'usage: hyp codex repair [--dry-run] [--json] [--codex-bin <path>]\n       hyp codex repair --restore <backup-path> [--json] [--codex-bin <path>]\n'
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write(usage + 'Close Codex Desktop and CLI sessions before repair or restore. Backups stay local under CODEX_HOME/hypaware-provider-repair.\n')
    return 0
  }
  let binary
  let backupPath
  let dryRun = false
  let json = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') json = true
    else if (arg === '--dry-run') dryRun = true
    else if ((arg === '--restore' || arg === '--codex-bin') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      const value = argv[++index]
      if (arg === '--restore') backupPath = value
      else binary = value
    } else {
      ctx.stderr.write(usage)
      return 2
    }
  }
  if (backupPath && dryRun) {
    ctx.stderr.write(usage)
    return 2
  }
  const home = path.dirname(defaultConfigPath(ctx.env))
  const checkStopped = deps.assertStopped ?? assertCodexStopped
  const log = getLogger('plugin.codex.repair')
  return withSpan('codex.provider_repair', { component: 'plugin.codex', operation: backupPath ? 'provider.restore' : 'provider.repair', dry_run: dryRun }, async span => {
    try {
      if (!dryRun) await checkStopped()
      const config = await (deps.readConfig ?? readCodexRepairConfig)({ codexHome: home, binary: binary ?? await codexRepairBinary(), env: ctx.env, cwd: ctx.cwd ?? process.cwd(), restoring: Boolean(backupPath) })
      const stopped = async () => {
        await checkStopped()
        if (await digest(path.join(home, 'config.toml')) !== config.configHash) throw new Error('Codex configuration changed; repair refused')
      }
      const result = backupPath
        ? await restoreCodexProviders({ codexHome: home, sqliteHome: config.sqliteHome, backupPath, assertStopped: stopped })
        : await repairCodexProviders({ codexHome: home, sqliteHome: config.sqliteHome, dryRun, assertStopped: stopped })
      span.setAttribute('status', 'ok')
      const count = 'repaired_threads' in result ? result.repaired_threads : result.restored_files
      const missing = 'missing_rollouts' in result ? result.missing_rollouts : 0
      span.setAttribute('affected_threads', count)
      log.info('codex.provider_repair.complete', { component: 'plugin.codex', operation: backupPath ? 'provider.restore' : 'provider.repair', status: 'ok', dry_run: dryRun, affected_threads: count, missing_rollouts: missing })
      if (json) ctx.stdout.write(JSON.stringify(result) + '\n')
      else {
        ctx.stdout.write(backupPath ? `Restored ${count} rollout files.\n` : `${dryRun ? 'Would repair' : 'Repaired'} ${count} saved Codex chats.\n`)
        if (missing) ctx.stdout.write(`Left ${missing} saved Codex chats unchanged because their files were deleted.\n`)
        if ('backup_path' in result && result.backup_path) ctx.stdout.write(`Backup: ${result.backup_path}\n`)
        if (!dryRun && count) ctx.stdout.write('Open Codex normally to continue your chats.\n')
      }
      return 0
    } catch (error) {
      span.setAttribute('status', 'error')
      log.warn('codex.provider_repair.failed', { component: 'plugin.codex', operation: 'provider.repair', status: 'error', error_kind: 'repair_refused' })
      // Native stderr and configuration are never included in this error.
      ctx.stderr.write(`Codex repair failed: ${error instanceof Error ? error.message : 'unknown failure'}\n`)
      return 1
    }
  })
}

async function codexRepairBinary() {
  if (process.platform === 'darwin') {
    for (const app of ['ChatGPT', 'Codex']) {
      const candidate = `/Applications/${app}.app/Contents/Resources/codex-cli/bin/codex`
      try {
        await fs.access(candidate)
        return candidate
      } catch {}
    }
  }
  return 'codex'
}
