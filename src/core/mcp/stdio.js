// @ts-check

import readline from 'node:readline'

import { PARSE_ERROR, jsonRpcError, parseMessage } from './jsonrpc.js'

/**
 * Serve an MCP server over a newline-delimited JSON-RPC stdio stream — the
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
 * @ref LLP 0034#stdio-stdout-discipline [implements] — stdout carries only JSON-RPC; one line per message
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
          stdout.write(JSON.stringify(response) + '\n')
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
