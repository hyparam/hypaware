import type {
  CapabilityRegistry,
  CapabilityRegistration,
} from '../../../collectivus-plugin-kernel-types.d.ts'

export type { CapabilityRegistry, CapabilityRegistration }

export interface CapabilityRegistryHandle extends CapabilityRegistry {
  /** Internal-only inspector used by dep_graph and tests. */
  _registrations(): Array<CapabilityRegistration & { value: unknown }>
  /**
   * Resolve a capability from a specific provider plugin. Returns the
   * value if the named provider registered the capability within the
   * semver range, or `undefined` otherwise.
   */
  fromProvider<T = unknown>(provider: string, name: string, range?: string): T | undefined
}

/**
 * Build the kernel-global capability registry. Emits `cap.provide`,
 * `cap.require_satisfied`, and `cap.require_missing` logs and ticks
 * the `hyp_capabilities_provided` UpDownCounter on each `provide`.
 */
export function createCapabilityRegistry(): CapabilityRegistryHandle
