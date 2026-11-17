# Linear

**Plugin:** `@hypaware/linear`. Optional, local collection.

Collect structural issue metadata and explicit GitHub PR attachment links from
selected Linear teams. Issue descriptions, titles and comment bodies stay in
Linear. Graph projection connects an `Issue` to the same `PullRequest` node the
GitHub collector uses, so existing commit/session paths become traversable.
Rows land in the local cache and can be exported by your existing configured
sinks, like other captured datasets.

## Connect Linear

```sh
hyp linear connect
hyp linear status
```

Approve read-only access in your browser, then choose the Linear teams to
collect. HypAware selects the team automatically if only one is available and
keeps any team scope you previously configured. The command enables the
collector and its graph dependency, saves the selection, and restarts a running
service daemon when the config changes. `hyp setup` does not offer Linear. Run
this command at any time to turn it on.

To set the team scope directly, pass `--team` for each team key or UUID you
want to collect, for example `hyp linear connect --team ENG --team OPS`.
This also works when the terminal cannot show a team picker.

If your organization manages the Linear settings, connect uses the teams it
set. If it turns Linear or the context graph off, sets no teams, or you pass
`--team`, connect makes no change and asks you to contact your administrator.

## Sign in again

Run `hyp linear login` to sign in again with your existing team settings. Both
commands use the shared **HypAware Local** OAuth app and handle the local
callback automatically. Sign in with a browser on the same machine as the CLI.
`--no-browser` prints the authorization URL so you can open it yourself. The
attempt expires after five minutes. Press Ctrl-C to cancel.

Tokens are saved privately in the plugin's state directory with automatic
refresh. A running daemon picks up login and logout on its next request.
`hyp linear logout` removes local OAuth credentials. Revoke the grant in Linear
settings to remove provider access as well.

Logout alone leaves the collector on, and `hyp linear status` then reports
that you are logged out. To stop collecting, run `hyp linear logout` first,
then set the Linear plugin's `teams` to an empty array or `enabled` to false
on its `plugins[]` entry, and run `hyp daemon restart`.

## Advanced authentication

To use your own [Linear OAuth application](https://linear.app/developers/oauth-2-0-authentication),
put its public client ID in the plugin's `client_id` setting, or set
`LINEAR_CLIENT_ID`. Explicit config takes precedence over the environment
variable, followed by the shared HypAware app. The default registered callback
is `http://127.0.0.1:19264/callback`. If that port is busy, free it or use a custom
app with a different loopback URL. Set `redirect_uri` for the custom URL and
register the exact same URL in Linear.

For headless collection, `LINEAR_API_KEY` can supply a personal API key. Its
value overrides saved OAuth, and `hyp linear connect` uses it directly. The
`token_env` config field changes that variable's name. Store the secret
outside configuration. Set it in the daemon environment for background
capture. Logout does not unset an override.

For managed configuration, list `@hypaware/linear` and
`@hypaware/context-graph` in `plugins[]`. The Linear plugin's `teams` array
accepts team keys or UUIDs. An empty array disables capture.

## Capture and graph

```sh
hyp linear backfill
hyp linear sync
hyp query sql "select event_type, identifier, repo, pr_number from linear_events"
```

Backfill starts a fresh import of the configured teams, including archived
issues and available PR attachments. Each invocation is bounded; `sync` or the
daemon resumes remaining work. The default daemon cadence is `24h`, with the
first capture within five minutes and unfinished work resumed within fifteen
minutes. `poll_interval` accepts durations from `5m` up to `596h`.

Issues and attachments have independent cursors. Linear's attachment listing
has no team filter: HypAware reads GitHub attachment metadata and parent issue
identities, then discards out-of-scope teams before storing anything. It never
fetches attachment content or follows arbitrary attachment URLs.

Capture automatically projects `linear_events`. Linear issues use immutable
workspace and issue UUIDs, with a readable label such as `HYP-7`. The edge is
`Issue -references-> PullRequest`; multiple PRs per issue and multiple issues
per PR work without title or branch-name inference. For GitHub commit/session
traversal, also enable the existing GitHub and session graph collectors.

The graph records observed historical links. Removing a PR attachment does
not retract its graph edge. Changing workflow state and assignment remain in
source snapshots, rather than being presented as current graph properties.
Polling is not a complete audit log, and repeating backfill may re-append
snapshots. Hosted team graphs and direct session-to-PR authorship are separate
features.
