// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { BackfillContribution, BackfillMaterializerContribution, BackfillMaterializerRegistry, BackfillRegistry } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Build the kernel-side `BackfillRegistry`. Plugins call
 * `register(contribution)` during activation; `hyp backfill list`,
 * `hyp backfill plan`, and `hyp backfill <provider...>` enumerate
 * providers through `list()` / `get()`. The registry is intentionally
 * narrow. The runner owns lifecycle and telemetry; the contribution's
 * `plan()` / `run()` own native discovery.
 *
 * @returns {BackfillRegistry}
 */
export function createBackfillRegistry() {
  /** @type {Map<string, BackfillContribution>} */
  const contributions = new Map()
  const log = getLogger('backfills')

  /**
   * `name` is read once and every later step uses that string, so the key
   * this registry stores under is the exact value it validated.
   * `contribution.name` is free to be an accessor answering differently each
   * time it is asked, and the key is both what `get()` addresses a provider by
   * and what `list()` now orders by. A second read landing in the Map leaves
   * neither checked: the validated name stops resolving, and the order comes
   * from a key nobody validated. That key does not even have to raise to be
   * wrong - `compareStrings` refuses a non-string, but `undefined` is the one
   * value `Array.prototype.sort` never hands a comparator, so it sorts last in
   * silence.
   *
   * `plugin` and `datasets` are read once for the same reason, even though
   * neither is a key: their second read used to be in the `backfill.register`
   * record below, which is after the `set`. A plugin property that answers
   * differently there logs a registration nobody performed, and one that
   * raises there leaves this registry holding a contribution while the loader
   * catches the throw and marks the plugin's whole activation failed
   * (`src/core/runtime/loader.js`). Every read of the plugin's object now
   * happens before the Map is touched, so nothing between validation and the
   * stored entry can still run plugin code.
   *
   * @param {BackfillContribution} contribution
   */
  function register(contribution) {
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('BackfillRegistry.register: contribution must be an object')
    }
    const name = contribution.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('BackfillRegistry.register: contribution.name must be a non-empty string')
    }
    const plugin = contribution.plugin
    if (typeof plugin !== 'string' || plugin.length === 0) {
      throw new TypeError(
        `BackfillRegistry.register: '${name}' missing plugin`
      )
    }
    const datasets = contribution.datasets
    if (!Array.isArray(datasets) || datasets.length === 0) {
      throw new TypeError(
        `BackfillRegistry.register: '${name}' datasets must be a non-empty array`
      )
    }
    if (typeof contribution.run !== 'function') {
      throw new TypeError(`BackfillRegistry.register: '${name}' missing run()`)
    }
    if (contribution.plan !== undefined && typeof contribution.plan !== 'function') {
      throw new TypeError(`BackfillRegistry.register: '${name}' plan must be a function when supplied`)
    }
    if (contributions.has(name)) {
      throw new Error(`BackfillRegistry.register: duplicate provider '${name}'`)
    }
    const datasetList = datasets.join(',')
    contributions.set(name, contribution)
    log.info('backfill.register', {
      [Attr.PLUGIN]: plugin,
      provider: name,
      datasets: datasetList,
    })
  }

  /** @param {string} name */
  function get(name) {
    return contributions.get(name)
  }

  /**
   * Every registered contribution, ordered by name.
   *
   * The order comes from the keys, not from `a.name`: the key is the name
   * this registry validated at registration, while `contribution.name` is a
   * live plugin property free to be an accessor. Reading it here would run
   * plugin code inside a comparator, where a throw escapes into every caller
   * of `list()` - the daemon's backfill sweep among them, which loses the
   * sweep for every provider rather than for one contribution (issue #1509).
   */
  function list() {
    return Array.from(contributions.keys())
      .sort(compareStrings)
      .map((name) => /** @type {BackfillContribution} */ (contributions.get(name)))
  }

  return { register, get, list }
}

/**
 * Build the dataset-materializer registry. Materializers are keyed by
 * `BackfillItem.kind`. The runner looks up the contributing
 * materializer for each yielded item and asks it to produce canonical
 * rows for the target dataset.
 *
 * @returns {BackfillMaterializerRegistry}
 */
export function createBackfillMaterializerRegistry() {
  /** @type {Map<string, BackfillMaterializerContribution>} */
  const contributions = new Map()
  const log = getLogger('backfill-materializers')

  /** @param {BackfillMaterializerContribution} contribution */
  function register(contribution) {
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('BackfillMaterializerRegistry.register: contribution must be an object')
    }
    if (typeof contribution.kind !== 'string' || contribution.kind.length === 0) {
      throw new TypeError('BackfillMaterializerRegistry.register: contribution.kind must be a non-empty string')
    }
    if (typeof contribution.dataset !== 'string' || contribution.dataset.length === 0) {
      throw new TypeError(
        `BackfillMaterializerRegistry.register: '${contribution.kind}' missing dataset`
      )
    }
    if (typeof contribution.plugin !== 'string' || contribution.plugin.length === 0) {
      throw new TypeError(
        `BackfillMaterializerRegistry.register: '${contribution.kind}' missing plugin`
      )
    }
    if (typeof contribution.materialize !== 'function') {
      throw new TypeError(
        `BackfillMaterializerRegistry.register: '${contribution.kind}' missing materialize()`
      )
    }
    if (contributions.has(contribution.kind)) {
      throw new Error(`BackfillMaterializerRegistry.register: duplicate kind '${contribution.kind}'`)
    }
    contributions.set(contribution.kind, contribution)
    log.info('backfill.materializer.register', {
      [Attr.PLUGIN]: contribution.plugin,
      kind: contribution.kind,
      [Attr.DATASET]: contribution.dataset,
    })
  }

  /** @param {string} kind */
  function get(kind) {
    return contributions.get(kind)
  }

  function list() {
    return Array.from(contributions.values()).sort((a, b) => compareStrings(a.kind, b.kind))
  }

  return { register, get, list }
}
