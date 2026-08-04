// @ts-check

import path from 'node:path'
import process from 'node:process'

import { parseCommandArgv } from '../cli/verb_codec.js'
import { Attr, getActiveSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import {
  ClientSyncListUnreadableError,
  clientSyncListPath,
  LocalOnlyListUnreadableError,
  localOnlyListPath,
  readClientSyncEntries,
  readLocalOnlyEntries,
  writeClientSyncEntries,
} from '../usage-policy/index.js'
import { defaultConfigPath } from '../config/schema.js'
import { resolveLayeredConfigFromDisk } from '../runtime/boot.js'
import { classifyClientProvenance } from '../cli/wizard/provenance.js'
import { buildAttachPluginCatalog, runIgnoreCheck, runMarkMachineLocal, runUnmarkMachineLocal } from './clients.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { PolicyHumanVocabulary } from '../../../src/core/commands/types.js'
 * @import { ClientSyncEntry, UsageClass } from '../../../src/core/usage-policy/types.js'
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
 * three-class lattice are untouched (LLP 0103 #cli). Every human line these
 * runners print goes through {@link PUBLIC_VOCABULARY}, so the verb answers
 * in the vocabulary it teaches; `--json` and the aliases do not.
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
const CLASS_TO_TOKEN = { full: 'sync', 'local-only': 'local-only', ignore: 'ignore' }

/**
 * How the machine-local store is named to a human: a policy store, not the
 * `local-only.json` file that happens to back it. Printing the path verbatim
 * made a `policy set <path> sync` confirmation read as though the folder had
 * become local-only (issue #393), which is the exact inversion LLP 0110
 * minted this verb to kill.
 */
const STORE_LABEL = 'machine-local policy store'

/**
 * The human wording every `policy` subcommand prints: the CLI-edge token
 * vocabulary the user typed and the hook and the privacy skill teach, never
 * the stored class or the store's file path. `--json` never routes through
 * this, so the machine contract keeps emitting the resolver vocabulary and
 * the real store path; the deprecated `hyp ignore` / `hyp unignore` flag
 * aliases do not pass it and keep their exact legacy output (LLP 0111
 * #aliases). A governing `.hypignore` is still named by its real path: it is
 * a file the user can open and edit, not an internal.
 *
 * @ref LLP 0111#tokens [implements]: the class-to-token mapping is a CLI-edge rendering; the store and the JSON keep speaking `full`
 * @ref LLP 0111#set [implements]: `storeSuffix` names `set`'s confirmation as machine-local too, so it is not the one `policy` line that fails to say so
 * @type {PolicyHumanVocabulary}
 */
const PUBLIC_VOCABULARY = {
  className: (cls) => CLASS_TO_TOKEN[cls] ?? cls,
  governor: (governedBy, listPath) => (governedBy === listPath ? STORE_LABEL : governedBy),
  storeSuffix: () => ` (${STORE_LABEL})`,
  implicitSuffix: () => ' (implicit default, not yet classified)',
}

/**
 * The `policy` edge's wording for a corrupt machine-local store: still names
 * the file (the user needs to know which one to repair) but never calls it
 * "the local-only list" - `LocalOnlyListUnreadableError`'s own message does,
 * which is exactly the internals-leaking vocabulary this verb exists to
 * avoid (LLP 0111 #tokens). Scoped to the four `policy` runners only
 * ({@link runPolicySet}, {@link runPolicyShow}, {@link runPolicyUnset},
 * {@link runPolicyList}): `hyp status` and the deprecated `hyp
 * ignore`/`hyp unignore` aliases keep the resolver's own wording (LLP 0111
 * #aliases).
 *
 * Catching here also means the error never reaches the dispatcher's generic
 * catch, which is what tags the `command.run` span with `error_kind`. So this
 * carries the error's own kind onto the active span itself (issue #413):
 * without it a corrupt policy store is the one `policy` failure that leaves
 * only a nonzero `exit_code` in telemetry, with nothing naming the broken
 * step. Purely additive - the wording and the exit code are unchanged.
 *
 * @ref LLP 0111#tokens [implements]: a corrupt store is still "the machine-local policy store", never "the local-only list"
 * @ref LLP 0021#the-attribute-contract [implements]: a handled failure still owes the span its `error_kind`; the error carries its own kind
 * @param {CommandRunContext} ctx
 * @param {LocalOnlyListUnreadableError} err
 * @returns {number}
 */
function reportUnreadableStore(ctx, err) {
  getActiveSpan()?.setAttribute(Attr.ERROR_KIND, err.error_kind)
  ctx.stderr.write(`error: the machine-local policy store at '${err.filePath}' is unreadable or malformed\n`)
  return 1
}

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
 * @ref LLP 0111#tokens [implements]: a corrupt store still speaks the policy-store wording, never "the local-only list"
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
  try {
    return await runMarkMachineLocal({ targetDir, ctx, targetClass, component: 'cmd-policy-set', vocabulary: PUBLIC_VOCABULARY })
  } catch (err) {
    if (!(err instanceof LocalOnlyListUnreadableError)) throw err
    return reportUnreadableStore(ctx, err)
  }
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
 * @ref LLP 0111#tokens [implements]: a corrupt store still speaks the policy-store wording, never "the local-only list"
 * @ref LLP 0103#reporting [constrained-by]: the report names which source governs (dotfile vs machine-local entry) and the class
 * @ref LLP 0103#cli [constrained-by]: the store, resolver, and class lattice are unchanged; only the verb spelling is new
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
  try {
    return await runIgnoreCheck({ targetDir, ctx, json: parsed.json, vocabulary: PUBLIC_VOCABULARY })
  } catch (err) {
    if (!(err instanceof LocalOnlyListUnreadableError)) throw err
    return reportUnreadableStore(ctx, err)
  }
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
 * @ref LLP 0111#tokens [implements]: a corrupt store still speaks the policy-store wording, never "the local-only list"
 * @ref LLP 0103#cli [constrained-by]: the symmetric removal `hyp unignore` grew, now spelled class-neutrally; store, resolver, and class lattice unchanged
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
  try {
    return await runUnmarkMachineLocal({
      targetDir,
      ctx,
      targetClass,
      component: 'cmd-policy-unset',
      vocabulary: PUBLIC_VOCABULARY,
    })
  } catch (err) {
    if (!(err instanceof LocalOnlyListUnreadableError)) throw err
    return reportUnreadableStore(ctx, err)
  }
}

/**
 * `hyp policy list [--json]`
 *
 * Enumerates the machine-local class-per-entry store (LLP 0103): one line
 * per entry with its `dir` and class rendered in the token vocabulary (a
 * stored `full` reads `sync`), plus the store path, labelled as the policy
 * store rather than dumped bare (LLP 0111 #tokens); `--json` emits
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
 * @ref LLP 0111#tokens [implements]: a corrupt store still speaks the policy-store wording, never "the local-only list"
 * @ref LLP 0103#cli [constrained-by]: enumerates the version-2 class-per-entry store as-is; no format change
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
const POLICY_CLIENT_USAGE = 'hyp policy client [<name>] [sync|local-only] [--json]'

/** How the per-client store is named to a human, mirroring {@link STORE_LABEL}. */
const CLIENT_STORE_LABEL = 'machine-local client policy store'

/**
 * The `policy client` edge's wording for a corrupt client-sync store,
 * mirroring {@link reportUnreadableStore} for the directory store (same
 * span-tagging rationale, issue #413).
 *
 * @param {CommandRunContext} ctx
 * @param {ClientSyncListUnreadableError} err
 * @returns {number}
 */
function reportUnreadableClientStore(ctx, err) {
  getActiveSpan()?.setAttribute(Attr.ERROR_KIND, err.error_kind)
  ctx.stderr.write(`error: the ${CLIENT_STORE_LABEL} at '${err.filePath}' is unreadable or malformed\n`)
  return 1
}

/**
 * @param {string[]} argv
 * @returns {{ name?: string, token?: 'sync' | 'local-only', json: boolean, error?: string }}
 */
function parsePolicyClientArgs(argv) {
  const empty = { json: false }
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      name: { type: 'string' },
      class: { type: 'string', enum: ['sync', 'local-only'] },
      json: { type: 'boolean', default: false },
    },
    positional: ['name', 'class'],
  })
  if ('help' in parsed) return { ...empty, error: `usage: ${POLICY_CLIENT_USAGE}` }
  if (!parsed.ok) return { ...empty, error: parsed.error }
  const p = /** @type {{ name?: string, class?: 'sync' | 'local-only', json: boolean }} */ (parsed.params)
  return { name: p.name, token: p.class, json: p.json }
}

