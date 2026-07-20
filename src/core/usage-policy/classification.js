// @ts-check

import path from 'node:path'

import { defaultConfigPath } from '../config/schema.js'
import { readObservabilityEnv } from '../observability/env.js'
import { readCentralSinkOrigins } from '../remote/gateway_seed.js'
import { createUsagePolicyResolver } from './matcher.js'
import { localOnlyListPath } from './local_only.js'

/**
 * Session-start classification (LLP 0106): on an enrolled machine, an
 * interactive session opened in a directory with no explicit governing usage
 * class is asked - once - to classify the folder (sync / local-only / ignore).
 * The answer is written through the same `hyp policy set` verb the human and
 * the privacy skill use (LLP 0111 #teaching, LLP 0103 #cli), landing an
 * explicit machine-local entry so the folder is never asked about again.
 * Choosing sync writes the explicit `full` entry, which is precisely what
 * suppresses the next prompt.
 *
 * This module is the shared, client-agnostic core the per-client hooks call:
 * the Claude hook (`hyp claude-hook classify-cwd`, a blocking SessionStart
 * prompt) and the Codex hook (`hyp codex-hook classify-cwd`, a degraded
 * first-prompt nag) differ only in how they deliver the prompt, never in the
 * decision or the copy. Keeping the decision, the prompt text, and the
 * verb mapping here means there is exactly one consent surface to pin with
 * tests (LLP 0106 consequences: "the prompt copy is load-bearing").
 *
 * @import { UsageClass, UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 */

/**
 * The three usage classes, in the order the prompt presents them (least to
 * most restrictive), each paired with the `hyp policy set` class token that
 * records it (LLP 0111 #teaching, LLP 0103 #cli). One store, three writers
 * (skill, hook, hand-run CLI); the hook advertises exactly the verb the other
 * two use. The token is the CLI-edge vocabulary (`sync` maps onto the stored
 * `full`); the deprecated `hyp ignore --sync` misnomer is gone from the copy.
 *
 * @ref LLP 0106 [implements]: the hook's answer is written via the same CLI verb, landing an LLP 0103 entry
 * @ref LLP 0111#teaching [implements]: the consent copy teaches `hyp policy set <path> <token>`, not the `hyp ignore --sync` misnomer
 * @type {ReadonlyArray<{ class: UsageClass, token: 'sync' | 'local-only' | 'ignore', label: string, blurb: string }>}
 */
export const CLASSIFICATION_CHOICES = [
  {
    class: 'full',
    token: 'sync',
    label: 'sync',
    blurb: "this folder's sessions upload to the shared server (the current default)",
  },
  {
    class: 'local-only',
    token: 'local-only',
    label: 'local-only',
    blurb: 'keep sessions on this machine only, never forward them to the server',
  },
  {
    class: 'ignore',
    token: 'ignore',
    label: 'ignore',
    blurb: 'do not record this folder\'s sessions at all',
  },
]

/**
 * The `hyp policy set` argv that records `targetPath` as `cls` in the
 * machine-local store (LLP 0111 #teaching, LLP 0103): `full` -> `sync`,
 * `local-only` -> `local-only`, `ignore` -> `ignore`. Returned as an argv
 * array (not a shell string) so a caller can dispatch it directly against the
 * same two-word `policy set` verb the human runs, which is exactly what the
 * "answer lands via the verbs" contract pins. The `policy set` verb has been
 * registered since T2, so the hook never advertises a spelling the binary
 * lacks.
 *
 * @ref LLP 0106 [implements]: map a chosen class to the marking verb the hook dispatches
 * @ref LLP 0111#teaching [implements]: emit `policy set <path> <token>`, retiring the `hyp ignore --sync` misnomer
 * @param {UsageClass} cls
 * @param {string} targetPath absolute path of the folder to classify
 * @returns {string[]}
 */
export function verbArgvForClass(cls, targetPath) {
  const choice = CLASSIFICATION_CHOICES.find((c) => c.class === cls)
  if (!choice) throw new Error(`verbArgvForClass: unknown class ${String(cls)}`)
  return ['policy', 'set', targetPath, choice.token]
}

/**
 * Build the classification prompt copy for a folder. This is the consent
 * surface many users first meet the class vocabulary through (LLP 0106
 * consequences), so it is deliberately explicit: it names the machine's
 * enrolled state, the default polarity, all three classes in plain language,
 * and the exact command that records each. Written to be delivered to a coding
 * agent (Claude/Codex), which then asks the human and runs the chosen verb.
 *
 * No em dashes and `-` in runtime strings, per the repo style.
 *
 * @ref LLP 0111#teaching [implements]: prints `hyp policy set <cwd> <token>`; the exit criterion is that no non-ignore class is ever taught with an ignore-spelled command
 * @ref LLP 0113 [implements]: the copy itself mandates menu presentation, tool-neutral with the Claude tool named, so tool-less clients degrade to prose
 * @param {{ cwd: string }} args
 * @returns {string}
 */
