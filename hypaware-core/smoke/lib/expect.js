// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Read every JSONL record from files in `dir` whose basename starts
 * with `prefix`. Used by `core_boot_noop` (and future flows) to
 * scan traces/logs/metrics emitted by the JSONL exporters.
 *
 * @param {string} dir
 * @param {string} prefix
 * @returns {Promise<object[]>}
 */
async function readJsonlByPrefix(dir, prefix) {
  /** @type {string[]} */
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return []
    throw err
  }
  /** @type {object[]} */
  const all = []
  for (const entry of entries.sort()) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.jsonl')) continue
    const data = await fs.readFile(path.join(dir, entry), 'utf8')
    let lineNo = 0
    for (const line of data.split('\n')) {
      lineNo += 1
      if (!line) continue
      try {
        all.push(JSON.parse(line))
      } catch (err) {
        throw new Error(`expect: malformed JSON in ${entry}:${lineNo}: ${/** @type {Error} */ (err).message}`)
      }
    }
  }
  return all
}

/**
 * Build the `expect` toolkit handed to each smoke flow. Each method
 * returns plain records read straight off disk so the flow can use
 * ordinary array filters — exactly the language used in the design's
 * SQL assertions, ahead of `hyp query` existing.
 *
 * @param {{ telemetryDir: string, runId: string, smokeName: string }} ctx
 */
export function makeExpect(ctx) {
  return {
    runId: ctx.runId,
    smokeName: ctx.smokeName,
    telemetryDir: ctx.telemetryDir,
    async traces() { return readJsonlByPrefix(ctx.telemetryDir, 'traces-') },
    async logs() { return readJsonlByPrefix(ctx.telemetryDir, 'logs-') },
    async metrics() { return readJsonlByPrefix(ctx.telemetryDir, 'metrics-') },
    /**
     * Throw if `predicate(value)` is falsy. Failure messages include
     * the smoke name and telemetry path so the developer can re-open
     * the JSONL files manually after a failed run.
     *
     * @template T
     * @param {string} message
     * @param {T} value
     * @param {(v: T) => boolean} predicate
     */
    that(message, value, predicate) {
      let ok = false
      try { ok = !!predicate(value) } catch (err) {
        throw assertionError(ctx, message, value, err)
      }
      if (!ok) throw assertionError(ctx, message, value)
    },
  }
}

/**
 * @param {{ runId: string, smokeName: string, telemetryDir: string }} ctx
 * @param {string} message
 * @param {unknown} value
 * @param {unknown} [cause]
 */
function assertionError(ctx, message, value, cause) {
  const valuePreview = JSON.stringify(value, null, 2)
  const causeLine = cause instanceof Error ? `\n  cause: ${cause.message}` : ''
  const err = new Error(
    `${message}\n  value=${valuePreview}\n  smoke=${ctx.smokeName} dev_run_id=${ctx.runId}\n  telemetry=${ctx.telemetryDir}${causeLine}`
  )
  // @ts-ignore — attach context for the harness to surface
  err.detail = `re-open: ls ${ctx.telemetryDir}`
  return err
}
