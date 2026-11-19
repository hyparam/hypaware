# Recap what you did

Answer "what did I do last week?" with one prompt.

HypAware can summarize what you did on any day or week, across every session
and repository. Use it for standups, status updates, and timesheets, so you
don't have to rebuild the week from git log and memory.

## Ask your agent

> From my HypAware history, what did I do on [day], across every repo?

> From my HypAware history, summarize what I shipped this week, and list anything I started and didn't finish.

> From my HypAware history, list the pull requests I merged [today], and for each one the tickets or tasks it should update.

From a terminal:

<!-- agent: From my HypAware history, summarize what I shipped this week, and list anything I started and didn't finish. -->
```sh
hyp ask "From my HypAware history, summarize what I shipped this week, and list anything I started and didn't finish."
```

For a chart of the last 7 days by task, with no prompt to write, run
[`hyp usage`](../CLI_REFERENCE.md#hyp-usage). It groups your Claude Code and
Codex sessions by what they were for and shows the output tokens and pull
requests behind each, where a recap prompt gives you prose in the format you
ask for.

```sh
hyp usage
```

## What you get back

A summary grouped by repository or task, built from the sessions in the window
you named. Ask for the format you need: bullet points for a standup, a short
paragraph for a status update, or hours per project.

## Get a better answer

- Name the window with a date or a day of the week. "Recently" is vague.
- Say what to leave out, such as exploratory sessions that went nowhere.
- Time per project is an estimate from session timestamps. A session left
  open overnight counts as long.
- For a team recap, use `From our HypAware team history, ...`. See
  [ask your team's history](ask-your-teams-history.md).

## Related

- [See where the work goes](see-where-the-work-goes.md), for the sessions
  behind a ticket or pull request.
- [Summarize a known period](../QUERYING.md#summarize-a-known-period) with SQL.
