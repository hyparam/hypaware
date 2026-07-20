// @ts-check

import path from 'node:path'
import process from 'node:process'

import { parseCommandArgv } from '../cli/verb_codec.js'
import { readObservabilityEnv } from '../observability/env.js'
import { localOnlyListPath, readLocalOnlyEntries } from '../usage-policy/index.js'
import { runIgnoreCheck, runMarkMachineLocal, runUnmarkMachineLocal } from './clients.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { UsageClass } from '../../../src/core/usage-policy/types.js'
 */

/**
 * The `hyp policy` command group (LLP 0110, LLP 0111): a class-neutral verb
 * over the machine-local usage-class store that replaces the
 * `hyp ignore --sync`/`--local-only`/`--private` misnomer. `set` / `show` /
 * `unset` / `list` are thin runners over the marking internals hoisted in
 * `src/core/commands/clients.js`; the `hyp ignore`/`hyp unignore` flag forms
 * keep working as delegating compatibility aliases (see
 * {@link runMarkMachineLocal}, {@link runUnmarkMachineLocal},
 * {@link runIgnoreCheck}). The store format, the shared resolver, and the
 * three-class lattice are untouched (LLP 0103 #cli).
 *
 * @ref LLP 0110 [implements]: the class-neutral `policy` verb surface that retires the `hyp ignore --sync` misnomer
 * @ref LLP 0111#surface [implements]: `policy set` / `show` / `unset` / `list`, registered as a `makeGroupCommand` group
 * @ref LLP 0103#cli [constrained-by]: the store, resolver, and class lattice are unchanged; only the verb spelling is new
 */

/**
 * The user-facing class vocabulary the classification hook and the
 * hypaware-privacy skill already teach. Mapped onto the store's class
 * lattice at the CLI edge only (LLP 0111 #tokens): `sync` is the "asked;
 * syncs" marker (stored as `full`); `local-only` and `ignore` map onto
 * themselves. `policy show --json` / `policy list --json` keep emitting the
 * resolver vocabulary (`full`/`local-only`/`ignore`) unchanged, so existing
 * consumers of the `--check --json` shape see identical fields.
 *
 * @ref LLP 0111#tokens [implements]: the sync -> full token mapping lives at the CLI edge; the store keeps speaking `full`
 */
const CLASS_TOKENS = /** @type {const} */ (['sync', 'local-only', 'ignore'])

/** @type {Record<(typeof CLASS_TOKENS)[number], UsageClass>} */
const TOKEN_TO_CLASS = { sync: 'full', 'local-only': 'local-only', ignore: 'ignore' }

/** @type {Record<UsageClass, string>} */
const CLASS_TO_TOKEN_GLOSS = { full: 'sync', 'local-only': 'local-only', ignore: 'ignore' }

const POLICY_SET_USAGE = 'hyp policy set <path> sync|local-only|ignore'
const POLICY_SHOW_USAGE = 'hyp policy show [path] [--json]'
const POLICY_UNSET_USAGE = 'hyp policy unset <path> [sync|local-only|ignore]'
const POLICY_LIST_USAGE = 'hyp policy list [--json]'

/**
 * @param {string[]} argv
 * @returns {{ path?: string, token?: string, error?: string }}
 */
function parsePolicySetArgs(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      class: { type: 'string', enum: [...CLASS_TOKENS] },
    },
    positional: ['path', 'class'],
    required: ['path', 'class'],
  })
  if ('help' in parsed) return { error: `usage: ${POLICY_SET_USAGE}` }
  if (!parsed.ok) return { error: parsed.error }
  const p = /** @type {{ path: string, class: string }} */ (parsed.params)
  return { path: p.path, token: p.class }
}

/**
 * @param {string[]} argv
 * @returns {{ path?: string, json: boolean, error?: string }}
 */
