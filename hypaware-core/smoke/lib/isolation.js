// @ts-check

import path from 'node:path'

/**
 * Isolate client settings and histories as well as HypAware state, before
 * importing a flow or starting test workers. HYP_HOME alone is insufficient:
 * daemon activation can run client migrations and native history sweeps.
 * @param {NodeJS.ProcessEnv} inherited
 * @param {string} homeDir
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedClientEnv(inherited, homeDir) {
  const env = { ...inherited }
  for (const key of [
    'HYP_CONFIG', 'CODEX_HOME', 'CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR',
    'HERMES_HOME',
    'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
    'OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH',
    'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
  ]) delete env[key]
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HYP_HOME: path.join(homeDir, '.hyp'),
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
  }
}
