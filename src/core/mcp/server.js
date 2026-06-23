// @ts-check

import { jsonReplacer } from '../query/format.js'
import { toJsonSchema, validateToolArguments } from '../cli/verb_codec.js'
import { verbAuthClass, verbExposure } from '../registry/verbs.js'
import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  isNotification,
  jsonRpcError,
  jsonRpcResult,
} from './jsonrpc.js'

/**
 * @import { QueryRegistry, VerbRegistration, VerbRegistry } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/** Protocol version advertised when the client sends none. */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const SERVER_NAME = 'hypaware'

/**
 * Build the **one server assembly** (verbs → MCP tools, datasets → MCP
 * resources) the kernel exposes. The transport (stdio here; HTTP later) is
 * a thin adapter over this object — the tool list is emergent from the
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
 * @ref LLP 0034#tool-auth-class [implements] — read/operator boundary lives on the tool; the credential scope gates it
 */
export function createMcpServer(opts) {
  const { verbs, query, runTool } = opts
  const transport = opts.transport ?? 'stdio'
  const allowOperator = opts.allowOperator ?? (transport === 'stdio')
  const serverVersion = opts.serverVersion ?? '0.0.0'

  /** @param {VerbRegistration} verb */
  function toolVisible(verb) {
    const exposure = verbExposure(verb)
    if (exposure === 'cli-only') return false
    if (transport !== 'stdio' && exposure === 'local-only') return false
    if (!allowOperator && verbAuthClass(verb) === 'operator') return false
    return true
  }

  function listTools() {
    return verbs.list().filter(toolVisible).map((verb) => ({
      name: verb.tool,
      description: verb.summary,
      inputSchema: toJsonSchema(verb.inputSchema),
    }))
  }

  function listResources() {
    return query.listDatasets().map((d) => ({
      uri: datasetSchemaUri(d.name),
      name: `${d.name} schema`,
      description: `Column schema for the ${d.name} dataset`,
      mimeType: 'application/json',
    }))
  }

  /**
   * Handle one parsed JSON-RPC message. Returns the response object, or
   * `null` for a notification (which gets no reply). Never throws — a
   * tool that throws becomes an `isError` tool result, and an unknown
   * method a `-32601` error response, so the stream is never corrupted.
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
        return callTool(id, params)
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
      // protocol error — the client sees it as a failed call, not a dead
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
