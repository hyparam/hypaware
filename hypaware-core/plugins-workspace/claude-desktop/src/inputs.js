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

import { findInstalledHypawareBin, isEphemeralBinPath } from '../../../../src/core/cli/global_install.js'

import { DEFAULT_BUNDLE_ID, DEFAULT_MODELS, resolveGatewayBaseUrl } from './profile.js'

/** Basename of the generated credential-helper wrapper under the state dir. */
export const HELPER_BASENAME = 'credential-helper.sh'

/** Entry-script extensions `node <path>` will load. */
const NODE_MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

/**
 * Absolute path of the `hyp` executable to embed in the wrapper.
 * Desktop runs the wrapper outside any shell profile, so a bare `hyp`
 * on PATH is not a given; resolve the running CLI's entry script.
 *
 * Under `npx hypaware` that entry script lives in npm's `_npx` cache, and in a
 * project that depends on `hypaware` it lives in that project's
 * `node_modules`; `isEphemeralBinPath` reads both as what they are, a copy npm
 * deletes on a schedule of its own, so writing either into the wrapper records
 * a path that outlives what owns it. Desktop runs the wrapper with the app's
 * minimal environment and reads its stdout, so a vanished interpreter target
 * surfaces as a credential-helper failure inside the app, with nothing on this
 * machine reporting it. An installed CLI is durable, and resolving it here
 * still yields a concrete absolute path: the `$PATH` walk is spent once, when
 * the wrapper is generated, which is the point.
 *
 * A durable copy found this way may be a different version than the one that
 * ran this command, which for a project-local entry script it usually is. What
 * the wrapper needs of the path it bakes is that it still exists and still
 * runs when Desktop next asks for a credential, and the command it runs is a
 * credential fetch rather than any version-pinned surface; an operator who
 * does mean a particular copy says so with `HYPAWARE_BIN`.
 *
 * With nothing installed the ephemeral path is still written, flagged
 * `ephemeral` rather than refused: a wrapper that works until npm removes that
 * tree beats no wrapper at all, and `install-helper` then says so instead of
 * writing the rot silently.
 *
 * An explicit `HYPAWARE_BIN`/`HYP_BIN` is taken as given: it names a path the
 * operator chose, and second-guessing it would defeat the override.
 *
 * `entry` defaults to the running CLI's own entry script and is a parameter
 * only so a test can present an ephemeral entrypoint: nothing short of a real
 * `npx` run or a real project install puts this package inside one of those
 * trees.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [entry]
 * @returns {{ binPath: string, ephemeral: boolean }}
 */
export function resolveHypBin(env = process.env, entry = process.argv[1]) {
  const explicit = [env.HYPAWARE_BIN, env.HYP_BIN]
    .find((value) => typeof value === 'string' && value.trim() !== '')
  // Trimmed, because the emptiness test above is already the decision that
  // surrounding whitespace is not part of the value. Untrimmed, ` /opt/hyp`
  // is not absolute, so `path.resolve` would anchor it to whatever directory
  // this command ran in and bake that into the wrapper.
  if (explicit !== undefined) return { binPath: path.resolve(explicit.trim()), ephemeral: false }

  const running = resolveEntryPath(entry)
  if (!isEphemeralBinPath(running, env)) return { binPath: running, ephemeral: false }
  // Recorded as `$PATH` spells it, never as `realpathSync` resolves it: what a
  // global install puts on `$PATH` is usually a symlink into the package tree,
  // and the durable name is that link, not the versioned directory it
  // currently points at. Each candidate's link is still followed inside the
  // walk, to decide whether to take it (`runsUnderNode`) or carry on past it;
  // only the name that comes back is left unresolved.
  const installed = findInstalledHypawareBin(env, process.platform, runsUnderNode)
  if (installed !== undefined) return { binPath: installed, ephemeral: false }
  return { binPath: running, ephemeral: true }
}

/**
 * Whether `node <candidate>` can run what `$PATH` calls `hypaware`.
 *
 * The wrapper is `exec <nodeBin> <hypBin> ...`, so this call site needs a
 * script Node can parse, not merely an executable. `findInstalledHypawareBin`
 * answers the weaker question its other caller asks: `@hypaware/claude` puts
 * the path at the head of a command line and runs it directly, where pnpm's
 * shell script or a volta/asdf shim is a perfectly good answer. Here the same
 * answer is a `SyntaxError` on the wrapper's first run, which Claude Desktop
 * reports as a failed credential helper and nothing on this machine reports at
 * all - so it would be worse than the `_npx` path it replaced, which at least
 * works until npm prunes the cache.
 *
 * `npm install -g` links `<prefix>/bin/hypaware` onto the package's own
 * `bin/hypaware.js`, so following the link and asking for a module extension
 * accepts the layout the walk exists to find and declines the shims. All three
 * of `.js`/`.mjs`/`.cjs` are listed because the question is what Node can run,
 * not what this package happens to name its entry today: pinning the check to
 * the current `bin` filename would turn a later rename into a silent return to
 * ephemeral wrappers, with every test still green.
 *
 * This is passed to the walk rather than applied to its answer, so a rejected
 * candidate costs the next `$PATH` entry and not the whole search - the
 * managers that ship shims are exactly the ones that put their directory in
 * front of `/usr/local/bin`. When the walk does come back empty, the fallback
 * is the npx path and its warning, which is what the machine had before the
 * walk: never worse than not looking.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function runsUnderNode(candidate) {
  try {
    return NODE_MODULE_EXTENSIONS.has(path.extname(fs.realpathSync(candidate)))
  } catch {
    return false
  }
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
