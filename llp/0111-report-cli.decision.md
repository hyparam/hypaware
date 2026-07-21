# LLP 0111: Report CLI Commands

**Type:** Decision
**Status:** Draft
**Systems:** CLI, Reports, Query
**Author:** Brendan / Claude
**Date:** 2026-07-20
**Related:** LLP 0033, LLP 0058, LLP 0062, LLP 0084, LLP 0104

## Context

The central server grew an org-scoped reports plane (server LLP 0059/0060):
`POST /v1/reports` publishes a report artifact (a single HTML/Markdown
document, or a gzipped ustar bundle), `GET /v1/reports` lists the org's
index, `GET /v1/reports/<kind>/<period>/<id>/...` fetches artifacts, and
`DELETE` tombstones a report. Writes require the `report-publish` scope (a
publisher-role login session, or an operator-minted `pt-` publish token);
reads accept any read-class org credential, which includes the OIDC session
`hyp remote login` already stores.

Until now the only clients were the server's operator CLI (`admin.js`,
admin-token only, wrong plane for org members) and ad-hoc `curl` inside the
`hypaware-publish-report` skill. HypAware members needed first-class `hyp`
commands: the credential, target registry, and refresh machinery they need
already exist on the `--remote` query path.

## Options considered

1. **A core `report` command group riding the `--remote` machinery** -
   `hyp report publish|list|get|delete`, resolving the target and bearer
   exactly as remote queries do.
2. **A plugin contribution** - ship the commands in a workspace plugin.
3. **Extend the skill only** - keep publishing as documented `curl` calls in
   the report skills, no CLI surface.

## Decision

**Option 1: a core `report` group, one new endpoint derivation, zero new
credential machinery.**

<a id="core-group"></a>**Core, not plugin.** `hyp` is the human-CLI client
of the server's self-authenticating planes (LLP 0033 §commands made `remote`
core on exactly this ground). Reports are another such plane; a plugin would
have to re-import the whole credential stack for no isolation gain. The
skill-only option is rejected because a skill cannot refresh an OIDC session
or share the 0600 store safely; it should call the CLI instead.

<a id="target"></a>**Target and credential resolution are the `--remote`
path verbatim.** Every subcommand takes `--remote <target>`, defaulting to
`query.default_remote` else the shipped built-in (LLP 0062). The bearer
comes from `resolveAccessJwt` with the one-shot refresh + retry policy
(`attachWithRefresh`, LLP 0058 D5); the per-target env override still wins
(LLP 0033 §credentials). No new store: a publisher-role session publishes
with its ordinary login, and an operator-minted publish token stores as a
static record via `hyp remote login <target> --token-file`. Reports are
server-specific (server LLP 0020), so there is no local mode: `--remote`
selects a server, it never switches one on.

<a id="endpoint"></a>**The reports endpoint derives from the one registered
target URL.** Sibling of `deriveIdentityBase` and `deriveMcpEndpoint`
(LLP 0084): a registered URL whose path ends in `/v1/mcp` is treated as that
server's base, and `/v1/reports` is appended after any path prefix. No
second URL is ever configured.

<a id="bundle"></a>**Directory publishes shell out to
`tar --format=ustar -cz`.** Server LLP 0060#bundle assigns bundle creation
to the publish CLI and demands plain ustar: default tar formats emit
pax/GNU extension entries (typeflags `x`/`g`/`L`/`K`) that the server
rejects, and only sometimes, so the format must be pinned at creation.

<a id="fail-fast"></a>**Client-side fail-fast, server authoritative.** The
kind/period grammar (`[a-z0-9][a-z0-9-]*` / `[A-Za-z0-9][A-Za-z0-9.-]*`,
max 64) and the entry-document rule (a bundle must contain `report.html` or
`report.md` at its root) are checked before any bytes move, so a typo fails
in milliseconds, not after a 32 MiB upload. The server re-validates
everything; the client copies are UX, not enforcement.

<a id="delete-confirm"></a>**Delete prompts on a TTY; `--yes` for
non-interactive.** A report delete is org-wide and unrecoverable (any
publish-scope holder can delete any of the org's reports, server LLP 0053's
write-side face), so it follows `hyp purge`'s confirmation posture
(LLP 0104) rather than `remote remove`'s silent one.

