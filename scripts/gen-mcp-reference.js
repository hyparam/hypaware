#!/usr/bin/env node
// @ts-check

/**
 * Generate `docs/MCP_REFERENCE.md` from the code that serves MCP:
 *
 * 1. the verbs core and the bundled plugins register, read from an injected
 *    kernel with no boot (each plugin is dry-run activated, as
 *    `test/core/cli-consistency-gate.test.js` does, so nothing binds a port
 *    or writes under `HYP_HOME`);
 * 2. `REMOTE_TOOL_CONTRACTS`, the recommendation tools hypaware-server binds;
 * 3. the prompt definitions in `src/core/mcp/prompts.js`.
 *
 * Titles, descriptions, schemas and hints are what `tools/list` answers for
 * each tool: both lists come from `createMcpServer`, never from a copy here.
 *
 *   node scripts/gen-mcp-reference.js           write the page
 *   node scripts/gen-mcp-reference.js --check   exit 1 when the page is stale
 *
 * `test/core/mcp-reference-drift.test.js` runs the check in `npm test`.
 *
 * @ref LLP 0494#docs-reference [implements]: generated from the registered verbs, the contracts and the prompts; the drift test stands in for a docs-build hook until HYP-140
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { loadManifest } from '../src/core/manifest.js'
import { REMOTE_TOOL_CONTRACTS } from '../src/core/mcp/contracts.js'
import { listPrompts } from '../src/core/mcp/prompts.js'
import { createMcpServer } from '../src/core/mcp/server.js'
import { dryRunActivate } from '../src/core/plugin_doctor/dry_run.js'
import { createCommandRegistry } from '../src/core/registry/commands.js'
import { createVerbRegistry, verbAuthClass, verbExposure } from '../src/core/registry/verbs.js'
import { createKernelRuntime } from '../src/core/runtime/activation.js'

/**
 * @import { PluginManifest, VerbExposure, VerbInputSchema, VerbRegistration } from '../hypaware-plugin-kernel-types.js'
 */

const REPO = path.resolve(import.meta.dirname, '..')
export const REFERENCE_PATH = path.join(REPO, 'docs', 'MCP_REFERENCE.md')
export const REGENERATE = 'node scripts/gen-mcp-reference.js'
const WORKSPACE = path.join(REPO, 'hypaware-core', 'plugins-workspace')

/**
 * The CLI command each prompt mirrors (LLP 0494#prompts). The prompt
 * definitions carry no such field, so a prompt added without a row here
 * stops the generator rather than reaching the page without one.
 */
const PROMPT_CLI = Object.freeze({
  fix_recommendation: 'hyp report fix <id>',
  open_recommendations: 'hyp report list --recommendations --status open',
  check_team_history: 'hyp ask',
})

/** What each exposure means for where a verb is a tool. */
const EXPOSURE_TEXT = Object.freeze({
  'cli+mcp': 'a CLI command and an MCP tool on every transport',
  'local-only': 'a CLI command, and an MCP tool over stdio only',
})

/** Who sees a tool of each auth class, by the `toolVisible` gate in `src/core/mcp/server.js`. */
const AUTH_TEXT = Object.freeze({
  read: 'listed to any caller the host admits',
  write: 'listed only to a credential holding the scope; `hyp mcp serve` passes no scopes',
  operator: 'listed over stdio (local trust); a network host lists it only when it allows operator tools',
})

/**
 * One tool on the page: the `tools/list` entry beside the registration
 * fields that entry does not carry.
 *
 * @param {ReturnType<ReturnType<typeof createMcpServer>['listTools']>[number]} entry
 * @param {{ authClass: string, scope?: string, exposure: string, cli: string, owner: string, schema: VerbInputSchema, cliFlags: boolean }} meta
 */
function toolSection(entry, meta) {
  const { title: _title, ...hints } = entry.annotations
  const auth = meta.scope ? `\`${meta.authClass}\`, scope \`${meta.scope}\`` : `\`${meta.authClass}\``
  const lines = [
    `### \`${entry.name}\``,
    '',
    `**${entry.title}**`,
    '',
    cell(entry.description, false),
    '',
    '| | |',
    '| --- | --- |',
    `| Title | ${cell(entry.title)} |`,
    `| Auth class | ${auth}: ${authText(meta.authClass)} |`,
    `| Hints | ${Object.entries(hints).map(([k, v]) => `\`${k}: ${v}\``).join(', ')} |`,
    `| Exposure | ${meta.exposure} |`,
    `| CLI equivalent | \`${meta.cli}\` |`,
    `| Registered by | ${meta.owner} |`,
    '',
    ...schemaTable(entry.inputSchema, meta.schema, meta.cliFlags),
  ]
  return lines.join('\n')
}

