// HYPWARE_PI_EXTENSION v1
// @ts-check

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4322'
const LEASE = Symbol.for('hypaware.pi-extension.v1')
const MAX_BYTES = 512 * 1024
const QUEUE_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 4096

/** Pi supplies the API at runtime; no Pi runtime dependency is installed. @param {any} pi */
export default function hypawarePi(pi) {
  const owner = {}
  const shared = /** @type {any} */ (globalThis)
  let leaf = null
  let enabled = false
  let stopping = false
  let endpoint = DEFAULT_ENDPOINT
  let queuedBytes = 0
  let dropped = 0
  let lastStatus = 'waiting for a persisted session'
  /** @type {{ body: string, bytes: number }[]} */
  const queue = []
  /** @type {Promise<void> | undefined} */
  let sending

  async function drain() {
    while (queue.length && !stopping) {
      const pending = queue.shift()
      if (!pending) continue
      const { body, bytes } = pending
      queuedBytes -= bytes
      try {
        const response = await fetch(`${endpoint}/entries`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
          signal: AbortSignal.timeout(1500),
        })
        await response.body?.cancel()
        lastStatus = response.ok ? 'connected' : `daemon returned ${response.status}; session recovery will retry`
        if (!response.ok) dropped++
      } catch {
        dropped++
        lastStatus = 'daemon unavailable; session recovery will retry'
      }
    }
  }

  /** @param {any} session @param {any[]} entries @param {string} mode */
  function enqueue(session, entries, mode) {
    if (!entries.length) return
    // Stop before walking payloads when the daemon cannot keep up. Encoding
    // also has a per-hook work budget, including entries too large to send.
    if (queuedBytes > QUEUE_BYTES - MAX_BYTES) { drop(); return }
    const budget = { remaining: QUEUE_BYTES - queuedBytes }
    const header = encodeJson(session, budget)
    if (!header) { drop(); return }
    const entrypoint = ['tui', 'print', 'json', 'rpc'].includes(mode) ? mode : 'unknown'
    const prefix = `{"version":1,"session":${header},"entrypoint":"${entrypoint}","entries":[`
    const overhead = Buffer.byteLength(prefix) + 2
    let bytes = overhead
    /** @type {string[]} */
    let batch = []
    function flush() {
      if (!batch.length) return true
      if (queuedBytes + bytes > QUEUE_BYTES) { drop(); return false }
      queue.push({ body: prefix + batch.join(',') + ']}', bytes })
      queuedBytes += bytes
      batch = []
      bytes = overhead
      if (!sending) sending = drain().finally(() => { sending = undefined })
      return true
    }
    for (const entry of entries) {
      if (budget.remaining <= 0 || queuedBytes > QUEUE_BYTES - MAX_BYTES) { drop(); break }
      const encoded = encodeJson(entry, budget)
      if (!encoded) { drop(); continue }
      const size = Buffer.byteLength(encoded)
      if (overhead + size > MAX_BYTES) { drop(); continue }
      if (batch.length && (batch.length >= 64 || bytes + size + 1 > MAX_BYTES)) {
        if (!flush()) return
      }
      bytes += size + (batch.length ? 1 : 0)
      batch.push(encoded)
    }
    flush()
  }

  function drop() {
    dropped++
    lastStatus = 'capture encoding or queue limit; session recovery will retry'
  }

  // @ref LLP 0416#capture: only read IDs after Pi appended completed entries
  /** @param {any} _event @param {any} ctx */
  function capture(_event, ctx) {
    if (!enabled || stopping || shared[LEASE] !== owner) return
    const sm = ctx.sessionManager
    const head = sm.getLeafId()
    if (head === leaf) return
    const entries = []
    let id = head
    while (id && id !== leaf && entries.length < MAX_ENTRIES) {
      const entry = sm.getEntry(id)
      if (!entry) break
      entries.push(entry)
      id = entry.parentId
    }
    leaf = head
    if (id && entries.length === MAX_ENTRIES) {
      dropped++
      lastStatus = 'entry traversal limit; session recovery will retry'
      return
    }
    // Moving to an earlier branch is not new work. Entries still dedupe in
    // the daemon if a later traversal crosses an already-recorded branch.
    entries.reverse()
    const session = sm.getHeader()
    if (!session || !sm.getSessionFile()) return
    enqueue(session, entries, ctx.mode ?? 'unknown')
  }

  pi.on('session_start', (_event, ctx) => {
    if (shared[LEASE] && shared[LEASE] !== owner) return
    shared[LEASE] = owner
    stopping = false
    try {
      const url = new URL(process.env.HYP_PI_ENDPOINT ?? DEFAULT_ENDPOINT)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('not loopback')
      endpoint = url.origin
      enabled = Boolean(ctx.sessionManager.getSessionFile())
      lastStatus = enabled ? 'ready; waiting for completed entries' : 'ephemeral session; capture disabled'
    } catch {
      enabled = false
      lastStatus = 'invalid HYP_PI_ENDPOINT; expected http://127.0.0.1:port'
    }
    leaf = ctx.sessionManager.getLeafId()
  })
  for (const event of ['turn_end', 'agent_end', 'agent_settled', 'session_compact']) pi.on(event, capture)
  pi.on('session_before_tree', capture)
  pi.on('session_tree', (event, ctx) => {
    if (!enabled || stopping || shared[LEASE] !== owner) return
    if (event.summaryEntry) enqueue(ctx.sessionManager.getHeader(), [event.summaryEntry], ctx.mode ?? 'unknown')
    leaf = ctx.sessionManager.getLeafId()
  })
  pi.on('session_shutdown', async (event, ctx) => {
    if (shared[LEASE] !== owner) return
    capture(event, ctx)
    if (sending) {
      let timer
      try { await Promise.race([sending, new Promise(resolve => { timer = setTimeout(resolve, 1800) })]) }
      finally { clearTimeout(timer) }
    }
    stopping = true
    enabled = false
    queue.length = 0
    queuedBytes = 0
    delete shared[LEASE]
  })
  pi.registerCommand('hypaware', {
    description: 'Show local HypAware capture status',
    handler: async (_args, ctx) => {
      ctx.ui.notify(`HypAware: ${lastStatus}. Capture drops: ${dropped}.`, 'info')
    },
  })
}

/**
 * Bound traversal before stringify can allocate an arbitrarily large result.
 * Raw UTF-16 units bound visits and strings; JSON escaping can expand them by
 * at most six, then the exact UTF-8 check enforces the transport limit.
 * @param {any} value @param {{ remaining: number }} budget
 */
function encodeJson(value, budget) {
  let remaining = MAX_BYTES
  try {
    const encoded = JSON.stringify(value, (key, item) => {
      const cost = key.length + (typeof item === 'string' ? item.length : 1) + 4
      remaining -= cost
      budget.remaining -= cost
      if (remaining < 0 || budget.remaining < 0) throw new Error('encoding_budget')
      return item
    })
    return encoded && Buffer.byteLength(encoded) <= MAX_BYTES ? encoded : undefined
  } catch { return undefined }
}
