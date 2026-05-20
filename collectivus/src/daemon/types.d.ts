// ---------- Daemon: macOS LaunchAgent ----------

export interface LaunchctlResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface LaunchctlAdapter {
  load(plistPath: string): Promise<LaunchctlResult>
  unload(plistPath: string): Promise<LaunchctlResult>
  list(label: string): Promise<LaunchctlResult>
}

export interface BuildPlistOptions {
  label: string
  nodePath: string
  binPath: string
  configPath: string
  logDir: string
  env?: Record<string, string>
  keepAlive?: boolean
  runAtLoad?: boolean
}

export interface MacosInstallOptions {
  binPath: string
  configPath: string
  label: string
  logDir: string
  nodePath?: string
  env?: Record<string, string>
  keepAlive?: boolean
  runAtLoad?: boolean
  /** Override directory for the plist file. Defaults to ~/Library/LaunchAgents. */
  plistDir?: string
  launchctl?: LaunchctlAdapter
}

export interface MacosUninstallOptions {
  label: string
  plistDir?: string
  launchctl?: LaunchctlAdapter
}

export interface MacosStatusOptions {
  label: string
  /** Unused; accepted for API symmetry. */
  plistDir?: string
  launchctl?: LaunchctlAdapter
}

// ---------- Daemon: Linux systemd ----------

export interface SystemctlResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SystemctlAdapter {
  daemonReload(): Promise<SystemctlResult>
  enable(unit: string): Promise<SystemctlResult>
  disable(unit: string): Promise<SystemctlResult>
  restart(unit: string): Promise<SystemctlResult>
  stop(unit: string): Promise<SystemctlResult>
  show(unit: string): Promise<SystemctlResult>
}

export interface BuildUnitOptions {
  description: string
  nodePath: string
  binPath: string
  configPath: string
  logDir: string
  env?: Record<string, string>
  restart?: boolean
}

export interface LinuxInstallOptions {
  label: string
  binPath: string
  configPath: string
  logDir: string
  description?: string
  nodePath?: string
  env?: Record<string, string>
  restart?: boolean
  /** Override directory for the unit file. Defaults to ~/.config/systemd/user. */
  unitDir?: string
  systemctl?: SystemctlAdapter
}

export interface LinuxUninstallOptions {
  label: string
  unitDir?: string
  systemctl?: SystemctlAdapter
}

export interface LinuxStatusOptions {
  label: string
  unitDir?: string
  systemctl?: SystemctlAdapter
}

// ---------- Daemon: cross-platform ----------

export type DaemonInstallOptions = MacosInstallOptions & LinuxInstallOptions
export type DaemonUninstallOptions = MacosUninstallOptions & LinuxUninstallOptions
