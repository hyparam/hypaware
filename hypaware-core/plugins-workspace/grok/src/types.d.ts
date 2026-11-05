export interface GrokCursor {
  offset: number
  line: number
  boundary: string
  fingerprint: string
  inode: string
}

export interface GrokSession {
  id: string
  cwd: string
  model?: string
  parent_thread_id?: string
}
