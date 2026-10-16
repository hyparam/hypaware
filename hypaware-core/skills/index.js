// @ts-check

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @import { PluginActivationContext, PluginSkillClient } from '../../hypaware-plugin-kernel-types.js' */

/** The skills the host-neutral tree ships, one subdirectory each. */
export const NEUTRAL_SKILL_NAMES = ['hypaware-query', 'hypaware-reference', 'hypaware-privacy', 'hypaware-report']

/** Root of the host-neutral skill tree, the directory holding this file. */
export const NEUTRAL_SKILLS_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Register every neutral skill for one client. Each client plugin registers
 * its own entries against the one shared tree, so the registry keeps one
 * entry per plugin registration and `hyp client skills install` places the
 * same files under each client's `skill_dir`.
 *
 * @param {PluginActivationContext} ctx
 * @param {string} plugin
 * @param {PluginSkillClient} client
 * @ref LLP 0494#skills [implements]: one neutral tree, registered by each client plugin that has no host-specific copy
 */
export function registerNeutralSkills(ctx, plugin, client) {
  for (const name of NEUTRAL_SKILL_NAMES) {
    ctx.skills.register({ name, plugin, clients: [client], sourceDir: path.join(NEUTRAL_SKILLS_DIR, name) })
  }
}
