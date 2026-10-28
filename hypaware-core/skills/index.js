// @ts-check

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @import { PluginActivationContext, PluginSkillClient } from '../../hypaware-plugin-kernel-types.js' */

/** The skills the shared tree ships, one subdirectory each. */
export const SHARED_SKILL_NAMES = ['hypaware-query', 'hypaware-reference', 'hypaware-privacy', 'hypaware-report']

/** Root of the shared skill tree, the directory holding this file. */
export const SHARED_SKILLS_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Register every shared skill for one client. Each client plugin registers
 * its own entries against the one shared tree, so the registry keeps one
 * entry per plugin registration and `hyp client skills install` places the
 * same files under each client's `skill_dir`.
 *
 * @param {PluginActivationContext} ctx
 * @param {string} plugin
 * @param {PluginSkillClient} client
 * @ref LLP 0563#single-source [implements]: every client registers the same source, with client-specific guidance inside it
 */
export function registerSkills(ctx, plugin, client) {
  for (const name of SHARED_SKILL_NAMES) {
    ctx.skills.register({ name, plugin, clients: [client], sourceDir: path.join(SHARED_SKILLS_DIR, name) })
  }
}
