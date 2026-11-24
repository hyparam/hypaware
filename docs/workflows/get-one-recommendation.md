# Get one recommendation and fix it

One prompt finds the problem. The next one fixes it.

Agents work around problems instead of reporting them: they retry, build the
same tool again, or take a slower path. Ask HypAware for one recommendation and
the agent looks through your recent sessions, finds a problem like that, and
proposes one change backed by the sessions that show it. Then you fix it in the
same conversation, without running a full report.

## 1. Ask for one recommendation

Name the problem if you know it:

> From my HypAware history, give me one recommendation about [problem] this week.

> From my HypAware history, give me one recommendation about why [job] keeps failing.

Or let it find the biggest one:

> From my HypAware history, give me one recommendation that would most improve how my agents work in this repo this week.

From a terminal, `hyp ask` opens your agent with the question:

<!-- agent: From my HypAware history, give me one recommendation about repeated test failures this week. -->
```sh
hyp ask "From my HypAware history, give me one recommendation about repeated test failures this week."
```

If you don't say which period or what to focus on, the agent asks first, and
suggests the last 7 days.

## What you get back

A short answer in the conversation, in two parts:

- **Problem:** what the agents keep doing and what it costs you.
- **Fix:** the change to make and where, such as a skill, an instruction file,
  a workflow, or configuration.

Under that come the sessions that show the problem, anything still uncertain,
and how to measure whether the fix worked. A container missing a tool that jobs
keep failing on, a skill the agent never loads, or an instruction it keeps
working around are the kind of thing it can find. If the evidence doesn't
support a change, it says so.

## 2. Fix it

You're already in the right conversation. Tell the agent to make the change:

> Make that change in this repo.

Review the diff before you merge it.

## 3. Share and track it

This step is optional. To give the recommendation an id your team can see,
and mark it applied when the fix lands, save it and publish it to HypAware
Cloud:

> Save that recommendation.

The agent writes one `recommendation-<slug>.md` page in the current
directory. Publish it:

```sh
hyp recommendation publish ./recommendation-<slug>.md
```

HypAware Cloud gives it a `hyprec-` id. Once the fix is merged, mark it
applied with the pull request link, as in
[act on a recommendation](act-on-a-recommendation.md). Publishing needs the
publisher role in your organization.

## 4. Check that it held

A week after the fix lands, ask:

> From my HypAware history, I fixed [problem] last week. Compare sessions before and after. Did it stop, and what else moved?

## Get a better answer

- Ask from the repository the problem lives in, so the change lands in the
  right place.
- If the recommendation doesn't fit, ask for the next one, or tell the agent
  what's wrong with it. It's a conversation.
- Use a [full report](find-and-fix-problems.md) instead when you want a whole
  period reviewed, several problems ranked, or something to share with the
  team. It takes longer.

## Related

- [`hyp usage`](../CLI_REFERENCE.md#hyp-usage) charts your week by task and
  offers up to three suggestions drawn from it, when you would rather pick
  from a list than name the problem.
- [Find problems with a full report](find-and-fix-problems.md), to review a
  whole period and rank everything it finds.
- [Act on a recommendation](act-on-a-recommendation.md), when someone else's
  report gave you the id.
- [`hyp recommendation publish`](../CLI_REFERENCE.md#hyp-recommendation-publish)
