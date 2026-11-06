# LLP 0454: Ineffective compaction alone does not need attention

**Type:** Spec
**Status:** Draft
**Systems:** Cache, Daemon, CLI
**Author:** Brendan / Codex
**Date:** 2026-09-29

<!-- @ref LLP 0228#status-file-is-the-surface [extends]: retain the snapshot and detailed report while narrowing warning eligibility -->

## Warning policy {#warning-policy}

When every skipped partition has reason `compaction_ineffective`, retain the
maintenance snapshot in verbose text and JSON but emit no maintenance warning.
A rewrite that reduced nothing is evidence for avoiding repeated work, not
proof of capture failure or a need for operator intervention.

Keep the warning when skipped partitions include failed attempts or unknown
reasons. Mixed warnings retain the complete count and reason breakdown.
Recommend `hyp query maintain --dry-run` for inspection; do not automatically
recommend `--force`, which may repeat an ineffective rewrite.

This changes presentation only. It does not change maintenance scheduling,
retry policy, snapshot retention, or persisted fields. It adds a constant-time
comparison to an already loaded snapshot, with no additional I/O or allocation.
Tests cover ineffective-only, mixed, empty, and unknown-reason snapshots.
