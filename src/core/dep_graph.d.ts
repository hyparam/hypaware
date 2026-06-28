import type { PluginManifest } from '../../collectivus-plugin-kernel-types.d.ts'
import type {
  DepGraphResolution,
  ResolveDependenciesOptions,
} from './types.d.ts'

/**
 * Resolve a topological activation order over manifests' `requires.plugins`
 * and `requires.capabilities`. Emits `dep_graph.resolve` (span) and
 * `dep_graph.reject` (log) per rejection. Capability requires drain
 * through the registry, which is what emits `cap.require_satisfied`
 * and `cap.require_missing`.
 */
export function resolveDependencies(
  manifests: PluginManifest[],
  opts?: ResolveDependenciesOptions,
): Promise<DepGraphResolution>
