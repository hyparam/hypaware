# Pick up where you left off

Stop explaining yesterday's work to your agent again.

HypAware keeps the whole conversation when a terminal closes, a laptop
reboots, or a session gets buried under a pile of worktrees. Ask your agent to
find the session and tell you where it stopped.

## Ask your agent

> From my HypAware history, find my last session in this repo and tell me where it stopped.

> From my HypAware history, what was the plan in the session that got cut off, and how far did we get?

> From my HypAware history, find the session where I set up [topic].

> From my HypAware history, find everywhere I discussed [topic], in any tool.

From a terminal:

<!-- agent: From my HypAware history, find my last session in this repo and tell me where it stopped. -->
```sh
hyp ask "From my HypAware history, find my last session in this repo and tell me where it stopped."
```

## What you get back

The agent searches your recorded sessions by topic, file, repository, and
branch, across every recorded client, then reads the matching conversation.
Ask it for the session id, when it ran, the last thing that was done, and
what was still open.

## Get a better answer

- Run it from the repository you were working in, or name the repository.
  Sessions record their working directory and git branch.
- Give the agent something distinctive: an error message, a file name, a
  function, or roughly when it happened.
- If the first session isn't the right one, say so and give one more detail.
  Similar sessions are common, especially across worktrees.
- To search sessions from other hosts and teammates, see
  [ask your team's history](ask-your-teams-history.md).

## Related

- [Find a conversation](../QUERYING.md#find-a-conversation) with `hyp query grep`.
- [Explain why a change was built](explain-why-a-change-was-built.md), to get
  the reasoning out of the session as well as the session itself.
