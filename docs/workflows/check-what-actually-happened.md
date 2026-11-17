# Check what actually happened

Don't take the agent's word for what it did. Check the record.

HypAware records every tool call and what came back, with timestamps. Use it
to check what an agent really did in a session: whether it ran the command it
reported, or whether a job ran once or twice. You get the record itself
instead of the agent's summary.

## Ask your agent

> From my HypAware history, in the session where we [change], did the agent actually [action], or did it only plan to?

> From my HypAware history, did [job] run last night, and how many times?

> From my HypAware history, when did [error] start showing up?

From a terminal:

<!-- agent: From my HypAware history, did [job] run last night, and how many times? -->
```sh
hyp ask "From my HypAware history, did [job] run last night, and how many times?"
```

## What you get back

An answer drawn from the recorded tool calls and their results: the command
that ran, what it returned, and when. Ask the agent to quote the tool call it
is relying on, so you can see the evidence instead of a paraphrase.

## Get a better answer

- Name the session or the time window. The narrower the window, the faster
  and more exact the answer.
- Ask for timestamps when order matters.
- HypAware records what passed through the agent. A side effect that happened
  outside the agent's tools, like a cron job on another host that isn't
  recorded, won't be there.

## Related

- [Find a conversation](../QUERYING.md#find-a-conversation), then read its tool
  calls with SQL.
- [Review an agent run](review-an-agent-run.md), when the question is why it
  happened.
