// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadLatestFileCatalogMetadata } from 'icebird'
import { fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { inventoryBucket, inventoryDay, inventoryKey, summarizeInventoryKeys } from '../sinks/sync-inventory.js'
import { effectiveRemotes, legacyCredentialName, sameServer } from '../remote/builtin_remotes.js'
import { attachWithRefresh, deriveIdentityBase, deriveMcpEndpoint, resolveAccessJwt } from '../remote/credentials.js'
import { readObservabilityEnv } from '../observability/env.js'
import { sinkInstanceConfig, sinkInstanceName } from '../registry/sinks.js'
import { readFirstSyncDeadline } from '../usage-policy/first_sync_hold.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { getLogger } from '../observability/index.js'
import { resolveIcebergDir } from '../cache/storage.js'
import { createLocalIcebergIO, tableUrlForDir } from '../cache/iceberg/resolver.js'
import { createSessionPurgeStore } from '../cache/session-purges.js'
import { tryReadCursorSync } from '../cache/partition.js'
import { requireConfirmation } from '../cli/confirm.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ExtendedSinkRegistry } from '../../../src/core/registry/types.js'
 * @import { InventoryRequest, InventoryResponse } from '../../../src/core/sinks/sync-inventory-types.js'
 */

const DATASET = 'ai_gateway_messages'

/** @param {string[]} tables */
async function localRevision(tables) {
  const { resolver } = await createLocalIcebergIO()
  const revisions = []
  for (const table of tables) {
    let hasCursor = false
    try {
      await fs.stat(path.join(table, 'cursor.json'))
      hasCursor = true
    }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
    const cursor = hasCursor ? tryReadCursorSync(table) : null
    if (hasCursor && !cursor) throw new Error('unreadable local cursor')
    const tableUrl = tableUrlForDir(resolveIcebergDir(table))
    /** @param {string} url */
    const lister = async url => {
      try { return (await fs.readdir(fileURLToPath(url), { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name) }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []
        throw error
      }
    }
    if (!(await lister(`${tableUrl}/metadata`)).length) {
      if (cursor && cursor.rowCount > 0) throw new Error('missing local table metadata')
      revisions.push([table, null])
      continue
    }
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
    revisions.push([table, tableUrl, metadata['table-uuid'], metadata['current-snapshot-id'], metadata['current-schema-id']])
  }
  return JSON.stringify(revisions)
}

/**
 * Compare sets, allowing server rows contributed by other machines. Proofs
 * are reusable only for identical local and server bucket fingerprints.
 * @ref LLP 0501#meaning [implements]: equal counts do not prove coverage; mismatches require bounded membership reconciliation
 * @param {Map<string, Set<string>>} local
 * @param {(request: InventoryRequest) => Promise<InventoryResponse>} request
 * @param {Set<string>} [proofs]
 * @param {{ includeMissing?: boolean }} [options]
 */
export async function compareSyncInventory(local, request, proofs = new Set(), { includeMissing = false } = {}) {
  let revision = ''
  let requests = 0
  const results = []
  // Keep only hashes already admitted by the local scan. A candidate is absent
  // from its day bucket, not yet authorized for upload or purge restoration.
  /** @type {Map<string, string[]> | undefined} */
  const missing = includeMissing ? new Map() : undefined
  const buckets = [...local.keys()].sort()
  /** @param {InventoryRequest} body */
  async function read(body) {
    if (++requests > 512) throw new Error('request budget exceeded; narrow --from/--to')
    const response = await request({ ...body, ...(revision ? { revision } : {}) })
    if (response.version !== 1 || response.dataset !== DATASET || !/^[a-f0-9]{64}$/.test(response.revision) ||
      (revision && revision !== response.revision)) throw new Error('server inventory changed or has an unsupported format')
    revision = response.revision
    return response
  }
  // Even an empty local scope must establish server freshness and authorization.
  for (let start = 0; start < Math.max(1, buckets.length); start += 256) {
    const batch = buckets.slice(start, start + 256)
    const response = await read({ buckets: batch })
    if (!Array.isArray(response.summaries) || response.summaries.length !== batch.length) throw new Error('invalid inventory summaries')
    for (let i = 0; i < batch.length; i++) {
      const bucket = batch[i]
      const remote = response.summaries[i]
      if (remote.bucket !== bucket || !Number.isSafeInteger(remote.count) || remote.count < 0 || remote.count > 100_000 ||
        !/^[a-f0-9]{64}$/.test(remote.fingerprint)) throw new Error('invalid inventory summary')
      const own = summarizeInventoryKeys(local.get(bucket) ?? [])
      const proof = createHash('sha256').update(JSON.stringify([bucket, own.fingerprint, remote.fingerprint])).digest('hex')
      let absent = own.count
      if ((own.count === remote.count && own.fingerprint === remote.fingerprint) || proofs.has(proof)) absent = 0
      else {
        const keys = new Set()
        let offset = 0
        while (true) {
          const page = await read({ buckets: [bucket], bucket, offset })
          if (!Array.isArray(page.keys) || page.keys.length > 1000 || page.keys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error('invalid inventory page')
          for (const key of page.keys) keys.add(key)
          offset += page.keys.length
          if (offset > remote.count || keys.size !== offset) throw new Error('invalid inventory pagination')
          if (page.next === null) break
          if (!page.keys.length || page.next !== offset) throw new Error('invalid inventory continuation')
        }
        const verified = summarizeInventoryKeys(keys)
        if (verified.count !== remote.count || verified.fingerprint !== remote.fingerprint) throw new Error('incomplete inventory pages')
        const absentKeys = own.keys.filter(key => !keys.has(key))
        absent = absentKeys.length
        if (absent) missing?.set(bucket, absentKeys)
      }
      if (!absent) proofs.add(proof)
      results.push({ day: bucket.split('/')[0], bucket, local: own.count, absent })
    }
  }
  // Revalidate the pinned source revision after all membership reads.
  await read({ buckets: [] })
  return { revision, requests, buckets: results, local: results.reduce((n, r) => n + r.local, 0), absent: results.reduce((n, r) => n + r.absent, 0),
    ...(missing ? { missing } : {}) }
}

/** @param {{ instance?: string, dataset?: string, from?: string, to?: string, json?: boolean, missing?: boolean, yes?: boolean, 'dry-run'?: boolean }} options @param {CommandRunContext} ctx */
export async function runSyncCheck(options, ctx) {
  const log = getLogger(options.missing ? 'sync.missing' : 'sync.check')
  try {
    if (options.dataset !== DATASET) throw new Error('initial check supports --dataset ai_gateway_messages only; other datasets are unsupported')
    for (const value of [options.from, options.to]) if (value !== undefined && (inventoryDay(value) === 'undated' || inventoryDay(value) !== value)) throw new Error('--from/--to must be YYYY-MM-DD')
    if (options.from && options.to && options.from > options.to) throw new Error('--from must not be after --to')
    if (!options.instance) throw new Error('select one sink instance: hyp sync <instance> --check --dataset ai_gateway_messages')
    const handles = /** @type {ExtendedSinkRegistry} */ (ctx.sinks).listHandles?.() ?? []
    const handle = handles.find(h => sinkInstanceName(h) === options.instance)
    const config = handle && sinkInstanceConfig(handle)
    if (!config || typeof config.url !== 'string') throw new Error('selected sink is not a server destination')
    if (options.missing && !handle?.sink.restoreMissingRows) throw new Error('selected sink does not support missing-row repair')
    const sinkUrl = config.url
    const remote = Object.entries(effectiveRemotes(ctx.config)).find(([, target]) => sameServer(sinkUrl, target.url))
    if (!remote) throw new Error('add a read remote for this destination with hyp remote add, then log in')
    const [target, { url }] = remote
    const legacyTarget = legacyCredentialName(target, ctx.config)
    const stateDir = readObservabilityEnv(ctx.env).stateDir
    if (await readFirstSyncDeadline({ stateDir }) !== null) throw new Error('first sync is still held; check is incomplete')
    const identityBase = deriveIdentityBase(url) ?? undefined
    const resolved = await resolveAccessJwt({ target, legacyTarget, env: ctx.env, stateDir, identityBase })
    if (!resolved.ok) throw new Error(resolved.error)
    const endpoint = new URL(deriveMcpEndpoint(url))
    endpoint.pathname = endpoint.pathname.replace(/\/mcp$/, '/sync-inventory')
    const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)
    const dataset = ctx.query.getDataset(DATASET)
    if (!dataset) throw new Error('AI dataset is unavailable locally')
    const policy = storage.exportPolicyFingerprint?.()
    const parts = await dataset.discoverPartitions({ config: ctx.config, cacheDir: storage.cacheRoot, scope: { limit: 4097 } })
    if (parts.length > 4096) throw new Error('local partition budget exceeded')
    const tables = [...new Set(parts.map(part => part.tablePath).filter(path => path !== undefined))].sort()
    const before = await localRevision(tables)
    const purges = createSessionPurgeStore(storage.cacheRoot)
    purges.refresh()
    const purgeCount = purges.size
    const local = /** @type {Map<string, Set<string>>} */ (new Map())
    let scanned = 0
    let count = 0
    if (parts.some(part => !part.tablePath)) throw new Error('local partition has no storage path')
    for (const table of tables) {
      if (storage.hasPendingSync(table)) throw new Error('local rows are still pending; retry after the normal flush')
      for await (const entry of storage.readRowsSince(table, { since: { v: 1, seq: '0' }, includeLegacy: true, columns: ['part_id', 'date'] })) {
        if (++scanned > 2_000_000) throw new Error('local scan budget exceeded')
        if (scanned % 1024 === 0) await setImmediate()
        if ('dropped' in entry) continue
        const day = inventoryDay(entry.row.date)
        if ((options.from || options.to) && day === 'undated') throw new Error('undated local rows cannot be checked within a date range')
        if (options.from && day < options.from || options.to && day > options.to) continue
        const key = inventoryKey(entry.row.part_id)
        const bucket = inventoryBucket(day, key)
        const values = local.get(bucket) ?? new Set()
        if (!values.has(key) && ++count > 400_000) throw new Error('local key budget exceeded; narrow --from/--to')
        values.add(key)
        local.set(bucket, values)
      }
    }
    if (policy !== storage.exportPolicyFingerprint?.()) throw new Error('local export policy changed during the check')
    const proofFile = path.join(stateDir, 'sync-check', createHash('sha256').update(endpoint.href).digest('hex') + '.json')
    const proofs = new Set()
    try {
      if ((await fs.stat(proofFile)).size <= 100_000) {
        const saved = JSON.parse(await fs.readFile(proofFile, 'utf8'))
        if (Array.isArray(saved)) for (const proof of saved.slice(-1000)) if (typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof)) proofs.add(proof)
      }
    } catch { /* An absent or damaged optimization never proves coverage. */ }
    let org = /** @type {string | undefined} */ (undefined)
    const selectedRows = /** @type {Map<string, Record<string, unknown>[]>} */ (new Map())
    const result = await compareSyncInventory(local, async body => {
      const response = await attachWithRefresh({ resolved,
        refresh: () => resolveAccessJwt({ target, legacyTarget, env: ctx.env, stateDir, identityBase, forceRefresh: true }),
        async op(token) {
          const value = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
          return { authFailed: value.status === 401, value }
        },
      })
      if (!response.ok) throw new Error(response.error)
      if (!response.value.ok) throw new Error(`server inventory unavailable (HTTP ${response.value.status}); an operator may need to refresh it`)
      const reader = response.value.body?.getReader()
      if (!reader) throw new Error('empty inventory response')
      const chunks = []
      let length = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > 128_000) throw new Error('inventory response exceeds byte budget')
          chunks.push(value)
        }
      } finally { await reader.cancel() }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (options.missing) {
        if (typeof data.org !== 'string' || org !== undefined && org !== data.org) throw new Error('server did not establish a stable organization for repair')
        org = data.org
      }
      return data
    }, proofs, { includeMissing: options.missing })
    const validate = async () => {
      const afterParts = await dataset.discoverPartitions({ config: ctx.config, cacheDir: storage.cacheRoot, scope: { limit: 4097 } })
      if (afterParts.length > 4096 || afterParts.some(part => !part.tablePath)) throw new Error('local partition scope changed')
      const afterTables = [...new Set(afterParts.map(part => part.tablePath).filter(path => path !== undefined))].sort()
      const after = await localRevision(afterTables)
      if (options.missing && await readFirstSyncDeadline({ stateDir }) !== null) throw new Error('first sync is still held')
      purges.refresh()
      if (before !== after || policy !== storage.exportPolicyFingerprint?.() ||
        purges.size !== purgeCount || afterTables.some(table => storage.hasPendingSync(table))) throw new Error('local data or export policy changed during the check')
      // @ref LLP 0501#missing [implements]: the policy fingerprint leaves out
      // `.hypignore`, so before every transport attempt each selected row is
      // asked again through the export seam's own verdict. The batch is
      // refused, not trimmed: a retry must resend the same body under the
      // same batch identity.
      let withheld = 0
      for (const [table, tableRows] of selectedRows) withheld += storage.exportWithheld(table, tableRows)
      if (withheld) throw new Error(`${withheld} selected rows are no longer export-eligible; repair refused, rerun to repair the rest`)
    }
    await validate()
    await fs.mkdir(path.dirname(proofFile), { recursive: true, mode: 0o700 })
    await atomicWriteJson(proofFile, [...proofs].slice(-1000), { mode: 0o600 })
    if (options.missing) {
      /** @param {object} report @param {string} text */
      const report = (report, text) => ctx.stdout.write(options.json ? JSON.stringify(report) + '\n' : text + '\n')
      if (!result.absent || options['dry-run']) {
        report({ status: options['dry-run'] ? 'preview' : 'matched', candidates: result.absent, revision: result.revision },
          `${result.absent} candidate IDs absent from their server day. Server repair excludes purged sessions and IDs present on other days.`)
        return 0
      }
      if (result.absent > 1000) throw new Error('repair exceeds 1,000 candidate IDs; narrow --from/--to')
      const confirmed = await requireConfirmation({ ctx, yes: options.yes ?? false,
        question: `Send up to ${result.absent} missing rows to ${options.instance}? Purged sessions stay excluded. [y/N] ` })
      if (confirmed === 'no-tty') throw new Error('missing-row repair needs confirmation; use --yes or preview with --dry-run')
      if (confirmed === 'declined') {
        report({ status: 'cancelled' }, 'Missing-row repair cancelled.')
        return 0
      }
      const rows = []
      const selected = new Set()
      const candidates = new Map([...result.missing ?? []].map(([bucket, keys]) => [bucket, new Set(keys)]))
      let bytes = 0
      scanned = 0
      // Read through the export privacy seam again after confirmation. No raw
      // cache access and no ordinary watermark movement is involved.
      for (const table of tables) {
        for await (const entry of storage.readRowsSince(table, { since: { v: 1, seq: '0' }, includeLegacy: true })) {
          if (++scanned > 2_000_000) throw new Error('local scan budget exceeded')
          if (scanned % 1024 === 0) await setImmediate()
          if ('dropped' in entry) continue
          const key = inventoryKey(entry.row.part_id)
          if (selected.has(key) || !candidates.get(inventoryBucket(inventoryDay(entry.row.date), key))?.has(key)) continue
          if (typeof entry.row.session_id !== 'string' || !entry.row.session_id.trim()) throw new Error('repair requires session IDs to respect server purges')
          bytes += Buffer.byteLength(JSON.stringify(entry.row, (_key, value) => typeof value === 'bigint' ? String(value) : value)) + 1
          if (bytes > 4 * 1024 * 1024) throw new Error('repair exceeds 4 MiB; narrow --from/--to')
          rows.push(entry.row)
          selected.add(key)
          const tableRows = selectedRows.get(table) ?? []
          tableRows.push(entry.row)
          selectedRows.set(table, tableRows)
        }
      }
      await validate()
      const expected = new Set([...result.missing?.values() ?? []].flat())
      if (selected.size !== expected.size) throw new Error('missing-row selection changed before upload')
      if (org === undefined) throw new Error('server did not establish repair organization')
      if (!handle?.sink.restoreMissingRows) throw new Error('selected sink no longer supports repair')
      const restored = await handle.sink.restoreMissingRows({ org, revision: result.revision, rows, validate })
      report({ ...restored, candidates: rows.length }, restored.status === 'already_accepted'
        ? 'The server already accepted this repair batch.'
        : `Restored ${restored.restored} rows; ${restored.present} already present; ${restored.purged} excluded by purge.`)
      log.info('sync.missing.completed', { status: restored.status, candidates: rows.length, restored: restored.restored, purged: restored.purged })
      return 0
    }
    const report = { status: result.absent ? 'differences' : 'matched', dataset: DATASET,
      scope: 'currently retained, export-eligible local rows; other datasets unsupported', ...result }
    ctx.stdout.write(options.json ? JSON.stringify(report) + '\n' :
      `${DATASET}: ${result.local} distinct local IDs checked, ${result.absent} absent from the matching server day.\n` +
      result.buckets.filter(b => b.absent).map(b => `  ${b.day}: ${b.absent} absent (${b.bucket})\n`).join('') +
      'Scope: currently retained, export-eligible local rows. Other datasets are unsupported.\n' +
      (result.absent ? 'Absent IDs may reflect pending backfill, purge, differing dates, or data loss; this check does not distinguish them.\n' : 'All IDs in this scope are present.\n'))
    log.info('sync.check.completed', { status: report.status, dataset: DATASET, rows: result.local, absent: result.absent, requests: result.requests })
    return result.absent ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (options.json) ctx.stdout.write(JSON.stringify({ status: 'incomplete', error: message }) + '\n')
    else ctx.stderr.write(`hyp sync --${options.missing ? 'missing' : 'check'}: incomplete: ${message}\n`)
    log.warn(options.missing ? 'sync.missing.incomplete' : 'sync.check.incomplete', { operation: options.missing ? 'missing' : 'check', status: 'incomplete' })
    return 2
  }
}
