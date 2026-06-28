import type {
  ActivatePluginsArgs,
  ActivatePluginsResult,
} from './types.d.ts'

/**
 * Activate every plugin in order. The caller is responsible for the
 * surrounding `kernel.boot` root span; each `plugin.activate` lands
 * as a child of whatever context is active when this is invoked.
 */
export function activatePlugins(args: ActivatePluginsArgs): Promise<ActivatePluginsResult>
