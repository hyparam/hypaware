import fs from 'node:fs'
import path from 'node:path'

/**
 * @import { LedgerEntry, UploadSignal } from './upload.d.ts'
 */

const LEDGER_FILENAME = '.upload-ledger.jsonl'

/**
 * Build the ledger key for a (service, signal, date) triple.
 *
 * @param {string} service
 * @param {UploadSignal} signal
 * @param {string} date YYYY-MM-DD UTC
 * @returns {string}
 */
function ledgerKey(service, signal, date) {
  return `${service}\0${signal}\0${date}`
}

/**
 * Read all committed entries from the ledger into a Set keyed by
 * (service, signal, date). Missing file yields an empty set.
 *
 * @param {string} outputDir
 * @returns {Set<string>}
 */
export function readLedger(outputDir) {
  const filePath = path.join(outputDir, LEDGER_FILENAME)
  /** @type {Set<string>} */
  const committed = new Set()
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    const { code } = /** @type {NodeJS.ErrnoException} */ (err)
    if (code === 'ENOENT') return committed
    throw err
  }
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (entry && entry.status === 'committed') {
        committed.add(ledgerKey(entry.service, entry.signal, entry.date))
      }
    } catch {
      // Skip malformed lines; the ledger is recovery state, not auth.
    }
  }
  return committed
}

/**
 * Append one committed entry. Uses appendFileSync + fsync so the entry
 * survives a process crash immediately after upload completes.
 *
 * @param {string} outputDir
 * @param {LedgerEntry} entry
 * @returns {void}
 */
export function appendLedger(outputDir, entry) {
  const filePath = path.join(outputDir, LEDGER_FILENAME)
  const fd = fs.openSync(filePath, 'a')
  try {
    fs.writeSync(fd, JSON.stringify(entry) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * @param {Set<string>} committed
 * @param {string} service
 * @param {UploadSignal} signal
 * @param {string} date
 * @returns {boolean}
 */
export function isCommitted(committed, service, signal, date) {
  return committed.has(ledgerKey(service, signal, date))
}