/**
 * The input schema as a table, from the advertised JSON Schema. With
 * `cliFlags`, a column gives the CLI spelling of each argument, read from the
 * verb's own schema (`positional` is CLI-only and not advertised).
 *
 * @param {object} advertised the entry's `inputSchema`, a JSON Schema object
 * @param {VerbInputSchema} schema
 * @param {boolean} cliFlags
 * @returns {string[]}
 */
function schemaTable(advertised, schema, cliFlags) {
  const json = /** @type {{ properties?: Record<string, unknown>, required?: string[] }} */ (advertised)
  const props = Object.entries(json.properties ?? {})
  if (props.length === 0) return ['No arguments.']
  const required = new Set(json.required ?? [])
  const positional = schema.positional ?? []
  const head = cliFlags
    ? ['| Argument | Type | Required | Default | CLI | Description |', '| --- | --- | --- | --- | --- | --- |']
    : ['| Argument | Type | Required | Default | Description |', '| --- | --- | --- | --- | --- |']
  const rows = props.map(([name, prop]) => {
    const p = /** @type {Record<string, any>} */ (prop)
    const cols = [
      `\`${name}\``,
      typeText(p),
      required.has(name) ? 'yes' : 'no',
      p.default === undefined ? '' : `\`${JSON.stringify(p.default)}\``,
    ]
    if (cliFlags) cols.push(positional.includes(name) ? `\`<${name}>\`` : `\`--${name.replace(/_/g, '-')}\``)
    cols.push(cell(p.description ?? ''))
    return `| ${cols.join(' | ')} |`
  })
  return [...head, ...rows]
}

/**
 * @param {Record<string, any>} prop
 */
function typeText(prop) {
  let text = prop.type === 'array' ? `array of ${prop.items?.type ?? 'any'}` : String(prop.type ?? 'any')
  const values = prop.enum ?? prop.items?.enum
  if (Array.isArray(values)) text += `: ${values.map((v) => `\`${v}\``).join(', ')}`
  if (prop.minimum !== undefined && prop.maximum !== undefined) text += `, ${prop.minimum} to ${prop.maximum}`
  else if (prop.minimum !== undefined) text += `, at least ${prop.minimum}`
  else if (prop.maximum !== undefined) text += `, at most ${prop.maximum}`
  return text
}

/**
 * A value set into a table cell (or, with `inTable` false, a paragraph).
 *
 * @param {string} text
 * @param {boolean} [inTable]
 */
function cell(text, inTable = true) {
  const flat = String(text).replace(/\s*\n\s*/g, ' ')
  return inTable ? flat.replace(/\|/g, '\\|') : flat
}

/**
 * @param {string} authClass
 */
function authText(authClass) {
  if (!Object.hasOwn(AUTH_TEXT, authClass)) throw new Error(`gen-mcp-reference: no description for auth class '${authClass}'`)
  return AUTH_TEXT[/** @type {keyof typeof AUTH_TEXT} */ (authClass)]
}

/**
 * @param {VerbExposure} exposure
 */
function exposureText(exposure) {
  if (!Object.hasOwn(EXPOSURE_TEXT, exposure)) throw new Error(`gen-mcp-reference: no description for exposure '${exposure}'`)
  return `\`${exposure}\`: ${EXPOSURE_TEXT[/** @type {keyof typeof EXPOSURE_TEXT} */ (exposure)]}`
}

/**
 * The CLI command a verb projects: `hyp <name>` and its positionals.
 *
 * @param {VerbRegistration} verb
 */
function verbCli(verb) {
  const required = new Set(verb.inputSchema.required ?? [])
  const parts = [`hyp ${verb.name}`]
  for (const p of verb.inputSchema.positional ?? []) parts.push(required.has(p) ? `<${p}>` : `[${p}]`)
  return parts.join(' ')
}

/** @returns {never} */
function unbound() {
  throw new Error('gen-mcp-reference: reference tools are listed, never called')
}

/**
 * The kernel `hyp mcp serve` would host: core verbs from
 * `createKernelRuntime`, then every bundled plugin's verbs, each read from a
 * dry-run activation of that plugin. Registering them into one registry
 * refuses a tool name two plugins claim, as the real loader does.
 *
 * @returns {Promise<{ kernel: ReturnType<typeof createKernelRuntime>, owners: Map<string, string> }>}
 */
