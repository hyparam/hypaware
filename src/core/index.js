// @ts-check

// Phase 0: top-level kernel barrel. The kernel itself does nothing yet —
// behavior is added incrementally in Phases 1-9. The observability layer
// is the only subsystem with a real implementation at this point.

export * from './observability/index.js'
