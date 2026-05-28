// @ts-check

import { Attr, getLogger } from '../observability/index.js'

/**
 * @import { BackfillContribution, BackfillMaterializerContribution, BackfillMaterializerRegistry, BackfillRegistry } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Build the kernel-side `BackfillRegistry`. Plugins call
 * `register(contribution)` during activation; `hyp backfill list`,
 * `hyp backfill plan`, and `hyp backfill <provider...>` enumerate
 * providers through `list()` / `get()`. The registry is intentionally
 * narrow — the runner owns lifecycle and telemetry; the contribution's
 * `plan()` / `run()` own native discovery.
 *
 * @returns {BackfillRegistry}
 */
export function createBackfillRegistry() {
  /** @type {Map<string, BackfillContribution>} */
  const contributions = new Map()
  const log = getLogger('backfills')

  /** @param {BackfillContribution} contribution */
  function register(contribution) {
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('BackfillRegistry.register: contribution must be an object')
    }
    if (typeof contribution.name !== 'string' || contribution.name.length === 0) {
      throw new TypeError('BackfillRegistry.register: contribution.name must be a non-empty string')
    }
    if (typeof contribution.plugin !== 'string' || contribution.plugin.length === 0) {
      throw new TypeError(
        `BackfillRegistry.register: '${contribution.name}' missing plugin`
      )
    }
    if (!Array.isArray(contribution.datasets) || contribution.datasets.length === 0) {
      throw new TypeError(
        `BackfillRegistry.register: '${contribution.name}' datasets must be a non-empty array`
      )
    }
    if (typeof contribution.run !== 'function') {
      throw new TypeError(`BackfillRegistry.register: '${contribution.name}' missing run()`)
    }
    if (contribution.plan !== undefined && typeof contribution.plan !== 'function') {
      throw new TypeError(`BackfillRegistry.register: '${contribution.name}' plan must be a function when supplied`)
    }
    if (contributions.has(contribution.name)) {
      throw new Error(`BackfillRegistry.register: duplicate provider '${contribution.name}'`)
    }
    contributions.set(contribution.name, contribution)
    log.info('backfill.register', {
      [Attr.PLUGIN]: contribution.plugin,
      provider: contribution.name,
      datasets: contribution.datasets.join(','),
    })
  }

  /** @param {string} name */
  function get(name) {
    return contributions.get(name)
  }

  function list() {
    return Array.from(contributions.values()).sort((a, b) => a.name.localeCompare(b.name))
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
    return Array.from(contributions.values()).sort((a, b) => a.kind.localeCompare(b.kind))
  }

  return { register, get, list }
}
