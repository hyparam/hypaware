# OpenClaw

**Status:** Supported. **Setup id:** `openclaw`. **Backfill:** Yes.

HypAware records OpenClaw in two ways: live, by routing OpenClaw's Anthropic and
OpenAI model calls through HypAware's local gateway, and from a sweep of
OpenClaw's local session transcripts every five minutes, which covers every
provider.

## What is recorded

- Live: Anthropic Messages and OpenAI Chat Completions exchanges, with tokens.
- From transcripts: OpenClaw sessions for every provider, settled onto the same
  session identity as the live rows.

OpenAI Responses API traffic is forwarded through the gateway but not recorded
live; it is picked up by the transcript sweep.

## Set it up

`hyp setup` offers OpenClaw when it finds `~/.openclaw/openclaw.json`. To add it
later:

```sh
hyp attach openclaw --dry-run
hyp attach openclaw
hyp client status openclaw
```

Attach points the `anthropic` and `openai` entries under `models.providers` in
`~/.openclaw/openclaw.json` at the local gateway, keeps your other settings,
and installs HypAware's skills in `~/.openclaw/skills`. Restart the OpenClaw
gateway so it reads the new providers:

```sh
openclaw gateway restart
```

## Import existing history

```sh
hyp backfill openclaw --dry-run
hyp backfill openclaw
```
