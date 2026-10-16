// @ts-check

import nodeFs from 'node:fs'

import { classifyClientProvenance } from '../cli/wizard/provenance.js'
import { createSourceWithholdResolver } from '../cache/source-withhold.js'
import { resolveEntrypointOwners } from '../backfill/entrypoint_owner.js'
import {
  clientSyncListPath,
  optedOutClientSourceIds,
  readClientSyncEntries,
  writeClientSyncEntries,
  ClientSyncListUnreadableError,
} from '../usage-policy/client_sync.js'
import { getLogger, Attr } from '../observability/index.js'

/**
 * @import { HypAwareV2Config } from '../../../hypaware-plugin-kernel-types.js'
 * @import { PluginCatalog } from '../../../src/core/types.js'
 * @import { SourceWithholdResolver } from '../../../src/core/cache/types.js'
 * @import { ClientSyncEntry } from '../../../src/core/usage-policy/types.js'
 */

/** Opt-out list read cadence, matching the directory list's resolver TTL. */
const CACHE_TTL_MS = 5_000

/**
 * One-time upgrade migration for the LLP 0188 default-sync flip. Pre-0188
 * the withheld set was derived at boot, not stored: every picker id
 * classified `'local'` on a machine with a central layer. The store's
 * absence marks a machine that enrolled under that rule (enrollment now
 * stamps an empty store first, `seedClientSyncStoreIfAbsent`), so the first
 * boot that sees a central layer and no store materializes the derived set
 * as explicit opt-outs: data the machine was told "stays on this machine"
 * never starts shipping because of an upgrade.
 *
 * A corrupt store is left untouched (never overwrite an uninterpretable
 * privacy signal); the export seam fails closed on it instead.
 *
 * @ref LLP 0188#migration [implements]: store absence + central layer materializes the pre-0188 derived withheld set as opt-out entries
 * @param {{
 *   catalog: Pick<PluginCatalog, 'plugins' | 'pickerDescriptors' | 'clientDescriptors'>,
 *   layered: { centralConfig?: HypAwareV2Config | null, effective?: HypAwareV2Config | null },
 *   stateDir: string,
 * }} args
 * @returns {Promise<{ migrated: boolean, sources?: string[] }>}
 */
export async function ensureClientSyncMigration({ catalog, layered, stateDir }) {
  if (!layered.centralConfig) return { migrated: false }

  let existing
  try {
    existing = await readClientSyncEntries({ stateDir })
  } catch (err) {
    if (err instanceof ClientSyncListUnreadableError) {
      getLogger('config').warn('client_sync.migration_skipped', {
        [Attr.COMPONENT]: 'config',
        [Attr.ERROR_KIND]: err.error_kind,
        file_path: err.filePath,
      })
      return { migrated: false }
    }
    throw err
  }
  if (existing !== null) return { migrated: false }

  const sources = [...catalog.pickerDescriptors.keys()].filter(
    (id) => classifyClientProvenance(id, layered, catalog) === 'local'
  )
  await writeClientSyncEntries({
    stateDir,
    entries: sources.map((source) => ({ source, class: /** @type {'local-only'} */ ('local-only') })),
  })
  getLogger('config').info('client_sync.migrated', {
    [Attr.COMPONENT]: 'config',
    migrated_source_count: sources.length,
  })
  return { migrated: true, sources }
}

/**
 * Build the boot-time `readRowsSince` source-scoped withhold resolver
 * (LLP 0188) from the plugin catalog, the two-layer config `bootKernel`
 * already resolved, and the machine-local opt-out store. This is the
 * boot-glue `createKernelRuntime` itself can't do: it runs before the
 * catalog and layered config are known, and classifying provenance needs
 * both.
 *
 * Returns `undefined` when there is nothing to withhold from: a machine
 * with no central layer (`classifyClientProvenance`'s own "the
 * managed-machine gate is applied by each consumer" contract: a solo
 * machine has no forward sink to withhold from). On an enrolled machine
 * the resolver is always built, even when nothing is currently opted out,
 * because the withheld set is live: the store is re-read on a short TTL so
 * an opt-out written by `hyp policy client` or the wizard takes effect in
 * a running daemon without a restart.
 *
 * The withheld set is the store's opted-out sources minus every source
 * classified `'central'`: org-configured sources always sync, so a stale
 * opt-out entry for a source the org has since adopted is inert, never an
 * error (LLP 0188 #locked). An absent store reads as "nothing opted out"
 * (enrollment stamps it empty and boot migration materializes upgrades,
 * so absence here is post-migration deletion, which fails open exactly as
 * deleting the directory list does); a corrupt store throws
 * {@link ClientSyncListUnreadableError} from `shouldWithhold`, failing the
 * partition read closed so the sink watermark stays put.
 *
 * @ref LLP 0188#opt-out [implements]: the boot-time reduction of the opt-out store + provenance classification + the catalog's `attribution_column` declarations into the resolver `readRowsSince` consults
 * @param {{
 *   catalog: Pick<PluginCatalog, 'plugins' | 'pickerDescriptors' | 'clientDescriptors'>,
 *   layered: { centralConfig?: HypAwareV2Config | null, effective?: HypAwareV2Config | null },
 *   stateDir: string,
 *   readFileSync?: (path: string, encoding: 'utf8') => string,
 *   now?: () => number,
 *   ttlMs?: number,
 * }} args
 * @returns {SourceWithholdResolver | undefined}
 */
