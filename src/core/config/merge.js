// @ts-check

/**
 * @import { HypAwareV2Config } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ConfigLayerDrop, ConfigMergeResult, ConfigValidationError } from '../../../src/core/config/types.js'
 */

/**
 * Merge the two config layers a joined gateway boots:
 *
 * - **central** — server-owned, authoritative/locked (the applied slot,
 *   or the join seed before the first pull).
 * - **local** — user-owned, additive-only (`hypaware-config.json`).
 *
 * The whole central document wins: it contributes every key it names and
 * **locks** it; the local layer may only contribute keys central omits.
 * A local entry that collides with a central-named key is **dropped**
 * (recorded in `drops`), never merged in — the central layer is
 * sacrosanct and always boots. With no central layer, `effective = local`
 * verbatim, so a host that never joined is completely unaffected.
 *
 * `query{}` is structurally **local-only** (machine-specific storage —
 * cache dir, maintenance, retention): the local layer always owns it, and
 * a `query` block appearing in the central document is ignored
 * (`centralQueryIgnored`), surfaced in `hyp status`, never merged.
 *
 * @param {HypAwareV2Config | null} central
 * @param {HypAwareV2Config | null} local
 * @returns {ConfigMergeResult}
 * @ref LLP 0031#merge-model [implements] — union keyed per section; central wins and locks; local contributes only the keys central omits
 */
export function mergeConfigLayers(central, local) {
  /** @type {ConfigLayerDrop[]} */
  const drops = []

  // No central layer: the local file *is* the effective config. Nothing
  // is authoritative, nothing can collide, query stays where it is.
  if (!central) {
    return { effective: local ?? { version: 2 }, drops, centralQueryIgnored: false }
  }

  /** @type {HypAwareV2Config} */
  const effective = { version: 2 }

  // plugins[] — keyed by plugin name.
  const centralPlugins = central.plugins ?? []
  const centralPluginNames = new Set(centralPlugins.map((p) => p.name))
  const plugins = [...centralPlugins]
  for (const entry of local?.plugins ?? []) {
    if (centralPluginNames.has(entry.name)) {
      drops.push({ section: 'plugins', key: entry.name, reason: 'collides_with_central' })
      continue
    }
    plugins.push(entry)
  }
  if (plugins.length > 0) effective.plugins = plugins

  // sinks{} — keyed by instance name.
  const centralSinks = central.sinks ?? {}
  /** @type {NonNullable<HypAwareV2Config['sinks']>} */
  const sinks = { ...centralSinks }
  for (const [name, sink] of Object.entries(local?.sinks ?? {})) {
    if (Object.prototype.hasOwnProperty.call(centralSinks, name)) {
      drops.push({ section: 'sinks', key: name, reason: 'collides_with_central' })
      continue
    }
    sinks[name] = sink
  }
  if (Object.keys(sinks).length > 0) effective.sinks = sinks

  // disambiguate{} — keyed by capability name; central wins per capability.
  const centralDisambiguate = central.disambiguate ?? {}
  /** @type {Record<string, string>} */
  const disambiguate = { ...centralDisambiguate }
  for (const [capability, plugin] of Object.entries(local?.disambiguate ?? {})) {
    if (Object.prototype.hasOwnProperty.call(centralDisambiguate, capability)) {
      drops.push({ section: 'disambiguate', key: capability, reason: 'collides_with_central' })
      continue
    }
    disambiguate[capability] = plugin
  }
  if (Object.keys(disambiguate).length > 0) effective.disambiguate = disambiguate

  // query{} — local-only. A central query block is ignored + flagged.
  const centralQueryIgnored = central.query !== undefined
  if (local?.query !== undefined) effective.query = local.query

  return { effective, drops, centralQueryIgnored }
}

/**
 * Resolve the effective config a joined gateway boots: the structural
 * key-merge of {@link mergeConfigLayers} *plus* a validation pass that
 * drops local additions which make the merge invalid (a capability tie a
 * local plugin introduces, an additive sink that references an unknown or
 * incompatible plugin, etc.). Collisions are still dropped by the key
 * merge; this pass catches the *valid-in-isolation* local entries that
 * only break things once layered onto the central document.
 *
 * The central layer is sacrosanct: validation runs against the central
 * baseline, so an error the central document carries on its own never
 * causes a drop, and central entries are never candidates. Local
 * additions are added back one at a time, in config order, and kept only
 * when they introduce no error beyond that baseline — a maximal valid
 * additive subset. The central layer always boots; a bad local addition
 * is surfaced (a drop + `hyp status`), never a boot failure.
 *
 * With no central layer, this is a pure passthrough of
 * {@link mergeConfigLayers} — a host that never joined is never validated
 * or pruned, so its behaviour is byte-for-byte unchanged.
 *
 * @param {{
 *   central: HypAwareV2Config | null,
 *   local: HypAwareV2Config | null,
 *   validate: (config: HypAwareV2Config) => ConfigValidationError[],
 * }} args
 * @returns {ConfigMergeResult}
 * @ref LLP 0031#central-layer-is-sacrosanct [implements] — drop local entries that invalidate the merge; central always boots
 */
