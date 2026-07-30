// Types for the shared Codex rollout `session_meta` reader.

/**
 * The three identifiers a Codex rollout's `session_meta` header carries, each
 * present only when the header itself carries it as a non-blank string, and
 * `cwd` only when that string is also an absolute path (LLP 0143 #usable-cwd:
 * a relative one has no stated base, and the policy matcher would supply the
 * daemon's process cwd as one).
 *
 * `sessionId` is `undefined` on a rollout written by a Codex old enough not to
 * emit the field. It is NEVER back-filled from `threadId`: the two coincide for
 * a root thread and differ for a subagent thread, so substituting one for the
 * other yields a confident wrong answer in a privacy control.
 */
export interface CodexRolloutSessionMeta {
  /** `payload.id`: the thread (`session.conversation_id`). */
  threadId: string | undefined
  /** `payload.session_id`: the session container the gateway drop keys on. */
  sessionId: string | undefined
  /** `payload.cwd`: the absolute directory the session was started in. */
  cwd: string | undefined
}
