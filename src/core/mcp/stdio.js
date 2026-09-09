// @ts-check

import readline from 'node:readline'

import { INTERNAL_ERROR, PARSE_ERROR, jsonRpcError, parseMessage } from './jsonrpc.js'

/**
 * Serve an MCP server over a newline-delimited JSON-RPC stdio stream: the
 * default, near-free transport (LLP 0034 §pluggable-transport). Reads one
 * JSON message per line from `stdin`, dispatches it to `server`, and writes
 * each response as a single line to `stdout`.
 *
 * **stdout is the protocol channel.** Nothing but JSON-RPC is ever written
 * here; all human text and logs must go to stderr/file, or a stray write
 * corrupts the stream (LLP 0034 §stdio-stdout-discipline). Messages are
 * processed in arrival order via a promise chain, so an async `tools/call`
 * never lets a later response overtake an earlier one.
 *
 * Resolves when `stdin` reaches EOF (the client disconnected).
 *
 * @param {{
 *   server: { handleMessage: (message: any) => Promise<object | null> },
 *   stdin: NodeJS.ReadableStream,
 *   stdout: { write: (chunk: string) => unknown },
 *   onError?: (err: unknown) => void,
 * }} args
 * @returns {Promise<void>}
 * @ref LLP 0034#stdio-stdout-discipline [implements]: stdout carries only JSON-RPC; one line per message
 */
export function serveStdio({ server, stdin, stdout, onError }) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity })
    /** @type {Promise<void>} */
    let chain = Promise.resolve()

    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      chain = chain.then(async () => {
        const parsed = parseMessage(trimmed)
        const response = parsed.ok
          ? await server.handleMessage(parsed.message)
          : jsonRpcError(null, PARSE_ERROR, 'parse error')
        if (response !== null && response !== undefined) {
          writeResponse(stdout, response, parsed.ok ? parsed.message?.id : null)
        }
      }).catch((err) => {
        // A handler must never throw (it maps tool failures to isError
        // results), but guard the loop so one bad line can't kill the
        // session. Surface it off the protocol channel.
        if (onError) onError(err)
      })
    })

    rl.on('close', () => {
      // Drain any in-flight handler before resolving so its response lands.
      chain.then(() => resolve(), () => resolve())
    })
  })
}

/**
 * Write one response as a single line, or, when it cannot be serialized, a
 * `-32603` carrying the same id.
 *
 * The response object is not the reply; the line is. `handleMessage` turns any
 * throw into a well-formed `-32603` object so the client always gets a reply,
 * but the object only becomes one at the `JSON.stringify` here, and a response
 * holding a value JSON cannot take (a BigInt, a cycle, a throwing `toJSON`)
 * makes that call raise. Without this, the failure went to `onError` off the
 * protocol channel and no line was written at all: the same forever-wait
 * `handleMessage`'s catch exists to end, one layer out and invisible to a
 * server that has already returned a well-formed object.
 *
 * The fallback is serializable by construction: its only outside value is the
 * id, which came through `parseMessage`'s `JSON.parse` and so can be no BigInt,
 * cycle, `toJSON` or `undefined`, and its reason is coerced by
 * {@link describeThrown}, which cannot raise. A message with no id is a
 * notification, owed no reply, so it gets no invented one.
 *
 * The fallback write can fail the way the first one did, on a closed or
 * erroring stdout. That is not answerable on the protocol channel, so it is
 * swallowed and the original failure rethrown: one report to `onError` either
 * way, and no retry at a stream that just refused.
 *
 * @param {{ write: (chunk: string) => unknown }} stdout
 * @param {object} response
 * @param {string | number | null | undefined} id the id off the wire, or `undefined` for a notification
 */
function writeResponse(stdout, response, id) {
  /** @type {string} */
  let line
  try {
    line = JSON.stringify(response) + '\n'
  } catch (err) {
    if (id !== undefined) {
      const reason = `response could not be serialized: ${describeThrown(err)}`
      try {
        stdout.write(JSON.stringify(jsonRpcError(id, INTERNAL_ERROR, reason)) + '\n')
      } catch {
        // stdout is gone; the rethrow below still reports the original failure.
      }
    }
    throw err
  }
  stdout.write(line)
}

/**
 * Describe a thrown value for the reason field, including one that throws on
 * the way out: `String()` raises on anything with no primitive conversion, and
 * the value described here can come from a `toJSON` a plugin wrote. The bare
 * idiom is repo-wide; it stays file-local, like its twins in
 * `src/core/mcp/server.js` and `src/core/sinks/driver.js`, because it is
 * load-bearing only where a raise would defeat the guard it reports from.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeThrown(err) {
  try {
    return String(err instanceof Error ? err.message : err)
  } catch {
    return 'unreadable error'
  }
}
