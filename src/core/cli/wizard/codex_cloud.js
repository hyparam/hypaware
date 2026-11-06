// @ts-check
import os from 'node:os'
import path from 'node:path'
import { readObservabilityEnv } from '../../observability/env.js'
import { pluginStateDir } from '../../runtime/paths.js'
import { Attr, withSpan } from '../../observability/index.js'

/** @import { PickerDescriptor } from '../../../../src/core/types.js' */
/** @import { CloudOnboarding } from '../../../../hypaware-core/plugins-workspace/codex-cloud/src/types.js' */

// The bundled plugin stays outside the core declaration build and activates no
// runtime merely to read its local grant. The small interface is type-only.
/** @returns {Promise<CloudOnboarding>} */
async function cloudState() {
  return import(new URL('../../../../hypaware-core/plugins-workspace/codex-cloud/src/cloud-state.js', import.meta.url).href)
}

export const HOSTED_CODEX_PICKS = ['codex-cloud', 'chatgpt-work']

/** @param {NodeJS.ProcessEnv} env */
function selectionOptions(env) {
  return {
    stateDir: pluginStateDir(readObservabilityEnv(env).stateDir, '@hypaware/codex-cloud'),
    codexHome: env.CODEX_HOME || path.join(env.HOME ?? os.homedir(), '.codex'),
    env,
  }
}

// @ref LLP 0511#onboarding: the local grant, not shared plugin membership, records each hosted choice.
/**
 * @param {{env: NodeJS.ProcessEnv, descriptors: Map<string, PickerDescriptor>, configured?: Set<string>, detected: Set<string>}} opts
 */
export async function seedHostedCodexPicks(opts) {
  if (!HOSTED_CODEX_PICKS.every(id => opts.descriptors.has(id))) return
  if (opts.detected.has('codex')) opts.detected.add('codex-cloud')
  opts.detected.delete('chatgpt-work')
  if (opts.configured) {
    const active = HOSTED_CODEX_PICKS.some(id => opts.configured?.has(id))
    for (const id of HOSTED_CODEX_PICKS) opts.configured.delete(id)
    if (!active) return
    const { readCloudConnection, DEFAULT_CLOUD_ORIGINS } = await cloudState()
    const connection = await readCloudConnection(selectionOptions(opts.env).stateDir)
    const origins = connection?.origins ?? (connection ? DEFAULT_CLOUD_ORIGINS : [])
    if (origins.includes('codex_cloud')) opts.configured.add('codex-cloud')
    if (origins.some(origin => origin !== 'codex_cloud')) opts.configured.add('chatgpt-work')
  }
}

// @ref LLP 0511#onboarding: commit only after setup's questions and config save; no unattended login.
/**
 * @param {{env: NodeJS.ProcessEnv, sources: string[], stdout: {write: (text: string) => unknown}, stderr: {write: (text: string) => unknown}}} opts
 * @param {{configure?: CloudOnboarding['configureCloudSelection']}} [deps]
 */
export async function configureWizardCloud(opts, deps = {}) {
  await withSpan('wizard.codex_cloud.configure', {
    [Attr.COMPONENT]: 'wizard', [Attr.OPERATION]: 'wizard.codex_cloud.configure',
  }, async span => {
    try {
      const configure = deps.configure ?? (await cloudState()).configureCloudSelection
      await configure({ ...selectionOptions(opts.env), sources: opts.sources })
      span.setAttribute('status', 'ok')
      if (opts.sources.some(id => HOSTED_CODEX_PICKS.includes(id))) {
        opts.stdout.write('Hosted chat selection saved. The daemon checks for history every five minutes.\n')
      }
    } catch {
      span.setAttribute('status', 'failed')
      span.setAttribute(Attr.ERROR_KIND, 'cloud_setup_incomplete')
      opts.stderr.write('Hosted chat setup did not finish. Check your Codex file-backed ChatGPT login and rerun `hyp setup` to select Codex Cloud or ChatGPT Work. Other setup will continue.\n')
    }
  }, { component: 'wizard' })
}
