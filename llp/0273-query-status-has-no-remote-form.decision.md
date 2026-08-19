# LLP 0273: `hyp query status` has no remote form

**Type:** Decision
**Status:** Accepted
**Systems:** Query, CLI
**Author:** Phil / Claude
**Date:** 2026-08-18
**Related:** LLP 0015, LLP 0025, LLP 0031, LLP 0062
**Extends:** LLP 0033 (#flag-compat: the "local-cache operation under
`--remote` is a hard error" rule is stated for `--refresh`; it also covers
`hyp query status`, which had been silently ignoring the flag)

> [LLP 0033 §flag-compat](./0033-remote-query-attach.spec.md#flag-compat)
> settles the principle: a flag that operates on the **local cache** is
> meaningless under `--remote`, so the combination is a hard error rather than
> a silent ignore. It names one instance, `--refresh`. `hyp query status` is
> the same kind of operation and was not covered, so it accepted `--remote`,
> printed the local cache, and exited 0. This document extends the rule to
> `status` and records why the silent-ignore failure mode is worse there.

## Context

<a id="asymmetry"></a>

### Why `status` is the worse instance

The two commands fail differently under a silent ignore.

A silently-ignored `--refresh` is **self-announcing**: the caller asked for
work and no work happened. The next stale-cache warning contradicts the
assumption, and the caller re-reads the flag.

A silently-ignored `--remote` on `status` is **self-consistent**. `status`
reports the recording root, cache freshness, and the registered dataset list,
which is exactly the shape of the answer a caller asking "what does the server
have?" expects. They get a plausible, well-formed, server-shaped inventory of
the wrong host, with nothing on stderr and a zero exit. There is no later
signal that contradicts it, because the output is a correct description of a
machine, just not the one that was asked about.

The consequence is a wrong answer that propagates. A caller who reads the
local dataset list as the server's will then write SQL against datasets the
server does not have, or skip datasets it does, and attribute the resulting
errors to the query rather than to the inventory.

<a id="evidence"></a>

### The failure mode is observed, not hypothetical

Recorded sessions on 2026-08-03 show `hyp query status --remote hyperparam`
issued in four distinct sessions (`019fc50e`, `019fc514`, `019fc5cc` twice),
each one an agent trying to enumerate the server's datasets. Every call
returned this machine's cache with exit 0. The intent is unambiguous from the
invocation itself: nobody passes `--remote hyperparam` to learn about the
laptop they are typing on.

<a id="no-remote-status"></a>

### There is no remote status to report

The refusal is not a gap waiting to be filled. Registration state is not
shared: the server owns its own dataset registration, cache layout, and
refresh cadence, and does not expose them across the wire. Only `query_sql`
and `graph_neighbors` cross the wire at all (LLP 0033; LLP 0034 for the
producer half), and neither carries an inventory. A remote `status` would
require a new server verb and a new server-side contract, which no local
command can synthesize.

So local registration says **nothing** about a remote host's datasets, in
either direction. The honest probe is the server itself:

```sh
hyp query sql "select 1 from <dataset> limit 1" --remote <target>
```

where an `unknown dataset` error **is** the answer, not a failure to work
around.

## Decision

`hyp query status` rejects `--remote` (both the `--remote <target>` and
`--remote=<target>` spellings, and the bare-`--remote` default-target sentinel
of [LLP 0062 §bare-remote](./0062-builtin-default-remote.decision.md#bare-remote))
with **exit 2** and a stderr message, before doing any cache work. Nothing is
written to stdout: a partial local inventory under `--remote` is the exact
output this change exists to prevent.

The message names the alternative rather than only the prohibition, so the
caller's actual question ("what does that host have?") has somewhere to go.

Naming one flag is not enough on its own. `status` takes no arguments at
all, so every other unrecognized token (`--remot prod`, `-r prod`,
`--format json`, a bare `prod`) reaches the same wrong-host answer under a
silent ignore, and a typo on the very flag this document tells agents not to
use is the likeliest way to type one. The rest of argv therefore goes through
the shared command codec (`parseCommandArgv`), which rejects unknown flags
and stray positionals with exit 2, so the spelled-out `--remote` refusal is a
better message on a path that already fails rather than the only path that
fails.

## Consequences

- **This is a behavior change on an existing accepted invocation.** A stale
  `hyp` accepts the flag and answers locally; a current one exits 2. That
  asymmetry is itself a hazard for agents reading skill docs, so both
  `hypaware-query` SKILL.md copies state the old behavior explicitly rather
  than only the new rule.
- The `hyp query status` usage string is unchanged, but the `hyp query`
  group help is not: it told the reader that `status` "ignore[s] --remote",
  which this change makes false. The help now names the refusal, so the CLI
  does not document the behavior it immediately contradicts.
- The rule now has two named instances (`--refresh`, `status`). A third should
  extend this doc's list rather than re-deriving the principle.

## References

- [LLP 0033](./0033-remote-query-attach.spec.md) §flag-compat: the rule this
  extends; remote attach, consumer half
- [LLP 0034](./0034-mcp-host-intrinsic.decision.md): producer half; why only
  `query_sql` / `graph_neighbors` cross the wire
- [LLP 0062](./0062-builtin-default-remote.decision.md) §bare-remote: the
  bare-`--remote` sentinel the refusal must also catch
- [LLP 0031](./0031-layered-config.decision.md): query is local-only by default
