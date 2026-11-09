import type { AiGatewayProjectedExchange, AiGatewayProjectedMessage } from '../../../../hypaware-plugin-kernel-types.js'

export interface CursorSession {
  id: string
  cwd: string
  dbPath: string
  frontend: 'editor' | 'cli'
  updatedAt: number
}

export interface CursorSnapshot {
  unchanged?: boolean
  root: string
  exchanges: AiGatewayProjectedExchange[]
}

export interface CursorMessage extends AiGatewayProjectedMessage {
  attributes?: { cursor: { generation_id: string, identity_source: string } }
}

export interface CursorReadOptions {
  onError?: (error: Error) => void
  env?: NodeJS.ProcessEnv
  homeDir?: string
  platform?: NodeJS.Platform
  editorDb?: string
  cliRoot?: string
}

export interface CursorCloudConnection {
  version: 1
  agentId: string
  repository: string
  cwd: string
}

export interface CursorCloudConversation {
  id: string
  messages: { id: string, type: string, text: string }[]
}

export interface CursorCloudSource {
  connection: CursorCloudConnection
  stateDir: string
  fetcher?: typeof fetch
  intervalMs?: number
  readMetadata?: (env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<{ agentId: string, repository: string }>
}