export function buildSourceWithholdResolver({
  catalog,
  layered,
  stateDir,
  readFileSync = nodeFs.readFileSync,
  now = Date.now,
  ttlMs = CACHE_TTL_MS,
}) {
  if (!layered.centralConfig) return undefined

  const centralIds = new Set(
    [...catalog.pickerDescriptors.keys()].filter(
      (id) => classifyClientProvenance(id, layered, catalog) === 'central'
    )
  )
  const filePath = clientSyncListPath(stateDir)

  /** @type {{ withheld: Set<string>, expiresAt: number } | null} */
  let cache = null
  const readWithheld = () => {
    const at = now()
    if (cache && cache.expiresAt > at) return cache.withheld
    /** @type {string | null} */
    let raw = null
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (err) {
      if (!err || /** @type {{ code?: string }} */ (err).code !== 'ENOENT') {
        throw new ClientSyncListUnreadableError(filePath, { cause: err })
      }
    }
    /** @type {Set<string>} */
    let withheld
    if (raw === null) {
      withheld = new Set()
    } else {
      /** @type {unknown} */
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        throw new ClientSyncListUnreadableError(filePath, { cause: err })
      }
      const entries = parseClientSyncShape(parsed)
      if (entries === null) throw new ClientSyncListUnreadableError(filePath)
      withheld = new Set(optedOutClientSourceIds(entries).filter((id) => !centralIds.has(id)))
    }
    cache = { withheld, expiresAt: at + ttlMs }
    return withheld
  }

  return createSourceWithholdResolver({
    withheldSourceIds: readWithheld,
    datasetAttributionColumns: datasetAttributionColumnsFromCatalog(catalog),
    datasetOwnedSourceIds: datasetOwnedSourceIdsFromCatalog(catalog),
    clientEntrypointOwners: clientEntrypointOwnersFromCatalog(catalog),
  })
}

/**
 * Sync-context duplicate of `client_sync.js`'s shape check (that module's
 * read path is async; the resolver's read is sync because `shouldWithhold`
 * is called per row inside a scan). Kept minimal and strict: a mismatch is
 * `null`, and the caller fails safe.
 *
 * @param {unknown} parsed
 * @returns {ClientSyncEntry[] | null}
 */
function parseClientSyncShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = /** @type {{ version?: unknown, entries?: unknown }} */ (parsed)
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return null
  /** @type {ClientSyncEntry[]} */
  const out = []
  for (const entry of candidate.entries) {
    if (entry === null || typeof entry !== 'object') return null
    const { source, class: cls } = /** @type {{ source?: unknown, class?: unknown }} */ (entry)
    if (typeof source !== 'string' || source === '' || cls !== 'local-only') return null
    out.push({ source, class: 'local-only' })
  }
  return out
}

/**
 * Fold every plugin's `contributes.datasets[].attribution_column`
 * (LLP 0132, `PluginDatasetManifest.attribution_column`) into one
 * dataset-name-keyed map. First-writer-wins on a name collision, matching
 * `buildPluginCatalog`'s own first-manifest-wins convention. A dataset
 * with no declared `attribution_column` is simply absent from the map:
 * `readRowsSince` treats an absent entry as "never subject to per-row
 * source-scoped withholding" (see `datasetOwnedSourceIdsFromCatalog` for
 * the dataset-scoped rule that can still cover it).
 *
 * @param {Pick<PluginCatalog, 'plugins'>} catalog
 * @returns {Map<string, string>}
 */
export function datasetAttributionColumnsFromCatalog(catalog) {
  /** @type {Map<string, string>} */
  const out = new Map()
  for (const entry of catalog.plugins.values()) {
    const datasets = entry.contributes?.datasets
    if (!Array.isArray(datasets)) continue
    for (const ds of datasets) {
      if (
        ds &&
        typeof ds.name === 'string' &&
        typeof ds.attribution_column === 'string' &&
        ds.attribution_column !== '' &&
        !out.has(ds.name)
      ) {
        out.set(ds.name, ds.attribution_column)
      }
    }
  }
  return out
}

