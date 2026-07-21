---
name: hypaware-publish-report
description: Publish a generated HypAware report (a Markdown/HTML one-pager or a rendered folder) to a HypAware server's org-scoped reports plane with `hyp report publish`, where every admitted member of the org can read it. Use when the user says "upload the report", "publish the report to the server", "push this report to the hypaware server", "share this report with the org/team", or after a report skill finishes and the user wants it hosted centrally. Requires a server with the reports plane plus a write-capable credential (a publisher-role login or an operator-minted publish token). Also covers `hyp report list`, `hyp report get`, and `hyp report delete`. Does NOT generate reports (use hypaware-ai-usage-report / hypaware-ai-security-report), does NOT build the HTML site (use hypaware-report-to-html), and never publishes without explicit confirmation - publishing makes the report visible to the whole org.
---

# Publish a HypAware report to the server

`hyp report publish` sends a finished report to a HypAware server's
org-scoped reports plane. Artifacts land under the org's archive prefix;
every admitted member of that org sees them (visibility is uniform within an
org, with no per-member ACLs), and they are immutable once published. The
sibling verbs `hyp report list`, `hyp report get`, and `hyp report delete`
read and manage what is already there.

## Confirm before publishing

Publishing is an org-visible, durable act. Before sending anything:

1. Tell the user which file/folder, which server (target), and which
   kind/period the publish will use.
2. Get an explicit yes. Never auto-publish as a side effect of generating a
   report.

## Prerequisites

- **A registered remote target.** `hyp report` rides the same target
  registry and credential store as `hyp query --remote`: run
  `hyp remote list` to see the targets. Every subcommand takes
  `--remote <target>`; omitting it uses the default target. If more than one
  target exists, ask the user which server to publish to; the server you
  query is the server you publish to. The server must have the reports plane
  (older servers 404 on `/v1/reports`).
- **A write-capable credential**, resolved automatically from the stored
  login (the CLI refreshes an expiring session silently):
  - A **publisher-role login**: an ordinary `hyp remote login <target>`
    session whose account a server admin has granted the publisher role.
  - An **operator-minted publish token**, stored as a static credential with
    `hyp remote login <target> --token-file <path>` (an operator mints one
    with `hypaware-server-admin mint-publish-token --org <org>`).
  - A plain member session can `list` and `get` but NOT publish or delete:
    reads and writes are separate scopes, and the server answers 401 to a
    valid session that lacks the report-publish scope.
- Only an operator using the admin token (via the per-target env override)
  needs `--org <org>`; a scoped credential pins its own org, so members
  never pass `--org`.

## What to publish

- **A one-pager** (`<slug>.md` from a report skill, or a standalone HTML
  file): publish the single file. Only `.md` and `.html` are accepted as
  single files; the server stores it as `report.md` / `report.html`, no
  renaming needed on your side.
