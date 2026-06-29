// @ts-check

import { spawn } from 'node:child_process'
import process from 'node:process'

/**
 * Spawn the platform browser opener for `url`, detached, so the login flow
 * does not hold the opener process. Returns whether an opener was found; the
 * caller prints the URL for manual open when it was not (or under
 * `--no-browser`). The static `--token-file`/stdin path remains the headless
 * escape hatch (LLP 0046 D8); no device-code flow.
 *
 * @param {string} url
 * @param {{ platform?: NodeJS.Platform, spawnImpl?: typeof spawn }} [opts]
 * @returns {boolean}
 * @ref LLP 0046#d8 [implements]: print-the-URL fallback when no opener; static token stays the headless path
 */
export function openBrowser(url, opts = {}) {
  const platform = opts.platform ?? process.platform
  const spawnImpl = opts.spawnImpl ?? spawn
  const opener = openerFor(platform)
  if (!opener) return false
  try {
    const child = spawnImpl(opener.command, [...opener.args, url], {
      detached: true,
      stdio: 'ignore',
    })
    if (child && typeof child.unref === 'function') child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * @param {NodeJS.Platform} platform
 * @returns {{ command: string, args: string[] } | undefined}
 */
function openerFor(platform) {
  if (platform === 'darwin') return { command: 'open', args: [] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] }
  // Treat every other Unix as freedesktop (xdg-open). A missing xdg-open
  // surfaces as a spawn error and falls back to printing the URL.
  return { command: 'xdg-open', args: [] }
}
