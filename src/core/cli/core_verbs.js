// @ts-check

import { querySqlVerb } from '../query/verb.js'

/**
 * @import { VerbRegistration, VerbRegistry } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * The intrinsic verbs core contributes on every host (LLP 0003). Exported
 * so `registerCoreCommands` can project their CLI commands pre-boot (for
 * `hyp --help`), while the kernel verb registry registers them for the MCP
 * tool surface at boot.
 *
 * @type {VerbRegistration[]}
 */
export const CORE_VERBS = [querySqlVerb]

/**
 * Register the intrinsic core verbs onto the kernel verb registry. Run
 * during `createKernelRuntime`, so the projected `query sql` command and
 * the `query_sql` MCP tool exist on every boot, with no plugin needed:
 * the intrinsic SQL surface (LLP 0003).
 *
 * @param {VerbRegistry} verbs
 */
export function registerCoreVerbs(verbs) {
  for (const verb of CORE_VERBS) verbs.register(verb)
}
