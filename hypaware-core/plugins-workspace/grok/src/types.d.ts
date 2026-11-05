export interface GrokCursor {
  offset: number
  line: number
  model?: string
  /** The last message built before this offset, so a resumed read keeps the chain. */
  previous?: string
  boundary: string
  fingerprint: string
  inode: string
}

export interface GrokForkSource {
  id: string
  /** When the copy was taken. Messages at or after it are not the ancestor's. */
  before_ms?: number
}

export interface GrokFloor {
  offset: number
  before_ms?: number
}

export interface GrokSession {
  id: string
  cwd: string
  model?: string
  started_at?: string
  parent_thread_id?: string
  /** A subagent whose parent link is not on disk yet. */
  parent_pending?: boolean
  /** This session, then its forks' parents and subagents' parents, nearest first. */
  lineage: string[]
  /** Ancestors whose update log this session copied, so their withheld bytes apply to the copy. */
  fork_sources: GrokForkSource[]
  git?: { git_branch?: string, git_remote?: string, repo_root?: string, head_sha?: string }
}

export interface GrokWithheldStore {
  /** Byte offsets below which this session's messages stay unrecorded. */
  floors(session: GrokSession): Promise<GrokFloor[]>
  mark(sessionId: string, offset: number): Promise<void>
}

export interface GrokPolicy {
  allowed(session: GrokSession): boolean
  sessionIgnored(session: GrokSession): boolean
}
