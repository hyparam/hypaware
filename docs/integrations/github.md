# GitHub

**Status:** Supported. **Plugin:** `@hypaware/github`. Optional.

The GitHub integration records repository activity alongside your AI sessions,
so a query can connect a session to the pull request, commit, or review it led
to. It captures structural metadata for issues, pull requests, commits, files,
reviews, and comments and projects it into the activity graph. Their content
remains on GitHub.

## Connect GitHub

Run this command to enable collection and sign in:

```sh
hyp github connect
```

The command shows a code and opens GitHub in your browser. Enter the code
there to sign in. With `--no-browser`, the command prints the URL and code for
you to open. It saves the local settings and restarts a running service daemon
after sign-in. Interactive `hyp setup` also offers to connect GitHub during
onboarding.

If your organization manages GitHub collection, connect uses its settings. If
it turns GitHub or the context graph off, connect makes no change and asks you
to contact your administrator.

Sign in again or check access at any time:

```sh
hyp github login
hyp github status
```

HypAware only needs read access, but GitHub has no read-only option, so
sign-in asks for the `repo` scope: read and write access to all your
repositories. HypAware uses it only to read metadata. By default, it polls the
repositories it has seen in your recorded sessions.

## Import existing activity

```sh
hyp github backfill owner/repo
hyp github sync
```

`hyp github backfill` imports history for the named repositories, or for the
configured selection when you name none. `hyp github sync` runs one poll now.
See the [GitHub reference](../CLI_REFERENCE.md#collect-github-activity) for
authentication and import behavior.

## Use the recorded context

Install the GitHub Action to give reviewers a cited introduction on every PR. [Add decision context to every pull request](../workflows/pr-context.md)
