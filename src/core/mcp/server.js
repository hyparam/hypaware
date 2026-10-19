// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { jsonReplacer } from '../query/format.js'
import { UNDECLARED_SCHEMA_NOTE } from '../query/schema.js'
import { toJsonSchema, validateToolArguments } from '../cli/verb_codec.js'
import { verbAuthClass, verbExposure } from '../registry/verbs.js'
import { buildInstructions } from './instructions.js'
import { listPrompts, renderPrompt } from './prompts.js'
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  isNotification,
  jsonRpcError,
  jsonRpcResult,
} from './jsonrpc.js'

/**
 * @import { DatasetRegistration, PluginName, QueryRegistry, VerbAuthClass, VerbRegistration, VerbRegistry } from '../../../hypaware-plugin-kernel-types.js'
 */

/** Protocol version advertised when the client sends none. */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const SERVER_NAME = 'hypaware'
/** Telemetry identity for the records this assembly emits. */
const SERVER_COMPONENT = 'mcp-server'
const LIST_TOOLS_OPERATION = 'mcp.tools_list'
const LIST_RESOURCES_OPERATION = 'mcp.resources_list'
const HANDLE_OPERATION = 'mcp.handle_message'

/**
 * The `annotations` hints each auth class implies. A verb names its class,
 * never its hints, so no registration can advertise a hint its class
 * contradicts (a `read` claim on a verb allowed to rewrite state).
 *
 * @type {Readonly<Record<VerbAuthClass, Readonly<{ readOnlyHint: boolean, destructiveHint?: boolean }>>>}
 * @ref LLP 0494#annotations [implements]: hints derive from the auth class, with no per-verb override
 */
const HINTS_BY_AUTH_CLASS = Object.freeze({
  read: Object.freeze({ readOnlyHint: true }),
  // A mark appends to a ledger and removes nothing, so `write` is not destructive.
  write: Object.freeze({ readOnlyHint: false, destructiveHint: false }),
  operator: Object.freeze({ readOnlyHint: false, destructiveHint: true }),
})

/**
 * Build the **one server assembly** (verbs → MCP tools, datasets → MCP
 * resources) the kernel exposes. The transport (stdio here; HTTP later) is
 * a thin adapter over this object: the tool list is emergent from the
 * verbs the active plugins registered, so a new capability is a new tool
 * with zero server change (LLP 0034 §pluggable-transport / §tool-exposure-emergent).
 *
 * The tool surface is gated by per-verb exposure + auth class:
 * - `cli-only` verbs are never tools.
 * - `local-only` verbs are tools on the local stdio host but withheld from
 *   a remote/HTTP transport.
 * - operator-class verbs require `allowOperator` (true for local-user-trust
 *   stdio; a query-scoped HTTP client gets only read-class tools).
 * - write-class verbs require their `scope` in `allowScopes` (default empty,
 *   on every transport): the server passes the principal's scopes, and the
 *   local host passes none.
 *
 * @param {{
 *   verbs: VerbRegistry,
 *   query: QueryRegistry,
 *   runTool: (verb: VerbRegistration, params: Record<string, unknown>, owner: PluginName | undefined) => Promise<unknown>,
 *   transport?: 'stdio' | 'http',
 *   allowOperator?: boolean,
 *   allowScopes?: readonly string[],
 *   serverVersion?: string,
 * }} opts
 * @ref LLP 0034#tool-auth-class [implements]: read/operator boundary lives on the tool; the credential scope gates it
 */
