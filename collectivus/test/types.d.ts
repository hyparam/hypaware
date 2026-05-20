import type { Server, IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'node:http'
import type { LaunchctlResult, SystemctlResult } from '../src/daemon/types.d.ts'

// ---------- recorder.test.js ----------

export interface CollectingSink {
  /** Rows written so far. Typed loose so tests don't need casts. */
  rows: any[]
  writeRow(obj: unknown): Promise<void>
  close(): Promise<void>
}

// ---------- proxy.test.js / recorder.test.js mock upstream ----------

export interface CapturedRequest {
  method: string | undefined
  url: string | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

export type MockUpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void

export interface MockUpstream {
  server: Server
  baseUrl: string
  port: number
  requests: CapturedRequest[]
  setHandler(handler: MockUpstreamHandler): void
}

export interface FetchTextResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

// ---------- cli/install.test.js ----------

export interface InstallCall {
  binPath: string
  configPath: string
  label: string
  logDir: string
  plistDir?: string
}

export interface AttachCall {
  port: number
  version: string
  settingsPath: string
  binPath?: string
}

export interface InstallMocks {
  installCalls: InstallCall[]
  attachCalls: AttachCall[]
  installLaunchAgent(opts: any): Promise<void>
  attach(opts: any): Promise<{ changed: true, prevValue?: string }>
  loadConfig(p: string): any
}

// ---------- cli/uninstall.test.js ----------

export interface UninstallCall {
  label: string
  plistDir?: string
}

export interface DetachCall {
  settingsPath?: string
  configPath?: string
}

export interface UninstallMocks {
  uninstallCalls: UninstallCall[]
  detachCalls: DetachCall[]
  codexDetachCalls: DetachCall[]
  uninstallLaunchAgent(opts: any): Promise<void>
  detach(opts: any): Promise<{ changed: boolean, removed?: string, warning?: string }>
  detachCodex(opts: any): Promise<{ changed: boolean, removed?: string, restoredValue?: string, warning?: string }>
  isAttached(opts: any): Promise<boolean>
  isCodexAttached(opts: any): Promise<boolean>
}

// ---------- daemon/macos.test.js ----------

export interface MacosFakeCall {
  op: 'load' | 'unload' | 'list'
  arg: string
}

export interface MacosFakeLaunchctl {
  calls: MacosFakeCall[]
  load(p: string): Promise<LaunchctlResult>
  unload(p: string): Promise<LaunchctlResult>
  list(l: string): Promise<LaunchctlResult>
}

export interface MacosFakeResponses {
  load?: LaunchctlResult
  unload?: LaunchctlResult
  list?: LaunchctlResult | ((label: string, callIndex: number) => LaunchctlResult)
}

// ---------- daemon/linux.test.js ----------

export interface LinuxFakeCall {
  op: 'daemonReload' | 'enable' | 'disable' | 'restart' | 'stop' | 'show'
  arg?: string
}

export interface LinuxFakeSystemctl {
  calls: LinuxFakeCall[]
  daemonReload(): Promise<SystemctlResult>
  enable(unit: string): Promise<SystemctlResult>
  disable(unit: string): Promise<SystemctlResult>
  restart(unit: string): Promise<SystemctlResult>
  stop(unit: string): Promise<SystemctlResult>
  show(unit: string): Promise<SystemctlResult>
}

export interface LinuxFakeResponses {
  daemonReload?: SystemctlResult
  enable?: SystemctlResult
  disable?: SystemctlResult
  restart?: SystemctlResult
  stop?: SystemctlResult
  show?: SystemctlResult | ((unit: string, callIndex: number) => SystemctlResult)
}
