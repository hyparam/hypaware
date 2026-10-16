// @ts-check

import { LoggerProvider, logs } from '../../src/core/observability/runtime.js'

/**
 * Collect the log records emitted while `fn` runs, alongside its return value,
 * then put the global logger provider slot back.
 *
 * The part worth having once is the `finally`: a provider left installed
 * captures the next test's records into a dead array, and a suite reading a
 * counter off those records then asserts about a run it never observed.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ result: T, records: any[] }>}
 */
export async function withLogRecords(fn) {
  /** @type {any[]} */
  const records = []
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: [{ exportBatch: (/** @type {any[]} */ batch) => { records.push(...batch) } }],
  })
  logs.setGlobalLoggerProvider(provider)
  try {
    const result = await fn()
    return { result, records }
  } finally {
    await provider.shutdown()
  }
}
