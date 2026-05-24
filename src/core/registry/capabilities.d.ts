import type {
  CapabilityRegistry,
  CapabilityRegistration,
} from '../../../collectivus-plugin-kernel-types.d.ts'

export type { CapabilityRegistry, CapabilityRegistration }

export interface CapabilityRegistryHandle extends CapabilityRegistry {
  /** Internal-only inspector used by dep_graph and tests. */
  _registrations(): Array<CapabilityRegistration & { value: unknown }>
}

/**
 * Build the kernel-global capability registry. Emits `cap.provide`,
 * `cap.require_satisfied`, and `cap.require_missing` logs and ticks
 * the `hyp_capabilities_provided` UpDownCounter on each `provide`.
 */
export function createCapabilityRegistry(): CapabilityRegistryHandle
