// @ts-check

/** @typedef {import('../../../collectivus-plugin-kernel-types').QueryRegistry} QueryRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').DatasetRegistration} DatasetRegistration */

/**
 * In-memory dataset registry. Built-in core registers **zero** datasets;
 * every dataset (`logs`, `traces`, `metrics`, `ai_gateway_messages`,
 * `gascity_messages`, …) is contributed by a plugin during activation.
 *
 * The kernel surfaces this registry through `ctx.query` on every
 * activation context and as `kernel.query` for the dispatcher.
 *
 * @returns {QueryRegistry}
 */
export function createQueryRegistry() {
  /** @type {Map<string, DatasetRegistration>} */
  const datasets = new Map()

  return {
    registerDataset(dataset) {
      if (!dataset || typeof dataset.name !== 'string' || dataset.name.length === 0) {
        throw new Error('registerDataset: dataset.name is required')
      }
      if (datasets.has(dataset.name)) {
        throw new Error(`registerDataset: dataset '${dataset.name}' already registered`)
      }
      datasets.set(dataset.name, dataset)
    },
    getDataset(name) {
      return datasets.get(name)
    },
    listDatasets() {
      return Array.from(datasets.values()).sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}
