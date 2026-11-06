# LLP 0562: Product telemetry packs CLI batches

**Type:** Spec
**Status:** Draft
**Systems:** Observability, CLI, Daemon
**Author:** Hernan / Claude
**Date:** 2026-10-27
**Extends:** LLP 0393 (#outbox: delivery packs queued CLI batches and holds CLI uploads; #contract: a packed batch carries one process id)
**Related:** LLP 0408 (bindings), LLP 0561 (#hooks: the other half of the same capacity incident)

> On 2026-10-27 the receiver's batch-receipt budget was full and nearly every
> batch was refused with `429 telemetry_capacity`. Every CLI run queued its own
> one- or two-record batch and later cost one receipt, so a host's receipt count
> grew with how many commands it ran. This spec makes a host's CLI uploads
> bounded by time and full by content.

## Packing {#pack}

The sender packs instead of sending the oldest slot as it stands. Under the
existing sender lock it takes the oldest live slot for the current binding:

- A **sealed** slot is sent unchanged. Sealing happens before a slot's first
  send, so a sealed slot may already have reached the receiver, and its batch
  id and bytes stay immutable across retries (LLP 0393 #outbox stands).
- A daemon batch is sent unchanged, as before. Its five-minute metric summaries
  cannot share a batch: the contract allows one interval per series per batch.
- An unsealed CLI batch was never sent. It packs with every other unsealed CLI
  batch of the same binding and the same resource apart from `process.id`
  (same version, platform and environment), oldest first, while the result
  stays within 100 records, the 32 KiB slot including its wrapper, and one
  interval per metric series. A member that does not fit stays queued.

A pack of several batches gets a new batch id. The packed batch is written over
the head's slot atomically with `sealed: true` and the ids it absorbed, then the
absorbed slots are removed. A crash between the two leaves absorbed slots
behind; the next maintenance pass recognizes their ids in a sealed slot and
removes them, so no record is uploaded twice and none is lost. Packing never
writes a new slot, so it works with a full queue, and every slot, byte and
seven-day bound in LLP 0393 #outbox is unchanged. Bindings never mix: slots of
another binding are expired by the same pass before packing, as before.

## Cadence {#cadence}

After a CLI upload is acknowledged, the next CLI pack waits an hour, unless the
waiting batches already hold more than 100 records or half the queue's slots.
The time of the last CLI acknowledgement is kept beside the existing backoff in
the delivery state file, so it survives new CLI processes and daemon restarts.
Sealed slots and daemon batches are never held.

A host therefore sends at most about 24 CLI uploads a day plus one per 100
records, instead of one per invocation. A record waits up to an hour longer.
A CLI-only host still delivers: any later CLI run drains as before.

## Process id {#process-id}

LLP 0393 #contract has process UUIDs distinguish a new CLI from an old running
daemon. A packed CLI batch carries the resource, and so the `process.id`, of
its oldest member. Role and version still separate a new CLI from an old
daemon, because batches differing in either never pack together, but a CLI
batch's `process.id` no longer names one invocation.

## Not changed {#not-changed}

A host running the daemon still uploads one batch per five-minute flush, 288 a
day, because each carries interval metrics. Reducing that changes the summary
cadence or the one-interval-per-series rule, both shared with the receiver, and
needs its own request.
