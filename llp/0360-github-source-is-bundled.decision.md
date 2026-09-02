# LLP 0360: The GitHub source is bundled with HypAware

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Graph, Config
**Author:** Phil / Codex
**Date:** 2026-09-02
**Related:** LLP 0005, LLP 0006, LLP 0010, LLP 0012, LLP 0023, LLP 0032,
LLP 0121, LLP 0213, LLP 0350; hyparam/hypaware-server#413
**Supersedes:** The standalone `@hypaware/github` packaging premise recorded in
LLP 0032 and used as the comparison in LLP 0121
**Extended-by:** [LLP 0361](./0361-github-capture-is-work-budgeted.decision.md)
(capture is page-wise and resumable under a whole-tick request budget)

> `@hypaware/github` ships under `hypaware-core/plugins-workspace/github`.
> Bundling does not activate it by default: adding it to `plugins[]` remains the
> explicit outbound-capture choice. Once active, it captures repositories
> evidenced by local agent sessions on a daily cadence, unless the machine
> explicitly chooses all repositories visible to its GitHub identity.

## Context {#context}

The first GitHub source implementation lived in an unpublished standalone
checkout. That boundary was reasonable while the source selected explicit
repositories and depended only on stable kernel and graph capability surfaces.
The default inventory subsequently changed to repositories evidenced by
`git_remote` on `ai_gateway_messages` rows. Repository discovery now depends on
the host dataset shape, incremental cache reads, usage-policy withholding, and
the shared graph key contract. Keeping those coordinated behaviors in separate
repositories creates release skew at the privacy and capture boundary.

The separate checkout also obscured ownership. HypAware master carried the
session half of the graph bridge, tests, and query guidance, while the source
that completed the bridge had no remote repository. A user could reasonably
inspect `hypaware-core/plugins-workspace` and conclude that GitHub capture did
not exist.

## Decision {#decision}

The complete source, `github_events` dataset, and T0 projection contract are
bundled in this repository. The old standalone checkout is no longer a source
of truth. Future changes to session evidence and GitHub capture land together.

This reverses only the old packaging premise. LLP 0121 still correctly bundles
Hermes, and LLP 0032's natural keys and convergence rules remain unchanged.

## Packaging and activation {#packaging}

The manifest requires both `@hypaware/context-graph` and its
`hypaware.context-graph` capability. The plugin registers its contract during
activation, following LLP 0006. It is shipped in the bundled workspace and is
listed in `V1_EXCLUDED_FROM_DEFAULT`.

Exclusion is deliberate. Merely shipping the plugin must not start credentialed
outbound GitHub API calls. A local or central config must explicitly list:

```json
{ "name": "@hypaware/github" }
```

After that explicit activation, the plugin's own safe defaults apply. The
context graph remains a required mechanism, and projection remains the separate
`hyp graph project` operation.

## Inventory {#inventory}

`inventory = "session_repos"` is the default. The source incrementally reads
only `git_remote` from export-eligible `ai_gateway_messages` cache rows,
normalizes GitHub remotes to lowercase `owner/repo` keys, and stores only those
keys plus opaque continuations and partition versions in a local sidecar. Raw
remotes are not persisted in the sidecar. Unchanged partitions are not
reopened.

The export-eligible read is deliberate. A repository evidenced only by a
`local-only` session must not produce `github_events` rows without equivalent
row-level provenance, because those structural rows could otherwise be sent to
a central sink. Rows dropped at capture by `ignore`, and rows withheld at the
export seam by `local-only` or client source opt-out, do not expand the GitHub
inventory. The read still advances its local continuation over withheld rows.

Session evidence is the complete local inventory in this mode. It is not
intersected with a central allowlist and does not enumerate GitHub organizations.
A positional repository passed to `hyp github backfill` narrows the active
inventory and never expands it.

`inventory = "all_visible"` is the explicit full-capture mode. It enumerates
owner, collaborator, and organization-member repositories visible to the
authenticated local identity. No `repos[]` or `orgs[]` config belongs to the
local source. Server-owned repository lists and server GitHub credentials from
hyparam/hypaware-server#413 are not moved here.

## Exclusions {#three-invariants}

`ignore[]` is the repository-level capture control in both inventory modes:

1. It is enforced before GitHub fetches, in poll and backfill paths.
2. It is forward-only and does not delete existing `github_events` or graph
   rows.
3. It is an exact, case-insensitive `owner/repo` match.

A later client UI may manage this list per repository without changing the
capture contract.

## Capture regimes {#capture-regimes}

The source has two triggers over one pipeline:

- `hyp github backfill` resets each selected repository cursor and fetches its
  available history.
- The daemon source and `hyp github sync` resume from the durable cursor.

Both append only to `github_events`. They do not invoke graph projection.
Webhooks remain deferred because the local daemon has no public ingress.

## Authentication {#authentication}

The configured environment variable, `GITHUB_TOKEN` by default, has priority.
When it is empty, the source runs `gh auth token` and caches that value only in
the short-lived capture client. Tokens are never logged or written to state.

The child lookup path adds common Homebrew, MacPorts, local-bin, and mise
locations because launchd often supplies only system paths. The daemon's own
environment is not mutated. Authentication failure is classified and
secret-safe.

## Cadence {#cadence}

The default interval is 24 hours. The first tick runs within five minutes of
source start. Each completion schedules the next timeout, so ticks cannot
overlap and a daemon restart cannot postpone capture for a full interval.
Failures retry on the ordinary cadence rather than in a busy loop.

Status and structured logs expose inventory mode, cadence, attempt and success
times, next tick, repository and event counts, duration, in-flight state, and
error kind. Inventory logs use counts rather than repository names. No signal
contains a credential.

## Cursoring {#cursoring}

Each repository has time-window high-water marks and ETags in
`github-cursors.json`. Backfill and polling share that sidecar, so a completed
backfill seeds the next incremental poll. Session-repository discovery has its
own atomic sidecar with cache-partition continuations and versions. Both are
mutable control state, not activity rows.

Each API phase advances a working cursor and publishes that cursor only after
its rows and dependent sub-resources append successfully. A failed append or
sub-resource request therefore retries from the last completed phase rather
than skipping the missing range. Rows appended by an earlier attempt remain
valid snapshots and are included in the tick's written-row count.

## Resource bounds {#resource-bounds}

Repositories are processed sequentially. API pagination is capped. Event-id
deduplication is scoped to one API result batch, because event namespaces are
disjoint across capture passes and retaining every id for an entire repository
history can dominate memory.

## Storage {#concrete-columns}

`github_events` is one append-only structural dataset. It stores stable keys,
state, timestamps, and small structural payloads, but not issue bodies, comment
text, diffs, or repository content. GitHub remains the content system of record.
The dataset rediscovers actual cache source-table partitions so query and graph
projection read rows written by the source.

## Graph contract {#graph-contract}

The plugin bundles a T0 contract for Repo, Actor, Commit, File, Issue,
PullRequest, and Review nodes plus their deterministic relationships. It builds
rows with the context graph capability kit. Repo, Commit, and File keys remain
the byte-compatible vocabulary settled by LLP 0032, so local session and GitHub
capture converge without a server-side identity join.

## Consequences {#consequences}

- A normal install carries the source code but performs no GitHub API work until
  config explicitly activates `@hypaware/github`.
- Local capture requires no server GitHub token.
- The plugin and `ai_gateway_messages` evidence contract share one release and
  test suite.
- This decision does not implement client-to-server graph snapshot transport.
  That remains a separate synchronization change.
