// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Check the page's scope label, not the dates or accuracy of its claims.
 * @param {string} text @returns {string | undefined}
 */
export function pageTimeZone(text) {
  let fenced = false
  for (const line of text.split(/\r?\n/).slice(0, 40)) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced
    if (fenced) continue
    const match = /^(?:\*\*)?Time zone:(?:\*\*)?\s*(\S+)\s*$/.exec(line)
    if (!match) continue
    try {
      new Intl.DateTimeFormat('en', { timeZone: match[1] })
      // Require an unambiguous UTC or IANA name rather than PST/EST aliases.
      if (match[1] === 'UTC' || match[1].includes('/')) return match[1]
    } catch { /* Invalid labels are reported as missing by the caller. */ }
  }
}

/** @param {string} target @returns {Promise<string[]>} */
export async function checkTimeZones(target) {
  const stat = await fs.stat(target)
  const files = stat.isDirectory()
    ? (await fs.readdir(target)).filter(name => name.endsWith('.md')).sort().map(name => path.join(target, name))
    : [target]
  if (!files.length) return ['no Markdown pages found']
  const failures = []
  for (const file of files) {
    const handle = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(8192)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (!pageTimeZone(buffer.subarray(0, bytesRead).toString('utf8'))) {
        failures.push(`${path.basename(file)}: add "Time zone: UTC" or an IANA zone in the opening scope block`)
      }
    } finally { await handle.close() }
  }
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const failures = await checkTimeZones(process.argv[2] ?? '.')
    if (failures.length) {
      process.stderr.write(failures.join('\n') + '\n')
      process.exitCode = 1
    } else process.stdout.write('Report page time zones: ok\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
