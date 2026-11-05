export interface GrokCursor {
  offset: number
  line: number
  model?: string
  boundary: string
  fingerprint: string
  inode: string
}

export interface GrokSession {
  id: string
  cwd: string
  model?: string
  parent_thread_id?: string
  /** A subagent whose parent link is not on disk yet. */
  parent_pending?: boolean
  /** This session, then its forks' parents and subagents' parents, nearest first. */
  lineage: string[]
  /** Ancestors whose update log this session copied, so their withheld bytes apply. */
  fork_sources: string[]
  git?: { git_branch?: string, git_remote?: string, repo_root?: string, head_sha?: string }
}

export interface GrokWithheldStore {
  /** The byte offset below which this session's messages stay unrecorded. */
  floor(session: GrokSession): Promise<number>
  mark(sessionId: string, offset: number): Promise<void>
}

export interface GrokPolicy {
  allowed(session: GrokSession): boolean
  sessionIgnored(session: GrokSession): boolean
}
