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
import process from 'node:process'

import { findInstalledHypawareBin, isNpxBinPath } from '../../../../src/core/cli/global_install.js'

import { DEFAULT_BUNDLE_ID, DEFAULT_MODELS, resolveGatewayBaseUrl } from './profile.js'

/** Basename of the generated credential-helper wrapper under the state dir. */
export const HELPER_BASENAME = 'credential-helper.sh'

/**
 * Absolute path of the `hyp` executable to embed in the wrapper.
 * Desktop runs the wrapper outside any shell profile, so a bare `hyp`
 * on PATH is not a given; resolve the running CLI's entry script.
 *
 * Under `npx hypaware` that entry script lives in npm's `_npx` cache, which
 * npm prunes on its own schedule, so writing it into the wrapper records a
 * path that outlives what owns it. Desktop runs the wrapper with the app's
 * minimal environment and reads its stdout, so a vanished interpreter target
 * surfaces as a credential-helper failure inside the app, with nothing on this
 * machine reporting it. An installed CLI is durable, and resolving it here
 * still yields a concrete absolute path: the `$PATH` walk is spent once, when
 * the wrapper is generated, which is the point.
 *
 * With nothing installed the npx path is still written, flagged `ephemeral`
 * rather than refused: a wrapper that works until npm prunes the cache beats
 * no wrapper at all, and `install-helper` then says so instead of writing the
 * rot silently.
 *
 * An explicit `HYPAWARE_BIN`/`HYP_BIN` is taken as given: it names a path the
 * operator chose, and second-guessing it would defeat the override.
 *
 * `entry` defaults to the running CLI's own entry script and is a parameter
 * only so a test can present an `_npx` entrypoint: nothing short of a real
 * `npx` run puts this package inside that cache.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [entry]
 * @returns {{ binPath: string, ephemeral: boolean }}
 */
export function resolveHypBin(env = process.env, entry = process.argv[1]) {
  const explicit = [env.HYPAWARE_BIN, env.HYP_BIN]
    .find((value) => typeof value === 'string' && value.trim() !== '')
  if (explicit !== undefined) return { binPath: path.resolve(explicit), ephemeral: false }

  const running = resolveEntryPath(entry)
  if (!isNpxBinPath(running, env)) return { binPath: running, ephemeral: false }
  // Taken as `$PATH` spells it, never through `realpathSync`: what a global
  // install puts on `$PATH` is usually a symlink into the package tree, and
  // the durable name is that link, not the versioned directory it currently
  // points at.
  const installed = findInstalledHypawareBin(env)
  if (installed !== undefined) return { binPath: installed, ephemeral: false }
  return { binPath: running, ephemeral: true }
}

/**
 * The running CLI's entry script. `realpathSync` resolves *through* the
 * `node_modules/.bin` shim that npx and npm both put on `$PATH`, so the answer
 * is the script itself rather than a link naming it, which is what a stripped
 * environment needs and what lets the npx check above see a cache checkout for
 * what it is.
 *
 * @param {string | undefined} entry
 * @returns {string}
 */
function resolveEntryPath(entry) {
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
