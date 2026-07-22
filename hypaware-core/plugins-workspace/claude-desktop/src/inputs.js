// @ts-check

/**
 * Shared input resolution for `@hypaware/claude-desktop`'s commands
 * (`profile`, `status`, `install`, `verify`). Split out of `index.js` so
 * `install.js`/`verify.js` can import these without a circular dependency
 * on the module that registers the commands that call them.
 *
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AnthropicCredentialCapability } from '../../claude-account/src/types.js'
 * @import { ProfileInputs } from './types.js'
 */

import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_BUNDLE_ID, DEFAULT_MODELS, resolveGatewayBaseUrl } from './profile.js'

/** Basename of the generated credential-helper wrapper under the state dir. */
export const HELPER_BASENAME = 'credential-helper.sh'

/**
 * Absolute path of the `hyp` executable to embed in the wrapper.
 * Desktop runs the wrapper outside any shell profile, so a bare `hyp`
 * on PATH is not a given; resolve the running CLI's entry script.
 *
 * @returns {string}
 */
export function resolveHypBin() {
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    try {
      return fs.realpathSync(entry)
    } catch {
      return entry
    }
  }
  return 'hyp'
}

/**
 * Resolve the wrapper's absolute path: `claude_desktop.helper_path`
 * override, else `<stateDir>/credential-helper.sh`.
 *
 * @param {Record<string, unknown>} sectionConfig
 * @param {string} stateDir
 * @returns {string}
 */
export function resolveHelperPath(sectionConfig, stateDir) {
  const override = sectionConfig.helper_path
  if (typeof override === 'string' && override.length > 0) return override
  return path.join(stateDir, HELPER_BASENAME)
}

/**
 * Resolve every input the profile renderer and `install.js`/`verify.js`
 * need: gateway endpoint, auth scheme, models, helper path, bundle id.
 * Shared so no two commands compute these two different ways. Throws if
 * the resolved gateway listen is ephemeral (`resolveGatewayBaseUrl`),
 * which `install.js` uses as its up-front refusal check.
 *
 * @param {Record<string, unknown>} sectionConfig
 * @param {AnthropicCredentialCapability} credential
 * @param {CommandRunContext} cmdCtx
 * @param {string} stateDir
 * @returns {ProfileInputs}
 */
export function resolveInputs(sectionConfig, credential, cmdCtx, stateDir) {
  const models = Array.isArray(sectionConfig.models)
    ? /** @type {string[]} */ (sectionConfig.models)
    : [...DEFAULT_MODELS]
  const bundleId = typeof sectionConfig.bundle_id === 'string' && sectionConfig.bundle_id.length > 0
    ? sectionConfig.bundle_id
    : DEFAULT_BUNDLE_ID
  return {
    baseUrl: resolveGatewayBaseUrl({ hypConfig: cmdCtx.config, sectionConfig }),
    // An org key presents under the x-api-key scheme; a subscription
    // bearer rides `bearer` plus the helper-supplied beta header.
    authScheme: credential.mode === 'org_key' ? 'x-api-key' : 'bearer',
    models,
    helperPath: resolveHelperPath(sectionConfig, stateDir),
    bundleId,
  }
}
