# Find problems with a full report

Review a whole period, rank every problem your agents ran into, and fix them
one by one.

For one problem you want fixed now, start with
[get one recommendation and fix it](get-one-recommendation.md). It's faster.
Use a full report when you want the whole picture: a week or a month of
sessions, every pattern ranked, and recommendations you can share with your
team.

## 1. Find the problems

Generate a report. It reviews the period, ranks what it finds, and writes one
recommendation page per proposed change:

<!-- agent: Use the hypaware-report skill to cover last week and focus on where my agents fail, retry, or repeat work. -->
```sh
hyp report generate "Cover last week and focus on where my agents fail, retry, or repeat work"
```

A report covers retries, rework, repeated context loading, unattended jobs, and
changes against the previous period. Each recommendation names the change, to
a skill, an instruction file, a workflow, or configuration, and cites the
sessions that motivated it. See [reports](../REPORTS.md).

To look around before you commit to a report, ask your agent directly:

> From my HypAware history, where did my agents go off the rails this week?

> From my HypAware history, what failure keeps repeating, and what triggers it?

> From my HypAware history, which tool calls fail most often, and is the agent calling something that isn't installed?

> From our HypAware team history, is any scheduled job hitting a turn or token limit every run?

## 2. Fix them

Every recommendation has an id that starts with `hyprec-`. Paste it into your
agent in the repository it applies to:

> Use HypAware to fix recommendation [recommendation id] in this repo, and mark it applied with the PR link when it lands.

From a terminal, `hyp fix` does the same:

<!-- agent: Read recommendation hyprec-0123456789abcdef with hyp recommendation get and apply it in this repository. When it is landed, mark it applied with the pull request link. Over MCP on our team's server, read it with get_recommendation and mark it with set_recommendation_status. -->
```sh
hyp fix hyprec-0123456789abcdef
```

Review the diff before you merge. Details are in
[act on a recommendation](act-on-a-recommendation.md).

## 3. Check that they held

> From my HypAware history, I applied [recommendation id] last week. Compare sessions before and after. Did the failure stop, and what else moved?

If a later report finds the same problem again, the recommendation goes back to
open, with the newer one named as the reason. A fix that didn't hold doesn't
stay marked done.

## Get a better answer

- Start narrow: one repository, one job, or one week. A focused report gives
  sharper recommendations than a month of everything.
- Ask for evidence. Every finding should point at sessions you can open.
- Publish the report to share it with your team; see [reports](../REPORTS.md).

## Related

- [Get one recommendation and fix it](get-one-recommendation.md)
- [Review an agent run](review-an-agent-run.md), to read one failure closely.
