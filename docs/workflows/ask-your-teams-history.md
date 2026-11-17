# Ask your team's history

Before you fix it, find out whether someone on your team already did.

Once your hosts sync to HypAware Cloud, the questions you ask about your own
history can run across your team's sessions, including agents running
unattended on build boxes and remote hosts.

## Ask your agent

> From our HypAware team history, did anyone already work on [error]?

> From our HypAware team history, what did everyone's agents work on yesterday?

> From our HypAware team history, what has the agent on [hostname] done today, and has it gone quiet?

> From our HypAware team history, what did the agent on [hostname] decide on its own overnight, and what was each decision based on?

From a terminal:

<!-- agent: From our HypAware team history, did anyone already work on [error]? -->
```sh
hyp ask "From our HypAware team history, did anyone already work on [error]?"
```

## Before you start

Team questions need this host connected to your organization in HypAware Cloud.
Run `hyp setup` and choose **Sync to the cloud**, or run `hyp remote login`.
See [Cloud and teams](../TEAM_SETUP.md). What each host shares depends on its
[privacy settings](../PRIVACY.md): folders marked local-only or ignored never
reach the team history. By default every member can read every member's synced
sessions; an admin can narrow that, and then team questions cover only the
sessions you can read.

## What you get back

The agent searches the team's synced sessions, follows the files and sessions
that match, and reads the conversations that look relevant. For a remote
agent, ask what it did, when it last ran, and what it decided along the way.

## Get a better answer

- Name the file, error, or feature. The agent finds team sessions fastest
  through the files they touched.
- Treat what another session said as a lead. Check whether a later session
  changed the decision before you rely on it.
- A host that hasn't synced recently won't show its latest work.

## Related

- [Explore the team's history](../QUERYING.md#explore-the-teams-history) and
  [query a remote target](../QUERYING.md#query-a-remote-target).
