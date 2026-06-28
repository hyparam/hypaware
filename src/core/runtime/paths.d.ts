import type { PluginPaths } from '../../../collectivus-plugin-kernel-types.d.ts'
import type { CreatePluginPathsArgs } from './types.d.ts'

/**
 * Build the four standard plugin directories and create them on disk.
 * See `paths.js` for the layout contract.
 */
export function createPluginPaths(args: CreatePluginPathsArgs): Promise<PluginPaths>
