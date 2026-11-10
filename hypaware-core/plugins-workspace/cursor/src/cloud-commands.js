// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'
import { stripManagedHooks } from '../../../../src/core/config/client_detach_disk.js'
import { createUsagePolicyResolver, isEqualOrDescendant } from '../../../../src/core/usage-policy/index.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { isPlainObject } from '../../../../src/core/util/json_util.js'
import { attachCursorHooks } from './attach.js'
import { cursorListenPort } from './config.js'
import { CURSOR_CLOUD_EVENTS } from './cloud.js'
import { connectCursorCloud, cursorCloudConnectionPath, readCursorCloudConnection } from './cloud-state.js'
import { CursorCloudError, readCursorCloudMetadata } from './cloud-client.js'

/** @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CursorCloudConnection } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js' */

/** @param {CursorCloudConnection} connection */
async function cloudHooksPath(connection) {
  const dir = path.join(connection.cwd, '.cursor')
  try {
    if (!isEqualOrDescendant(await fs.realpath(dir), connection.cwd)) throw new CursorCloudError('cloud_hooks_scope')
  } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
  const file = path.join(dir, 'hooks.json')
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new CursorCloudError('cloud_hooks_scope')
  } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
  return file
}

/** @param {CursorCloudConnection} connection */
async function removeCloudHooks(connection) {
  const file = await cloudHooksPath(connection)
  try {
    const mtime = (await fs.stat(file)).mtimeMs
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!isPlainObject(value) || !isPlainObject(value._hypaware) || value._hypaware.scope !== 'cursor-cloud' ||
        !isPlainObject(value._hypaware.managed) || !Array.isArray(value._hypaware.managed.hook_entries)) return
    stripManagedHooks(value, value._hypaware.managed.hook_entries)
    delete value._hypaware
    await atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, expectedMtimeMs: mtime })
  } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw new CursorCloudError('cloud_hooks_cleanup_failed') }
}

/** @param {number} port */
async function listener(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500), redirect: 'error' })
    // The listener's own response is a small fixed object, not captured data.
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 8192) return undefined
    if (!response.body) return undefined
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 8192 || chunks.length >= 32) return undefined
      chunks.push(chunk)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return isPlainObject(value) ? value : undefined
  } catch { return undefined }
}

/**
 * @param {CursorCloudConnection} connection
 * @param {NodeJS.ProcessEnv} env
 * @param {number} port
 * @ref LLP 0593#runtime: detach the existing foreground daemon, whose bounded staged-restart handling is shared with containers.
 */
export async function startCursorCloudDaemon(connection, env, port) {
  const metadata = await readCursorCloudMetadata(env)
  if (metadata.agentId !== connection.agentId || metadata.repository !== connection.repository) throw new CursorCloudError('cloud_metadata_scope')
  const existing = await listener(port)
  if (existing) {
    if (existing.name !== 'hypaware/cursor' || existing.mode !== 'cloud' || existing.agent_id !== connection.agentId || existing.cwd !== connection.cwd) throw new CursorCloudError('cloud_listener_conflict')
    if (existing.status !== 'ready') throw new CursorCloudError('cloud_collector_starting_try_again')
    return { already_running: true }
  }
  const childEnv = { ...env }
  childEnv.HYP_HOME = path.resolve(readObservabilityEnv(env).hypHome)
  if (childEnv.HYP_CONFIG) childEnv.HYP_CONFIG = path.resolve(childEnv.HYP_CONFIG)
  delete childEnv.HYP_CI_TOKEN
  // This detached process has no service manager or Node IPC parent to relaunch it.
  for (const key of ['INVOCATION_ID', 'XPC_SERVICE_NAME', 'HYP_SUPERVISED', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']) delete childEnv[key]
  const bin = fileURLToPath(new URL('../../../../bin/hypaware.js', import.meta.url))
  const child = spawn(process.execPath, [bin, 'daemon', 'run'], { cwd: connection.cwd, env: childEnv, detached: true, stdio: 'ignore' })
  let failed = false
  child.once('error', () => { failed = true })
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = await listener(port)
      if (current?.name === 'hypaware/cursor' && current.status === 'ready' && current.mode === 'cloud' && current.agent_id === connection.agentId && current.cwd === connection.cwd) {
        child.unref()
        return { already_running: false }
      }
      if (failed || child.exitCode !== null || child.signalCode !== null) throw new CursorCloudError('cloud_daemon_start_failed')
      await delay(250)
    }
    throw new CursorCloudError('cloud_daemon_start_timeout')
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    child.unref()
    throw error
  }
}

