// @ts-check
import os from 'node:os'
import path from 'node:path'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { validateBackfillSection } from '../../codex/src/config.js'
import { createCodexCloudProvider } from './cloud.js'
import { registerCloudCommands } from './cloud-state.js'

/** @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */

// @ref LLP 0511#onboarding: hosted activation does not attach or record the local Codex client.
/** @param {PluginActivationContext} ctx */
export async function activate(ctx) {
  const codexHome = ctx.env.CODEX_HOME || path.join(ctx.env.HOME ?? os.homedir(), '.codex')
  registerCloudCommands(ctx, codexHome)
  ctx.configRegistry.registerSection({
    plugin: '@hypaware/codex-cloud', section: 'codex-cloud',
    validate(value) {
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
        return { ok: false, errors: [{ pointer: '', message: 'codex-cloud config must be an object' }] }
      }
      const errors = validateBackfillSection(/** @type {Record<string, unknown> | undefined} */ (value)?.backfill, '/backfill', true)
      return errors.length ? { ok: false, errors } : { ok: true }
    },
  })
  ctx.backfills.register(createCodexCloudProvider({
    codexHome, stateDir: ctx.paths.stateDir, env: ctx.env,
    ignoredSessions: new SessionIgnoreSet(readObservabilityEnv(ctx.env).stateDir, ctx.log),
  }))
}
