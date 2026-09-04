# LLP 0361: GitHub capture is page-wise and work-budgeted

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Graph, Config
**Author:** Phil / Codex
**Date:** 2026-09-02
**Related:** LLP 0032, LLP 0095, LLP 0096, LLP 0360
**Extends:** LLP 0360
**Extended-by:** [LLP 0373](./0373-boundary-identity-is-the-id-not-the-snapshot.rfc.md)
(the request covering the identity behind #page-work's equal-timestamp rule:
`pullChangedSince` recognizes a boundary pull by its number and the other three
passes by their event id, so an item updated twice inside one second never has
its second snapshot captured)

> A GitHub capture tick has one fixed request budget across its repository
> inventory. API pages are normalized and appended as they arrive, unfinished
> repository work is durable, and a round-robin continuation prevents a large
> repository from starving the rest. While work remains the daemon resumes on
> a bounded backlog cadence; after catch-up it returns to the configured daily
> cadence.

## Context {#context}

LLP 0360 bounded each endpoint to 50 pages and processed repositories and
requests sequentially. Those bounds prevent concurrency spikes, but they do not
bound a complete tick. One 5,000-pull page set can fan out into 15,000 pull
subresource requests, followed by 5,000 commit-detail requests. The GitHub
hourly request allowance can expire before that repository publishes its phase
cursor, causing the next tick to repeat the same prefix.

The old paginator also retained every complete REST object until an endpoint
finished. Issue, pull, and comment objects carry content fields that the
structural dataset deliberately discards. The page cap therefore still allowed
hundreds of megabytes of avoidable transient heap.

The bundled graph contract was also authored entirely as raw SQL even though
LLP 0096 provides declarative rules specifically to collapse rules over one
source dataset into one shared scan.

## Decision {#decision}

### Whole-tick budget and fairness {#budget}

A poll, sync, or backfill invocation spends at most 400 GitHub API requests on
repository capture. The budget is fixed implementation policy, not a user
configuration surface. Repository processing remains sequential. The cursor
sidecar records the next repository, so a repository that consumes the rest of
one tick yields to its neighbor at the start of the next tick.

An unfinished backfill remains a backfill when resumed by the daemon's ordinary
poll trigger. Repeating `hyp github backfill` while that backfill is active
continues it; invoking it after completion starts a deliberate new backfill.
Commands report whether bounded work remains rather than claiming a partial
chunk is the full history.

### Page-wise durable work {#page-work}

Every repository endpoint returns one normalized page. Capture appends that
page before advancing its page token. Pull and commit pages retain at most one
page of small pending task descriptors in the cursor sidecar while their files,
reviews, and commits are drained. The next page URL and current subresource are
durable, so later ticks resume rather than replaying the completed prefix.

API response objects are projected immediately to the structural fields the
dataset uses. Content bodies never survive beyond one response page. The
all-visible inventory still has a 50-page enumeration guard, but it retains
only normalized `owner/repo` strings.

Pull pages request newest-updated-first order. An incremental poll stops once a
page passes the previous pull high-water mark. Equal-timestamp unseen pulls are
still captured because GitHub timestamps have second granularity. The cursor
retains observed pull numbers so later issue-comment pages can distinguish PR
conversation comments without reloading the full pull history.

### Backlog cadence and interval floor {#cadence}

When a tick exhausts its budget with work remaining, the daemon resumes in at
most 15 minutes. With the 400-request budget this caps the source at 1,600
repository API requests per hour before GitHub-side rate limiting. Once no work
remains, the configured poll interval applies again.

GitHub polling intervals below five minutes are invalid. This is an API-heavy
background source, so millisecond test-style durations must not be accepted by
production configuration. Source tests may still inject shorter already-
validated runtime values.

### Projection {#projection}

The GitHub T0 contract uses LLP 0096 declarative `columns` and `where` rules.
All rules share one source-table scan. Null guards that cannot be expressed by
the predicate vocabulary remain in `toRow`, preserving output semantics.

## Consequences {#consequences}

- Capture has a finite request and transient-payload bound per tick.
- Large histories converge over multiple resumable ticks instead of repeatedly
  failing at the same rate-limit boundary.
- A very large backfill may take several backlog ticks, and command output says
  so explicitly.
- Cursor state grows by at most one page of pending pull or commit descriptors
  per in-progress repository, plus the compact set of observed pull numbers.
- Graph projection reads `github_events` once per run rather than once per rule.
