export type CloudOriginator = 'codex_cloud' | 'codex_work_web' | 'codex_work_mobile'

/** Local opt-in to selected hosted chats. Contains no credentials. */
export interface CloudSelectedConnection {
  version: 1
  accountHash: string
  /** Omitted legacy grants mean codex_cloud only. */
  origins?: CloudOriginator[]
  threads: string[]
}

/** Account-wide opt-in. The optional lower bound never moves backwards. */
export interface CloudAccountConnection {
  version: 2
  scope: 'account'
  accountHash: string
  /** Omitted legacy grants mean codex_cloud only. */
  origins?: CloudOriginator[]
  since?: string
}

export type CloudConnection = CloudSelectedConnection | CloudAccountConnection

/** The bounded local-state seam the onboarding wizard uses without activation. */
export interface CloudOnboarding {
  DEFAULT_CLOUD_ORIGINS: CloudOriginator[]
  readCloudConnection(stateDir: string): Promise<CloudConnection | undefined>
  configureCloudSelection(opts: {
    stateDir: string
    codexHome: string
    env: NodeJS.ProcessEnv
    sources: string[]
  }): Promise<void>
}