function parsePolicyShowArgs(argv) {
  const empty = { json: false }
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    positional: ['path'],
  })
  if ('help' in parsed) return { ...empty, error: `usage: ${POLICY_SHOW_USAGE}` }
  if (!parsed.ok) return { ...empty, error: parsed.error }
  const p = /** @type {{ path?: string, json: boolean }} */ (parsed.params)
  return { path: p.path, json: p.json }
}

/**
 * @param {string[]} argv
 * @returns {{ path?: string, token?: string, error?: string }}
 */
function parsePolicyUnsetArgs(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      class: { type: 'string', enum: [...CLASS_TOKENS] },
    },
    positional: ['path', 'class'],
    required: ['path'],
  })
  if ('help' in parsed) return { error: `usage: ${POLICY_UNSET_USAGE}` }
  if (!parsed.ok) return { error: parsed.error }
  const p = /** @type {{ path: string, class?: string }} */ (parsed.params)
  return { path: p.path, token: p.class }
}

/**
 * @param {string[]} argv
 * @returns {{ json: boolean, error?: string }}
 */
function parsePolicyListArgs(argv) {
  const empty = { json: false }
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      json: { type: 'boolean', default: false },
    },
  })
  if ('help' in parsed) return { ...empty, error: `usage: ${POLICY_LIST_USAGE}` }
  if (!parsed.ok) return { ...empty, error: parsed.error }
  const p = /** @type {{ json: boolean }} */ (parsed.params)
  return { json: p.json }
}

/**
 * `hyp policy set <path> sync|local-only|ignore`
 *
 * Writes a machine-local usage-class marking for `<path>` in the
 * class-per-entry store (LLP 0103), delegating to
 * {@link runMarkMachineLocal}, the internal both this verb and the
 * `hyp ignore --sync`/`--local-only`/`--private` compatibility aliases call.
 * `<path>` is required (the bare grammar makes it necessary: `hyp policy set
 * sync` would be ambiguous between a path and a class token) and resolved
 * against the command-context cwd, matching the sibling verbs; the resolved
 * directory is marked exactly where it points, with no repo-root default
 * (LLP 0111 #set) - an explicit path already says which directory is meant.
 * `set <path> ignore` writes a machine-local `ignore` entry; it never writes
 * a `.hypignore` dotfile (that stays bare `hyp ignore`'s job alone). An
 * unknown class token is a usage error (exit 2) naming the three valid
 * tokens (`sync`, `local-only`, `ignore`).
 *
 * @ref LLP 0110 [implements]: the class-neutral `policy set` that replaces the `hyp ignore --sync` misnomer for consent-adjacent marking
 * @ref LLP 0111#set [implements]: required path, sync -> full token mapping, delegates to the hoisted marking internal
 * @ref LLP 0103#cli [constrained-by]: the store, resolver, and class lattice are unchanged; only the verb spelling is new
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runPolicySet(argv, ctx) {
  const parsed = parsePolicySetArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }
  const targetDir = path.resolve(ctx.cwd ?? process.cwd(), /** @type {string} */ (parsed.path))
  const targetClass = TOKEN_TO_CLASS[/** @type {(typeof CLASS_TOKENS)[number]} */ (parsed.token)]
  return runMarkMachineLocal({ targetDir, ctx, targetClass, component: 'cmd-policy-set' })
}

