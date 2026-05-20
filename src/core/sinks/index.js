// @ts-check

/**
 * Public surface for blob-sink destination plugins. Re-exports the
 * kernel's `sink.encode_partition` wrapper so plugins can drop in the
 * common observability contract instead of re-implementing it.
 *
 * Plugins import via:
 *
 * ```js
 * import { encodePartition } from 'hypaware/core/sinks'
 * ```
 */

export { encodePartition } from './encoder.js'
