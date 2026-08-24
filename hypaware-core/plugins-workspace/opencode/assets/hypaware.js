// HYPWARE_OPENCODE_PLUGIN v1

const HYPWARE_ENDPOINT = '__HYPWARE_OPENCODE_ENDPOINT__'
const pending = new Map()

function value(result) {
  return result && typeof result === 'object' && 'data' in result ? result.data : result
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
      const [sessionResult, messagesResult] = await Promise.all([
        client.session.get({ sessionID: id }),
        client.session.messages({ sessionID: id }),
      ])
      const session = value(sessionResult)
      const messages = value(messagesResult)
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
