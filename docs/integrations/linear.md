# Linear

**Plugin:** `@hypaware/linear`. Optional, local collection.

Collect structural issue metadata and explicit GitHub PR attachment links from
selected Linear teams. Issue descriptions, titles and comment bodies stay in
Linear. Graph projection connects an `Issue` to the same `PullRequest` node the
GitHub collector uses, so existing commit/session paths become traversable.
Rows land in the local cache and can be exported by your existing configured
sinks, like other captured datasets.

## Configure

Keep your existing configuration and add this entry to `plugins[]`. Ensure
`@hypaware/context-graph` is also listed once:

```json
{
  "name": "@hypaware/linear",
  "config": {
    "teams": ["HYP"]
  }
}
```

Use your own team keys or team UUIDs. Empty `teams` disables capture. Enabling
the plugin does not add a setup-wizard choice or log you in automatically.
Restart a running daemon after adding the plugin or changing its config.

## Browser login

Run `hyp linear login` to authorize the shared **HypAware Local** OAuth app in
your Linear workspace. No app registration or client ID configuration is
required. Login uses S256 PKCE and requests only the `read` scope; no client
secret is shipped. The app's registered callback is:

```text
http://127.0.0.1:19264/callback
```

```sh
hyp linear login
hyp linear status
```

The browser must run on the same machine as the CLI. `--no-browser` prints the
authorization URL without opening it, and still waits for the local callback.
The attempt expires after five minutes; Ctrl-C cancels it. If the default port
is unavailable, free that port or use a custom OAuth app with another registered
loopback callback.

To use your own [Linear OAuth application](https://linear.app/developers/oauth-2-0-authentication),
put its public client ID in `client_id`, or set `LINEAR_CLIENT_ID` when running
login. Explicit config takes precedence over the environment variable, followed
by the shared HypAware app. Set `redirect_uri` only when your custom app uses a
different callback, and register that exact URL in Linear.

Tokens are saved privately in the plugin's state directory, outside config,
with automatic refresh. A running daemon picks up login and logout on its next
request. `hyp linear logout` removes local OAuth credentials; revoke the grant
in Linear settings to remove provider access as well.

For headless collection, `LINEAR_API_KEY` can supply a personal API key. Its
value overrides saved OAuth. The `token_env` config field changes that variable's
name. Store the secret outside configuration; logout does not unset an override.

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
