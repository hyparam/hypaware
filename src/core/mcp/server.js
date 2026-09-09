// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { jsonReplacer } from '../query/format.js'
import { toJsonSchema, validateToolArguments } from '../cli/verb_codec.js'
import { verbAuthClass, verbExposure } from '../registry/verbs.js'
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
 * @import { DatasetRegistration, QueryRegistry, VerbRegistration, VerbRegistry } from '../../../hypaware-plugin-kernel-types.js'
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
 *
 * @param {{
 *   verbs: VerbRegistry,
 *   query: QueryRegistry,
 *   runTool: (verb: VerbRegistration, params: Record<string, unknown>) => Promise<unknown>,
 *   transport?: 'stdio' | 'http',
 *   allowOperator?: boolean,
 *   serverVersion?: string,
 * }} opts
 * @ref LLP 0034#tool-auth-class [implements]: read/operator boundary lives on the tool; the credential scope gates it
 */
export function createMcpServer(opts) {
  const { verbs, query, runTool } = opts
  const transport = opts.transport ?? 'stdio'
  const allowOperator = opts.allowOperator ?? (transport === 'stdio')
  const serverVersion = opts.serverVersion ?? '0.0.0'

  const log = getLogger(SERVER_COMPONENT)

  /** @param {VerbRegistration} verb */
  function toolVisible(verb) {
    const exposure = verbExposure(verb)
    if (exposure === 'cli-only') return false
    if (transport !== 'stdio' && exposure === 'local-only') return false
    if (!allowOperator && verbAuthClass(verb) === 'operator') return false
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
   * included: it costs no extra read, and `listTools` is called outside any
   * handler try/catch (`src/core/commands/mcp.js`), so an accessor that throws
   * costs the whole tool surface rather than the one verb.
   *
   * @param {VerbRegistration} verb
   * @returns {{ name: string, description: string, inputSchema: object } | undefined}
   */
  function toolEntry(verb) {
    /** @type {string | undefined} */
    let named
    try {
      if (!toolVisible(verb)) return undefined
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
      return {
        name: tool,
        description: verb.summary,
        inputSchema: toJsonSchema(verb.inputSchema),
      }
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
      return {
        uri: datasetSchemaUri(name),
        name: `${name} schema`,
        description: `Column schema for the ${name} dataset`,
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
    /** @type {{ name: string, description: string, inputSchema: object }[]} */
    const tools = []
    for (const verb of verbs.list()) {
      const entry = toolEntry(verb)
      if (entry !== undefined) tools.push(entry)
    }
    return tools
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
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: serverVersion },
        })
      case 'ping':
        return jsonRpcResult(id, {})
      case 'tools/list':
        return jsonRpcResult(id, { tools: listTools() })
      case 'resources/list':
        return jsonRpcResult(id, { resources: listResources() })
      case 'tools/call':
        // Awaited, not returned: an unawaited promise rejects past the caller's
        // catch, which is the whole point of having it.
        return await callTool(id, params)
      case 'resources/read':
        return readResource(id, params)
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
    if (!verb || !toolVisible(verb)) {
      return jsonRpcError(id, METHOD_NOT_FOUND, `unknown tool '${name}'`)
    }
    const validated = validateToolArguments(verb.inputSchema, params?.arguments ?? {})
    if (!validated.ok) {
      return jsonRpcError(id, INVALID_PARAMS, validated.error)
    }
    try {
      const structured = await runTool(verb, validated.params)
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
      const text = err instanceof Error ? err.message : String(err)
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