/**
 * Resolve the catalog and layered config for provenance classification,
 * best-effort: a broken config layer must not lock the user out of editing
 * their own opt-out store, so a resolution failure degrades to "provenance
 * unknown" (`layered: null`), which never blocks a write - only a proven
 * `'central'` classification does (LLP 0181 #locked); the resolver applies
 * the same exemption at build time, so a wrongly accepted entry is inert,
 * never a leak.
 *
 * @param {CommandRunContext} ctx
 */
async function resolveClientPolicyContext(ctx) {
  const catalog = await buildAttachPluginCatalog(ctx)
  const obsEnv = readObservabilityEnv(ctx.env)
  const configPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)
  /** @type {Awaited<ReturnType<typeof resolveLayeredConfigFromDisk>> | null} */
  let layered = null
  try {
    layered = await resolveLayeredConfigFromDisk({
      stateRoot: obsEnv.stateDir,
      configPath,
      knownPlugins: catalog.pluginMetadata,
      knownDatasets: catalog.knownDatasets,
    })
  } catch { /* provenance degrades to unknown; the write path stays available */ }
  return { catalog, layered, stateDir: obsEnv.stateDir }
}

/**
 * `hyp policy client [<name>] [sync|local-only] [--json]`
 *
 * The per-client sibling of the directory verbs (LLP 0181): on an enrolled
 * machine every configured source syncs by default, and this verb edits the
 * machine-local opt-out store that keeps a client's rows local. With no
 * arguments it enumerates the store plus the current syncing/local-only
 * picture; with a name it reports that client's state; with a trailing
 * token it writes (`local-only` opts out, `sync` removes the opt-out,
 * idempotent both ways). A source the central config carries always syncs
 * and cannot be opted out (LLP 0181 #locked). Flipping back to `sync`
 * ships only future rows: withholding is drop-but-advance, so rows dropped
 * while opted out are never retroactively uploaded
 * (LLP 0181 #no-retroactive-ship) - the confirmation says so.
 *
 * @ref LLP 0181#opt-out [implements]: the post-onboarding CLI surface over the client-sync store
 * @ref LLP 0181#locked [implements]: a central-classified source is refused with the managed-by-your-fleet wording
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runPolicyClient(argv, ctx) {
  const parsed = parsePolicyClientArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }
  const { catalog, layered, stateDir } = await resolveClientPolicyContext(ctx)
  const storePath = clientSyncListPath(stateDir)
  /** @type {ClientSyncEntry[] | null} */
  let entries
  try {
    entries = await readClientSyncEntries({ stateDir })
  } catch (err) {
    if (!(err instanceof ClientSyncListUnreadableError)) throw err
    return reportUnreadableClientStore(ctx, err)
  }
  const optedOut = new Set((entries ?? []).map((e) => e.source))
  /** @type {(name: string) => 'central' | 'local' | 'absent' | 'unknown'} */
  const provenanceOf = (name) =>
    layered ? classifyClientProvenance(name, layered, catalog) : 'unknown'

  if (!parsed.name) {
    if (parsed.json) {
      ctx.stdout.write(JSON.stringify({ entries: entries ?? [], path: storePath }) + '\n')
      return 0
    }
    if (optedOut.size === 0) {
      ctx.stdout.write(`no clients are kept local-only - every configured source syncs by default (${CLIENT_STORE_LABEL}: ${storePath})\n`)
      return 0
    }
    ctx.stdout.write(`clients kept local-only: ${[...optedOut].sort().join(' · ')}\n`)
    ctx.stdout.write(`(${CLIENT_STORE_LABEL}: ${storePath})\n`)
    return 0
  }

  const name = parsed.name
  const known = catalog.pickerDescriptors.has(name) || catalog.clientDescriptors.has(name)
  if (!known) {
    const knownIds = [...catalog.pickerDescriptors.keys()].sort().join(', ')
    ctx.stderr.write(`error: unknown client '${name}' (known: ${knownIds})\n`)
    return 2
  }
  const provenance = provenanceOf(name)

  if (!parsed.token) {
    if (parsed.json) {
      const state = provenance === 'central' ? 'sync' : optedOut.has(name) ? 'local-only' : 'sync'
      ctx.stdout.write(JSON.stringify({ source: name, state, managed: provenance === 'central', path: storePath }) + '\n')
      return 0
    }
    if (provenance === 'central') {
      ctx.stdout.write(`${name}: sync (managed by your fleet)\n`)
    } else if (optedOut.has(name)) {
      ctx.stdout.write(`${name}: local-only (${CLIENT_STORE_LABEL})\n`)
    } else {
      ctx.stdout.write(`${name}: sync (default)\n`)
    }
    return 0
  }

  if (parsed.token === 'local-only') {
    if (provenance === 'central') {
      ctx.stderr.write(`error: '${name}' is managed by your fleet and always syncs to your server\n`)
      return 1
    }
    const next = [...(entries ?? []), { source: name, class: /** @type {'local-only'} */ ('local-only') }]
    try {
      await writeClientSyncEntries({ stateDir, entries: next })
    } catch (err) {
      if (!(err instanceof ClientSyncListUnreadableError)) throw err
      return reportUnreadableClientStore(ctx, err)
    }
    ctx.stdout.write(`${name}: local-only${optedOut.has(name) ? ' (unchanged)' : ''}\n`)
    ctx.stdout.write(`  future ${name} rows stay on this machine; rows already exported are not recalled\n`)
    if (layered && !layered.centralConfig) {
      ctx.stdout.write('  this machine is not connected to a server; the opt-out takes effect if it joins one\n')
    }
    return 0
  }

  // token === 'sync': remove the opt-out, idempotent.
  if (!optedOut.has(name)) {
    ctx.stdout.write(`${name}: sync${provenance === 'central' ? ' (managed by your fleet)' : ' (default, unchanged)'}\n`)
    return 0
  }
  try {
    await writeClientSyncEntries({ stateDir, entries: (entries ?? []).filter((e) => e.source !== name) })
  } catch (err) {
    if (!(err instanceof ClientSyncListUnreadableError)) throw err
    return reportUnreadableClientStore(ctx, err)
  }
  ctx.stdout.write(`${name}: sync\n`)
  // @ref LLP 0181#no-retroactive-ship [implements]: the flip-back confirmation states the no-history-upload property so it reads as designed, not as a bug
  ctx.stdout.write(`  future ${name} rows sync to your server; rows withheld while local-only are not uploaded\n`)
  return 0
}

