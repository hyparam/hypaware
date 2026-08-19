// @ts-check

/**
 * @import { ClaudeTelemetryEvent, ClaudeTelemetrySessionVerdict, SessionContextRecord } from '../types.js'
 * @import { UsagePolicyResolver } from '../../../../../src/core/usage-policy/types.js'
 */

/**
 * The verdict for a session whose cwd is not known: the SessionStart hook's
 * record has not landed (or never will, for a session started without hooks).
 *
 * It is its own class, distinct from `full`, because "we could not ask the
 * question" is not "the answer was yes". A session in this state is not
 * recorded: a `.hypignore` under its cwd would have suppressed it, and writing
 * first and resolving after is the fail-open window LLP 0085 exists to patch,
 * which this path is not allowed to reopen.
 *
 * @ref LLP 0257#ingest [implements]: S10 - a session with no hook record is
 *   undetermined, not clean
 */
export const POLICY_UNDETERMINED = 'undetermined'

/**
 * Resolve one session's usage class from the cwd its SessionStart hook
 * recorded.
 *
 * The resolver is the shared one every other capture seam uses, so a
 * `.hypignore` dotfile and the machine-local list (LLP 0103) are both in
 * scope and the more restrictive of the two wins - the listener does not get
 * its own opinion about what `ignore` means.
 *
 * @ref LLP 0254#policy-inline [implements]: `.hypignore` and the machine-local
 *   list are evaluated at ingest, from the cwd the retained hook recorded
 * @param {{ record: SessionContextRecord | undefined, resolver: UsagePolicyResolver }} args
 * @returns {ClaudeTelemetrySessionVerdict}
 */
export function resolveSessionUsagePolicy({ record, resolver }) {
  const cwd = record?.cwd
  if (!cwd) return { class: POLICY_UNDETERMINED }
  const policy = resolver.resolve(cwd)
  /** @type {ClaudeTelemetrySessionVerdict} */
  const verdict = { class: policy.class, cwd, governedBy: policy.governedBy, declared: policy.declared }
  if (policy.warn) verdict.warn = policy.warn
  return verdict
}

/**
 * Split one batch of events three ways by the usage policy of the session
 * each names: recorded, dropped (`ignore`), and withheld (undetermined).
 *
 * `local-only` is kept, exactly as the proxy projector keeps it: that class is
 * enforced at the export and query seams (LLP 0070), not by refusing to record.
 * Both of those seams key on the row's own `cwd`, so keeping the event here
 * only holds up because the behavioral row is stamped with the cwd this
 * verdict was resolved from (LLP 0266); before it was, `local-only` had
 * nothing downstream to enforce it and the rows forwarded (issue #878).
 *
 * An event that names NO session is kept, for the same reason the per-session
 * opt-out keeps it: a folder policy is resolved through a session's cwd, and
 * an event with no session has no cwd to resolve. Nothing conversational can
 * ride out that way - the message projection skips events with no `session.id`
 * outright, and the behavioral dataset does not store content events at all -
 * so what is kept is a content-free counter, not somebody's prompt.
 *
 * @ref LLP 0254#policy-inline [implements]: the split happens before any row is
 *   written, so a row that must not exist is never written
 * @param {ClaudeTelemetryEvent[]} events
 * @param {{ verdictFor: (sessionId: string) => ClaudeTelemetrySessionVerdict }} opts
 * @returns {{
 *   kept: ClaudeTelemetryEvent[],
 *   droppedBySession: Map<string, { events: ClaudeTelemetryEvent[], verdict: ClaudeTelemetrySessionVerdict }>,
 *   withheldBySession: Map<string, { events: ClaudeTelemetryEvent[], verdict: ClaudeTelemetrySessionVerdict }>,
 * }}
 */
export function partitionByUsagePolicy(events, { verdictFor }) {
  /** @type {ClaudeTelemetryEvent[]} */
  const kept = []
  /** @type {Map<string, { events: ClaudeTelemetryEvent[], verdict: ClaudeTelemetrySessionVerdict }>} */
  const droppedBySession = new Map()
  /** @type {Map<string, { events: ClaudeTelemetryEvent[], verdict: ClaudeTelemetrySessionVerdict }>} */
  const withheldBySession = new Map()
  // One verdict per session per batch: the resolver caches per cwd, but the
  // record lookup is a scan of the session-context tail and a batch routinely
  // carries a dozen events for the same session.
  /** @type {Map<string, ClaudeTelemetrySessionVerdict>} */
  const verdicts = new Map()

  for (const event of events) {
    const sessionId = event.attributes['session.id']
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      kept.push(event)
      continue
    }
    let verdict = verdicts.get(sessionId)
    if (verdict === undefined) {
      verdict = verdictFor(sessionId)
      verdicts.set(sessionId, verdict)
    }
    const bucket = verdict.class === 'ignore'
      ? droppedBySession
      : verdict.class === POLICY_UNDETERMINED
        ? withheldBySession
        : undefined
    if (bucket === undefined) {
      kept.push(event)
      continue
    }
    const existing = bucket.get(sessionId)
    if (existing) existing.events.push(event)
    else bucket.set(sessionId, { events: [event], verdict })
  }

  return { kept, droppedBySession, withheldBySession }
}
