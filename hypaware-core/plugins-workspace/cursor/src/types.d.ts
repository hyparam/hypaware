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