export function buildClassificationPrompt({ cwd }) {
  const lines = [
    'This machine is enrolled with a shared HypAware server, so by default the',
    'AI coding sessions you run here are recorded and forwarded to that server.',
    `The folder ${cwd} has not been classified yet, so it would sync by default.`,
    '',
    'Before continuing, ask the user how this folder should be handled, then run',
    'the matching command once to record the answer (you will not be asked again',
    'for this folder):',
    '',
  ]
  for (const choice of CLASSIFICATION_CHOICES) {
    lines.push(`  - ${choice.label}: ${choice.blurb}`)
    lines.push(`      hyp policy set ${cwd} ${choice.token}`)
  }
  lines.push('')
  lines.push('Present these three choices as a selection menu using your environment\'s')
  lines.push('native question tool (in Claude Code, the AskUserQuestion tool); do not ask')
  lines.push('in open-ended text unless no such tool exists. Then run the chosen command.')
  lines.push('If the user is unsure, the safe choice is local-only (recorded here, never')
  lines.push('forwarded). This affects only what HypAware records and forwards; it does')
  lines.push('not change your task.')
  return lines.join('\n')
}

/**
 * The pure decision at the heart of the hook (LLP 0106): prompt only when the
 * machine is enrolled AND the session is interactive AND the folder has no
 * explicit governing class. Every other combination passes through silently:
 *
 * - unenrolled: nothing forwards, so sync-vs-local-only is a distinction
 *   without a difference; a prompt there is pure friction (LLP 0106
 *   #enrolled-only).
 * - already classified: the question was asked and answered once; an explicit
 *   entry (including an explicit `full`/sync) suppresses it (LLP 0106
 *   #interactive, LLP 0103 explicit-full).
 * - non-interactive / headless: proceeds under today's implicit default and
 *   leaves the folder unclassified for the next interactive session to catch;
 *   the hook must never hang or fail such a run (LLP 0106 #interactive).
 *
 * @ref LLP 0106 [implements]: unclassified + interactive + enrolled => ask once
 * @param {{ enrolled: boolean, interactive: boolean, governed: boolean }} state
 * @returns {{ prompt: boolean, reason: 'unenrolled' | 'classified' | 'non-interactive' | 'unclassified' }}
 */
export function decideClassification({ enrolled, interactive, governed }) {
  if (!enrolled) return { prompt: false, reason: 'unenrolled' }
  if (governed) return { prompt: false, reason: 'classified' }
  if (!interactive) return { prompt: false, reason: 'non-interactive' }
  return { prompt: true, reason: 'unclassified' }
}

/**
 * Resolve, from disk, whether an interactive session in `cwd` should be asked
 * to classify the folder, and if so the prompt copy to deliver. Reads exactly
 * the state the CLI marking verbs and the export seam read: the machine-local
 * list under `readObservabilityEnv(env).stateDir` (so a mark made by any writer
 * is honored), and the central-layer sink origins (the LLP 0063 D4 enrollment
 * gate) for the enrolled check.
 *
 * Defensive throughout: a hook must never hang or fail a session (LLP 0106
 * #interactive). An enrollment lookup that throws is treated as unenrolled
 * (inert), and a corrupt/unreadable machine-local list is treated as "do not
 * prompt" rather than surfacing an error into the session - the mark verbs and
 * `hyp status` are where a corrupt list is meant to fail loudly, not a
 * best-effort session-start hook.
 *
 * fs/env lookups are injected for tests; they default to the real readers.
 *
 * @param {{
 *   cwd: string,
 *   interactive: boolean,
 *   env: NodeJS.ProcessEnv,
 *   deps?: {
 *     readObservabilityEnv?: typeof readObservabilityEnv,
 *     readCentralSinkOrigins?: typeof readCentralSinkOrigins,
 *     createResolver?: (listPath: string) => UsagePolicyResolver,
 *   },
 * }} args
 * @returns {Promise<{ prompt: boolean, reason: string, cwd: string, enrolled: boolean, governed: boolean, promptText?: string }>}
 */
export async function evaluateCwdClassification({ cwd, interactive, env, deps = {} }) {
  const obsEnv = (deps.readObservabilityEnv ?? readObservabilityEnv)(env)
  const stateDir = obsEnv.stateDir
  const listPath = localOnlyListPath(stateDir)
  const configPath = env.HYP_CONFIG ? path.resolve(env.HYP_CONFIG) : defaultConfigPath(obsEnv.hypHome)

  let enrolled = false
  try {
    const origins = await (deps.readCentralSinkOrigins ?? readCentralSinkOrigins)({ stateDir, configPath })
    enrolled = Array.isArray(origins) && origins.length > 0
  } catch {
    // Can't read the central layer -> treat as not enrolled (inert), never
    // fail the session on it.
    enrolled = false
  }

  let governed = false
  let resolveFailed = false
  try {
    const resolver = deps.createResolver
      ? deps.createResolver(listPath)
      : createUsagePolicyResolver({ localOnlyListPath: listPath })
    const result = resolver.resolve(cwd)
    // `governedBy !== null` means an explicit source (a `.hypignore` dotfile or
    // an explicit machine-local entry, incl. an explicit `full`) governs this
    // folder: it has been classified. `null` is the implicit `full` default -
    // "never asked" (LLP 0103 explicit-full, LLP 0106).
    governed = result.governedBy !== null
  } catch {
    // A corrupt/unreadable machine-local list throws here. Do not prompt on a
    // broken read (and do not crash the session); the mark verbs / hyp status
    // are the loud-failure surfaces for that.
    resolveFailed = true
    governed = true
  }

  const decision = decideClassification({ enrolled, interactive, governed })
  /** @type {{ prompt: boolean, reason: string, cwd: string, enrolled: boolean, governed: boolean, promptText?: string }} */
  const out = {
    prompt: decision.prompt,
    reason: resolveFailed ? 'resolve-error' : decision.reason,
    cwd,
    enrolled,
    governed,
  }
  if (decision.prompt) out.promptText = buildClassificationPrompt({ cwd })
  return out
}
