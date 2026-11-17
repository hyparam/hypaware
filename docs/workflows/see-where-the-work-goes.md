# See where the work goes

Find out which tickets and pull requests your agents' work actually went into.

HypAware connects a session to the commits it made, a commit to its pull
request through the [GitHub integration](../integrations/github.md), and a
pull request to its ticket through the [Linear integration](../integrations/linear.md).
So you can start from a ticket or a PR and get every session behind it: how
long it took, how many times the agent went back and forth, where it got
stuck, and what it used. Or start from a session and find the ticket it was
for.

## Ask your agent

Start from one ticket or PR:

> From my HypAware history, for [ticket], show the pull requests, the sessions behind them, and where the agent got stuck.

> From my HypAware history, which sessions went into [PR], how long did they take, and how many tokens did they use?

Look across a sprint or a month:

> From my HypAware history, which tickets this sprint took far more agent work than the rest, and why?

> From my HypAware history, which pull requests this month needed the most sessions, and what made them hard?

> From my HypAware history, which pull requests needed the most rework after review?

Go the other way:

> From my HypAware history, which ticket and pull request was this session for?

From a terminal:

<!-- agent: From my HypAware history, which tickets this sprint took far more agent work than the rest, and why? -->
```sh
hyp ask "From my HypAware history, which tickets this sprint took far more agent work than the rest, and why?"
```

## Before you start

- **Pull requests** need the [GitHub integration](../integrations/github.md).
  `hyp setup` offers it at the end; run `hyp setup` again to add it later. Use
  `hyp github backfill` to bring in history from before you turned it on.
- **Tickets** also need the [Linear integration](../integrations/linear.md).
  Run `hyp linear connect` to sign in and choose your Linear teams. It links
  an issue to the pull requests attached to it in Linear, and collects on the
  host where you set it up.

## What you get back

For each ticket or pull request: the sessions that worked on it, when they
ran, how much back-and-forth they took, token use where the client records it,
and a short account of what went smoothly and what didn't. Across a sprint,
the agent ranks tickets or PRs by the work that went into them and explains
the outliers.

## Get a better answer

- The link runs through commits. Work that never produced a commit, such as
  exploration or an approach you threw away, doesn't link on its own. Ask the
  agent to also match sessions by branch name, which every session records.
- A ticket links only to pull requests attached to it in Linear. If your team
  doesn't attach PRs to issues, start from the PR instead.
- Token counts depend on the client. Some integrations don't record token use;
  see [integrations](../INTEGRATIONS.md).
- An outlier is a question to ask, not a verdict. Ask why a ticket took so much
  work: a vague spec, a flaky test, and a missing tool look the same in a
  count and very different in the sessions.

## Related

- [Explain why a change was built](explain-why-a-change-was-built.md), for the
  reasoning behind one PR.
- [Get one recommendation and fix it](get-one-recommendation.md), when the
  outliers share a cause.
- [Follow relationships in the activity graph](../QUERYING.md#follow-relationships-in-the-activity-graph)
