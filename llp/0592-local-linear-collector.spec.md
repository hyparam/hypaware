# LLP 0592: Local Linear collector and PR graph links

**Type:** Spec
**Status:** Draft
**Systems:** Plugins, Sources, Graph, Config
**Author:** Phil / Codex
**Date:** 2026-11-06
**Related:** LLP 0012, LLP 0023, LLP 0032, LLP 0360, LLP 0361, LLP 0392, LLP 0409

## Request

Implement the requested local Linear plugin with browser login and explicit
issue-to-PR graph links, following the bundled GitHub collector pattern.
Hosted collection, webhooks and direct session-to-PR authorship are outside
this change.

## Activation and scope {#scope}

`@hypaware/linear` is bundled but excluded from default activation. Its config
accepts `teams` (Linear team keys or UUIDs), `poll_interval` (default `24h`,
minimum `5m`), `token_env` (default `LINEAR_API_KEY`), `client_id` and
`redirect_uri` (default `http://127.0.0.1:19264/callback`). Empty `teams` means
no capture, with an actionable status. Explicit configuration is the capture
authorization, independently of OAuth visibility. No session text is scanned
to discover Linear issues or expand scope.

Issues are filtered by configured teams at the API. Attachments have an
independent workspace-wide updated stream but no issue/team API filter. Read
only GitHub URL attachment metadata and its parent issue's structural facts;
filter parent teams before appending anything. Do not infer attachment changes
from the issue's `updatedAt`.

## Browser authentication {#authentication}

`hyp linear login [--no-browser]` uses Linear's authorization-code flow with
S256 PKCE, random state, `read` scope and a fixed registered loopback callback.
Bind only loopback, validate path, method, state and duplicate parameters, and
bound the wait. Close the listener on completion, cancellation and failure.
The printed URL is usable from a browser on the same machine; this is not a
cross-machine device-code flow. No client secret is distributed. Login defaults
to the public HypAware Local OAuth application, client id
`68c419c2c54fbbfe5e50a7e51172a6cf`, registered with the default callback.
An explicit `client_id` takes precedence over `LINEAR_CLIENT_ID`, which takes
precedence over the bundled public id. The callback is configurable for custom
applications but must remain HTTP on 127.0.0.1 or localhost with an explicit port
and no query or fragment.

Follow GitHub's private 0700 directory / 0600 atomic credential file, selected
pending/active/logged-out state, superseding login generations and mutexed
refresh. Store the client id with its grant so config changes cannot redirect
a rotating refresh token to a different application. Verify viewer and
organization before committing login. Environment API keys explicitly override
OAuth. No tokens, response bodies, codes or verifier enter logs, datasets or
errors. Logout clears local credentials; provider revocation is separate.

## Capture and resumption {#capture}

`linear_events` is one append-only structural snapshot dataset: issue rows
and GitHub PR attachment rows, with deterministic revision ids. Content stays
in Linear. Snapshot polling is not a complete audit log and missing/deleted
attachments do not retract historical graph links.

Use independently paginated issue and attachment streams ordered by creation
time inside a frozen updated-time interval. Per-workspace cursors record the
interval, opaque continuation and stream; a whole-tick request budget bounds
work. Save progress only after appending a page, with one page-commit mutex shared
by CLI and daemon. Network calls run outside it; compare the cursor generation
inside it before appending, then rotate the generation with each page commit.
Keep the lower bound inclusive with a small overlap to
recover concurrent updates; replayed boundary snapshots are harmless. Backfill
resets continuations deliberately and may re-append like GitHub. Workspace or
team-selection or authenticated-user changes start a fresh cursor scope.
Include archived resources.

Schedule a short first delay and completion-relative daily ticks. Bounded
backlogs resume after at most 15 minutes, failures on the ordinary cadence.
Stop aborts network work and awaits in-flight storage/projection. Emit safe
structured capture/projection/auth lifecycle logs and expose source status.

## Graph identity {#graph}

Register `linear_events`' own T0 contract with the existing graph capability.
Reuse `Issue` with natural key `linear:<workspace UUID>:<issue UUID>` and the
human identifier as label. A PR attachment emits `Issue -references->
PullRequest` using the existing GitHub `owner/repo#number` identity. Mint that
PR endpoint as well so links remain traversable before GitHub capture. Reject
non-GitHub hosts, userinfo, malformed URLs and non-PR paths. Keep attachment id
and normalized source identity in provenance. Do not copy GitHub-private code
into this source or import another plugin's internals.

Projection is source-scoped after capture and on first activation, and retries
after failure even on an unchanged tick. Nodes and edges record observed
historical structure, not current workflow state: the graph's earliest-value
merge cannot act as a latest-state materialized view. Query source snapshots
for changing state. Existing GitHub commit/session convergence is unchanged.

## Bounds and verification {#verification}

No new runtime dependencies. Fetch only selected structural fields, 50 records
per page, bounded bodies and deadlines, with a finite request budget and no
per-issue attachment fan-out. Cursor state is constant-sized per active scope;
no all-history dedup set or growing queue. Existing projection still scans
source history and graph ids; run at most once per changed tick, and skip idle
ticks after success. Query heap limits do not guarantee a process RSS ceiling.

Traditional tests cover config, callback/PKCE/refresh races, secret-safe API
errors, independent stream pagination, team and workspace changes, budget and
restart recovery, durable cursor failures, cancellation, graph convergence and
projection retries. A hermetic smoke proves login through a local callback,
capture through the real GraphQL client, automatic projection, and the path
from issue through PR and commit to a session, with run-specific telemetry.
Real provider acceptance requires a registered OAuth app and human consent.
