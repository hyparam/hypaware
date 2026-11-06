# LLP 0565: A lost ingest seq counter restarts at the clock

**Type:** design
**Status:** Active
**Systems:** Cache, Sinks
**Author:** Kenny Daniel
**Date:** 2026-10-28
**Extends:** [LLP 0492#reserve-at-commit](./0492-ingest-seq-reserved-at-commit.design.md#reserve-at-commit) (what `reserve` reads when the counter file does not answer)
**Related:** LLP 0040#seq-allocator, LLP 0347#file-not-reader

@ref LLP 0492#reserve-at-commit [extends]: the restart point for a counter file that is present but unreadable

## Why {#why}

`readNextSeq` answered `null` for any read or parse failure, and `reserve`
started a `null` counter at 1. A corrupt `_hyp_ingest_seq.json` therefore
re-issued seqs from 1, below every sink watermark, and those rows never
exported. Nothing on disk says that happened.

## Recovery {#recovery}

- **Absent file.** A fresh cache. Start at 1, as before. This is the same
  missing-versus-unreadable line LLP 0347#file-not-reader draws for cursors.
- **Present but unreadable or malformed.** Restart at the wall clock in
  microseconds (`Date.now() * 1000`), WARN with `error_kind:
  ingest_seq_unreadable`, and let the normal reserve write replace the file.
  No operator step: nobody repairs this file by hand.
- **The bad file cannot be replaced** (a directory in its place, say). The
  write throws, the chunk waits in the spool (LLP 0492#contention), and no seq
  is consumed.

## Why the clock {#why-the-clock}

- The counter advances one per committed row. To pass the clock floor it would
  need about 1.8e15 rows, or, after an earlier recovery, more than a million
  committed rows a second since then. Every issued seq, and every watermark,
  stays below it.
- It is O(1). The alternative, the max `_hyp_ingest_seq` across the cache,
  scans every partition and still misses watermarks whose top rows were purged.
- The value stays far inside int64 (about 1.8e15 against 9.2e18).

## Not covered {#not-covered}

A wall clock set years behind could land the floor under issued seqs. Recovery
is already the rare path, so this is accepted rather than defended.
