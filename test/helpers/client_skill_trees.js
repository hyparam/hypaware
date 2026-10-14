// @ts-check

/**
 * Which skill tree each client installs.
 *
 * @ref LLP 0494#skills: claude and codex keep their host-specific trees; every other client installs the one neutral tree
 */

import path from 'node:path'

/** Every client that installs HypAware skills. */
export const SKILL_CLIENTS = ['claude', 'codex', 'pi', 'opencode', 'cursor', 'openclaw']

/** Repo-relative skill tree per host; a client not listed installs `neutral`. */
export const SKILL_TREES = {
  claude: 'hypaware-core/plugins-workspace/claude/skills',
  codex: 'hypaware-core/plugins-workspace/codex/skills',
  neutral: 'hypaware-core/skills',
}

/**
 * Repo-relative skill tree a client installs.
 *
 * @param {string} client
 * @returns {string}
 */
export function clientSkillTree(client) {
  return client === 'claude' || client === 'codex' ? SKILL_TREES[client] : SKILL_TREES.neutral
}

/**
 * Absolute skill tree a client installs.
 *
 * @param {string} repoRoot
 * @param {string} client
 * @returns {string}
 */
export function clientSkillsDir(repoRoot, client) {
  return path.join(repoRoot, clientSkillTree(client))
}
