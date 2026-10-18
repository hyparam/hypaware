# LLP 0537: Held-dataset status for a server that cannot accept a dataset

**Type:** Spec
**Status:** Accepted
**Systems:** Sinks, Plugins, Daemon, CLI
**Author:** Phil / HypForge
**Date:** 2026-10-18
**Extends:** LLP 0305 #routing, LLP 0453 #warning-rule
**Related:** LLP 0307, LLP 0471, issue #999

## Request {#request}

LLP 0305 makes dataset registration a capability gate. When a server answers
`PUT /v1/datasets/{name}` with 404 or 405 it predates that route, so the client
holds the dataset locally and re-probes every five minutes. The hold lived only
in memory and in one log line: `hyp status` reported healthy forwarding while
the rows went nowhere, and the sink counted the held partition as exported.
This records Phil's 2026-10-05 decision on issue #999 (option b): keep a small
durable record of current holds and turn it into a status warning.

## Held outcome {#held-outcome}

The forward path returns an explicit internal held outcome for a refused
registration. Zero bytes cannot carry it, because an empty export also sends
zero bytes.

- A held partition is not counted in `partitionsExported` and is not returned
  in `retryPartitions`, so the driver writes no outbox entry for it. The public
  `ExportResult` status vocabulary is unchanged.
- The watermark does not move. The rollout boundary and the five-minute
  reprobe stay as LLP 0305 and LLP 0307 left them.
- The hold is recorded before the partition counts as settled. If that write
  fails, the partition fails and retries, so a failed state write can never
  read as healthy forwarding.
- Only a registration the server accepted clears a hold. The reprobe timer
  expiring is not evidence of recovery.
- A privacy-withheld dataset (LLP 0305 #eligibility) keeps its intentional
  withholding and never becomes a hold; a withheld verdict clears any stale
  hold for that name.

## Snapshot {#snapshot}

Each central sink instance keeps `held-datasets.json` beside its watermarks:
`{ v: 1, destination, datasets, updatedAt }`.

- `destination` is the SHA-256 of the configured URL, and the URL itself is
  not written. A record for another destination reads as holding nothing, so a
  replaced server or a re-enrollment never inherits another server's warning.
- `datasets` holds only the current held names: no attempts, partitions,
  credentials or row contents. On sink creation the record is pruned to the
  open datasets the sink still forwards, and rewritten for the current
  destination.
- Every write replaces the whole set with an atomic write-rename, and writes
  are serialized, so overlapping ticks land in call order and an older write
  cannot resurrect a cleared hold. A write that fails leaves the store dirty and
  the next hold or clear rewrites it.

## Status warning {#status-warning}

`hyp status` reads each configured request sink's snapshot from disk, with no
daemon to ask, and adds one `sink_dataset_unsupported` warning per sink that
holds a dataset. The message names the datasets (the first five, then a count)
and says their rows stay local; the repair is to upgrade the server.

- The warning degrades `overall`. Rows an enabled destination cannot accept
  are not healthy forwarding.
- It is a different kind from `sink_export_failing` (LLP 0453 #warning-rule), a
  transport failure, and privacy withholding produces no diagnostic.
- A snapshot that cannot be read or parsed warns too, because an empty answer
  would certify forwarding that nobody checked.
- A sink removed from config, or one whose plugin is disabled, is not read.
