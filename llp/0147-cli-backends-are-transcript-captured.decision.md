# LLP 0147: OpenClaw CLI backends are transcript-captured, never proxied

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Gateway
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0026 (Claude native granularity), LLP 0027 (cache settlement), LLP 0109 (OpenClaw client adapter), LLP 0141 (Codex Desktop rides the Codex adapter), LLP 0152 (plugin-steered shadow providers)

> OpenClaw can delegate a turn to the `claude` or `codex` binary as a child
> process. Those turns never touch OpenClaw's provider layer, so no amount
> of shadow steering or in-process hooking sees them. They are captured by
> the existing transcript adapters or not at all. Name the seam so nobody
> later reads LLP 0152 as total coverage.

## Context

OpenClaw's `claude-cli` backend spawns the real Claude Code binary:
`claude -p --output-format stream-json --session-id <uuid>
--append-system-prompt …`, with `cwd` set to the agent's workspace directory
and the environment inherited from the OpenClaw gateway
(`openclaw` repo, `src/agents/cli-runner/execute.ts`,
`extensions/anthropic/cli-backend.ts`). A Codex backend works the same way.

Consequences that matter here, all verified against OpenClaw source:

- Routing is by the provider prefix on the resolved model ref: a turn goes
  to the CLI if and only if its model is `claude-cli/*`. So a single
  OpenClaw agent can mix proxied turns and CLI turns depending on its model
  config.
- OpenClaw never sets `CLAUDE_CONFIG_DIR`, so the child writes its own
  transcript to `~/.claude/projects/<slug-of-cwd>/<session-id>.jsonl`,
  indistinguishable in shape from an interactive Claude Code session apart
  from the appended system prompt. OpenClaw itself reads those files back to
  render CLI history.
- The transcript is partitioned by the agent's workspace directory, so a
  multi-agent OpenClaw setup scatters across one `~/.claude/projects/<slug>`
  directory per workspace.
- The CLI backend receives no OpenClaw tool calls at all — OpenClaw's own
  tool executions, approvals, routing and queueing are absent from that
  transcript by design.

None of LLP 0152's steering applies: the child process resolves its own
credentials, makes its own HTTP calls, and never consults OpenClaw's
provider catalog.

LLP 0141 settled the analogous case for Codex Desktop — a client whose
traffic is already covered by an existing adapter, where the work was making
the coverage fact legible rather than adding capture.

## Options considered

1. **Force CLI turns onto the proxy** by rewriting the child's environment
   or config. Rejected: it means HypAware reaching into Claude Code's
   configuration from inside OpenClaw, which duplicates the Claude adapter
   badly, and OpenClaw deliberately strips `ANTHROPIC_API_KEY` from the
   child environment to avoid shadowing subscription auth. Fighting that is
   asking for a support burden.
2. **Say nothing and let LLP 0152 read as total coverage.** Rejected. This
   is the failure mode the whole revision exists to remove; leaving an
   unstated hole is the same defect in a new place.
3. **Declare the seam, and let the existing Claude/Codex transcript
   adapters own those turns.** Chosen.

## Decision

- CLI-backend turns are **out of scope** for the OpenClaw gateway capture
  path, permanently, not as a v1 limitation.
- They are covered — to the extent they are covered at all — by the existing
  Claude and Codex adapters reading the child's own transcript. A machine
  running OpenClaw with a CLI backend wants the corresponding client adapter
  enabled as well.
- Any HypAware surface that reports OpenClaw coverage states this
  explicitly, in the same register as LLP 0146's exclusions: not captured
  here, by design, captured over there if the sibling adapter is on.
- HypAware does not attempt to correlate an OpenClaw session with the child
  CLI session it spawned. OpenClaw passes the child a `--session-id` it
  generates, so a correlation key exists in principle; whether either
  adapter can observe it has not been investigated, and the decision not to
  correlate stands regardless — see the open question below.

## Consequences

- The honest coverage statement for OpenClaw becomes: every bearer-token,
  in-process provider turn (LLP 0152, 0144, 0145, 0146), plus CLI-backend
  turns via the sibling adapters, and nothing else. That is a sentence the
  product can defend.
- A machine with OpenClaw on `claude-cli` and no Claude adapter enabled has
  a real, nameable gap. Enrollment guidance should notice that combination
  rather than leaving the user to discover it.
- CLI-backend turns land in `~/.claude/projects` slugged by OpenClaw's
  agent workspace directory, so they may appear under directory names the
  user does not recognize as OpenClaw. This interacts with directory
  classification (`sync` / `local-only` / `ignore`): an OpenClaw agent
  workspace could be classified differently from the OpenClaw
  installation, which is a policy question worth checking against LLP 0103.

## Open questions

- Is OpenClaw's generated `--session-id` recoverable from either side, and
  would joining the OpenClaw session to the child CLI session in the context
  graph be worth the coupling? LLP 0027's transcript enricher is the
  natural place if so.
- Should the OpenClaw plugin detect a configured CLI backend and warn that
  those turns need the sibling adapter? That is a coverage-legibility
  feature in the spirit of LLP 0141 and may deserve its own decision.
- Does the workspace-directory partitioning interact badly with
  `.hypignore` / policy-class resolution, given the directory is OpenClaw's
  agent workspace rather than a repo the user thinks of as theirs?

## References

- LLP 0026, 0027, 0103, 0109, 0141, 0142, 0144, 0145, 0146
- `openclaw` repo: `src/agents/cli-runner/execute.ts`,
  `extensions/anthropic/cli-backend.ts`,
  `src/gateway/cli-session-history.claude.ts`
- https://docs.openclaw.ai/gateway/cli-backends
