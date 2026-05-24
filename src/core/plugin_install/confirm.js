// @ts-check

import readline from 'node:readline/promises'

/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginManifest} PluginManifest */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginSourceSpec} PluginSourceSpec */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginLockEntry} PluginLockEntry */
/** @import { ConfirmOutcome, ConfirmDecision, StagedArtifact } from './types.d.ts' */

/**
 * Optional warning lines printed to stderr ahead of the prompt. Soft
 * warnings only — they never block install on their own. The strings
 * are short so they grep cleanly in smoke logs.
 *
 * @param {StagedArtifact} staged
 * @returns {string[]}
 */
export function buildWarnings(staged) {
  /** @type {string[]} */
  const warnings = []
  const permissions = staged.manifest.permissions ?? []
  const broad = permissions.filter(isBroadPermission)
  if (broad.length > 0) {
    warnings.push(
      `WARNING: plugin requests broad permissions: ${broad.join(', ')}`
    )
  }
  const refIsBranch = sourceIsUnpinnedBranch(staged.source)
  if (refIsBranch) {
    const refText = staged.source.ref ? `'${staged.source.ref}'` : '<default branch>'
    warnings.push(
      `WARNING: ref ${refText} is an unpinned branch — pin a tag or commit SHA for reproducible installs`
    )
  }
  return warnings
}

/**
 * `network` is the V1 broad-scope permission. Anything else falls
 * through (per-plugin permission strings are vetted by the manifest
 * validator).
 *
 * @param {string} p
 */
function isBroadPermission(p) {
  return p === 'network'
}

/**
 * A ref counts as an unpinned branch when it is missing entirely (the
 * fetch picks the remote default branch) or when it does not look like
 * a tag (`v1.2.3`, semver-like) or a commit SHA. We do not call out to
 * `git ls-remote` here — the smoke fixture is local and the warning
 * is intentionally heuristic.
 *
 * @param {PluginSourceSpec} source
 */
export function sourceIsUnpinnedBranch(source) {
  if (source.kind !== 'git') return false
  const ref = source.ref
  if (!ref) return true
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return false
  if (/^v?\d+\.\d+\.\d+/i.test(ref)) return false
  return true
}

/**
 * Render the printable summary the user sees before deciding. Designed
 * to be printed to stderr (the install span keeps stdout clean for the
 * `installed ...` success line and `--json` shapes).
 *
 * @param {StagedArtifact} staged
 * @param {{ previous?: PluginLockEntry, headerKind?: 'install'|'update' }} [opts]
 * @returns {string}
 */
export function renderConfirmationSummary(staged, opts = {}) {
  const lines = []
  if (opts.headerKind === 'update') {
    lines.push(`About to update plugin ${staged.manifest.name}@${staged.manifest.version}`)
  } else {
    lines.push(`About to install plugin ${staged.manifest.name}@${staged.manifest.version}`)
  }
  lines.push(`  source:        ${staged.source.kind} (${staged.source.raw})`)
  if (staged.resolvedRef) {
    if (opts.previous?.resolved_ref && opts.previous.resolved_ref !== staged.resolvedRef) {
      lines.push(`  resolved_ref:  ${opts.previous.resolved_ref} -> ${staged.resolvedRef}`)
    } else {
      lines.push(`  resolved_ref:  ${staged.resolvedRef}`)
    }
  }
  if (opts.previous && opts.previous.version !== staged.manifest.version) {
    lines.push(`  version:       ${opts.previous.version} -> ${staged.manifest.version}`)
  }
  if (opts.previous && opts.previous.content_hash !== staged.contentHash) {
    lines.push(`  content_hash:  ${opts.previous.content_hash} -> ${staged.contentHash}`)
  } else {
    lines.push(`  content_hash:  ${staged.contentHash}`)
  }
  const permissions = staged.manifest.permissions ?? []
  lines.push(`  permissions:   ${permissions.length === 0 ? '(none)' : permissions.join(', ')}`)
  lines.push(`  entrypoint:    ${staged.manifest.entrypoint}`)
  return lines.join('\n') + '\n'
}

/**
 * Decide whether to proceed with a staged install/update. Pure policy:
 *
 *   - `yes=true`           → auto_yes, proceed.
 *   - non-TTY              → non_tty_no_yes, abort.
 *   - TTY + ask returns y  → confirmed, proceed.
 *   - TTY + ask returns n  → rejected, abort.
 *
 * The `ask` callback exists so tests can inject a deterministic answer
 * without touching `process.stdin`.
 *
 * @param {{
 *   yes: boolean,
 *   tty: boolean,
 *   ask?: () => Promise<boolean>,
 * }} input
 * @returns {Promise<ConfirmDecision>}
 */
export async function decideConfirmation({ yes, tty, ask }) {
  if (yes) return { proceed: true, outcome: 'auto_yes' }
  if (!tty) return { proceed: false, outcome: 'non_tty_no_yes' }
  if (!ask) return { proceed: false, outcome: 'non_tty_no_yes' }
  const answer = await ask()
  return answer
    ? { proceed: true, outcome: 'confirmed' }
    : { proceed: false, outcome: 'rejected' }
}

/**
 * Build a default `ask` that prompts on the supplied stdin/stdout pair.
 * Accepts `y`/`yes` (case-insensitive) as confirmation, anything else
 * counts as rejection. Closes the readline interface once an answer
 * comes back so the dispatcher doesn't leak file descriptors.
 *
 * @param {{
 *   stdin: NodeJS.ReadableStream,
 *   stdout: NodeJS.WritableStream,
 *   promptText?: string,
 * }} args
 * @returns {() => Promise<boolean>}
 */
export function buildTtyPrompt({ stdin, stdout, promptText }) {
  return async function ask() {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false })
    try {
      const answer = await rl.question(promptText ?? 'Proceed? [y/N] ')
      const trimmed = answer.trim().toLowerCase()
      return trimmed === 'y' || trimmed === 'yes'
    } finally {
      rl.close()
    }
  }
}