/**
 * Fold the catalog into a dataset-name-keyed map of the picker source ids
 * whose owning plugin declares that dataset in `contributes.datasets`.
 * Feeds two withholding rules: the dataset-scoped rule (LLP 0188
 * #enforcement-scope), where a dataset with no attribution column cannot
 * be filtered per row, but when every declared owner is opted out, the
 * whole dataset is withheld, and the fail-closed unattributed-row rule
 * (LLP 0192 #fail-closed), which reads the same owner list. A dataset
 * contributed by a plugin with no picker row maps to an empty owner list
 * and is never withheld this way (the conservative default).
 *
 * The owner list is the **union** across every plugin contributing the
 * name, not the first manifest's (the first-wins rule its sibling
 * `datasetAttributionColumnsFromCatalog` uses, which is right there
 * because a dataset has one attribution column but wrong here). "Every
 * declared owner" is a union by construction, and first-wins understates
 * it: two plugins contributing one dataset name, the first opted out and
 * the second not, would withhold the whole dataset - dropping rows from a
 * source the user never opted out, and, when that second plugin is the
 * org's, withholding a locked source that LLP 0188 #locked guarantees
 * always syncs.
 *
 * @param {Pick<PluginCatalog, 'plugins' | 'pickerDescriptors'>} catalog
 * @returns {Map<string, string[]>}
 */
export function datasetOwnedSourceIdsFromCatalog(catalog) {
  /** @type {Map<string, string[]>} */
  const pickerIdsByPlugin = new Map()
  for (const descriptor of catalog.pickerDescriptors.values()) {
    const ids = pickerIdsByPlugin.get(descriptor.plugin) ?? []
    ids.push(descriptor.id)
    pickerIdsByPlugin.set(descriptor.plugin, ids)
  }
  /** @type {Map<string, Set<string>>} */
  const owners = new Map()
  for (const entry of catalog.plugins.values()) {
    const datasets = entry.contributes?.datasets
    if (!Array.isArray(datasets)) continue
    const pluginOwners = pickerIdsByPlugin.get(entry.name) ?? []
    for (const ds of datasets) {
      if (!ds || typeof ds.name !== 'string') continue
      const set = owners.get(ds.name) ?? new Set()
      for (const id of pluginOwners) set.add(id)
      owners.set(ds.name, set)
    }
  }
  /** @type {Map<string, string[]>} */
  const out = new Map()
  for (const [name, set] of owners) out.set(name, [...set])
  return out
}

/**
 * Fold the catalog into a transcript-`entrypoint`-keyed map of the picker
 * source id that owns each value, from every client descriptor's
 * `contributes.client.transcript_entrypoints` (LLP 0140).
 *
 * This is the seam's second attribution axis and it exists for one shipped
 * asymmetry: `claude-desktop` is a real picker id, so `hyp privacy client
 * claude-desktop local-only` writes a real opt-out entry, but its live rows
 * deliberately land under `client_name: "claude"` with `entrypoint:
 * "claude-desktop-3p"` (LLP 0133 #attribution). Keyed on the picker id and
 * tested against `client_name`, that entry could never match a row
 * (LLP 0346). Its own backfilled rows already carry `client_name:
 * "claude-desktop"` by whichever of LLP 0140's two admission rules the
 * session's location selects (`classifyTranscriptEntrypoint` for the shared
 * tree, `classifyContainerSession` for the `Claude-3p` container, whose tag
 * is deliberately unclaimed), so only the live route was unenforceable.
 *
 * Restricted to descriptors whose name is also a PICKER id: only a picker
 * id can appear in the opt-out store, and every extra name here widens the
 * set of `client_name` values whose `entrypoint` is read as an ownership
 * claim (see `entrypointNamespace` in `createSourceWithholdResolver`).
 * The restriction is applied to the descriptors BEFORE arbitration, not to
 * the winner after it. Filtering the winner reads the same but fails open:
 * a non-picker client descriptor declaring one of Desktop's values ahead of
 * Desktop would win `resolveEntrypointOwners`' first-declaration-wins race,
 * and the filter would then drop that value from the map entirely instead
 * of falling through to the picker that also declares it, silently
 * restoring the very defect this map exists to fix. Arbitrating within the
 * picker-named set cannot lose a picker's claim to a non-picker.
 * `resolveEntrypointOwners` is reused rather than reimplemented so the
 * first-declaration-wins arbitration for a value two plugins claim stays in
 * one place; its `configured` flag is irrelevant here (a source that is not
 * configured contributes no rows to withhold) so the predicate is constant.
 *
 * @ref LLP 0346#entrypoint-refinement [implements]: entrypoint ownership is read off the same manifest declaration the backfill gate reads, never a core table
 * @param {Pick<PluginCatalog, 'clientDescriptors' | 'pickerDescriptors'>} catalog
 * @returns {Map<string, string>}
 */
export function clientEntrypointOwnersFromCatalog(catalog) {
  /** @type {Map<string, string>} */
  const out = new Map()
  const pickerNamed = [...(catalog.clientDescriptors?.values() ?? [])].filter((descriptor) =>
    catalog.pickerDescriptors?.has(descriptor.name)
  )
  const owners = resolveEntrypointOwners(pickerNamed, () => true)
  for (const [entrypoint, owner] of owners) out.set(entrypoint, owner.client)
  return out
}
