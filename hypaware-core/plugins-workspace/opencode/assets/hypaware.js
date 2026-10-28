// HYPWARE_OPENCODE_PLUGIN v1

const HYPWARE_ENDPOINT = '__HYPWARE_OPENCODE_ENDPOINT__'
const SNAPSHOT_INTERVAL_MS = 1000
const SNAPSHOT_TIMEOUT_MS = 5000
const MAX_PENDING_SESSIONS = 128

// The generated SDK client answers `{ data, request, response }` on success and
// `{ error, request, response }` on failure. Returning the failure envelope
// would ship a snapshot whose `session` is an error object, which the HypAware
// listener can only report as a missing cwd.
function value(result) {
  if (!result || typeof result !== 'object') return result
  if ('error' in result && result.error !== undefined) return undefined
  return 'data' in result ? result.data : result
}

function sessionID(event) {
  const props = event && typeof event === 'object' ? event.properties : undefined
  if (!props || typeof props !== 'object') return undefined
  for (const candidate of [
    props.sessionID,
    props.session_id,
    props.sessionId,
    props.info && props.info.sessionID,
    props.info && props.info.id,
    // `message.part.updated` carries the part alone, with no `info` and no
    // top-level session id. Without this the highest-frequency wake-up in the
    // stream resolves to nothing and is dropped.
    props.part && props.part.sessionID,
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

export const HypAware = async ({ client, directory, worktree, project }) => {
  // OpenCode itself defaults this flag to `cli`; Desktop sets `desktop`
  // before launching its shared sidecar.
  const entrypoint = process.env.OPENCODE_CLIENT || 'cli'
  const pending = new Map()
  let timer
  let running = false
  let lastStarted = -Infinity
  let disposed = false
  const lifetime = new AbortController()

  async function reconcile(id, eventType) {
    const request = new AbortController()
    try {
      const signal = AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)])
      // The generated SDK client takes route parameters under `path`. A bare
      // `sessionID` leaves `/session/{id}` unsubstituted, so both reads fail
      // against the OpenCode server and every snapshot is an error envelope.
      const [sessionResult, messagesResult] = await Promise.all([
        client.session.get({ path: { id }, signal }),
        client.session.messages({ path: { id }, signal }),
      ])
      const session = value(sessionResult)
      const messages = value(messagesResult)
      // A failed SDK read is not a snapshot. Drop it here so the listener's
      // missing-cwd counter keeps meaning "OpenCode reported no directory".
      if (!session || !messages) return
      await fetch(`${HYPWARE_ENDPOINT}/snapshot`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session,
          messages,
          entrypoint,
          entrypoint_source: 'plugin-process',
          directory,
          worktree,
          project_id: project && project.id,
          trigger: eventType,
        }),
      }).then(response => response.body?.cancel())
    } catch {
      // Capture must never fail or delay OpenCode's model call. A later event
      // or bounded export reconciles the session.
    } finally {
      // If one parallel SDK read fails, cancel its sibling before the queue
      // starts another snapshot.
      request.abort()
    }
  }

  // @ref LLP 0502#scheduling [implements]: one bounded queue, one in-flight snapshot, and a trailing refresh for events received during I/O
  function wake() {
    if (disposed || running || timer || pending.size === 0) return
    timer = setTimeout(async () => {
      timer = undefined
      const [id, eventType] = pending.entries().next().value
      pending.delete(id)
      running = true
      lastStarted = Date.now()
      try {
        await reconcile(id, eventType)
      } finally {
        running = false
        wake()
      }
    }, Math.max(25, SNAPSHOT_INTERVAL_MS - (Date.now() - lastStarted)))
    timer.unref?.()
  }

  function schedule(event) {
    if (disposed) return
    const id = sessionID(event)
    if (!id) return
    // Retain only the latest wake-up per session. At capacity prefer recent
    // activity; evicted sessions remain available through native export.
    if (!pending.has(id) && pending.size >= MAX_PENDING_SESSIONS) {
      pending.delete(pending.keys().next().value)
    }
    pending.set(id, event.type)
    // Preserve the existing debounce for an isolated burst. Cooldown timers
    // and a queue of different sessions must not be postponed by new events.
    if (timer && pending.size === 1 && Date.now() - lastStarted >= SNAPSHOT_INTERVAL_MS) {
      clearTimeout(timer)
      timer = undefined
    }
    wake()
  }

  return {
    event({ event }) {
      schedule(event)
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      pending.clear()
      lifetime.abort()
    },
  }
}
