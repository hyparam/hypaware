// Private, bounded IPC for the Python callback. Uses the same recorder and policy.
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { MAX_EVENT_BYTES } from './journal.js'

const methods = new Set(['handleChainStart', 'handleChainEnd', 'handleChainError',
  'handleChatModelStart', 'handleLLMEnd', 'handleLLMError', 'handleToolStart', 'handleToolEnd', 'handleToolError'])

/** @import { LangGraphRecorder } from '../../../../hypaware-core/plugins-workspace/langgraph/src/recorder.js' */
/** @type {LangGraphRecorder | undefined} */
let capture
let bytes = Buffer.alloc(0)
async function receive(line) {
  const request = JSON.parse(line)
  if (!capture) {
    if (request.method !== 'init' || typeof request.modulePath !== 'string') throw new Error('invalid_init')
    const { createHypAwareCallback } = await import(pathToFileURL(request.modulePath).href)
    capture = createHypAwareCallback(request.options)
  } else {
    if (!methods.has(request.method) || !Array.isArray(request.args)) throw new Error('invalid_method')
    await capture[request.method](...request.args)
  }
  // The caller already owns the session ID. Keep acknowledgements scalar and
  // small even for an ID near the recorder's 4096-character limit.
  if (!process.stdout.write(JSON.stringify({ ...capture?.status(), session_id: undefined }) + '\n')) await once(process.stdout, 'drain')
}

try {
  // @ref LLP 0548#python: one acknowledged event in flight, no unbounded IPC queue
  for await (const chunk of process.stdin) {
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      if (bytes.length + end - start > MAX_EVENT_BYTES) throw new Error('event_limit')
      bytes = Buffer.concat([bytes, chunk.subarray(start, end)])
      start = end + 1
      if (newline >= 0) {
        await receive(bytes.toString('utf8'))
        bytes = Buffer.alloc(0)
      }
    }
  }
} catch {
  // Never print payloads, provider errors or credential-bearing exception text.
  process.exitCode = 1
}
