# HypAware plugin

Connect Claude Code, Cursor, or any agent that reads skills to the hosted
HypAware MCP server. Your agent can then query your team's AI coding
history and act on HypAware recommendations.

The plugin holds two things:

- **The MCP connection** to `https://api.hypaware.ai/v1/mcp`, sent with your
  agent token in the `Authorization` header.
- **Two skills:** `hypaware-query` (how to query the history and act on
  recommendations) and `hypaware-reference` (what HypAware is and how data
  flows). They are copies of the skills in the HypAware release this plugin
  is pinned to.

The plugin only reads and acts. It has no hooks, commands, agents, or
binaries; it records nothing and runs nothing on your machine. Recording
is the job of the `hyp` CLI and `hyp attach`.

## Get a token

The plugin reads your token from the `HYPAWARE_AGENT_TOKEN` environment
variable. If you have never minted one:

1. Install the CLI: `npm install -g hypaware`.
2. Sign in for queries only: `hyp remote login --no-forward`. This opens a
   browser sign-in and does not turn on any recording.
3. Mint a token: `hyp remote mint --scope query --label <where-it-runs>`.
   It lasts the server's default, 21 days today. Ask for longer with
   `--expires-days <n>`, up to the server's limit (90 days by default).
4. Put it in the environment your client starts in, such as
   `export HYPAWARE_AGENT_TOKEN=<token>` in your shell profile, or in the
   client's own secret store. Never put it in a file you commit.
5. When you stop using it, revoke it: `hyp remote tokens` lists your tokens
   and `hyp remote tokens revoke <jti>` revokes one.

**What the token can do.** It acts as you, the person who minted it, until
it expires or you revoke it. It can read your organization's recorded
history, mark a recommendation's status, publish reports, and delete
reports. It cannot change configuration, record or upload sessions, manage
the organization, or mint more tokens. Anyone holding it can do the same,
so keep it secret.

## Install

### Claude Code

In Claude Code:

```text
/plugin marketplace add hyparam/hypaware-plugin
/plugin install hypaware@hypaware
```

Or from a shell:

```sh
claude plugin marketplace add hyparam/hypaware-plugin
claude plugin install hypaware@hypaware
```

Start Claude Code from a shell where `HYPAWARE_AGENT_TOKEN` is set. If
`claude mcp list` shows the `hypaware` server as "Failed to connect" with
HTTP 401, the token is unset or no longer valid.

### Cursor, for a team

A team admin opens the Cursor dashboard, then Plugins & MCPs, Add
Marketplace, Import from Repo, and enters `hyparam/hypaware-plugin`. The
admin then sets `HYPAWARE_AGENT_TOKEN` under Plugins, Configure. Cursor
lets only team admins set plugin variables.

### Cursor, for one person

Cursor has no plugin install for one person, so set it up in two steps:

1. Add the remote `hypaware` block from the
   [Cursor section of the MCP guide](https://github.com/hyparam/hypaware/blob/master/docs/MCP.md#cursor)
   to `~/.cursor/mcp.json` (or a project's `.cursor/mcp.json`). It reads
   the token as `${env:HYPAWARE_AGENT_TOKEN}`, so export the token before
   you start Cursor.
2. Add the skills: `npx skills add hyparam/hypaware-plugin -a cursor`.

### Other agents

For any agent the `skills` CLI knows (Pi, Codex, OpenCode and others):

```sh
npx skills add hyparam/hypaware-plugin
```

This installs the two skills only. Connect the MCP server by following
[the MCP guide](https://github.com/hyparam/hypaware/blob/master/docs/MCP.md)
for your client.

## If you already run `hyp attach`

`hyp attach` installs the same skills. With it, you need the plugin only for
the MCP connection. In Claude Code both copies load side by side (the
plugin's are named `hypaware:hypaware-query` and so on), so nothing is
overwritten.

## Self-hosted servers

This plugin connects to the hosted server only. For a self-hosted HypAware
server, configure your client by hand from
[the MCP guide](https://github.com/hyparam/hypaware/blob/master/docs/MCP.md),
using your server's base URL followed by `/v1/mcp`.

## The MCP Registry entry

`registry/server.json` lists two ways to run the server:

- **The remote** is the hosted server. Pick it if you have an agent token.
- **The npm package** runs `hyp mcp serve` against your own local HypAware
  data. Pick it if you run the HypAware collector on your machine; without
  the collector it has nothing to show.

## Updating the skills

Never edit a file under `skills/` by hand. Change the skill in
[hypaware](https://github.com/hyparam/hypaware), release it, then run
`node scripts/sync-skills.js <version>` here and commit the result. CI fails
if `skills/` differs from that release or any version field disagrees with
it.

## License

MIT. See [LICENSE](LICENSE).
