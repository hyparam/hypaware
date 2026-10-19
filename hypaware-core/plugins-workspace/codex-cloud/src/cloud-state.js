// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { atomicWriteJson } from '../../../../src/core/util/index.js'
import { acquireCloudAuth, CloudError } from './cloud-auth.js'

/** @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CloudConnection, CloudOriginator } from '../../../../hypaware-core/plugins-workspace/codex-cloud/src/types.js' */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @type {CloudOriginator[]} */
export const DEFAULT_CLOUD_ORIGINS = ['codex_cloud']

/** @param {unknown} value @returns {CloudOriginator[]} */
export function validateCloudOrigins(value) {
  const supported = ['codex_cloud', 'codex_work_web', 'codex_work_mobile']
  if (!Array.isArray(value) || !value.length || value.length > supported.length
    || value.some(origin => !supported.includes(origin)) || new Set(value).size !== value.length) {
    throw new CloudError('choose_codex_cloud_codex_work_web_or_codex_work_mobile')
  }
  return /** @type {CloudOriginator[]} */ (value)
}

/** @param {string} stateDir */
export function cloudConnectionPath(stateDir) { return path.join(stateDir, 'cloud-connection.json') }

/** @param {string} stateDir @returns {Promise<CloudConnection | undefined>} */
export async function readCloudConnection(stateDir) {
  try {
    const file = await fs.open(cloudConnectionPath(stateDir), 'r')
    let text
    try {
      if ((await file.stat()).size > 8192) throw new CloudError('invalid_cloud_connection')
      text = await file.readFile('utf8')
    } finally { await file.close() }
    const value = JSON.parse(text)
    if (!/^[a-f0-9]{64}$/.test(value.accountHash)) throw new CloudError('invalid_cloud_connection')
    if (value.origins !== undefined) validateCloudOrigins(value.origins)
    if (value.version === 1) validateCloudThreads(value.threads)
    else if (value.version !== 2 || value.scope !== 'account' || value.threads !== undefined
      || (value.since !== undefined && (typeof value.since !== 'string'
        || !Number.isFinite(Date.parse(value.since))))) throw new CloudError('invalid_cloud_connection')
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new CloudError('invalid_cloud_connection')
  }
}

/** @param {string[]} threads */
export function validateCloudThreads(threads) {
  if (!Array.isArray(threads) || !threads.length || threads.length > 20 || threads.some(id => !UUID.test(id)) || new Set(threads).size !== threads.length) {
    throw new CloudError('provide_1_to_20_unique_thread_ids')
  }
}

// @ref LLP 0511#decision: only an explicit local command grants cloud collection, never central config.
/**
 * @param {PluginActivationContext} ctx
 * @param {string} codexHome
 * @param {{acquire?: typeof acquireCloudAuth}} [deps]
 */
