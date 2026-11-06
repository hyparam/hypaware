// @ts-check

import {
  activateAntigravityVariant,
  DEFAULT_ANTIGRAVITY_DESKTOP_SUBDIR,
} from '../../antigravity/src/index.js'

/**
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AntigravityVariantOptions } from '../../antigravity/src/types.js'
 */

export const DESKTOP_VARIANT = /** @type {AntigravityVariantOptions} */ ({
  pluginName: '@hypaware/antigravity-desktop',
  clientName: 'antigravity-desktop',
  configSectionName: 'antigravity_desktop',
  defaultAppDataSubdir: DEFAULT_ANTIGRAVITY_DESKTOP_SUBDIR,
  entrypoint: 'desktop',
  excludeCliSyncedSummaries: true,
})

/**
 * Activate `@hypaware/antigravity-desktop` (Antigravity Desktop collector).
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  await activateAntigravityVariant(ctx, DESKTOP_VARIANT)
}
