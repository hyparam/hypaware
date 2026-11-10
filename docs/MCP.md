# Connect an MCP client

<!-- @ref LLP 0494#docs-mcp: hand-written setup page; every config block is checked by test/core/docs-mcp-configs.test.js -->
HypAware speaks the Model Context Protocol (MCP), so an AI client can query
your recorded AI work and your organization's recommendations as tools. The
server for HypAware Cloud is:

```text
https://api.hypaware.ai/v1/mcp
```

There are three ways to connect to it:

- **Sign in from a chat client:** add the server to Claude as a connector
  and sign in with your HypAware account. No token, no headers, and no
  `hyp` install. Most people start here.
- **Agent token:** the client sends a token you mint. Use it for cloud
  agents, CI jobs, and clients that cannot sign in themselves.
- **Local:** the client starts `hyp mcp serve` on a host that already runs
  `hyp`.

> **Tip:** On a host that already runs `hyp`, you do not need an agent
> token to reach your team's history: `hyp mcp serve --remote` uses the
> session you already have. See [Local setup](#local-setup-hyp-mcp-serve).

## Sign in from a chat client

### Claude

Add the connector in claude.ai or Claude Desktop. Once it is connected, it
also works in the Claude mobile apps.

1. Open **Customize**, then **Connectors**, then **+ Add**, then **Add
   custom connector**.
2. Name it `HypAware`, set the URL to `https://api.hypaware.ai/v1/mcp`, and
   click **Continue**.
3. Keep the detected settings and click **Continue**. Under
   **Authentication**, pick **Sign in now** or **Sign in when needed**.
   Leave **OAuth client** at its default and **Request headers** empty,
   then click **Add**.
4. Click **Connect**, sign in to HypAware, and click **Allow**.
5. In a chat, turn the connector on under **+**, then **Connectors**.

On a Team or Enterprise plan, an Owner first adds the connector for the
organization under **Organization settings**, then **Connectors**, then
**Add**, then **Custom**, then **Web**. Each member then clicks **Connect**
and signs in. The Claude Free plan allows one custom connector.

The menu paths follow Claude's own guide,
[Getting started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp).

### What the connection can do

The connection acts as you, in your organization. If you belong to more
than one, you pick it on the Allow page. The Allow page says what the
connection can do, with your organization's name in place of Example Co:

> Claude will be able to read Example Co's recorded AI sessions, including
> other members' sessions, and its reports, and to mark recommendations as
> applied or dismissed. It can't publish or delete reports, change
> settings, or manage the organization.

### How long it lasts and how to disconnect

The connection lasts 30 days, unless your server sets another lifetime.
The Allow page shows the number. After that, Claude asks you to sign in
again.

Removing the HypAware connector in Claude's settings stops Claude using
it. To end the connection on the server sooner, revoke it with
`hyp remote tokens` (see [List and revoke tokens](#list-and-revoke-tokens)),
or ask an admin of your organization to disconnect it.

## Remote setup: `/v1/mcp` with an agent token

Use an agent token for cloud agents, CI jobs, and clients that cannot sign
in through a connector. The endpoint is the same,
`https://api.hypaware.ai/v1/mcp`. The client sends the token in the
`Authorization` header as `Bearer <token>`.

### Mint an agent token

Sign in with `hyp remote login`, then mint a token. `--label` names the
agent or job that will hold it:

```sh
hyp remote mint --scope query --label devin-prod
```

The command prints the token, and nothing else, on stdout. Put it straight
into the secret store of the agent or CI job that needs it: HypAware keeps no
copy, and the token is not shown again.

The token lasts for the server's default lifetime, 21 days unless the server
sets another. Ask for a different lifetime with `--expires-days <n>`, up to
the server's limit (90 days by default). You can hold up to ten live agent
tokens at a time.

### What the token can do

The token acts **as you**, the person who minted it, until it expires or is
revoked. It can:

- read your organization's recorded history (every read tool on `/v1/mcp`,
  and `/v1/query`);
- mark a recommendation's status;
- publish reports and standalone recommendations;
- delete any report in your organization.

It cannot change configuration, record or upload sessions, generate or
promote a report, manage the organization, or mint more tokens.

These are the token's two permissions, named as HypAware names them on the
Auth tokens page:

- `read`, **Query organization**: the reads on `/v1/mcp` and `/v1/query`.
  `/v1/mcp` refuses a token without it.
- `report-publish`, **Publish and manage reports**: publishing reports and
  standalone recommendations, changing a recommendation's status, and
  deleting any report in your organization. Marking through
  `set_recommendation_status` needs `read` as well.

### Personal or service token

The token `hyp remote mint --scope query` prints is a **personal** token. It
belongs to you, acts as you, and stops working when it expires (see its
lifetime above) or when you revoke it. Use it for a script or agent you
run yourself.

For an integration that should keep working whatever happens to one person's
account, an organization admin creates a **service token** on the Service
accounts page in HypAware instead. It belongs to a service account, not a
person, and lasts until it is revoked. It can hold `read` and
`report-publish` as above, and **Submit telemetry**, which a host needs to
record and upload sessions.

A service token's secret is never pasted into a client's `Authorization`
header. Store it with `hyp remote login <server> --token-file <path>`: `hyp`
exchanges it for a one-hour access token as needed, so `hyp query --remote`
and `hyp mcp serve --remote` work with it when it holds `read`. A host enrolls
with it through `hyp join`. See
[Collect as an organization service account](integrations/ci-and-headless.md#collect-as-an-organization-service-account).

> **Caution:** Anyone who holds the token can read your organization's
> history and publish or delete reports as you. Keep it in a secret store,
> never in a file you commit.

### List and revoke tokens

```sh
hyp remote tokens
hyp remote tokens revoke <jti>
```

`hyp remote tokens` lists the `jti`, label, creation time, expiry, and revoked
state of each of your agent tokens. It never shows a token value.

It also lists your MCP connections, the ones Claude or another client made
when you signed in through its connector: the connection ID, the client, the
org, creation time, and expiry. Revoke one with the same command:

```sh
hyp remote tokens revoke <connection id>
```

Both need a `hyp remote login` session. If you connected only through
Claude, sign in first, or remove HypAware from Claude's connectors.

## Client setup

Each client below has a local block (see
[Local setup](#local-setup-hyp-mcp-serve)) and, where the client supports a
bearer header, a remote block. Remote blocks read the token from the
`HYPAWARE_AGENT_TOKEN` environment variable unless the client stores secrets
itself.

### Claude Code

Add to `.mcp.json` at the root of your project.

Local:

<!-- mcp-config: claude-code stdio -->
```json
{
  "mcpServers": {
    "hypaware": {
      "type": "stdio",
      "command": "hyp",
      "args": ["mcp", "serve"]
    }
  }
}
```

Remote:

<!-- mcp-config: claude-code remote -->
```json
{
  "mcpServers": {
    "hypaware": {
      "type": "http",
      "url": "https://api.hypaware.ai/v1/mcp",
      "headers": {
        "Authorization": "Bearer ${HYPAWARE_AGENT_TOKEN}"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project, or to `~/.cursor/mcp.json` for
every project.

Local:

<!-- mcp-config: cursor stdio -->
```json
{
  "mcpServers": {
    "hypaware": {
      "type": "stdio",
      "command": "hyp",
      "args": ["mcp", "serve"]
    }
  }
}
```

Remote:

<!-- mcp-config: cursor remote -->
```json
{
  "mcpServers": {
    "hypaware": {
      "url": "https://api.hypaware.ai/v1/mcp",
      "headers": {
        "Authorization": "Bearer ${env:HYPAWARE_AGENT_TOKEN}"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` in your workspace.

Local:

<!-- mcp-config: vscode stdio -->
```json
{
  "servers": {
    "hypaware": {
      "type": "stdio",
      "command": "hyp",
      "args": ["mcp", "serve"]
    }
  }
}
```

Remote. VS Code asks for the token the first time it starts the server and
stores it for you:

<!-- mcp-config: vscode remote -->
```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "hypaware-token",
      "description": "HypAware agent token",
      "password": true
    }
  ],
  "servers": {
    "hypaware": {
      "type": "http",
      "url": "https://api.hypaware.ai/v1/mcp",
      "headers": {
        "Authorization": "Bearer ${input:hypaware-token}"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings, Developer, Edit Config), then
restart Claude Desktop. Its config file runs local servers only. To reach your
team's server, add `"--remote"` to `args`, or skip the file and
[sign in from a chat client](#sign-in-from-a-chat-client).

<!-- mcp-config: claude-desktop stdio -->
```json
{
  "mcpServers": {
    "hypaware": {
      "command": "hyp",
      "args": ["mcp", "serve"]
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`, or to `.codex/config.toml` in a trusted
project.

Local:

<!-- mcp-config: codex stdio -->
```toml
[mcp_servers.hypaware]
command = "hyp"
args = ["mcp", "serve"]
```

Remote:

<!-- mcp-config: codex remote -->
```toml
[mcp_servers.hypaware]
url = "https://api.hypaware.ai/v1/mcp"
bearer_token_env_var = "HYPAWARE_AGENT_TOKEN"
```

### Devin

An organization admin adds the server in Devin under Customize, MCPs, Add
MCP, Add custom MCP:

- **Server Name:** HypAware
- **Transport:** HTTP
- **Server URL:** `https://api.hypaware.ai/v1/mcp`
- **Authentication method:** Auth Header, with key `Authorization` and value
  `Bearer ` followed by the agent token

Devin keeps the token with the server's settings. The same settings, in the
JSON form Devin documents:

<!-- mcp-config: devin remote -->
```json
{
  "transport": "HTTP",
  "url": "https://api.hypaware.ai/v1/mcp",
  "auth_method": "auth_header",
  "headers": {
    "Authorization": "Bearer <agent token>"
  }
}
```

Click **Test tools** to check the connection.

## Check the connection

Ask the agent to list its HypAware tools. Over `/v1/mcp` it sees read tools
such as `query_sql`, `list_recommendations` and `get_recommendation`. With a
token that can mark, it also sees `set_recommendation_status`. Locally it sees
the tools of this host's `hyp`. The client's tool list is the
exact set.

If the connection fails:

- **Local:** run the same command in a terminal, for example
  `hyp mcp serve`. It should print a line naming the tools it serves and
  then wait; press Ctrl-C to stop it. With `--remote`, sign in first with
  `hyp remote login`.
- **Sign-in:** after 30 days, or after the connection is revoked, click
  **Connect** in Claude and sign in again.
- **Remote:** a `401` means the token has expired or was revoked; mint a new
  one. Check that the header reads `Bearer ` followed by the token.

## Local setup: `hyp mcp serve`

Use this on a host that already runs `hyp`. Configure your client to run
`hyp` with the arguments `mcp` and `serve`. The client starts it and talks to
it over stdio. `hyp mcp serve` speaks the protocol on stdout; it is not an
interactive command.

- `hyp mcp serve` answers from this host's recordings.
- `hyp mcp serve --remote` answers from your team's server instead, as you.
  Sign in once first with `hyp remote login`.

The client must be able to find `hyp`. Desktop apps often do not read your
shell's `PATH`, so if the client reports that it cannot start the server,
replace `hyp` with the full path that `command -v hyp` prints.