<a id="period-explicit"></a>**`--period` is always explicit; there is no
default and no `auto` sentinel.** The established convention (the
`hypaware-publish-report` skill) makes period the report's *coverage
window*, never the publish date: a weekly report about week 28 published on
Monday of week 29 must say `2026-W28`. A now-derived default would silently
mislabel exactly that most-common case, and the CLI can never compute the
coverage window - only the report generator that did the date math knows
it. The actual scheduled publishers are the report skills, which already
compute their date range, so the ergonomic win of a default is near zero.
This also keeps the server's period grammar genuinely open rather than
freezing an ISO-week convention client-side.

<a id="not-verbs"></a>**The `report` group stays a REST command group; MCP
report tools are the server's to register.** LLP 0034 subsumes bespoke REST
with MCP tools for *query-shaped* operations (typed params in, structured
result out), and the reports plane is mostly not that: publish uploads
local file bytes, get streams arbitrary binary artifacts (images, fonts)
where base64-in-JSON would bloat a 32 MiB bundle, and the REST routes must
exist anyway for the browser-viewing story. Only `list` is purely
query-shaped, and routing it over MCP while its siblings ride REST would
split the auth and error handling (including the write-401 messaging
above) for no gain. Nor do report verbs belong in the *client* registry:
the plane is server-only, so a client verb would have no local operation,
and the verb surface has no remote-only exposure class. Agent reach comes
from the server side instead, per LLP 0034's zero-client-change promise: a
server-registered read-class `report_list` / entry-document `report_get`
tool appears to every direct-installed MCP client and to the `hyp mcp
--remote` proxy with no change in this repo. That registration is a
server-corpus decision (LLP 0034 §server-coordination pattern); this
document only records why the client does not mirror it.

<a id="write-401"></a>**A write 401 that survives the refresh retry is
explained as scope, not only expiry.** The server answers 401 (not 403) to
a valid read-class session that lacks `report-publish`, so on publish and
delete the standard "session expired - re-login" guidance would mis-advise
a member who simply lacks the publisher role. The write-path message names
both causes: re-login if expired, else ask an admin for the publisher role
or store a publish token. Reads keep `describeAuthRejection` unchanged.

## Consequences

- The `hypaware-publish-report` skill can shrink to `hyp report publish`
  plus argument selection; its `curl` recipe and hand-rolled tar invocation
  become fallbacks for machines without a logged-in `hyp`.
- Quota exhaustion (`report_quota_exceeded`, HTTP 507) surfaces verbatim
  with the server's make-room-explicitly posture (server LLP 0059
  #quota-full): the CLI never suggests auto-pruning.
- The publish retry-safety header (`x-report-content-hash`) is always sent,
  so a timed-out re-run of the same artifact answers 200 with the existing
  report instead of double-listing it.

## Open questions

- `hyp report open <kind> <period> <id>`: launch the entry document in a
  browser. Blocked on the server's cookie-session viewing story (server
  LLP 0060 open question): a browser holds no bearer, so the URL the
  command would open cannot authenticate yet. An interim download-and-open
  was considered and rejected: a bundle's entry `report.html` references
  sibling assets a lone temp file breaks, the API has no manifest route to
  mirror a bundle from, and a `.md` entry document opened via `file://`
  renders as plain text. `hyp report get --output` already covers the
  single-`.html` case an interim would have served. Once server viewing
  lands, `open` is a URL derivation plus platform launcher, nothing more.
- Server-side `report_list` / `report_get` read-class MCP tools: proposed
  to the server corpus (see #not-verbs); until the server registers them,
  agents without a logged-in `hyp` have no report reach.

## References

- Server LLP 0059 - org-scoped report storage and serving (decision)
- Server LLP 0060 - report upload and read routes (design)
- [LLP 0033](./0033-remote-query-attach.spec.md) - remote targets, credential store, commands are core
- [LLP 0058](./0058-oidc-login-client.decision.md) - OIDC login client, refresh policy
- [LLP 0062](./0062-builtin-default-remote.decision.md) - built-in default remote
- [LLP 0084](./0084-mcp-endpoint-from-base.decision.md) - endpoint derivation from the registered base
- [LLP 0104](./0104-hyp-purge.decision.md) - destructive-command confirmation posture
