// @ts-check
import os from 'node:os'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'
import { readSettings, editSetting } from '../../../../src/core/config/jsonc_settings.js'
import { dataRoots } from './paths.js'

/** @import { JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */
/** @param {NodeJS.ProcessEnv} env */
export function receiptPath(env) { return path.join(env.COPILOT_HOME || path.join(env.HOME ?? os.homedir(), '.copilot'), 'hypaware.json') }

/** @param {NodeJS.ProcessEnv} env @param {Record<string, unknown>} settings */
export function checkCompatibility(env, settings) {
  const prefix = 'chat.agentHost.otel.'
  const protocol = String(env.OTEL_EXPORTER_OTLP_PROTOCOL ?? env.COPILOT_OTEL_PROTOCOL ?? settings[prefix + 'otlpProtocol'] ?? '').trim().toLowerCase()
  const exporter = env.COPILOT_OTEL_EXPORTER_TYPE ?? settings[prefix + 'exporterType']
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? env.COPILOT_OTEL_ENDPOINT ?? settings[prefix + 'otlpEndpoint']
  if (endpoint && (['http/protobuf', 'grpc', 'http/grpc'].includes(protocol) || exporter === 'otlp-grpc')) throw new Error('copilot_exporter_conflict: Agent Host DB fan-out requires HTTP JSON; preserve the existing destination and configure a compatible protocol explicitly')
  for (const name of ['COPILOT_OTEL_DB_SPAN_EXPORTER_ENABLED', 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']) {
    if (env[name] !== undefined && !['true', '1'].includes(env[name].toLowerCase())) throw new Error(`copilot_environment_conflict: ${name} disables the requested database/content pipeline`)
  }
}

/** @param {{ env: NodeJS.ProcessEnv, config?: JsonObject, dryRun?: boolean, version: string }} opts */
export async function attachCopilot(opts) {
  const settingsPath = receiptPath(opts.env)
  const receipt = await readSettings(settingsPath)
  const previous = receipt.value._hypaware
  if (previous !== undefined && (!previous?.managed || !Array.isArray(previous.managed.settings_files))) throw new Error('copilot_receipt_invalid')
  const priorFiles = previous?.managed?.settings_files ?? []
  const records = new Map(priorFiles.map(record => [record.path, record]))
  const writes = []
  const keys = ['github.copilot.chat.otel.dbSpanExporter.enabled', 'chat.agentHost.otel.dbSpanExporter.enabled', 'chat.agentHost.otel.captureContent']
  for (const root of dataRoots(opts.env, opts.config)) {
    if (!opts.config?.user_data_dirs) {
      try {
        if (!(await stat(root)).isDirectory()) continue
      } catch (err) {
        if (err?.code === 'ENOENT') continue
        throw err
      }
    }
    const file = path.join(root, 'User', 'settings.json')
    const read = await readSettings(file)
    checkCompatibility(opts.env, read.value)
    const prior = records.get(file)
    const record = { path: file, managed: { ...prior?.managed }, previous: { ...prior?.previous } }
    let text = read.text
    for (const key of keys) {
      if (read.value[key] === true) continue
      if (Object.hasOwn(read.value, key)) record.previous[key] = read.value[key]
      else delete record.previous[key]
      record.managed[key] = true
      text = editSetting(text, key, true)
    }
    records.set(file, record)
    writes.push({ file, read, text })
  }
  if (!writes.length) throw new Error('copilot_installation_missing: select a VS Code user-data root with copilot.user_data_dirs')
  if (records.size > 64) throw new Error('settings_undo_limit')
  const marker = { version: opts.version, mode: 'database', attached_at: previous?.attached_at ?? new Date().toISOString(), managed: { settings_files: [...records.values()] } }
  const changed = writes.some(w => w.text !== w.read.text) || JSON.stringify(previous) !== JSON.stringify(marker)
  if (!opts.dryRun && changed) {
    // Write the undo journal before settings. An interrupted attach remains
    // detachable, but its preparing marker never admits recording.
    await atomicWriteFile(settingsPath, JSON.stringify({ ...receipt.value, _hypaware: { ...marker, mode: 'preparing' } }, null, 2) + '\n', { mode: 0o600, expectedMtimeMs: receipt.mtimeMs })
    for (const { file, read, text } of writes) if (text !== read.text) await atomicWriteFile(file, text, { expectedMtimeMs: read.mtimeMs })
    await atomicWriteFile(settingsPath, JSON.stringify({ ...receipt.value, _hypaware: marker }, null, 2) + '\n', { mode: 0o600 })
  }
  return { settingsPath, changed, files: writes.length }
}
