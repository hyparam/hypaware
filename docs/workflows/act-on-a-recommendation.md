# Act on a recommendation

Turn a report recommendation into a pull request with one paste.

Every HypAware report ends with recommendations, and each one has an id that
starts with `hyprec-`. Paste the id into your agent in the repository it
applies to. The agent checks it against your current code, makes the change,
and marks it applied with a link to the change, so the next report doesn't
raise it again.

## Ask your agent

> Use HypAware to fix recommendation [recommendation id] in this repo, and mark it applied with the PR link when it lands.

> From our HypAware team history, which open recommendations apply to this repo?

From a terminal, `hyp fix` starts your agent on the change:

<!-- agent: Read recommendation hyprec-0123456789abcdef with hyp recommendation get and apply it in this repository. When it is landed, mark it applied with the pull request link. Over MCP on our team's server, read it with get_recommendation and mark it with set_recommendation_status. -->
```sh
hyp fix hyprec-0123456789abcdef
```

Replace the id with one from your report, or list the open ones:

<!-- agent: Use HypAware to list our organization's open recommendations. Over MCP on our team's server, use list_recommendations. -->
```sh
hyp recommendation list --status open
```

## What you get back

A change in your working tree, made after the agent checks the recommendation
against the code as it is now. It makes the change without asking first, so
review the diff before you merge it. Once the change lands, the agent marks the
recommendation applied with the link you give it.

## Get a better answer

- Run it from the repository the recommendation is about.
- If the recommendation no longer applies, the agent should leave it open and
  say why. Don't mark it applied to clear the list.
- Mark it applied after the change is merged, not when the branch is opened.
- If a later report finds the same problem again, the recommendation goes
  back to open, with the newer one named as the reason.

## Related

- [Get one recommendation and fix it](get-one-recommendation.md), for finding the problem in the first place.
- [Reports](../REPORTS.md), for generating and sharing reports.
- [`fix_recommendation`](../MCP_REFERENCE.md#fix_recommendation), the same
  flow from an MCP client.