async function bundledKernel() {
  const kernel = createKernelRuntime({ commandRegistry: createCommandRegistry() })
  /** @type {Map<string, string>} */
  const owners = new Map(kernel.verbs.list().map((verb) => [verb.tool, 'core']))
  const dirs = (await fs.readdir(WORKSPACE, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(WORKSPACE, entry.name))
    .sort()
  /** @type {Map<string, string[]>} */
  const knownCapabilities = new Map()
  /** @type {{ dir: string, manifest: PluginManifest }[]} */
  const plugins = []
  for (const dir of dirs) {
    const loaded = await loadManifest(dir)
    if (!loaded.ok) throw new Error(`gen-mcp-reference: ${dir}: manifest does not load`)
    plugins.push({ dir, manifest: loaded.manifest })
    for (const [name, version] of Object.entries(loaded.manifest.provides?.capabilities ?? {})) {
      knownCapabilities.set(name, [...(knownCapabilities.get(name) ?? []), version])
    }
  }
  for (const { dir, manifest } of plugins) {
    const dry = await dryRunActivate(manifest, dir, { knownCapabilities, withVerbs: true })
    if (!dry.ok) throw new Error(`gen-mcp-reference: ${manifest.name}: activate() did not complete (${dry.error?.kind}: ${dry.error?.message})`)
    for (const verb of dry.verbs ?? []) {
      kernel.verbs.register(verb)
      owners.set(verb.tool, `\`${manifest.name}\``)
    }
  }
  return { kernel, owners }
}

/**
 * Render the whole page. Pure apart from reading the plugin workspace: the
 * drift test compares this string with the checked-in file.
 *
 * @returns {Promise<string>}
 */
export async function renderMcpReference() {
  const { kernel, owners } = await bundledKernel()

  // Every class and scope admitted, so each verb that is an MCP tool at all
  // is listed with the entry and hints `tools/list` gives for it.
  const localVerbs = kernel.verbs.list()
  const localScopes = localVerbs.filter((v) => verbAuthClass(v) === 'write').map((v) => /** @type {string} */ (v.scope))
  const localServer = createMcpServer({
    verbs: kernel.verbs, query: kernel.query, runTool: unbound, transport: 'stdio', allowOperator: true, allowScopes: localScopes,
  })
  const localEntries = localServer.listTools()

  // The recommendation contracts, registered the way hypaware-server binds
  // them, and listed as `/v1/mcp` lists them to a credential holding every
  // scope they name.
  const remote = createVerbRegistry()
  for (const contract of REMOTE_TOOL_CONTRACTS) {
    remote.register({
      name: contract.tool,
      tool: contract.tool,
      title: contract.title,
      summary: contract.summary,
      inputSchema: contract.inputSchema,
      authClass: contract.authClass,
      ...(contract.scope === undefined ? {} : { scope: contract.scope }),
      operation: unbound,
      render: unbound,
    })
  }
  const remoteScopes = REMOTE_TOOL_CONTRACTS.flatMap((c) => (c.scope === undefined ? [] : [c.scope]))
  const remoteServer = createMcpServer({
    verbs: remote, query: kernel.query, runTool: unbound, transport: 'http', allowScopes: remoteScopes,
  })
  const remoteEntries = remoteServer.listTools()
  if (remoteEntries.length !== REMOTE_TOOL_CONTRACTS.length) {
    throw new Error('gen-mcp-reference: a recommendation contract is not listed with every scope it names')
  }

  const out = [
    '# MCP reference',
    '',
    `<!-- Generated by scripts/gen-mcp-reference.js. Do not edit by hand: run \`${REGENERATE}\`. -->`,
    '',
    'HypAware serves MCP in two places:',
    '',
    '- `hyp mcp serve`, over stdio, for an agent on your machine. It lists the tools core and your active plugins register.',
    '- hypaware-server\'s `/v1/mcp`, over HTTP, for an agent with a member session or an agent token. What it lists depends on the credential.',
    '',
    'Every tool below has a CLI command that does the same thing. Each tool\'s `tools/list` entry carries its title, description, input schema and hints, as shown here.',
    '',
    '## Local tools',
    '',
    'Registered by core and the bundled plugins. `hyp mcp serve` lists each one whose plugin is active.',
    '',
  ]
  for (const entry of localEntries) {
    const verb = /** @type {VerbRegistration} */ (kernel.verbs.getByTool(entry.name))
    const authClass = verbAuthClass(verb)
    out.push(toolSection(entry, {
      authClass,
      ...(authClass === 'write' ? { scope: verb.scope } : {}),
      exposure: exposureText(verbExposure(verb)),
      cli: verbCli(verb),
      owner: owners.get(entry.name) ?? 'core',
      schema: verb.inputSchema,
      cliFlags: true,
    }), '')
  }

  out.push(
    '## Recommendation tools',
    '',
    'Served by hypaware-server on `/v1/mcp`. Their names, schemas and CLI equivalents are shared with the client (`src/core/mcp/contracts.js`); `hyp mcp serve` does not list them.',
    '',
  )
  for (const entry of remoteEntries) {
    const contract = /** @type {(typeof REMOTE_TOOL_CONTRACTS)[number]} */ (REMOTE_TOOL_CONTRACTS.find((c) => c.tool === entry.name))
    out.push(toolSection(entry, {
      authClass: contract.authClass,
      ...(contract.scope === undefined ? {} : { scope: contract.scope }),
      exposure: '`/v1/mcp` only',
      cli: contract.cli,
      owner: 'hypaware-server, from the shared contract',
      schema: contract.inputSchema,
      cliFlags: false,
    }), '')
  }

  out.push(
    '## Server-only tools',
    '',
    '`session_evidence` and the other tools hypaware-server registers on its own are defined in the server alone, so they have no entry here. '
      + 'Call `tools/list` on `/v1/mcp` for the tools your credential sees, with their titles, schemas and hints.',
    '',
    '## Prompts',
    '',
    'Each prompt is an agent command as text an agent can run (`prompts/list`, `prompts/get`). '
      + 'A rendering names only the tools the assembly lists.',
    '',
  )
  const localVisible = new Set(localEntries.map((e) => e.name))
  const allVisible = new Set([...localVisible, ...remoteEntries.map((e) => e.name)])
  const stdioPrompts = new Set(listPrompts(localVisible, 'stdio').map((p) => p.name))
  const httpBare = new Set(listPrompts(new Set(), 'http').map((p) => p.name))
  for (const prompt of listPrompts(allVisible, 'http').concat(listPrompts(localVisible, 'stdio'))
    .filter((p, i, all) => all.findIndex((q) => q.name === p.name) === i)) {
    if (!Object.hasOwn(PROMPT_CLI, prompt.name)) {
      throw new Error(`gen-mcp-reference: prompt '${prompt.name}' has no CLI equivalent in PROMPT_CLI`)
    }
    /** @type {string} */
    let http
    if (httpBare.has(prompt.name)) {
      http = 'always'
    } else {
      const needs = remoteEntries.map((e) => e.name).filter((tool) => listPrompts(new Set([tool]), 'http').some((p) => p.name === prompt.name))
      http = needs.length > 0 ? `when ${needs.map((t) => `\`${t}\``).join(' or ')} is listed` : 'not offered'
    }
    out.push(
      `### \`${prompt.name}\``,
      '',
      `**${prompt.title}**`,
      '',
      cell(prompt.description, false),
      '',
      '| | |',
      '| --- | --- |',
      `| Title | ${cell(prompt.title)} |`,
      `| Over stdio | ${stdioPrompts.has(prompt.name) ? 'always' : 'not offered'} |`,
      `| Over \`/v1/mcp\` | ${http} |`,
      `| CLI equivalent | \`${PROMPT_CLI[/** @type {keyof typeof PROMPT_CLI} */ (prompt.name)]}\` |`,
      '',
    )
    if (prompt.arguments.length === 0) {
      out.push('No arguments.', '')
    } else {
      out.push('| Argument | Required | Description |', '| --- | --- | --- |')
      for (const arg of prompt.arguments) out.push(`| \`${arg.name}\` | ${arg.required ? 'yes' : 'no'} | ${cell(arg.description)} |`)
      out.push('')
    }
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

if (isMain(import.meta.url, process.argv[1])) {
  const page = await renderMcpReference()
  if (process.argv.includes('--check')) {
    const current = await fs.readFile(REFERENCE_PATH, 'utf8').catch(() => '')
    if (current !== page) {
      process.stderr.write(`docs/MCP_REFERENCE.md is stale: run ${REGENERATE}\n`)
      process.exit(1)
    }
  } else {
    await fs.writeFile(REFERENCE_PATH, page)
    process.stdout.write(`wrote ${path.relative(REPO, REFERENCE_PATH)}\n`)
  }
}

/**
 * @param {string} moduleUrl
 * @param {string | undefined} argvPath
 */
function isMain(moduleUrl, argvPath) {
  return !!argvPath && moduleUrl === pathToFileURL(argvPath).href
}
