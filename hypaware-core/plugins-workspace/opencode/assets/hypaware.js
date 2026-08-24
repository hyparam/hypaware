// HYPWARE_OPENCODE_PLUGIN v1

const HYPWARE_ENDPOINT = '__HYPWARE_OPENCODE_ENDPOINT__'
const pending = new Map()

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

  async function reconcile(id, eventType) {
    try {
      // The generated SDK client takes route parameters under `path`. A bare
      // `sessionID` leaves `/session/{id}` unsubstituted, so both reads fail
      // against the OpenCode server and every snapshot is an error envelope.
      const [sessionResult, messagesResult] = await Promise.all([
        client.session.get({ path: { id } }),
        client.session.messages({ path: { id } }),
      ])
      const session = value(sessionResult)
      const messages = value(messagesResult)
      // A failed SDK read is not a snapshot. Drop it here so the listener's
      // missing-cwd counter keeps meaning "OpenCode reported no directory".
      if (!session || !messages) return
      await fetch(`${HYPWARE_ENDPOINT}/snapshot`, {
        method: 'POST',
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
      })
    } catch {
      // Capture must never fail or delay OpenCode's model call. A later event
      // or bounded export reconciles the session.
    }
  }

  function schedule(event) {
    const id = sessionID(event)
    if (!id) return
    const prior = pending.get(id)
    if (prior) clearTimeout(prior)
    const timer = setTimeout(() => {
      pending.delete(id)
      void reconcile(id, event.type)
    }, 25)
    pending.set(id, timer)
  }

  return {
    event({ event }) {
      schedule(event)
    },
  }
}
