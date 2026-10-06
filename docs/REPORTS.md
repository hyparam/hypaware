[← All documentation](README.md)

---

# Generate and share reports

Reports review your recorded AI work over a chosen period. Your agent examines
sessions, identifies recurring patterns, and proposes changes supported by the
recordings.

A report includes:

- **Usage:** token use, models, and activity over time.
- **Work:** recurring tasks, delegation, and opportunities to automate workflows.
- **Health:** tool failures, retries, and how sessions recovered.
- **Recommendations:** specific changes to skills, instructions, or configuration,
  with evidence from the sessions that motivated them.

The report is saved as Markdown for you to read and review. You can keep it
locally or publish it to HypAware Cloud to share with your organization.

## Contents

- [Generate a report](#generate-a-report)
- [Publish a report](#publish-a-report)

## Generate a report

`hyp report generate` opens a recorded AI client that has the
`hypaware-report` skill installed, which means Claude Code or Codex, to analyze
your local recordings. Tell it which period to cover and what to investigate:

```sh
hyp report generate "Cover last week and focus on repeated debugging work"
```

Without additional instructions, it reviews the previous calendar month.

The report skill drafts `./hypaware-report-<from>-to-<to>/`, adding a numbered
suffix if needed, and when the report is reviewed runs `hyp report save` on it,
which moves the folder into `~/.hyp/reports` (`$HYP_HOME/reports`). Every
finished report is in that one place, and `hyp report list` shows them beside
the published ones (`hyp report list --local` shows them alone). The agent
never writes under your home directory itself; the CLI does the move, and
only a folder that would publish is admitted. The session follows the current
directory's recording and sync policy, excerpts it quotes from `local-only`
history included ([PRIVACY.md](PRIVACY.md#marking-directories)). Publishing
remains a separate action, using `hyp report publish <name> ...`.

You can also write a Markdown report yourself with your findings, query scope,
and tables. The remote renders uploaded Markdown; no local render step is needed.

## Publish a report

Publishing makes the report appear in your organization's
[HypAware Cloud dashboard](https://app.hypaware.ai/), where your team can read it.

To share the generated report with your organization, replace `REPORT_NAME`
with the saved name printed by `hyp report save` (a path to a folder works
too) and `PERIOD` with the reporting period, such as `2026-W36`:

```sh
hyp report publish REPORT_NAME --kind usage-review --period PERIOD --remote team
hyp report list --kind usage-review --limit 10 --remote team
```

Publishing uploads the report bundle and requires a write-capable credential. Review
the report for private content first. See the [report command reference](CLI_REFERENCE.md#generate-and-manage-reports)
for bundles, downloads, and organization-wide deletion.
