// @ts-check
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

/** @import { JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */
/** @param {NodeJS.ProcessEnv} env @param {JsonObject} [config] @param {NodeJS.Platform} [platform] */
export function dataRoots(env, config = {}, platform = process.platform) {
  if (Array.isArray(config.user_data_dirs)) return [...new Set(config.user_data_dirs.map(String))]
  if (env.VSCODE_PORTABLE) return [path.join(env.VSCODE_PORTABLE, 'user-data')]
  const home = env.HOME ?? os.homedir()
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : platform === 'win32' ? env.APPDATA ?? path.join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME ?? path.join(home, '.config')
  return ['Code', 'Code - Insiders'].map(name => path.join(base, name))
}

/** @param {string} dir @param {number} [cap] */
export async function directories(dir, cap = 1024) {
  const result = []
  try {
    const handle = await fs.opendir(dir)
    for await (const entry of handle) {
      if (entry.isDirectory()) result.push(path.join(dir, entry.name))
      if (result.length > cap) throw new Error('directory_limit')
    }
  } catch (err) { if (err?.code !== 'ENOENT') throw err }
  return result
}

/** @param {string} file */
export async function fingerprint(file) {
  try {
    const stat = await fs.stat(file)
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
  } catch (err) {
    if (err?.code === 'ENOENT') return 'missing'
    throw err
  }
}

/** @param {NodeJS.ProcessEnv} env @param {JsonObject} config */
export async function discoverStores(env, config) {
  const stores = []
  for (const root of dataRoots(env, config)) {
    const user = path.join(root, 'User')
    const profiles = [user, ...await directories(path.join(user, 'profiles'), 64)]
    for (const profile of profiles) {
      const file = path.join(profile, 'globalStorage', 'github.copilot-chat', 'agent-traces.db')
      if (await fingerprint(file) !== 'missing') stores.push({ file, root, harness: 'local', profile })
    }
    const file = path.join(root, 'agent-host', 'otel', 'agent-host-traces.db')
    if (await fingerprint(file) !== 'missing') stores.push({ file, root, harness: 'agent-host', profile: user })
  }
  return stores
}
