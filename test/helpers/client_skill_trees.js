// @ts-check

/**
 * Which skill tree each client installs.
 *
 * @ref LLP 0563#single-source: all clients install the same skill tree
 */

import path from 'node:path'

/** Every client that installs HypAware skills. */
export const SKILL_CLIENTS = ['claude', 'codex', 'pi', 'droid', 'opencode', 'cursor', 'openclaw', 'hermes']

/** Authoritative repo-relative skill tree for every client. */
const SKILLS_DIR = 'hypaware-core/skills'

/**
 * Repo-relative skill tree a client installs.
 *
 * @param {string} client
 * @returns {string}
 */
export function clientSkillTree(client) {
  return SKILLS_DIR
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