export function registerCloudCommands(ctx, codexHome, deps = {}) {
  const stateDir = ctx.paths.stateDir
  ctx.commands.registerGroup?.({ name: 'codex-cloud', summary: 'Manage beta local collection of Codex cloud chats' })
  ctx.commands.register({
    name: 'codex-cloud connect',
    summary: 'Connect cloud chats to the existing local ChatGPT login (beta)',
    usage: 'hyp codex-cloud connect (<thread-id>... | --all [--from-now]) [--origins <origin,...>]',
    async run(argv, command) {
      let parsed
      try {
        parsed = parseArgs({ args: argv, allowPositionals: true, options: {
          all: { type: 'boolean' }, 'from-now': { type: 'boolean' }, origins: { type: 'string' },
        } })
      } catch { throw new CloudError('invalid_connection_arguments') }
      const { values, positionals: threads } = parsed
      const all = values.all === true
      if ((all && threads.length) || (!all && values['from-now'])) throw new CloudError('use_thread_ids_or_all')
      if (!all) validateCloudThreads(threads)
      const origins = validateCloudOrigins(values.origins === undefined
        ? DEFAULT_CLOUD_ORIGINS : values.origins.split(',').map(value => value.trim()))
      const auth = await (deps.acquire ?? acquireCloudAuth)({ codexHome, env: ctx.env })
      const connection = all
        ? { version: 2, scope: 'account', accountHash: auth.accountHash, origins,
          ...(values['from-now'] ? { since: new Date().toISOString() } : {}) }
        : { version: 1, accountHash: auth.accountHash, threads, origins }
      await atomicWriteJson(cloudConnectionPath(stateDir), connection, { mode: 0o600, dirMode: 0o700 })
      command.stdout.write(`Beta Codex Cloud collection connected: ${all ? 'automatic discovery' : `${threads.length} cloud chat(s)`} for ${origins.join(', ')}. This replaces the previous selection. Run hyp backfill codex-cloud to import now; the daemon checks every five minutes. Imported records follow your existing export settings.\n`)
      return 0
    },
  })
  ctx.commands.register({
    name: 'codex-cloud disconnect', summary: 'Stop collecting connected cloud chats', usage: 'hyp codex-cloud disconnect',
    async run(argv, command) {
      if (argv.length) throw new CloudError('disconnect_takes_no_arguments')
      await fs.rm(cloudConnectionPath(stateDir), { force: true })
      command.stdout.write('Cloud collection disconnected. Previously recorded data remains.\n')
      return 0
    },
  })
  ctx.commands.register({
    name: 'codex-cloud status', summary: 'Show the local cloud chat selection', usage: 'hyp codex-cloud status',
    async run(argv, command) {
      if (argv.length) throw new CloudError('status_takes_no_arguments')
      const connection = await readCloudConnection(stateDir)
      command.stdout.write(JSON.stringify(connection ? { connected: true, origins: connection.origins ?? DEFAULT_CLOUD_ORIGINS, ...(connection.version === 2 ? { scope: 'account', since: connection.since ?? null } : { threads: connection.threads }) } : { connected: false }, null, 2) + '\n')
      return 0
    },
  })
}

// @ref LLP 0511#onboarding: a confirmed picker answer narrows first and preserves prior scope and history bounds.
/**
 * @param {{stateDir: string, codexHome: string, env: NodeJS.ProcessEnv, sources: string[]}} opts
 * @param {{acquire?: typeof acquireCloudAuth}} [deps]
 */
export async function configureCloudSelection(opts, deps = {}) {
  const current = await readCloudConnection(opts.stateDir)
  const previous = current?.origins ?? (current ? DEFAULT_CLOUD_ORIGINS : [])
  /** @type {CloudOriginator[]} */
  const desired = []
  if (opts.sources.includes('codex-cloud')) desired.push('codex_cloud')
  if (opts.sources.includes('chatgpt-work')) {
    const work = previous.filter(origin => origin !== 'codex_cloud')
    // An existing CLI grant to just web or mobile remains narrow on reconfigure.
    desired.push(...(work.length ? work : /** @type {CloudOriginator[]} */ (['codex_work_web', 'codex_work_mobile'])))
  }
  if (desired.length === previous.length && desired.every(origin => previous.includes(origin))) return
  const retained = previous.filter(origin => desired.includes(origin))
  if (current && retained.length !== previous.length) {
    if (retained.length) await atomicWriteJson(cloudConnectionPath(opts.stateDir), { ...current, origins: retained }, { mode: 0o600, dirMode: 0o700 })
    else await fs.rm(cloudConnectionPath(opts.stateDir), { force: true })
  }
  if (desired.every(origin => previous.includes(origin))) return
  const auth = await (deps.acquire ?? acquireCloudAuth)({ codexHome: opts.codexHome, env: opts.env,
    ...(current ? { accountHash: current.accountHash } : {}) })
  const connection = current ? { ...current, origins: desired }
    : { version: 2, scope: 'account', accountHash: auth.accountHash, origins: desired }
  await atomicWriteJson(cloudConnectionPath(opts.stateDir), connection, { mode: 0o600, dirMode: 0o700 })
}
