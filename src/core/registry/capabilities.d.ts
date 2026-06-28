import type { CapabilityRegistryHandle } from './types.d.ts'

/**
 * Build the kernel-global capability registry. Emits `cap.provide`,
 * `cap.require_satisfied`, and `cap.require_missing` logs and ticks
 * the `hyp_capabilities_provided` UpDownCounter on each `provide`.
 */
export function createCapabilityRegistry(): CapabilityRegistryHandle
