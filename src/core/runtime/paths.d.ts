import type {
  PluginName,
  PluginPaths,
} from '../../../collectivus-plugin-kernel-types.d.ts'

export type { PluginPaths }

export interface CreatePluginPathsArgs {
  pluginName: PluginName
  rootDir: string
  stateRoot: string
  runId: string
  tmpRoot?: string
}

/**
 * Build the four standard plugin directories and create them on disk.
 * See `paths.js` for the layout contract.
 */
export function createPluginPaths(args: CreatePluginPathsArgs): Promise<PluginPaths>
