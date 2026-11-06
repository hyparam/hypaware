# GitHub

**Status:** Supported. **Plugin:** `@hypaware/github`. Optional.

The GitHub integration records repository activity alongside your AI sessions,
so a query can connect a session to the pull request, commit, or review it led
to. It captures structural metadata for issues, pull requests, commits, files,
reviews, and comments and projects it into the activity graph. Their content
remains on GitHub.

## Set it up

At the end of an interactive `hyp setup`, HypAware asks whether to collect
GitHub information from your AI sessions. **Yes** enables the plugin and opens
GitHub in your browser to sign in. To add it later, run `hyp setup` again. Sign
in again or check access at any time:

```sh
hyp github login
hyp github status
```

Login uses a GitHub device code. HypAware only needs read access, but GitHub
has no read-only option, so it asks for read and write access to all your
repositories (the `repo` scope). Review the repositories selected in
the plugin configuration. By default HypAware polls the repositories it has
seen in your recorded sessions.

## Import existing activity

```sh
hyp github backfill owner/repo
hyp github sync
```

`hyp github backfill` imports history for the named repositories, or for the
configured selection when you name none. `hyp github sync` runs one poll now.
See the [GitHub reference](../CLI_REFERENCE.md#collect-github-activity) for
authentication and import behavior.
