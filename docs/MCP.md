# Connect an MCP client

<!-- @ref LLP 0494#docs-mcp: hand-written setup page; every config block is checked by test/core/docs-mcp-configs.test.js -->
HypAware speaks the Model Context Protocol (MCP), so an AI client can query
your recorded AI work and your organization's recommendations as tools. There are two
ways to connect:

- **Local:** the client starts `hyp mcp serve` on your host. It needs
  `hyp` installed and uses your own sign-in. No token is involved.
- **Remote:** the client connects over HTTPS to your team's server at
  `/v1/mcp` and sends an agent token. Use it for cloud agents, CI jobs, and
  any client that has no `hyp` on its host.

> **Tip:** On your own host, use the local setup, even to reach your
> team's history: `hyp mcp serve --remote` uses the session you already
> have. You do not need an agent token.

## Local setup: `hyp mcp serve`

Configure your client to run `hyp` with the arguments `mcp` and `serve`. The
client starts it and talks to it over stdio. `hyp mcp serve` speaks the
protocol on stdout; it is not an interactive command.

- `hyp mcp serve` answers from this host's recordings.
- `hyp mcp serve --remote` answers from your team's server instead, as you.
  Sign in once first with `hyp remote login`.

The client must be able to find `hyp`. Desktop apps often do not read your
shell's `PATH`, so if the client reports that it cannot start the server,
replace `hyp` with the full path that `command -v hyp` prints.

## Remote setup: `/v1/mcp` with an agent token

The endpoint for HypAware Cloud is:

```text
https://api.hypaware.ai/v1/mcp
```

The client sends the token in the `Authorization` header as `Bearer <token>`.

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

Each client below has a local block and, where the client supports a bearer
header, a remote block. Remote blocks read the token from the
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
team's server, add `"--remote"` to `args`.

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
- **Remote:** a `401` means the token has expired or was revoked; mint a new
  one. Check that the header reads `Bearer ` followed by the token.
