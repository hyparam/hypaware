# LLP 0436: Publish Markdown report sources

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports, Plugins
**Author:** Phil / Codex
**Date:** 2026-09-24
**Related:** LLP 0155, LLP 0107, LLP 0196, LLP 0216 (the removal this reverses)

## Decision

### Sources {#sources}

`hyp report publish` uploads Markdown for the server to render, matching
HypAware Server LLP 0484 and server PR #1135. A single `.md` or `.markdown`
file is sent as `text/markdown`. A folder must contain `report.md` and only
regular Markdown files named `usage.md`, `work.md`, `health.md`, or
`recommendation-<slug>.md`; the legacy `change-<slug>.md` spelling also works.
Slugs use the server grammar `[a-z0-9][a-z0-9-]*`.

Reject HTML, assets, unknown pages, directories, and symlinks before packing
or sending a directory. Enumerate only its immediate entries and pack the
validated filenames explicitly using the existing ustar transport. Members
are packed under their bare filenames (`report.md`, not `./report.md`), with
no directory entry, because the validated list names files explicitly rather
than packing the whole directory tree as the old HTML bundle path did (`./`
and `./<name>`). The server remains authoritative for content validation, raw
HTML and unsafe links, input and output limits, rendering, and organization
permissions. No Markdown parser or renderer is added to the client upload path.

This extends LLP 0155's entry-document and fail-fast contract. Existing
published HTML remains readable. `hyp report render` remains available as
a standalone local command; its output is no longer a publish input.

### Skill {#skill}

This section supersedes [LLP 0216](./0216-reports-generate-server-side.decision.md)
[D1](./0216-reports-generate-server-side.decision.md#d1) and its
[#no-skill-needed](./0216-reports-generate-server-side.decision.md#no-skill-needed)
finding. 0216 removed the skill for an honest reason: once generation lived on
the server, a client skill teaching a model to generate a report locally
documented a workflow the product no longer wanted. What changed is the publish
contract in [#sources](#sources) above: the server now renders Markdown that a
client writes, so a local generator produces the server's input rather than
competing with it. Generation needs neither a server account nor publishing, so
the skill is also the whole product on a machine that never joins an org.
**The skill surface goes from three back to four**: `hypaware-query`,
`hypaware-reference`, and `hypaware-privacy` are the other three, and 0216's
[#consequences](./0216-reports-generate-server-side.decision.md#consequences)
"The skill surface is three" bullet no longer holds. 0216
[D2](./0216-reports-generate-server-side.decision.md#d2) (`hyp report` stays)
is unaffected: [#sources](#sources) above settles the seam D2 deferred,
`hyp report render` stays a local command and its output is no longer a
publish input.

The bundled `hypaware-report` skill produces Markdown with analyst subagents
through each host's existing delegation facilities. Both adapters register
it as a client skill so the ordinary attach/materialization path installs it.
Generation requires neither a server account nor publishing.

When the user requests publishing, the skill uses `hyp report publish` with
the selected remote and the report's actual coverage period. Existing
credentials and the organization's publisher role govern the write. Publishing
authorization does not authorize raw-log upload or applying recommendations.
An upload failure leaves local sources available and is reported as a failure,
without a fallback to HTML or silent changes to content or destination.

### Constraints and the content boundary {#constraints}

Of the eleven constraints [D3](./0216-reports-generate-server-side.decision.md#d3)
handed to the server, four return to `test/fixtures/skill-constraints.json`
with their original harm statements, because the restored skill restates them
locally: `coalesce-token-sums`, `no-wide-column-scans`, `tokens-never-dollars`,
`no-person-rankings`. A fifth id, `captured-content-is-data`, already covers
the boundary text below; it was never one of the eleven D3 removed (it stayed
in the fixture for `hypaware-query` under [D4](./0216-reports-generate-server-side.decision.md#d4)'s
narrower list), so it now also matches `hypaware-report` rather than being
newly added. The other six of the eleven stay the server's, because they
describe publishing, rendering, and enrichment steps this skill does not
perform locally.

The enforceable wide-column rule text preserved in 0216
[#recovered-rule-text](./0216-reports-generate-server-side.decision.md#recovered-rule-text)
ships in the skill again, verbatim: `references/querying.md` names `cwd` and
`content_text` as the wide columns the messages table must never
`GROUP BY` / `DISTINCT` / row-fetch at scale.

The skill reads recorded content back and emits durable change artifacts
(each recommendation page's ready-to-apply diff, skill file, or config text),
so it joins the [D4](./0216-reports-generate-server-side.decision.md#d4)
register in `test/plugins/query-skill-content-boundary.test.js`, which D4 says
is a register of what qualifies today, not a budget that shrinks as files are
deleted.

Both guards (`test/helpers/skill_host_divergence.js` and
`test/plugins/skill-constraints-survive.test.js`) now walk a skill directory
recursively: `hypaware-report` is the first skill with a nested `references/`
tree, and one-level enumeration made its prose invisible to both.

### Validation {#validation}

CLI tests cover Markdown transport, rejected files and bundle entries before
network access, and server validation errors. The parity and constraint guards
(`test/helpers/skill_host_divergence.js`, `test/plugins/skill-constraints-survive.test.js`)
were made recursive so they cover the skill's nested `references/` tree, which
a one-level enumeration made invisible before this change, and the divergence
fixture (`test/fixtures/skill-host-divergence.json`) records the real host
divergence between the claude and codex copies.

CPU and memory: validation walks one directory without reading page contents
or recursing; it retains only accepted filenames before the existing bounded
tar output buffer. It adds no dependency, rendering work, or long-lived state.
