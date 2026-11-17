# Everyday workflows

Your agents leave a full record of every session: what they were asked, what
they tried, what broke, and what they decided. HypAware gives that record back
to your agents, so they can find what's going wrong and fix it, pick up work
where it stopped, and explain why the code looks the way it does.

These are short workflows to make HypAware part of your day. Each one has
prompts you can paste, what comes back, and how to get a better answer.

## Find problems and fix them

| Workflow | What you get |
| --- | --- |
| [Get one recommendation and fix it](workflows/get-one-recommendation.md) | One problem, one evidence-backed change, fixed in the same conversation, without waiting for a full report |
| [Find problems with a full report](workflows/find-and-fix-problems.md) | A whole week or month reviewed, every problem ranked, and a recommendation for each that your agent can apply and you can share with the team |
| [Act on a recommendation](workflows/act-on-a-recommendation.md) | A report recommendation turned into a pull request, and marked applied when it lands |
| [Review an agent run](workflows/review-an-agent-run.md) | Why the agent did what it did on one run, so you can fix the prompt or harness |

## Never lose work again

| Workflow | What you get |
| --- | --- |
| [Pick up where you left off](workflows/pick-up-where-you-left-off.md) | The session that closed, crashed, or got buried, and exactly where it stopped |
| [Explain why a change was built](workflows/explain-why-a-change-was-built.md) | A PR description or reviewer reply written from the sessions that built the branch |
| [Recap what you did](workflows/recap-what-you-did.md) | A day or week of work across every session and repo, ready for standup |
| [Check what actually happened](workflows/check-what-actually-happened.md) | The tool calls and results that settle what the agent really did |

## See where the work goes

| Workflow | What you get |
| --- | --- |
| [See where the work goes](workflows/see-where-the-work-goes.md) | Every session behind a Linear ticket or pull request, and which tickets and PRs took the most agent work, and why |

## Work as a team

| Workflow | What you get |
| --- | --- |
| [Ask your team's history](workflows/ask-your-teams-history.md) | Whether someone already fixed it, and what the agents on other hosts are doing |

## How to ask

Ask in the agent you already use: Claude Code, Codex, Cursor, or any recorded
client with HypAware's skills installed. Start with
`From my HypAware history, ...` for this host's recordings, or
`From our HypAware team history, ...` for everything your team syncs to
HypAware Cloud. The agent often reaches for HypAware without being told;
naming it makes the prompt work every time. From a terminal, `hyp ask` does
the same (see [queries](QUERYING.md#use-hyp-ask)).

Placeholders in brackets, like `[topic]` or `[PR]`, are yours to fill in with
your own file, error, branch, or topic.
