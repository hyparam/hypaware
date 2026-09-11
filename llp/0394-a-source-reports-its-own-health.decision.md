# LLP 0394: A source's own health reaches the status file

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Daemon, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-08
**Extends:** LLP 0012, LLP 0164
**Related:** LLP 0021, LLP 0225, LLP 0385

> The kernel contract has published `SourceStatus.state`, `message`,
> `rowsWritten` and `lastError` since V1, and the daemon kept only `details`.
> A source could report a failure faithfully on every tick and no operator
> surface would ever show it. The daemon now records what the source said
> about itself beside what it observed about its lifecycle.

## Context

[LLP 0012](./0012-sources.spec.md) publishes `status?(): Promise<SourceStatus>`
as the way a source answers for itself, and the shipped contract
(`hypaware-plugin-kernel-types.d.ts`) gives that answer five fields: `state`,
`message`, `details`, `rowsWritten` and `lastError`.

[LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md#status-reads-it-from-the-status-file)
put the probe on the tick loop so an accruing *detail* would stop being frozen
at its bind-time value. It kept the field it was about:

```js
const probe = boot.runtime.sources.status(name).then((s) => s?.details ?? undefined)
```

The other four were dropped at that `.then`, and at the boot-time `safeStatus`
beside it. The `failure` channel next to it carries the kernel's own probe
failure (a timeout, an unsettled previous probe), never anything the source
reported about itself.

This is not hypothetical. Eight shipped sources populate at least one of the
dropped fields, and `@hypaware/gascity`, `@hypaware/otel`, `@hypaware/github`,
`@hypaware/opencode` and the Claude telemetry listener all set `lastError`
exactly as the contract invites. A GitHub source failing its projection every
tick said so through `lastError` and `hyp status` showed nothing (issue #1490).

A published field that a plugin populates and the kernel silently drops is
worse than an absent one: the author reads the interface, implements it
correctly, and gets no signal and no error saying it does nothing. It is also
the opposite of what [LLP 0021](./0021-observability.spec.md)
asks of a failure, which is to identify the broken step rather than be
invisible.

The alternative resolution was to delete the four fields from the published
interface and leave `details` as the only channel. It was rejected on the
evidence above: the fields are not vestigial, they are used, and deleting a
required `state` from a published contract would break every source plugin in
and out of this tree to remove information those plugins are already trying to
give. Nothing about `details` recommends itself as the sole channel either:
each plugin shapes it differently, so core cannot read a failure out of it
without learning plugin-specific keys.

## Decision

### Health rides beside state, not instead of it {#health-rides-beside-state}

`SourceSnapshot` gains one optional field, `health`, holding the reported
`state`, `message`, `rowsWritten` and `lastError` under their published names.
The daemon fills it wherever it already filled `details`: at boot in
`startConfiguredSources`, and on every tick and at shutdown in the refresh.

It is a sub-object rather than four fields spread over the snapshot because
the snapshot already has a `state`, and it is a *different* state.
`SourceSnapshot.state` is the lifecycle's verdict, in the lifecycle's
vocabulary (`started` / `failed` / `stopped`); `SourceStatus.state` is the
source's reading of how that is going, in a health vocabulary (`ready` /
`degraded` / `error` / ...). They can honestly disagree: a started source is
free to report itself degraded. Keeping them in separate places is what lets
LLP 0164's "name, plugin, and state are left alone" go on holding literally:
liveness is still the lifecycle's business, and nothing a probe returns
rewrites it.

Every field of `health` is optional and independently validated, because a
plugin may return anything: an unrecognized `state` word, a `rowsWritten` of
`NaN`, or a `message` of a megabyte. A field that does not arrive usable is
dropped rather than recorded wrong, and a `health` with nothing usable left in
it is not recorded at all.

The strings are cleaned and clamped (200 characters) *at the point of record*,
for the reason LLP 0164 gives for `entrypoint` labels: `status.json` is
rewritten every tick and is read back by a command that prints it to a
terminal, and nothing on the way in bounds a plugin-authored string. They are
cleaned again on the way out, where every other field read back out of that
file already is.

A probe that answers replaces `health` wholesale, including erasing it. A
`lastError` the source has stopped reporting is a failure that is over, and a
stale copy of it would outlive the failure it describes. A probe that throws,
times out, or is skipped changes nothing, exactly as it already changes
nothing about `details`.

### The text plane speaks only for a source reporting trouble {#quiet-when-healthy}

`hyp status --json` carries the whole of `health` for every source, and
`hyp daemon status --json` carries the file's copy of it verbatim. The text
plane prints one extra line, indented under the source, and only when the
source is saying something is wrong: a `lastError`, or a state that is neither
`ready` nor `starting`.

```
  sources:
    - github  (@hypaware/github)  [started]
        reports degraded: projection budget exhausted
```

The restraint is deliberate. Most sources report a `message` and a
`rowsWritten` on every healthy tick, so rendering the reported fields
unconditionally would add a line per source to every `hyp status` on every
machine, and bury the block it is meant to make legible. A machine plane can
be filtered by its reader; a terminal cannot.

## Consequences

- **`status.json` grows by a bounded amount per source**: at most two
  200-character strings, a small number and a state word, rewritten on a tick
  that already rewrote the file.
- **Nothing is removed from the plugin contract**, so no source plugin changes
  and none has to. The five fields keep their published meaning; four of them
  acquire a reader.
- **An operator on an older daemon sees no `health`**, and every reader treats
  its absence as "this daemon did not record one" rather than as health.
- **`hyp status` gains a line a passing test may not expect** only on an
  install where a source is reporting trouble, which is the state the line
  exists for.
- **A plugin can now put a sentence of its choosing on an operator's
  terminal.** That is what the field is for, and it is why the value is
  cleaned and clamped at both ends rather than trusted at either.