/**
 * `hyp policy show [path] [--json]`
 *
 * The class-neutral successor to `hyp ignore --check`: resolves `[path]`
 * (default cwd, preserving `--check`'s ergonomics) and reports the resolved
 * class, the governing source (`dotfile`/`machine-local`/`none`), the
 * governing file, and the residual already-cached row count with the
 * `hyp purge` hint. Prospective-only, never destructive. `--json` emits the
 * exact field set `hyp ignore --check --json` emits today (byte-compatible),
 * since {@link runIgnoreCheck} is the shared implementation both spellings
 * call.
 *
 * @ref LLP 0110 [implements]: the class-neutral `policy show`, the `hyp ignore --check` successor
 * @ref LLP 0111#show [implements]: `--json` stays byte-compatible with today's `--check --json` field set
 * @ref LLP 0103#cli [constrained-by]: names the governing source (dotfile vs machine-local) and class; store/resolver unchanged
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runPolicyShow(argv, ctx) {
  const parsed = parsePolicyShowArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }
  const targetDir = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
  return runIgnoreCheck({ targetDir, ctx, json: parsed.json })
}

/**
 * `hyp policy unset <path> [sync|local-only|ignore]`
 *
 * Removes machine-local markings governing `<path>` (equal to it, or an
 * ancestor of it). By default (no trailing class token) it is class-neutral:
 * every machine-local entry governing the target is removed, "back to the
 * implicit default" (LLP 0111 #unset), matching the store's one-entry-per-dir
 * shape. An optional trailing class token scopes removal to that class only
 * - the scoped form the `hyp unignore --sync`/`--local-only`/`--private`
 * aliases delegate to. Both forms delegate to {@link runUnmarkMachineLocal}.
 * `unset` never touches `.hypignore` dotfiles and never touches cached rows
 * (LLP 0104 boundary). Idempotent: nothing governing (of the given class, or
 * of any class) is a no-op success.
 *
 * @ref LLP 0110 [implements]: the class-neutral `policy unset`, replacing per-class `hyp unignore` flags as the primary spelling
 * @ref LLP 0111#unset [implements]: class-neutral by default, an optional trailing class token scopes it
 * @ref LLP 0103#cli [constrained-by]: reuses the shared `isEqualOrDescendant` ancestor predicate; store/resolver unchanged
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runPolicyUnset(argv, ctx) {
  const parsed = parsePolicyUnsetArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }
  const targetDir = path.resolve(ctx.cwd ?? process.cwd(), /** @type {string} */ (parsed.path))
  const targetClass = parsed.token
    ? TOKEN_TO_CLASS[/** @type {(typeof CLASS_TOKENS)[number]} */ (parsed.token)]
    : undefined
  return runUnmarkMachineLocal({ targetDir, ctx, targetClass, component: 'cmd-policy-unset' })
}

/**
 * `hyp policy list [--json]`
 *
 * Enumerates the machine-local class-per-entry store (LLP 0103): one line
 * per entry with its `dir` and class (`full` renders with a `sync` gloss for
 * the human reader), plus the store path; `--json` emits
 * `{ entries: [{ dir, class }], path }`. This is the store's first
 * enumeration surface (LLP 0111 #list): `policy show` answers "what governs
 * this path", `list` answers "what have I marked on this machine". It
 * deliberately lists only the machine-local store - `.hypignore` dotfiles
 * are discovered per-path by the ancestor walk and cannot be enumerated
 * without a filesystem crawl, and `show` already names them when they
 * govern. An empty store lists zero entries successfully.
 *
 * @ref LLP 0110 [implements]: names the machine-local store's enumeration surface with the class-neutral verb
 * @ref LLP 0111#list [implements]: the store's first enumeration surface; `--json` emits `{ entries, path }`
 * @ref LLP 0103#cli [constrained-by]: enumerates the version-2 class-per-entry store as-is; no format change
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runPolicyList(argv, ctx) {
  const parsed = parsePolicyListArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const listPath = localOnlyListPath(stateDir)
  const entries = await readLocalOnlyEntries({ stateDir })

  if (parsed.json) {
    ctx.stdout.write(JSON.stringify({ entries, path: listPath }) + '\n')
    return 0
  }

  if (entries.length === 0) {
    ctx.stdout.write(`no machine-local entries (${listPath})\n`)
    return 0
  }
  for (const entry of entries) {
    const gloss = entry.class === 'full' ? ` (${CLASS_TO_TOKEN_GLOSS.full})` : ''
    ctx.stdout.write(`${entry.dir}: ${entry.class}${gloss}\n`)
  }
  ctx.stdout.write(`(${listPath})\n`)
  return 0
}