/** @param {PluginActivationContext} ctx */
export function registerCursorCloudCommands(ctx) {
  const stateDir = ctx.paths.stateDir
  ctx.commands.registerGroup?.({ name: 'cursor-cloud', summary: 'Record the current Cursor Cloud VM' })
  ctx.commands.register({
    name: 'cursor-cloud connect', summary: 'Connect this Cloud agent and install owned repository hooks',
    usage: 'hyp cursor-cloud connect [--dry-run]',
    async run(argv, command) {
      const parsed = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' } }, allowPositionals: false })
      if ((command.platform ?? process.platform) !== 'linux') throw new CursorCloudError('cloud_requires_managed_linux_vm')
      const obs = readObservabilityEnv(command.env)
      const policy = createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(obs.stateDir) })
      const root = await fs.realpath(command.cwd)
      if (policy.resolve(root).class === 'ignore') throw new CursorCloudError('cloud_workspace_ignored')
      const ignored = new SessionIgnoreSet(obs.stateDir, ctx.log)
      const dryRun = parsed.values['dry-run'] === true
      const connection = await connectCursorCloud(stateDir, root, command.env, { dryRun,
        async beforeSave(connection) {
          if (ignored.loadError || ignored.has(connection.agentId)) throw new CursorCloudError('cloud_session_ignored')
          await attachCursorHooks({ endpoint: `http://127.0.0.1:${cursorListenPort(ctx.config)}`, version: ctx.plugin.version,
            settingsPath: await cloudHooksPath(connection), cloud: true, events: CURSOR_CLOUD_EVENTS, dryRun,
          })
        },
      })
      ctx.log.info('cursor.cloud.connected', { component: 'plugin.cursor', operation: 'cloud.connect', status: dryRun ? 'dry_run' : 'ok' })
      command.stdout.write(JSON.stringify({ connected: !dryRun, dry_run: dryRun, agent_id: connection.agentId, cwd: connection.cwd }) + '\n')
      return 0
    },
  })
  ctx.commands.register({
    name: 'cursor-cloud disconnect', summary: 'Revoke Cloud capture and remove only owned repository hooks', usage: 'hyp cursor-cloud disconnect',
    async run(argv, command) {
      if (argv.length) throw new CursorCloudError('cloud_disconnect_takes_no_arguments')
      const connection = await readCursorCloudConnection(stateDir).catch(() => undefined)
      // Revoke first, even if later hook cleanup fails or the old grant is corrupt.
      await fs.rm(cursorCloudConnectionPath(stateDir), { force: true })
      if (connection) await removeCloudHooks(connection)
      ctx.log.info('cursor.cloud.disconnected', { component: 'plugin.cursor', operation: 'cloud.disconnect', status: 'ok' })
      command.stdout.write('Cursor Cloud disconnected. Captured data remains.\n')
      return 0
    },
  })
  ctx.commands.register({
    name: 'cursor-cloud status', summary: 'Show the locally connected Cursor Cloud agent', usage: 'hyp cursor-cloud status',
    async run(argv, command) {
      if (argv.length) throw new CursorCloudError('cloud_status_takes_no_arguments')
      const connection = await readCursorCloudConnection(stateDir)
      command.stdout.write(JSON.stringify(connection ? { connected: true, agent_id: connection.agentId, cwd: connection.cwd, repository: connection.repository } : { connected: false }) + '\n')
      return 0
    },
  })
  ctx.commands.register({
    name: 'cursor-cloud start', summary: 'Start a detached collector for the connected Cloud VM', usage: 'hyp cursor-cloud start',
    async run(argv, command) {
      if (argv.length) throw new CursorCloudError('cloud_start_takes_no_arguments')
      if ((command.platform ?? process.platform) !== 'linux') throw new CursorCloudError('cloud_requires_managed_linux_vm')
      if (!command.config.plugins?.some(plugin => plugin.name === '@hypaware/cursor' && plugin.enabled !== false)) throw new CursorCloudError('cloud_enable_cursor_with_hyp_setup_first')
      if (!command.env.CURSOR_API_KEY?.trim()) throw new CursorCloudError('cloud_api_key_missing_or_invalid')
      const connection = await readCursorCloudConnection(stateDir)
      if (!connection) throw new CursorCloudError('cloud_connect_first')
      const result = await startCursorCloudDaemon(connection, command.env, cursorListenPort(ctx.config))
      ctx.log.info('cursor.cloud.started', { component: 'plugin.cursor', operation: 'cloud.start', status: 'ok', ...result })
      command.stdout.write("Cursor Cloud collector is running. Check health with 'hyp status --json', deliver with 'hyp sync --yes', and stop with 'hyp cursor-cloud disconnect' then 'hyp daemon stop'.\n")
      return 0
    },
  })
}