export async function runPolicyList(argv, ctx) {
  const parsed = parsePolicyListArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const listPath = localOnlyListPath(stateDir)
  let entries
  try {
    entries = await readLocalOnlyEntries({ stateDir })
  } catch (err) {
    if (!(err instanceof LocalOnlyListUnreadableError)) throw err
    return reportUnreadableStore(ctx, err)
  }
  // The per-client opt-out store (LLP 0181) is enumerated alongside the
  // directory entries: `list` answers "what have I marked on this machine",
  // and a client marking is exactly that. Additive: the `--json` byte-compat
  // guarantee binds `policy show --json` (LLP 0111 #show), not `list`.
  const clientStorePath = clientSyncListPath(stateDir)
  /** @type {ClientSyncEntry[]} */
  let clientEntries = []
  try {
    clientEntries = (await readClientSyncEntries({ stateDir })) ?? []
  } catch (err) {
    if (!(err instanceof ClientSyncListUnreadableError)) throw err
    return reportUnreadableClientStore(ctx, err)
  }

  if (parsed.json) {
    ctx.stdout.write(JSON.stringify({
      entries,
      path: listPath,
      clients: { entries: clientEntries, path: clientStorePath },
    }) + '\n')
    return 0
  }

  if (entries.length === 0 && clientEntries.length === 0) {
    ctx.stdout.write(`no machine-local entries (policy store: ${listPath})\n`)
    return 0
  }
  for (const entry of entries) {
    ctx.stdout.write(`${entry.dir}: ${PUBLIC_VOCABULARY.className(entry.class)}\n`)
  }
  if (entries.length > 0) ctx.stdout.write(`(policy store: ${listPath})\n`)
  if (clientEntries.length > 0) {
    ctx.stdout.write(`clients kept local-only: ${clientEntries.map((e) => e.source).sort().join(' · ')}\n`)
    ctx.stdout.write(`(${CLIENT_STORE_LABEL}: ${clientStorePath})\n`)
  }
  return 0
}
