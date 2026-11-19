# Explain why a change was built

Your PR description can come straight from the sessions that built the branch.

The reasoning behind a change lives in the sessions that built it: what the
agent tried first, what you threw out, and why this approach won. HypAware lets
your agent read those sessions back and put that reasoning in the PR
description, your reply to a reviewer, or a design doc.

## Ask your agent

> From my HypAware history, write the PR description for this branch, and use the sessions that built it to explain why.

> From my HypAware history, were the review comments on [PR] already handled in an earlier session?

> From my HypAware history, why did we choose [approach] over [alternative] for [topic]?

> From our HypAware team history, why was [file] changed this way, and who decided?

From a terminal:

<!-- agent: From my HypAware history, write the PR description for this branch, and use the sessions that built it to explain why. -->
```sh
hyp ask "From my HypAware history, write the PR description for this branch, and use the sessions that built it to explain why."
```

## What you get back

The agent finds the sessions recorded on your current branch and repository,
reads what was tried and decided, and drafts the text you asked for with the
reasoning included. For review comments, it checks each comment against the
later sessions and tells you which were addressed and where.

## Get a better answer

- Ask from the branch itself. Sessions record their git branch, which is the
  most reliable way to find the ones that built it.
- If the work moved across branches or worktrees, name the topic or the main
  files as well.
- Ask for the alternatives that were rejected and why. Reviewers usually want
  those.
- Read the draft before you post it. A session records what was said, and an
  approach the agent proposed is not always the one that shipped. Check it
  against the diff.
- With the [GitHub integration](../integrations/github.md), sessions also link
  to the pull requests and commits they led to, which helps the agent start
  from a PR number.

## Related

- [Add decision context to every pull request](pr-context.md) to generate a cited introduction automatically with GitHub Actions.
- [Pick up where you left off](pick-up-where-you-left-off.md)
- [Follow relationships in the activity graph](../QUERYING.md#follow-relationships-in-the-activity-graph)
