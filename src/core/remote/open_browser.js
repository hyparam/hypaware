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
    // A missing opener (e.g. no `xdg-open`) is delivered ASYNCHRONOUSLY as an
    // 'error' event, not a synchronous throw. Without a listener that becomes
    // an uncaught exception that crashes the process. Swallow it: the printed
    // URL and the loopback timeout are the real backstops (D8). The boolean
    // return is therefore best-effort, not a guarantee the browser opened.
    if (child && typeof child.on === 'function') child.on('error', () => {})
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
  // win32: NOT `cmd /c start <url>`. cmd treats `&` as a command separator, so
  // an unquoted authorize URL (always multi-param: redirect_uri, code_challenge,
  // state, ...) is truncated at the first `&`, opening a PKCE-less URL. rundll32
  // is spawned directly (no shell), so the URL reaches the handler verbatim.
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler'] }
  // Treat every other Unix as freedesktop (xdg-open). A missing xdg-open
  // surfaces as an async spawn 'error' event (swallowed above); the caller's
  // loopback waits and the URL is printed, so login still completes manually.
  return { command: 'xdg-open', args: [] }
}