- **A rendered folder** (e.g. `html/<slug>/` from hypaware-report-to-html):
  publish the folder; the CLI builds the bundle itself (correct tar format,
  hashing, retry safety), so never hand-roll a tarball. The folder root MUST
  contain `report.html` or `report.md` (the entry document the server serves
  at the report's root URL); the CLI refuses the publish before uploading if
  it is missing. A report-to-html folder uses `index.html`, so copy or
  rename it to `report.html` first (keep relative asset links; they survive
  as-is).
- Allowed file types: html, md, css, png, jpg/jpeg, svg, webp, json, txt,
  csv, woff2. **No JavaScript**: `.js` files are rejected and the serving
  CSP blocks scripts anyway; strip them from a rendered folder rather than
  letting the publish fail.

## Choosing kind, period, title

- `--kind`: kebab-case report family, `[a-z0-9][a-z0-9-]*` (max 64). Keep
  the vocabulary stable so listings do not fragment: use `usage-review` and
  `security-review` for the standard skills, not ad-hoc variants.
- `--period`: the report's coverage window, `[A-Za-z0-9][A-Za-z0-9.-]*`
  (max 64), e.g. `2026-W29` (ISO week) or `2026-07-17` (a date). Take it
  from the report's own date range, not today's date.
- `--title`: the report's human title (goes in the listing only).

The CLI validates kind and period before any bytes move, so a typo fails in
milliseconds, not after a large upload.

## How to publish

```sh
# a rendered folder (entry document report.html/report.md at its root)
hyp report publish html/ai-usage-2026-07-17 \
  --kind usage-review --period 2026-W29 --title "AI usage review, week 29"

# or a single-file one-pager
hyp report publish ai-usage-2026-07-17.md \
  --kind usage-review --period 2026-W29 --title "AI usage review, week 29"
```

Add `--remote <target>` to publish to a non-default server. On success the
CLI prints `published <kind>/<period>/<id>` and the matching
`hyp report get` command; relay both to the user.

Retries are safe: the CLI always sends a content hash, so re-running the
same publish after a timeout answers `already published as ... (same
content)` instead of double-listing the report. That is success, not an
error.

## Verify and read back

```sh
hyp report list --kind usage-review          # the org's index, newest first (--json for structured output)
hyp report get usage-review 2026-W29 <id>    # entry document to stdout
hyp report get usage-review 2026-W29 <id> assets/style.css --output style.css
```

Any admitted member's login can run these; confirm the new report lists,
then give the user its `kind/period/id`.

## Deleting

`hyp report delete <kind> <period> <id>` tombstones a report org-wide and
unrecoverably. It prompts for confirmation on a TTY and requires `--yes`
otherwise. Only run it when the user explicitly asks, and name exactly
which report goes.

## Errors you will actually see

- **A write 401 that survives the CLI's silent refresh**: the message names
  both causes - an expired session (re-run `hyp remote login <target>`) or
  an account that lacks the publisher role (ask a server admin for it, or
  store a publish token with `--token-file`). The client cannot tell which;
  relay both remedies.
- **`HTTP 403: org_mismatch`**: an explicit `--org` that contradicts the
  credential's org. Drop the flag; a scoped credential pins its org.
- **`HTTP 400: org_required`**: an admin-token publish without `--org`
  (`--org ''` is the single-org form).
- **`must contain report.html or report.md`** and kind/period grammar
  errors: client-side fail-fast; fix the input and rerun.
- **`HTTP 413: report_too_large` / `report_too_many_files`**: over the
  per-publish caps (32 MiB / 512 files by default). Reports are documents;
  trim assets rather than asking for a bigger cap.
- **`HTTP 507` (quota full)**: the org's report quota is exhausted. The
  server never auto-prunes; surface this to the user, whose options are
  deleting old reports (`hyp report delete`) or having the operator raise
  the quota. Never delete reports to make room without being told, and name
  exactly which reports would go.

## Fallback: no logged-in `hyp` on this machine

Raw HTTP works anywhere the publish token is at hand. The tar format is
load-bearing: the server accepts plain ustar only, and default tar output
is not plain ustar, so always pass `--format=ustar`:

```sh
tar --format=ustar -cz -C html/ai-usage-2026-07-17 . > /tmp/report.tgz
HASH=$(shasum -a 256 /tmp/report.tgz | cut -d' ' -f1)
curl -sS -X POST "$HYPSERVER_URL/v1/reports?kind=usage-review&period=2026-W29" \
  -H "authorization: Bearer $HYPSERVER_PUBLISH_TOKEN" \
  -H "content-type: application/gzip" \
  -H "x-report-content-hash: $HASH" \
  --data-binary @/tmp/report.tgz
```

For a single file, POST the file with `content-type: text/markdown` (or
`text/html`) and the hash of the file itself. Prefer the CLI whenever a
logged-in `hyp` exists; it handles refresh, retry safety, and validation.

## Scope limits

- Never mint tokens yourself unless the user is the operator and asks; the
  admin token and mint step belong to them.
- One publish per confirmed report; do not re-publish variants to "fix"
  metadata (each becomes a new immutable report). If metadata was wrong,
  tell the user and let them decide between living with it and
  delete-and-republish.
