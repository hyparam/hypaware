# Generate and share reports

Reports review recorded AI work over a chosen period, from this machine's
recordings or from your team's on a configured remote. Your agent examines
sessions, identifies recurring patterns, and proposes changes supported by the
recordings.

A report includes:

- **Overview (`report.md`):** goals, outcomes, what deserves attention, and the
  ranked recommendations.
- **Comparison:** changes in outcomes and token use against the preceding period
  of the same length.
- **Work:** which projects and objectives used tokens, and what they produced.
- **Automation:** usage from interactive work, unattended agents, recurring jobs,
  and reviews.
- **Repeated work:** where retries, rework, and repeated context loading used
  tokens, and whether that repetition was necessary.
- **Recommendations (`recommendation-<slug>.md`):** one page per proposed change
  to skills, instructions, workflows, or configuration, with evidence from the
  sessions that motivated it.

The report is saved as Markdown for you to read and review. You can keep it
locally or publish it to HypAware Cloud to share with your organization.

## Generate a report

We recommend Fable or Astra for the best report quality.

`hyp report generate` opens a recorded AI client that has the
`hypaware-report` skill installed, which means Claude Code or Codex, to analyze
this machine's recordings or your team's. Tell it which period to cover and what
to investigate:

<!-- agent: Use the hypaware-report skill to cover last week and focus on repeated debugging work. -->
```sh
hyp report generate "Cover last week and focus on repeated debugging work"
```

Before it starts, the skill asks for whatever your instructions leave open: the
scope (this machine or the team), the period, and the focus. It suggests the
last 7 days including today but waits for your answer. "Last week" means the
last 7 days including today; ask for a calendar week or month to get those
boundaries. Today's recordings are included and labeled partial, and the report
compares the period with the preceding period of the same length.

The report skill drafts `./hypaware-report-<from>-to-<to>/`, adding a numbered
suffix if needed, and when the report is reviewed runs `hyp report save` on it,
which moves the folder into `~/.hyp/reports` (`$HYP_HOME/reports`). Every
finished report is in that one place, and `hyp report list` shows them beside
the published ones (`hyp report list --local` shows them alone; in JSON, only
`--local --json` lists them, and `--json` alone lists published reports). The agent
never writes under your home directory itself; the CLI does the move, and
only a folder that would publish is admitted: `report.md` plus
`comparison.md`, `work.md`, `automation.md`, `repeated-work.md`, `usage.md`,
`health.md`, and `recommendation-<slug>.md` pages. The session follows the current
directory's recording and sync policy, excerpts it quotes from `local-only`
history included ([PRIVACY.md](PRIVACY.md#marking-directories)). Publishing
remains a separate action, using `hyp report publish <name> ...`.

<!-- @ref LLP 0461 [explains]: the report skill offers a single-recommendation path that hyp report recommend publishes -->
To get one recommendation instead of a full report, ask for it:

<!-- agent: Use the hypaware-report skill to give me one recommendation about repeated test failures. -->
```sh
hyp report generate "Give me one recommendation about repeated test failures"
```

If you have not named a period, the skill asks for one, suggesting the last 7
days including today. It answers in the session. Ask it to save the
recommendation and it writes one `recommendation-<slug>.md` page in the current
directory; it does not save a report folder. Publish the page only if you want
to share it, with [`hyp report recommend`](CLI_REFERENCE.md#hyp-report-recommend).

You can also write a Markdown report yourself with your findings, query scope,
and tables. The remote renders uploaded Markdown; no local render step is needed.

## Publish a report

Publishing makes the report appear in your organization's
[HypAware Cloud dashboard](https://app.hypaware.ai/), where your team can read it.

To share the generated report with your organization, replace `REPORT_NAME`
with the saved name printed by `hyp report save` (a path to a folder works
too) and `PERIOD` with the reporting period, such as `2026-W36`:

<!-- agent: Use HypAware to publish the report folder REPORT_NAME to our organization as a usage review for PERIOD, then list the last ten usage reviews. -->
```sh
hyp report publish REPORT_NAME --kind usage-review --period PERIOD --remote team
hyp report list --kind usage-review --limit 10 --remote team
```

Publishing uploads the report bundle and requires a write-capable credential. Review
the report for private content first. See the [report command reference](CLI_REFERENCE.md#generate-and-manage-reports)
for bundles, downloads, and organization-wide deletion.

To download a whole published report, open it in the dashboard and choose
**Export** at the top of the report, then **Markdown ZIP**. The ZIP holds the
report's Markdown pages and an `export.json` file with details such as the
report's title, period, and recommendation ids. It does not include the
recorded sessions behind the report, and links in it to the evidence behind
the report may ask you to sign in to HypAware Cloud. Some older reports,
published as HTML rather than Markdown, cannot be exported.

To see the recommendations your organization has not acted on yet:

<!-- agent: Use HypAware to list our organization's open recommendations. Over MCP on our team's server, use list_recommendations. -->
```sh
hyp report list --status open
```

Over MCP, on your team's server at `/v1/mcp`, use `list_recommendations`.

To act on a recommendation from inside a repository, run `hyp report fix` with
the id from `hyp report list`; it starts your agent on the change.

<!-- agent: Read recommendation hyprec-0123456789abcdef with hyp report get and apply it in this repository. When it is landed, mark it applied with the pull request link. Over MCP on our team's server, read it with get_recommendation and mark it with set_recommendation_status. -->
```sh
hyp report fix hyprec-0123456789abcdef
```

Over MCP, the `fix_recommendation` prompt does the same: the agent reads the
recommendation with `get_recommendation` and marks it applied with
`set_recommendation_status`, the tool for `hyp report mark`.

If a later report finds the same problem again, a recommendation marked
applied goes back to open, with the newer recommendation named as the reason.