export function createMcpServer(opts) {
  const { verbs, query, runTool } = opts
  const transport = opts.transport ?? 'stdio'
  const allowOperator = opts.allowOperator ?? (transport === 'stdio')
  // Copied once, so a caller that later edits its array cannot widen what this
  // assembly already listed.
  const allowScopes = new Set(opts.allowScopes ?? [])
  const serverVersion = opts.serverVersion ?? '0.0.0'

  const log = getLogger(SERVER_COMPONENT)

  /**
   * @param {VerbRegistration} verb
   * @param {VerbAuthClass} [authClass] the class already read, so a caller
   *   that also derives hints from it gates and annotates on one answer
   */
  function toolVisible(verb, authClass) {
    const exposure = verbExposure(verb)
    if (exposure === 'cli-only') return false
    if (transport !== 'stdio' && exposure === 'local-only') return false
    const cls = authClass ?? verbAuthClass(verb)
    if (!allowOperator && cls === 'operator') return false
    // @ref LLP 0494#write-class [implements]: by class and scope, never by tool name; listing and dispatch share this gate
    if (cls === 'write' && !allowScopes.has(/** @type {string} */ (verb.scope))) return false
    return true
  }

  /**
   * The `tools/list` entry for one verb, or `undefined` when the verb has
   * none that can be advertised honestly.
   *
   * `callTool` dispatches on the registry's key (`verbs.getByTool`), and a
   * registration is held by reference, so `verb.tool` is plugin code free to
   * answer a different key each time it is asked. Advertising one read of it
   * put another plugin's registered name on this verb's `description` and
   * `inputSchema`, so the text a model reads to decide how to call a tool came
   * from one plugin while the code that ran came from another. Resolving the
   * name back through the dispatch map is what makes the advertised entry the
   * one that would run.
   *
   * The rest of the entry is read inside the same guard, the visibility filter
   * included: it costs no extra read, and `listTools` has a call site outside
   * any handler try/catch (`src/core/commands/mcp.js`), so an accessor that
   * throws costs the whole tool surface rather than the one verb.
   *
   * The auth class is read once and used for both the visibility gate and the
   * hints, so an accessor answering `read` to one and `operator` to the other
   * cannot list a verb under hints its gate did not judge. A class outside
   * the hint table has no honest hints and is not listed.
   *
   * @param {VerbRegistration} verb
   * @returns {{ name: string, title: string, description: string, inputSchema: object, annotations: { title: string, readOnlyHint: boolean, destructiveHint?: boolean } } | undefined}
   */
  function toolEntry(verb) {
    /** @type {string | undefined} */
    let named
    try {
      const authClass = verbAuthClass(verb)
      if (!toolVisible(verb, authClass)) return undefined
      const tool = verb.tool
      if (verbs.getByTool(tool) !== verb) {
        warnNotAdvertised({
          event: 'mcp.tool_not_advertised',
          operation: LIST_TOOLS_OPERATION,
          errorKind: 'tool_name_not_registered',
          key: 'tool',
          name: typeof tool === 'string' ? tool : '',
        })
        return undefined
      }
      named = tool
      if (!Object.hasOwn(HINTS_BY_AUTH_CLASS, authClass)) {
        warnNotAdvertised({
          event: 'mcp.tool_not_advertised',
          operation: LIST_TOOLS_OPERATION,
          errorKind: 'unknown_auth_class',
          key: 'tool',
          name: tool,
        })
        return undefined
      }
      // One read: a missing (or drifted, non-string) title falls back to the
      // tool name, so every listed entry carries a non-empty one.
      const declared = verb.title
      const title = typeof declared === 'string' && declared.length > 0 ? declared : tool
      // Proved serializable here, where a throw costs this verb its listing
      // and nothing else. `serveStdio` writes the whole response with one
      // `JSON.stringify`, and both remaining fields are second reads of
      // plugin properties the registry type-checked once: `verb.summary`, and
      // the property objects `toJsonSchema` spreads wholesale. A value JSON
      // cannot take (a BigInt, a cycle, a throwing `toJSON`) made that write
      // raise, and `serveStdio` answered with no line at all - the same
      // forever-wait `handleMessage`'s catch ends one layer out, on the one
      // method every client calls first, so it hung the session, not a call.
      // The title goes in both places the MCP spec has for one, so a client
      // reading either finds it.
      return JSON.parse(JSON.stringify({
        name: tool,
        title,
        description: verb.summary,
        inputSchema: toJsonSchema(verb.inputSchema),
        annotations: { title, ...HINTS_BY_AUTH_CLASS[authClass] },
      }))
    } catch (err) {
      warnNotAdvertised({
        event: 'mcp.tool_not_advertised',
        operation: LIST_TOOLS_OPERATION,
        errorKind: 'unreadable_verb',
        key: 'tool',
        name: named ?? '',
        error: describeThrown(err),
      })
      return undefined
    }
  }

  /**
   * The `resources/list` entry for one dataset, or `undefined` when it has
   * none that can be advertised honestly.
   *
   * The same seam as {@link toolEntry}, one registry over: `readResource`
   * resolves a URI back through `query.getDataset`, so the name in the URI
   * decides which schema a read serves, while `dataset.name` is plugin code
   * free to answer differently each time it is asked. Three reads built one
   * entry, so a drifting accessor produced an entry whose URI addressed one
   * dataset, whose label named a second and whose description named a third,
   * and two entries could carry the same URI. One read, resolved back through
   * the registry, makes the advertised entry the one a read would serve.
   *
   * @param {DatasetRegistration} dataset
   * @returns {{ uri: string, name: string, description: string, mimeType: string } | undefined}
   */
  function resourceEntry(dataset) {
    /** @type {string | undefined} */
    let named
    try {
      const name = dataset.name
      if (query.getDataset(name) !== dataset) {
        warnNotAdvertised({
          event: 'mcp.dataset_not_advertised',
          operation: LIST_RESOURCES_OPERATION,
          errorKind: 'dataset_name_not_registered',
          key: 'dataset',
          name: typeof name === 'string' ? name : '',
        })
        return undefined
      }
      named = name
      // The resource body stays `{ dataset, columns }`; an empty declaration
      // is qualified here, in the slot the entry already has.
      const declared = dataset.schema.columns.length > 0
      return {
        uri: datasetSchemaUri(name),
        name: `${name} schema`,
        description: declared
          ? `Column schema for the ${name} dataset`
          : `Column schema for the ${name} dataset: ${UNDECLARED_SCHEMA_NOTE}`,
        mimeType: 'application/json',
      }
    } catch (err) {
      warnNotAdvertised({
        event: 'mcp.dataset_not_advertised',
        operation: LIST_RESOURCES_OPERATION,
        errorKind: 'unreadable_dataset',
        key: 'dataset',
        name: named ?? '',
        error: describeThrown(err),
      })
      return undefined
    }
  }

  /**
   * A verb or dataset dropped from an advertised list says so: it stays
   * registered and reachable by its key, so nothing else reports that clients
   * can no longer see it. `key` names the attribute the subject goes under
   * (`tool` or `dataset`), so one record shape serves both lists; `event`
   * stays a literal at each call site so the record names are greppable.
   *
   * @param {{ event: string, operation: string, errorKind: string, key: 'tool' | 'dataset', name: string, error?: string }} what
   */
  function warnNotAdvertised(what) {
    log.warn(what.event, {
      [Attr.COMPONENT]: SERVER_COMPONENT,
      [Attr.OPERATION]: what.operation,
      [Attr.ERROR_KIND]: what.errorKind,
      [Attr.STATUS]: 'degraded',
      [what.key]: what.name,
      error: what.error,
    })
  }

  function listTools() {
    /** @type {{ name: string, title: string, description: string, inputSchema: object, annotations: { title: string, readOnlyHint: boolean, destructiveHint?: boolean } }[]} */
    const tools = []
    for (const verb of verbs.list()) {
      const entry = toolEntry(verb)
      if (entry !== undefined) tools.push(entry)
    }
    return tools
  }

  /** @type {ReadonlySet<string> | undefined} */
  let visibleTools
  /** @type {string | undefined} */
  let instructions

  /**
   * The names of the tools this assembly lists, read once. The visible set is
   * fixed for the assembly's life (`listChanged: false`), so the instructions
   * and the prompts share this one read. Taken on the first request that
   * needs it rather than at creation: listing reads plugin-controlled verb
   * properties, and reading at creation would add a read and a skip warn to
   * every assembly, including one that never sees `initialize`.
   *
   * @ref LLP 0494#instructions: once per assembly, never per request
   */
  function assemblyVisibleTools() {
    visibleTools ??= new Set(listTools().map((tool) => tool.name))
    return visibleTools
  }

  /**
   * The `initialize` instructions, built once per assembly from the tools it
   * lists and its transport; every later `initialize` returns this one string.
   */
  function assemblyInstructions() {
    instructions ??= buildInstructions(assemblyVisibleTools(), transport)
    return instructions
  }

  function listResources() {
    /** @type {{ uri: string, name: string, description: string, mimeType: string }[]} */
    const resources = []
    for (const dataset of query.listDatasets()) {
      const entry = resourceEntry(dataset)
      if (entry !== undefined) resources.push(entry)
    }
    return resources
  }

  /**
   * Handle one parsed JSON-RPC message. Returns the response object, or
   * `null` for a notification (which gets no reply). Never throws: a
   * tool that throws becomes an `isError` tool result, and an unknown
   * method a `-32601` error response, so the stream is never corrupted.
   *
   * The `catch` in this function is what makes that true rather than an
   * aspiration. Every arm below reads plugin-controlled properties outside the
   * `runTool` guard - `verb.exposure` and `verb.authClass` for the call
   * gate, `verb.inputSchema` for argument validation, `dataset.schema` for
   * a resource read - and an accessor that threw from any of them left
   * `serveStdio` with a rejected promise, which it logged off-channel and
   * answered with nothing at all: the client waited forever on an id that
   * never got a reply. A `-32603` is a reply.
   *
   * @param {any} message
   * @returns {Promise<object | null>}
   */
  async function handleMessage(message) {
    if (isNotification(message)) return null
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      return jsonRpcError(message?.id ?? null, INVALID_REQUEST, 'invalid JSON-RPC request')
    }
    const { id, method, params } = message
    try {
      return await dispatch(id, method, params)
    } catch (err) {
      log.warn('mcp.request_failed', {
        [Attr.COMPONENT]: SERVER_COMPONENT,
        [Attr.OPERATION]: HANDLE_OPERATION,
        [Attr.ERROR_KIND]: 'unreadable_registration',
        [Attr.STATUS]: 'degraded',
        method,
        error: describeThrown(err),
      })
      return jsonRpcError(id, INTERNAL_ERROR, `internal error handling '${method}'`)
    }
  }

  /**
   * @param {string | number | null} id
   * @param {string} method
   * @param {any} params
   * @returns {Promise<object | null>}
   */
  async function dispatch(id, method, params) {
    switch (method) {
      case 'initialize':
        return jsonRpcResult(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' && params.protocolVersion
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: serverVersion },
          instructions: assemblyInstructions(),
        })
      case 'ping':
        return jsonRpcResult(id, {})
      case 'tools/list':
        return jsonRpcResult(id, { tools: listTools() })
      case 'resources/list':
        return jsonRpcResult(id, { resources: listResources() })
      case 'tools/call':
        // `return await`, not `return`: the caller's catch sees this rejection
        // either way, because an async function's promise adopts the one it
        // returns. The `await` is kept so it still would if a `try` were ever
        // added inside this function, where the difference is real.
        return await callTool(id, params)
      case 'resources/read':
        return readResource(id, params)
      case 'prompts/list':
        return jsonRpcResult(id, { prompts: listPrompts(assemblyVisibleTools(), transport) })
      case 'prompts/get': {
        const rendered = renderPrompt(params?.name, params?.arguments, assemblyVisibleTools(), transport)
        return rendered.ok ? jsonRpcResult(id, rendered.result) : jsonRpcError(id, INVALID_PARAMS, rendered.error)
      }
      default:
        return jsonRpcError(id, METHOD_NOT_FOUND, `unknown method '${method}'`)
    }
  }

  /**
   * @param {string | number | null} id
   * @param {any} params
   */
  async function callTool(id, params) {
    const name = params?.name
    const verb = typeof name === 'string' ? verbs.getByTool(name) : undefined
    if (!verb) {
      return jsonRpcError(id, METHOD_NOT_FOUND, `unknown tool '${name}'`)
    }
    // Settle the owner from the same resolution that produced `verb`, before a
    // single plugin-controlled property runs: `toolVisible` reads `verb.exposure`
    // and `verb.authClass`, and `validateToolArguments` reads `verb.inputSchema`,
    // any of which can be an accessor that unregisters this verb and empties the
    // ledger for the slot the host is mid-dispatch on. Resolved by `name`, the
    // key `getByTool` matched, never `verb.tool`; carried into `runTool` so the
    // config slice is picked from the owner captured here and never from a
    // re-read of a ledger plugin code has since mutated (issue #1982). This is
    // the CLI route's order: `dispatch` settles `commandOwner` from
    // `registry.ownerOf(matched.invokedName)` before it runs any plugin code.
    // @ref LLP 0425#tool-owner [implements]: capture the owner at the resolution instant, before any plugin property runs, and carry it forward
    // `ownerOfTool` is core `createVerbRegistry`'s, not the plugin-facing
    // `VerbRegistry` contract (a host may drive its own registry without it),
    // so feature-detect it: absent means every tool keeps the whole config.
    const ownerOfTool = /** @type {VerbRegistry & { ownerOfTool?: (tool: string) => PluginName | undefined }} */ (verbs).ownerOfTool
    const owner = typeof ownerOfTool === 'function' ? ownerOfTool.call(verbs, name) : undefined
    if (!toolVisible(verb)) {
      return jsonRpcError(id, METHOD_NOT_FOUND, `unknown tool '${name}'`)
    }
    const validated = validateToolArguments(verb.inputSchema, params?.arguments ?? {})
    if (!validated.ok) {
      return jsonRpcError(id, INVALID_PARAMS, validated.error)
    }
    try {
      const structured = await runTool(verb, validated.params, owner)
      // Round-trip through the query replacer so BigInt/Date in rows can't
      // break the outer response serialization, and structuredContent stays
      // a plain JSON value.
      const safe = JSON.parse(JSON.stringify(structured ?? null, jsonReplacer))
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
        structuredContent: safe,
        isError: false,
      })
    } catch (err) {
      // A tool execution failure is a tool *result* (isError), not a
      // protocol error: the client sees it as a failed call, not a dead
      // connection.
      // Coerced, not passed through: `err.message` is whatever the plugin's
      // throw carried, and a non-string one broke the transport's own
      // `JSON.stringify` the same way, for no reply at all.
      const text = describeThrown(err)
      return jsonRpcResult(id, { content: [{ type: 'text', text }], isError: true })
    }
  }

  /**
   * @param {string | number | null} id
   * @param {any} params
   */
  function readResource(id, params) {
    const uri = params?.uri
    const name = typeof uri === 'string' ? parseDatasetSchemaUri(uri) : undefined
    const dataset = name ? query.getDataset(name) : undefined
    if (!dataset) {
      return jsonRpcError(id, INVALID_PARAMS, `unknown resource '${uri}'`)
    }
    const text = JSON.stringify({ dataset: name, columns: dataset.schema.columns }, null, 2)
    return jsonRpcResult(id, { contents: [{ uri, mimeType: 'application/json', text }] })
  }

  return { handleMessage, listTools, listResources }
}

/**
 * Describe a thrown value for a log field, including one that throws on the
 * way out: the throw being reported here came from plugin code.
 *
 * @param {unknown} err
 */
function describeThrown(err) {
  try {
    return String(err instanceof Error ? err.message : err)
  } catch {
    return 'unreadable error'
  }
}

/** @param {string} name */
function datasetSchemaUri(name) {
  return `hypaware://dataset/${name}/schema`
}

/**
 * @param {string} uri
 * @returns {string | undefined}
 */
function parseDatasetSchemaUri(uri) {
  const match = /^hypaware:\/\/dataset\/(.+)\/schema$/.exec(uri)
  return match ? match[1] : undefined
}
