# LLP 0499: HypAware MCP, Phase 2 distribution design

**Type:** Design
**Status:** Draft
**Systems:** MCP, Plugins, Docs
**Author:** HypForge designer
**Date:** 2026-10-15
**Source:** [HYP-128 "HypAware MCP: close the agent access gap"](https://linear.app/hyperparam/issue/HYP-128/hypaware-mcp-close-the-agent-access-gap), Phase 2 ("the registry entry and publishing where agents look", LLP 0494#seams); Hernan's Phase 2 answers of 2026-10-15T22:09:16Z
**Extends:** [LLP 0494#seams](./0494-hypaware-mcp-phase-1.design.md#seams) (the Phase 2 seam)
**Implemented-by:** [LLP 0500](./0500-hypaware-mcp-phase-2.plan.md) (the plan)
**Related:** LLP 0034#pluggable-transport, #scoped-credential,
#tool-auth-class, LLP 0107#every-attach, LLP 0491#guidance, LLP 0197,
LLP 0494#cli-mint, #skills, #docs-mcp, #docs-order; hypaware-server LLP
0597 (the agent token, out of tree)

> Draft 2026-10-15. Decision owner: Hernan Alvarez, through the mayor.
> His answers (22:09:16Z, "1. Kenny | 2. Kenny | 3. me | 4. Wait for phase
> three") set who does what: Kenny creates the public repo and adds the
> DNS TXT record, Hernan runs the registry publish and sends the GitHub
> email, and the Anthropic directory submission (HYP-143) waits for Phase
> 3. HypForge stages the repo contents and never holds the registry
> signing key. No seat contacts a human directly. Revision 2 folds guardian
> round 1 (B1 to B4, C1 to C6, A1 to A6): the release gates before the
> move, Hernan's exact commands, the working push, one Kenny ask after
> Hernan's key, and the Cursor route.
> Revision 3 folds guardian round 2's three advisories (R2-A1 to R2-A3).
> Revision 4 folds the plan actionability check (P1: the staging push
> scope matches LLP 0500#t2; P2: the moved repo's `validate.yml` run is a
> verification row; the GitHub draft's no-mark variant).

## Summary {#summary}

Phase 1 made the MCP useful to an agent that already has `hyp`. Phase 2
puts it where agents and their people look for it: one public plugin repo
that Claude Code, Cursor and `npx skills add` all install from, and one
entry in the MCP Registry, which GitHub's MCP Registry draws on.

| Piece | Change, in one line | Where |
| --- | --- | --- |
| Plugin repo | one repo, three host manifests, the hosted endpoint with a bearer header from `HYPAWARE_AGENT_TOKEN`, two skills; read and act only, no hooks | `hyparam/hypaware-plugin` (new, Kenny), staged first (#staging) |
| Skills | a byte-identical copy of `hypaware-query` and `hypaware-reference` from a pinned hypaware release | the plugin repo's `skills/` |
| Registry entry | `ai.hypaware/hypaware`: the hosted remote plus the `hypaware` npm package | the plugin repo's `registry/server.json` |
| mcpName | `"mcpName": "ai.hypaware/hypaware"` in hypaware's `package.json` | this repo, one small PR |
| DNS proof | one TXT record on `hypaware.ai`, from a key Hernan generates and keeps | Kenny's DNS, Hernan's machine |
| CI | validate every manifest, the skills, the copy and the registry entry offline | the plugin repo's `.github/workflows/validate.yml` |

Nothing in this repo's runtime changes. The only change here is the
`mcpName` line (#mcpname).

## The plugin repo {#layout}

One repo serves all three hosts from one tree. Each host reads its own
manifest and ignores the others'; all three read `skills/`.

```
.claude-plugin/
  plugin.json          Claude Code plugin manifest
  marketplace.json     Claude Code marketplace, one entry, source "./"
.mcp.json              Claude Code MCP server (remote, bearer header)
.cursor-plugin/
  plugin.json          Cursor plugin manifest, declares the token variable
  marketplace.json     Cursor marketplace, for Import from Repo
mcp.json               Cursor MCP server (remote, bearer header)
skills/
  hypaware-query/      copied from the pinned hypaware release (#skills-sync)
  hypaware-reference/  copied from the pinned hypaware release
registry/
  server.json          MCP Registry entry (#registry)
scripts/
  sync-skills.js       copy skills from the pinned npm tarball
  check.js             the repo's own checks (#ci)
.github/workflows/
  validate.yml         CI (#ci)
README.md              install per host, the token, what the plugin does not do
LICENSE                MIT, as hypaware
.gitignore             `*.pem`, so a registry key can never be committed
```

**Read and act only.** The plugin has no `hooks/`, no `bin/`, no
`commands/` and no `agents/`. It connects a client to the hosted MCP and
ships guidance; it captures nothing and runs nothing on the user's
machine. Capture stays with `hyp` and its attach (LLP 0107#every-attach).

**Names.** The plugin `name` is `hypaware` in both host manifests, and so
is the Claude Code marketplace `name`, so the install is
`/plugin install hypaware@hypaware`. Neither name hits a reserved prefix
or reserved marketplace name.

**`.claude-plugin/plugin.json`:**

```json
{
  "name": "hypaware",
  "version": "<pin>",
  "description": "Query your team's AI coding history and act on HypAware recommendations from Claude Code.",
  "author": { "name": "Hyperparam", "url": "https://hypaware.ai" },
  "homepage": "https://hypaware.ai",
  "repository": "https://github.com/hyparam/hypaware-plugin",
  "license": "MIT"
}
```

`skills/` and `.mcp.json` sit at their default paths, so the manifest names
neither. `<pin>` is the hypaware release the skills come from
(#skills-sync); every version field in the repo carries it.

**`.claude-plugin/marketplace.json`:**

```json
{
  "name": "hypaware",
  "owner": { "name": "Hyperparam" },
  "metadata": { "description": "The HypAware MCP and its skills." },
  "plugins": [
    { "name": "hypaware", "source": "./", "description": "The HypAware MCP and its skills." }
  ]
}
```

`metadata.description` is required in practice: without it `claude plugin
validate . --strict` warns "No marketplace description provided" and
exits 1 (Claude Code 2.1.283, guardian round 1). `owner` carries `name`
only, the one field both hosts' marketplace schemas share.

**`.mcp.json`** (Claude Code):

```json
{
  "mcpServers": {
    "hypaware": {
      "type": "http",
      "url": "https://api.hypaware.ai/v1/mcp",
      "headers": { "Authorization": "Bearer ${HYPAWARE_AGENT_TOKEN}" }
    }
  }
}
```

**`.cursor-plugin/plugin.json`:**

```json
{
  "name": "hypaware",
  "version": "<pin>",
  "description": "Query your team's AI coding history and act on HypAware recommendations from Cursor.",
  "author": { "name": "Hyperparam" },
  "homepage": "https://hypaware.ai",
  "repository": "https://github.com/hyparam/hypaware-plugin",
  "license": "MIT",
  "variables": {
    "type": "object",
    "properties": {
      "HYPAWARE_AGENT_TOKEN": {
        "type": "string",
        "description": "Agent token from `hyp remote mint --scope query`."
      }
    },
    "required": ["HYPAWARE_AGENT_TOKEN"]
  }
}
```

**`mcp.json`** (Cursor; no leading dot, no `type`, which Cursor infers from
`url`):

```json
{
  "mcpServers": {
    "hypaware": {
      "url": "https://api.hypaware.ai/v1/mcp",
      "headers": { "Authorization": "Bearer ${HYPAWARE_AGENT_TOKEN}" }
    }
  }
}
```

**`.cursor-plugin/marketplace.json`** is the same file: `name`, `owner`
with `name` only (Cursor's `owner` allows `name` and `email`, so no
`url`), `metadata.description`, and the one plugin at `./`.

**Install, per host** (the README states these):

- Claude Code: `/plugin marketplace add hyparam/hypaware-plugin`, then
  `/plugin install hypaware@hypaware`; or `claude plugin marketplace add
  hyparam/hypaware-plugin` and `claude plugin install hypaware@hypaware`
  from a shell.
- Cursor, on a team: a team admin opens the Cursor dashboard, Plugins &
  MCPs, Add Marketplace, Import from Repo, `hyparam/hypaware-plugin`, then
  sets `HYPAWARE_AGENT_TOKEN` under Plugins, Configure. This is the route
  Cursor documents; it is a team feature (admin-only on Enterprise), and
  Cursor documents plugin variables as set by team admins only.
- Cursor, as an individual: Cursor documents no plugin install for one
  person, so the README gives two plain steps instead. First, add the
  `hypaware` block from `docs/MCP.md` to `~/.cursor/mcp.json` (or a
  project's `.cursor/mcp.json`), with `${env:HYPAWARE_AGENT_TOKEN}` in the
  header, and export the token. Second, run `npx skills add
  hyparam/hypaware-plugin -a cursor` for the skills.
- Cursor's public marketplace (cursor.com/marketplace/publish) is a
  submission, not authorized in this phase (#out-of-scope).
- Any agent the `skills` CLI knows (Pi, Codex, OpenCode, Cursor and
  others): `npx skills add hyparam/hypaware-plugin`. This installs the two
  skills only; the `skills` CLI installs no MCP server, so the README
  sends these users to `docs/MCP.md` (LLP 0494#docs-mcp) for the
  connection.

**No root `plugin.json`.** The task row named one, for the open
agent-plugins layout. That layout allows no secret in a header, and a
bearer header is the whole of Phase 2's auth, so a root manifest would
either carry a broken server or none. Each host reads its own directory
instead (#rejected).

## The token {#token}

The environment variable is **`HYPAWARE_AGENT_TOKEN`**. It holds an agent
token a member mints with `hyp remote mint --scope query [--label <name>]`
(LLP 0494#cli-mint). That token reads the org's history, marks
recommendations, and publishes and deletes reports, as the member who
minted it; `hyp remote tokens` lists and revokes it. The README says all
of this in plain words next to the install line, as `docs/MCP.md` does.

**A person who has never minted one** follows these steps, which the
README gives in this order:

1. Install the CLI: `npm install -g hypaware`.
2. Sign in for queries only: `hyp remote login --no-forward` (browser
   sign-in; `--no-forward` enrolls no capture).
3. Mint: `hyp remote mint --scope query --label <where-it-runs>`. The
   token lasts the server's default, 21 days today; `--expires-days <n>`
   asks for longer, up to the server's ceiling (90 days by default),
   as LLP 0494#cli-mint says.
4. Put it in the environment the client starts in: `export
   HYPAWARE_AGENT_TOKEN=<token>` in a shell profile or the client's own
   secret store, never in a committed file.
5. Revoke it with `hyp remote tokens` when the integration goes away.

- **Claude Code** expands `${HYPAWARE_AGENT_TOKEN}` from the environment
  Claude Code starts in (guardian round 1 saw `Bearer test-token-123`
  arrive at a local listener). An unset variable is not warned about: the
  header goes out literally and `claude mcp list` prints "Failed to
  connect" with HTTP 401. The README says a 401 there means the token is
  unset or invalid.
- **Cursor on a team** reads `${HYPAWARE_AGENT_TOKEN}` as a plugin
  variable, declared in `variables` and set by a team admin under Plugins,
  Configure (#layout).
- **Cursor for an individual** reads `${env:HYPAWARE_AGENT_TOKEN}` from
  `.cursor/mcp.json`, the documented form for a plain MCP config
  (#layout).
- **The name is ours.** Claude Code reads some credential-shaped names
  (`ANTHROPIC_*`, `NPM_TOKEN` and the like) as empty in plugin config, so
  the variable carries the product name and nothing generic.
- **A self-hosted server** is configured by hand from `docs/MCP.md`. The
  plugin's URL is the hosted one only (#endpoint).

Minting needs the CLI, as in Phase 1. A person with no CLI waits for
Phase 3's OAuth (#out-of-scope).

## The endpoint {#endpoint}

Every manifest names `https://api.hypaware.ai/v1/mcp`, the hosted server's
streamable HTTP endpoint (LLP 0034#pluggable-transport), with
`Authorization: Bearer <agent token>`. `api.hypaware.ai` is the canonical
host of the built-in `hyperparam` remote; the `hypaware.hyperparam.app`
alias is not used in any manifest, because the registry lets each URL
belong to one server name only and one URL keeps that simple.

What the endpoint serves is Phase 1's: the read tools, the mark
(`set_recommendation_status`, the `write` class, LLP 0034#tool-auth-class),
instructions on `initialize`, the three prompts, and annotations. Phase 2
adds no tool and no server change. Today production does not serve the
mark yet (server T6), so nothing in this design moves, publishes or
announces the plugin before it does (#staging, gate 2).

## Which skills ship {#skills}

The plugin ships **`hypaware-query`** and **`hypaware-reference`**.

- `hypaware-query` is the read and act guidance. It names the MCP tools
  (`query_sql`, `grep_search`, `graph_neighbors`) beside the CLI, and its
  `reports.md` carries the mark (`set_recommendation_status`). This is the
  skill a remote-only user needs.
- `hypaware-reference` is orientation: what HypAware is and how data
  flows. It costs a short description in context and answers the first
  question a new user asks.
- `hypaware-report` is left out. It generates a report with local `hyp`,
  which a plugin user may not have, and generation is not read or act.
- `hypaware-privacy` is left out. It controls local capture, and the
  plugin captures nothing.

**Links stay whole.** Neither shipped skill links a file outside its own
directory: `hypaware-query` and `hypaware-reference` name the other two
skills in text only (query's "Use **hypaware-report** only to generate a
full report", reference's skill list), and no `../` link leaves either
tree. `hypaware-report` is the one skill with an outward file link
(`../hypaware-query/reports.md`), and it does not ship. A text name for a
skill the user does not have is accurate: it is a HypAware skill, which
`hyp attach` installs. CI pins this (#ci).

**Overlap with `hyp attach`.** A user who also runs `hyp attach` (or
`npx skills add`) gets the same skills twice. In Claude Code the plugin's
copies are namespaced (`hypaware:hypaware-query`), so nothing is
overwritten; both load. The README says that a user with `hyp` attached
already has the skills and needs the plugin only for the MCP connection.
The plugin cannot detect the attach, and two copies of the same text at
nearby versions cost context, not correctness.

## Skill sync {#skills-sync}

The plugin's `skills/<name>/` is a **byte-identical copy of
`hypaware-core/skills/<name>/` from a pinned hypaware release**, taken
from that release's npm tarball (the `files` list ships
`hypaware-core/`). The neutral tree stays the one source (LLP
0494#skills, LLP 0491#guidance); the plugin repo never edits a skill.

- **Why a release, not master.** A skill copied from master can name a
  tool production does not serve yet. Phase 1's copy rules hold the docs
  to what is merged and deployed (LLP 0494#docs-order); a release is the
  same gate for the skills, and the npm tarball is the release's own
  record of them. The first usable pin is later than `v1.42.0`: the
  skills moved to `hypaware-core/skills/` after it (#2592), so
  `sync-skills.js` against `v1.42.0` finds nothing (#staging, gate 1).
- **One pin.** The pin is the hypaware version. It is
  `registry/server.json`'s `packages[0].version` and `version`, and both
  plugin manifests' `version`. A Claude Code user receives an update only
  when the plugin version changes, so tying it to the pin delivers every
  skill change and nothing else.
- **`scripts/sync-skills.js <version>`** runs `npm pack hypaware@<version>`
  into a temp directory, extracts `package/hypaware-core/skills/<name>/`
  for the two names, replaces `skills/<name>/` with them, and writes
  `<version>` into the four version fields. It uses Node's standard
  library and `tar` only. It is run by hand, by whoever bumps the pin.
- **The drift check** (CI) runs the same extraction for the pinned
  version and fails on any byte difference, any missing or extra file, or
  a version field that disagrees with the pin.
- **When to bump.** On each hypaware release that changes either skill,
  after the server serves every tool the new text names. The bump is one
  commit in the plugin repo and, when `server.json` changes, one registry
  publish by Hernan (registry versions are unique per publish).

## The registry entry {#registry}

`registry/server.json`, against the registry schema of 2025-12-11:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "ai.hypaware/hypaware",
  "title": "HypAware",
  "description": "Query your team's AI coding history and act on HypAware recommendations from any MCP client.",
  "version": "<pin>",
  "websiteUrl": "https://hypaware.ai",
  "repository": {
    "url": "https://github.com/hyparam/hypaware-plugin",
    "source": "github"
  },
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://api.hypaware.ai/v1/mcp",
      "headers": [
        {
          "name": "Authorization",
          "description": "Bearer <agent token>. Mint one with `hyp remote mint --scope query`.",
          "isRequired": true,
          "isSecret": true
        }
      ]
    }
  ],
  "packages": [
    {
      "registryType": "npm",
      "identifier": "hypaware",
      "version": "<pin>",
      "runtimeHint": "npx",
      "transport": { "type": "stdio" },
      "packageArguments": [
        { "type": "positional", "value": "mcp" },
        { "type": "positional", "value": "serve" }
      ]
    }
  ]
}
```

- The description is 92 characters; the cap is 100. The title is 8.
- **The remote** is the hosted server, for people with an agent token.
- **The package** is `hyp mcp serve` over stdio, the same server against
  the user's own local cache (LLP 0034#stdio-stdout-discipline). It is
  useful to a user who runs the collector, and empty for one who does not;
  the README and `docs/MCP.md` say which entry to pick. A registry client
  runs it as `npx hypaware@<pin> mcp serve`, so it lags a newer installed
  `hyp` by at most one pin bump.
- **`version`** is the pin (#skills-sync), exact, and unique per publish.
- **Ownership of the npm package** is proven by `mcpName` in the
  published `package.json` (#mcpname); the registry checks it against
  `packages[0].version` on npm at publish time.

## `mcpName` in hypaware {#mcpname}

One small PR on this repo adds a top-level line to `package.json`:

```json
"mcpName": "ai.hypaware/hypaware",
```

and one test that reads `package.json` and asserts the value, so a later
edit cannot drop it unnoticed (the registry would refuse the next publish,
long after the edit). This is the only change to this repo. It must ship
in an npm release before Hernan's first publish, and that release is the
first pin.

## What CI validates {#ci}

`.github/workflows/validate.yml` runs on every push and pull request to
the plugin repo. No step publishes, and no step depends on the registry
being up (`mcp-publisher validate` is not used: its source, read for
this design, sends the file to the registry's `/v0/validate` route).

1. **Claude Code**, with `npx @anthropic-ai/claude-code@<pinned>` as
   `claude`. It needs no login (guardian round 1 ran it with an empty
   `HOME` and no credential), so it stays in CI:

   ```sh
   claude plugin validate . --strict
   claude plugin validate .claude-plugin/plugin.json --strict
   claude plugin marketplace add "$PWD"
   claude plugin install hypaware@hypaware
   ```

   The first command checks the marketplace and, through `plugins[0]`,
   `plugin.json`. It does not check `.mcp.json`; the second command does.
   Exit 0 passes, and a warning fails under `--strict`. The last two
   install the plugin from the checkout into a throwaway `HOME`, the
   hermetic half of "installs in Claude Code". A GitHub runner's home is
   per job; a local run sets `HOME="$(mktemp -d)"` first, so the install
   never reaches a real Claude Code config (guardian round 2, R2-A2).
   Neither validator checks a skill's `name` against its directory; step 3
   does.
2. **Cursor.** `scripts/check.js` applies the cursor/plugin-template
   checklist rules that apply here: `name` is kebab-case and the same in
   both Cursor files, every `${VAR}` in `mcp.json` is declared in
   `.cursor-plugin/plugin.json`'s `variables`, and every URL is `https`.
3. **Skills.** `scripts/check.js` parses each `skills/*/SKILL.md`
   frontmatter: `name` matches its directory and is 1 to 64 characters of
   `[a-z0-9-]`, and `description` is 1 to 1024 characters (the same caps
   this repo enforces). Unknown keys are allowed, because `hypaware-query`
   and `hypaware-reference` carry `user-invocable: false`. Then `npx
   skills@<pinned> add . --list` must list exactly `hypaware-query` and
   `hypaware-reference`. No Markdown link under `skills/` may resolve
   outside its own skill directory.
4. **Drift.** The #skills-sync check: bytes against the pinned tarball,
   and the four version fields against the pin.
5. **Registry entry.** `server.json` validates against the pinned schema
   with a draft-07 validator (`npx ajv-cli@<pinned>`, fetching the schema
   by its `$schema` URL), and `scripts/check.js` adds the rules the schema
   does not state: description 100 characters or fewer, `version` and
   `packages[0].version` equal the pin, the remote URL equals the one in
   `.mcp.json` and `mcp.json`, and no `localhost`.
6. **Directory hygiene** (kept for Phase 3, #out-of-scope): `README.md`
   has at least 40 words, `LICENSE` exists, every URL is `https`, no file
   holds a string shaped like a token, no file holds `BEGIN PRIVATE KEY`,
   and `.gitignore` lists `*.pem`.

All tools run through `npx` at pinned versions; the repo has no
dependencies and no lockfile to keep.

## The DNS proof {#dns}

The registry namespace `ai.hypaware` is proven by one TXT record on the
apex of `hypaware.ai`. The proof grants `ai.hypaware/*` and
`ai.hypaware.*`.

**Hernan, once, on his own Mac.** The `openssl` on a Mac's `PATH` is
LibreSSL, which fails with "Algorithm Ed25519 not found", so every command
names Homebrew's OpenSSL 3 by path. The key lives outside any repo, so no
`git add` can reach it:

```sh
brew install openssl@3
OPENSSL="$(brew --prefix openssl@3)/bin/openssl"
mkdir -p ~/.config/hypaware-registry && cd ~/.config/hypaware-registry
"$OPENSSL" genpkey -algorithm Ed25519 -out key.pem && chmod 600 key.pem
echo "v=MCPv1; k=ed25519; p=$("$OPENSSL" pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
```

The last command prints the exact record value, one line of the form
`v=MCPv1; k=ed25519; p=<44 base64 characters>`, with Hernan's public key
as the last part. The line is public. Hernan keeps
`~/.config/hypaware-registry/key.pem` and sends the line to the mayor,
who puts it in the one Kenny ask (#staging). HypForge never generates,
sees or holds the key.

**Kenny, once, in the `hypaware.ai` DNS:**

| Field | Value |
| --- | --- |
| Type | `TXT` |
| Host | `@` (the apex, `hypaware.ai.`) |
| Value | the line from Hernan, exactly, starting `v=MCPv1;` (the ask carries it) |
| TTL | the provider's default |

An existing TXT record on the apex (SPF, site verification) stays; TXT
records coexist. `dig +short TXT hypaware.ai` shows the new line beside
them once it propagates.

**Hernan, to publish**, after Kenny's record shows in `dig` (#staging):

```sh
brew install mcp-publisher
OPENSSL="$(brew --prefix openssl@3)/bin/openssl"
KEY=~/.config/hypaware-registry/key.pem
PRIVATE_KEY=$("$OPENSSL" pkey -in "$KEY" -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')
mcp-publisher login dns --domain hypaware.ai --private-key "$PRIVATE_KEY"
cd "$(mktemp -d)" && git clone https://github.com/hyparam/hypaware-plugin.git
cd hypaware-plugin/registry && mcp-publisher publish
```

The clone is a fresh public checkout in a temp directory, apart from the
key's directory.

**Rotation.** A new key means a new record. A stale record left on the
apex is tried and fails verification, so Kenny replaces the old value
with the new one in one change (delete the old, add the new), and only
then does Hernan run `login dns`.

## GitHub's MCP Registry {#github}

After the publish lands, and only once all three gates in #staging hold
(so the mark the email names is served), Hernan emails
partnerships@github.com to ask that
`ai.hypaware/hypaware` be listed. Curation is manual and what GitHub wants
in the email is unconfirmed; a short draft:

> HypAware (ai.hypaware/hypaware) is now in the MCP Registry. It gives an
> agent read access to a team's AI coding history and lets it mark
> HypAware's recommendations applied. Remote: https://api.hypaware.ai/v1/mcp
> (bearer agent token); package: npm `hypaware`. Repo:
> https://github.com/hyparam/hypaware-plugin. We would like it listed in
> GitHub's MCP Registry.

If Hernan moves before server T6 is deployed (gate 2's fallback), the
mayor passes the no-mark variant instead, which drops only the clause on
marking:

> HypAware (ai.hypaware/hypaware) is now in the MCP Registry. It gives an
> agent read access to a team's AI coding history. Remote:
> https://api.hypaware.ai/v1/mcp (bearer agent token); package: npm
> `hypaware`. Repo: https://github.com/hyparam/hypaware-plugin. We would
> like it listed in GitHub's MCP Registry.

Either draft uses the repo name Kenny confirmed (#open-question). The
mayor passes the draft to Hernan; it is not committed anywhere.

## Staging {#staging}

Until Kenny creates the repo, the contents live on an **orphan branch,
`staging/hypaware-plugin`, in `hyparam/hypaware`**, whose tree is exactly
the future repo's root.

- **It moves as-is, by Kenny.** Kenny creates the repo empty and pushes
  the branch into it as `main`, with its history, from no clone:

  ```sh
  gh repo create hyparam/hypaware-plugin --public
  git clone --bare --single-branch --branch staging/hypaware-plugin git@github.com:hyparam/hypaware.git hp.git
  git -C hp.git push git@github.com:hyparam/hypaware-plugin.git staging/hypaware-plugin:refs/heads/main
  ```

  `gh repo create` with no template, README, license or `.gitignore`
  makes an empty repo, which the push needs. The full `refs/heads/main`
  is needed because `main` does not exist yet; a short `:main` is
  rejected, and a local branch name fails from a normal clone (guardian
  round 1 ran all three). Kenny owns the push because he creates the repo
  and already has access; HypForge pushing would need a write grant and
  its own authorization to publish to a new public repo.
- **HypForge deletes the staging branch** once `git ls-remote
  git@github.com:hyparam/hypaware-plugin.git main` shows the staging
  head: `git push origin --delete staging/hypaware-plugin`.
- **HypForge pushes one ref, under the build task's authorization.**
  Creating the staging branch (sequence step 2), fast-forward fix-ups to
  it before the move (a red `validate.yml` run, or a rename at step 3),
  and deleting it (step 4) are pushes to `hyparam/hypaware`. LLP 0500#t2
  carries the authorization and its exact scope: `staging/hypaware-plugin`
  only, fast-forward only, no force push, no tags, no other ref, and the
  delete only after the two equal heads are recorded (guardian round 2,
  R2-A3; plan actionability check, P1).
- **It is checked before it moves.** Its own `validate.yml` runs on push
  to the branch. hypaware's `ci.yml` does not: it triggers on pull
  requests, merge groups and pushes to `master` only, and the orphan tree
  does not contain it.
- **It touches nothing here.** No file on `master` changes, no skill PR
  gains a drift check against a second copy, and no release PR's head
  moves.
- **Gates.** Nothing moves, publishes or is announced until all three
  hold, because the README, the skills, the registry entry and the email
  name what they deliver:
  1. **The pin** is a hypaware npm release that carries T7 (`hyp remote
     mint --scope query`, `hyp remote tokens`), the skills at
     `hypaware-core/skills/`, and the #mcpname line. The client release
     that carries T7 (the plan's R1) is the natural carrier.
  2. **Production serves every tool the plugin's text names**, the mark
     (`set_recommendation_status`) included: server T6 is deployed. If it
     is not, the README and the email drop the mark. The skills need no
     change: `hypaware-query`'s `reports.md` names the mark only "when the
     connected MCP lists it" (guardian round 2, R2-A1).
  3. **`docs/MCP.md` is merged** past Hernan's docs gate (LLP
     0494#docs-order), since the README sends Cursor individuals,
     `npx skills add` users and self-hosted users to it.
- **Sequence:**
  1. Hernan generates the key and sends the TXT line to the mayor (#dns).
     This needs none of the gates and can happen first.
  2. Once the gates hold, HypForge builds the staging branch with
     `sync-skills.js <pin>`, and its `validate.yml` is green.
  3. The mayor sends Kenny one ask, in a new Kenny Phase 2 thread, with
     the exact values: confirm the repo name, run the three commands
     above, and add TXT record `hypaware.ai` (host `@`) = `v=MCPv1;
     k=ed25519; p=<Hernan's value>`. Kenny checks with `dig +short TXT
     hypaware.ai`.
  4. HypForge confirms the new `main` and deletes the staging branch.
  5. Hernan runs the publish block (#dns) and checks the registry
     (#verification).
  6. Hernan sends the GitHub email (#github).

## Verification map {#verification}

| Claim | Hermetic proof | Human or production proof |
| --- | --- | --- |
| The plugin installs in Claude Code and passes `claude plugin validate` | CI step 1 (both validates, then `marketplace add` and `install` from the checkout) | `validate.yml` green on the moved repo's `main` at the staging head, read with `gh run list` (a seat); `/plugin install hypaware@hypaware` from the public repo, then a `query_sql` call with a real agent token (human) |
| The plugin installs in Cursor | CI step 2 | a Cursor team admin, named through the mayor, runs Import from Repo, sets the variable under Configure, and calls `query_sql`; one individual follows the README's two steps and calls `query_sql` (human) |
| `npx skills add` installs the two skills | CI step 3 (`--list`) | one install into a real agent (human) |
| The skills match the pinned release | CI step 4 | none |
| The registry entry is well formed and resolves | CI step 5 | `mcp-publisher publish` succeeds; the entry appears at `https://registry.modelcontextprotocol.io/v0.1/servers?search=ai.hypaware/hypaware` (Hernan) |
| `mcpName` ships | the #mcpname test | `npm view hypaware@<pin> mcpName` prints `ai.hypaware/hypaware` |
| The DNS proof holds | none | `dig +short TXT hypaware.ai` shows the line; `login dns` succeeds (Hernan) |
| The GitHub request is sent | none | Hernan confirms the email went to partnerships@github.com, with the date |

## CPU and memory {#cpu-memory}

Nothing here runs in the daemon, the CLI or the hosted server. The
`mcpName` line is static package metadata. The plugin's scripts run in
CI or by hand, once per push or pin bump, over two skill trees and five
small JSON files. Clients connect to the existing endpoint with the
existing token. No hot path changes; no CPU or memory concern.

## Out of scope, and kept open {#out-of-scope}

- **HYP-143, the Anthropic directory.** Waits for Phase 3 (Hernan). No
  submission material is written now. The plugin stays valid for it:
  `claude plugin validate --strict` passes, the README and LICENSE meet
  its blocking checks, and every URL is `https`. Two things the directory
  prefers are Phase 3's: it reviews a `Bearer ${ENV_VAR}` header as "uses
  a credential from the user's machine" and prefers `userConfig` with
  `sensitive: true`, and it lists a remote MCP as a connector, which is
  OAuth's job.
- **Phase 3, OAuth.** Replaces the pasted token for people with no CLI.
  The plugin then gains the OAuth form beside the header form, or drops
  the header, and the directory submission follows. Nothing in this
  layout blocks either.
- **Claude chat and Cowork** ignore a plugin MCP server whose config needs
  a value they cannot supply; they get the skills only until Phase 3's
  connector.
- **Cursor's public marketplace.** A submission at
  cursor.com/marketplace/publish is a publish step; it needs its own
  authorization and a named human, and is not part of this phase.

## Open question {#open-question}

1. **The repo name.** `hyparam/hypaware-plugin` is the working name
   (Kenny, at creation). Every manifest, the README, `server.json`'s
   `repository.url` and the move command in #staging carry it; a
   different name is a find and replace on the staging branch before the
   move. The plugin's own `name` stays `hypaware` either way.

## Rejected {#rejected}

- **A root `plugin.json`** for the open agent-plugins layout (named in the
  task row). That layout allows no secret in a header, so it cannot carry
  the bearer header Phase 2 needs; it would ship a server that cannot
  connect. Revisit with OAuth.
- **`userConfig` with `sensitive: true`** for the token in Claude Code.
  It is what the directory prefers, but the directory waits for Phase 3,
  where OAuth replaces the token, and a `${user_config.*}` URL or header is
  ignored in claude.ai chat. One environment variable works the same in
  Claude Code, a shell and CI. Kept as a Phase 3 seam.
- **All four skills.** `hypaware-report` and `hypaware-privacy` drive
  local `hyp` and local capture, which a read and act plugin does not
  have (#skills).
- **Skills synced from `master`.** Could name a tool before production
  serves it (#skills-sync).
- **A `plugin/` folder on hypaware's `master`** as the staging place. Every
  skill PR would carry a second copy and its drift check, and the folder
  would need a master merge to exist and a removal after the move.
- **A HypForge-owned repo** as the staging place. A new repo outside
  `hyparam` is not HypForge's to create, and moving it would change its
  owner and history.
- **`mcp-publisher validate` in CI.** Per its source it sends the file to
  the registry; CI should not depend on the registry being up.
- **HypForge generating the DNS key.** The key proves the namespace for
  every future publish; it belongs with the person who publishes
  (orchestrator, 22:10Z).
- **The `hypaware.hyperparam.app` alias** in any manifest. One URL per
  server name in the registry, and one canonical host keeps the three
  manifests and the entry equal.

## Consequences {#consequences}

- LLP 0494 (Draft) gains an `Extended-by: LLP 0499` line for its Phase 2
  seam.
- The #mcpname PR is a separate, small task; it is the only change to
  this repo's tree outside `llp/`.
- The plugin repo becomes a second place a skill change has to reach. The
  pin and the drift check make that a deliberate step, not a silent
  divergence: a skill change on `master` reaches plugin users only when
  someone bumps the pin after the release.
