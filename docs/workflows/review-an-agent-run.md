# Review an agent run

When an agent surprises you, good or bad, find out why.

Each recorded run shows why the agent did what it did: the prompt it had, what
it tried, in what order, and where the time went. People read one run closely
to improve their prompts, skills, and harnesses.

## Ask your agent

> From my HypAware history, walk me through [job]'s last run. What did the agent try, in what order, and where did the time go?

> From my HypAware history, how did the agent decide to [change] in [topic]? What did it see that led there?

> From my HypAware history, were the agent's hypotheses in [session] right, and which ones did it drop?

From a terminal:

<!-- agent: From my HypAware history, walk me through [job]'s last run. What did the agent try, in what order, and where did the time go? -->
```sh
hyp ask "From my HypAware history, walk me through [job]'s last run. What did the agent try, in what order, and where did the time go?"
```

## What you get back

A step-by-step account of one run from its recorded messages and tool calls:
what the agent was asked, what it read, what it tried, what failed, and how
long each stretch took. Ask what it would change in the prompt or harness.

## Get a better answer

- Point at one run: a session id, a time, or the job name and "last run."
- Subagent work is recorded with the session. Ask the agent to include it.
- For the same failure across many runs, ask about the pattern instead:
  "From my HypAware history, where do my agents keep getting stuck?"

## Related

- [Check what actually happened](check-what-actually-happened.md)
- [Reports](../REPORTS.md), for patterns across many runs.
