import fs from 'node:fs/promises'
import os from 'node:os'
import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'
import { markActionRefused } from '../../../../src/core/config/action_refusal.js'
import { resolveConfigPath } from '../../../../src/core/runtime/boot.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'

export const LANGGRAPH_MARKER = '// HYPWARE_LANGGRAPH_RECORDER v1'

/** @param {{ env: NodeJS.ProcessEnv, dryRun?: boolean }} options */
export async function attachLangGraph(options) {
  const settingsPath = resolveClientSettingsPath('langgraph', '.config/hypaware/langgraph.mjs',
    options.env, options.env.HOME ?? os.homedir())
  const { hypHome } = readObservabilityEnv(options.env)
  const configPath = resolveConfigPath({ env: options.env, hypHome })
  const moduleUrl = new URL('./recorder.js', import.meta.url).href
  const body = `${LANGGRAPH_MARKER}\nimport { createHypAwareCallback as create } from ${JSON.stringify(moduleUrl)}\n` +
    `export function createHypAwareCallback(options = {}) {\n` +
    `  return create({ ...options, env: { ...process.env, HYP_HOME: ${JSON.stringify(hypHome)}, HYP_CONFIG: ${JSON.stringify(configPath)} } })\n}\n`
  let existing
  try { existing = await fs.readFile(settingsPath, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing !== undefined && !existing.startsWith(LANGGRAPH_MARKER + '\n')) {
    throw markActionRefused(new Error(`LangGraph module is not HypAware-owned: ${settingsPath}`))
  }
  const changed = existing !== body
  if (changed && !options.dryRun) await atomicWriteFile(settingsPath, body, { mode: 0o600, dirMode: 0o700, fsync: true })
  return { settingsPath, changed }
}
