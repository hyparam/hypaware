// @ts-check

import { requireGascityRuntime } from './runtime.js'

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types'
 */

/**
 * `hyp gascity attach <city> [--api-url <url>]`
 *
 * Adds the named city to the source's running config and either
 * starts the source (first attach) or reloads it (subsequent
 * attaches). The kernel emits `source.start` / `source.reload` spans
 * around each call so the smoke can assert on lifecycle without
 * peeking at plugin internals.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runAttach(argv, ctx) {
  const parsed = parseAttachArgv(argv)
  if (parsed.error) {
    ctx.stderr.write(parsed.error + '\n')
    return 2
  }
  const runtime = requireGascityRuntime()
  const config = runtime.ctx.config ?? {}
  const citiesRaw = /** @type {unknown[]} */ (
    Array.isArray(config.cities) ? [...config.cities] : []
  )
  /** @type {Record<string, unknown>[]} */
  const cities = []
  let alreadyAttached = false
  for (const raw of citiesRaw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const entry = /** @type {Record<string, unknown>} */ (raw)
      if (entry.name === parsed.city) {
        alreadyAttached = true
        cities.push({ ...entry, ...(parsed.apiUrl ? { api_url: parsed.apiUrl } : {}) })
      } else {
        cities.push(entry)
      }
    }
  }
  if (!alreadyAttached) {
    /** @type {Record<string, unknown>} */
    const entry = { name: parsed.city }
    if (parsed.apiUrl) entry.api_url = parsed.apiUrl
    cities.push(entry)
  }
  // Mutate the activation config in place so the StartedSource's
  // `reload(ctx)` sees the new city set when the kernel re-invokes
  // through the same context reference.
  runtime.ctx.config = /** @type {import('../../../../collectivus-plugin-kernel-types').JsonObject} */ (
    { ...config, cities }
  )

  if (!runtime.started) {
    await runtime.sources.start('gascity', runtime.ctx)
    runtime.started = true
  } else {
    await runtime.sources.reload('gascity', runtime.ctx)
  }
  ctx.stdout.write(`attached gascity city '${parsed.city}'\n`)
  return 0
}

/**
 * `hyp gascity detach <city>`
 *
 * Drops the named city from the running config. If the source has not
 * yet been started, the command is a no-op. Otherwise the kernel
 * emits a `source.reload` span; the source's `reload` closes the
 * underlying subscription.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runDetach(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp gascity detach <city>\n')
    return 2
  }
  const city = argv[0]
  const runtime = requireGascityRuntime()
  const config = runtime.ctx.config ?? {}
  const citiesRaw = /** @type {unknown[]} */ (
    Array.isArray(config.cities) ? config.cities : []
  )
  const filtered = citiesRaw.filter(
    (raw) =>
      !(
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        /** @type {Record<string, unknown>} */ (raw).name === city
      )
  )
  runtime.ctx.config = /** @type {import('../../../../collectivus-plugin-kernel-types').JsonObject} */ (
    { ...config, cities: filtered }
  )
  if (runtime.started) {
    await runtime.sources.reload('gascity', runtime.ctx)
  }
  ctx.stdout.write(`detached gascity city '${city}'\n`)
  return 0
}

/**
 * `hyp gascity list`
 *
 * Print the currently attached city set. Returns the same data
 * whether the source is started or not so this can be invoked
 * before the first attach.
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runList(_argv, ctx) {
  const runtime = requireGascityRuntime()
  const config = runtime.ctx.config ?? {}
  const citiesRaw = /** @type {unknown[]} */ (
    Array.isArray(config.cities) ? config.cities : []
  )
  if (citiesRaw.length === 0) {
    ctx.stdout.write('No gascity cities attached.\n')
    return 0
  }
  for (const raw of citiesRaw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = /** @type {Record<string, unknown>} */ (raw)
    const name = typeof entry.name === 'string' ? entry.name : '<unknown>'
    const apiUrl = typeof entry.api_url === 'string' ? entry.api_url : ''
    ctx.stdout.write(apiUrl ? `  ${name}  (${apiUrl})\n` : `  ${name}\n`)
  }
  return 0
}

/**
 * @param {string[]} argv
 * @returns {{ city: string, apiUrl?: string } | { error: string, city?: undefined, apiUrl?: undefined }}
 */
function parseAttachArgv(argv) {
  /** @type {string | undefined} */
  let city
  /** @type {string | undefined} */
  let apiUrl
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--api-url') {
      const value = argv[i + 1]
      if (!value) return { error: 'hyp gascity attach: --api-url expects a value' }
      apiUrl = value
      i += 1
    } else if (token.startsWith('--')) {
      return { error: `hyp gascity attach: unknown option '${token}'` }
    } else if (!city) {
      city = token
    } else {
      return { error: `hyp gascity attach: unexpected argument '${token}'` }
    }
  }
  if (!city) return { error: 'usage: hyp gascity attach <city> [--api-url <url>]' }
  return apiUrl ? { city, apiUrl } : { city }
}