export function resolveLayeredConfig({ central, local, validate }) {
  const base = mergeConfigLayers(central, local)
  // No central layer ⇒ nothing is authoritative, nothing to validate
  // against: the local file is the effective config verbatim.
  if (!central) return base

  const centralKeys = {
    plugins: new Set((central.plugins ?? []).map((p) => p.name)),
    sinks: new Set(Object.keys(central.sinks ?? {})),
    disambiguate: new Set(Object.keys(central.disambiguate ?? {})),
  }

  // Start from the central layer alone; query is local-only so it carries
  // over from the structural merge. Then add back each surviving local
  // entry only if it keeps the merge valid.
  /** @type {HypAwareV2Config} */
  let current = { version: 2 }
  if ((central.plugins ?? []).length > 0) current.plugins = [...(central.plugins ?? [])]
  if (Object.keys(central.sinks ?? {}).length > 0) current.sinks = { ...central.sinks }
  if (Object.keys(central.disambiguate ?? {}).length > 0) current.disambiguate = { ...central.disambiguate }
  if (base.effective.query !== undefined) current.query = base.effective.query

  /** @type {ConfigLayerDrop[]} */
  const drops = [...base.drops]
  let currentSignatures = errorSignatures(validate(current))

  for (const cand of additiveLocalEntries(local, centralKeys)) {
    const trial = cloneShallow(current)
    cand.add(trial)
    const trialErrors = validate(trial)
    const introduced = trialErrors.filter((e) => !currentSignatures.has(signatureOf(e)))
    if (introduced.length === 0) {
      current = trial
      currentSignatures = errorSignatures(trialErrors)
    } else {
      drops.push({
        section: cand.section,
        key: cand.key,
        reason: 'invalid_merge',
        detail: introduced[0].errorKind,
      })
    }
  }

  return { effective: current, drops, centralQueryIgnored: base.centralQueryIgnored }
}

/**
 * The local entries that survived the structural collision merge (their
 * key is not owned by the central layer) — the add-back candidates, in
 * config order: plugins, then sinks, then disambiguate.
 *
 * @param {HypAwareV2Config | null} local
 * @param {{ plugins: Set<string>, sinks: Set<string>, disambiguate: Set<string> }} centralKeys
 * @returns {Array<{ section: ConfigLayerDrop['section'], key: string, add: (cfg: HypAwareV2Config) => void }>}
 */
function additiveLocalEntries(local, centralKeys) {
  /** @type {Array<{ section: ConfigLayerDrop['section'], key: string, add: (cfg: HypAwareV2Config) => void }>} */
  const out = []
  for (const entry of local?.plugins ?? []) {
    if (centralKeys.plugins.has(entry.name)) continue
    out.push({ section: 'plugins', key: entry.name, add: (cfg) => { (cfg.plugins ??= []).push(entry) } })
  }
  for (const [name, sink] of Object.entries(local?.sinks ?? {})) {
    if (centralKeys.sinks.has(name)) continue
    out.push({ section: 'sinks', key: name, add: (cfg) => { (cfg.sinks ??= {})[name] = sink } })
  }
  for (const [capability, plugin] of Object.entries(local?.disambiguate ?? {})) {
    if (centralKeys.disambiguate.has(capability)) continue
    out.push({ section: 'disambiguate', key: capability, add: (cfg) => { (cfg.disambiguate ??= {})[capability] = plugin } })
  }
  return out
}

/**
 * Shallow-clone a config's section containers. Entry objects are shared
 * (the merge never mutates an entry's contents), so cloning the arrays /
 * maps is enough to trial an add-back without disturbing `current`.
 *
 * @param {HypAwareV2Config} cfg
 * @returns {HypAwareV2Config}
 */
function cloneShallow(cfg) {
  /** @type {HypAwareV2Config} */
  const out = { version: 2 }
  if (cfg.plugins) out.plugins = [...cfg.plugins]
  if (cfg.sinks) out.sinks = { ...cfg.sinks }
  if (cfg.disambiguate) out.disambiguate = { ...cfg.disambiguate }
  if (cfg.query !== undefined) out.query = cfg.query
  return out
}

/**
 * @param {ConfigValidationError} e
 * @returns {string}
 */
function signatureOf(e) {
  return `${e.errorKind} ${e.pointer ?? ''}`
}

/**
 * @param {ConfigValidationError[]} errors
 * @returns {Set<string>}
 */
function errorSignatures(errors) {
  return new Set(errors.map(signatureOf))
}
