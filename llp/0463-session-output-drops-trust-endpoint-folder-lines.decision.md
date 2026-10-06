# LLP 0463: session command output drops the trust, endpoint, and folder lines

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Plugins
**Author:** Kenny / Claude
**Date:** 2026-10-05
**Related:** LLP 0066, LLP 0067, LLP 0166

> The human output of `hyp session status`, `ignore`, and `unignore` no longer
> prints the `trust:`, `endpoint:`, or `folder:` lines. The `--json` fields
> behind them (`endpoint_authenticated`, `endpoint_source`, `folder_policy`)
> stay.
>
> @ref LLP 0166#stated-not-proved [constrained-by]: replaces the human-output
> half; the JSON half stands.

## Why

Each line answered a real question once, but printed on every run they buried
the answer the user asked for:

- `trust:` said nothing proves the responder is the gateway. The only party
  that could fake one is a process already running as this user, which can
  already read and change everything HypAware holds (LLP 0166 says as much).
  A caveat that cannot be acted on and is always true is noise.
- `endpoint:` said the port came from the pinned `listen` rather than a live
  daemon. That is a debugging detail, not something a user decides on.
- `folder:` pointed at `hyp privacy show`. Folder policy is documented on its
  own surface, and the session verbs answer only for the session.

## What changes {#human-output}

- LLP 0166 §stated-not-proved: the human `trust:` note is removed from every
  verb. `endpoint_authenticated: false` stays in `--json`, unchanged.
- LLP 0066 R11: the reader no longer names the folder governor in its human
  output. `folder_policy` stays in the status `--json`.
- LLP 0066 R12 and LLP 0067 §cli-provenance: the endpoint half of the
  provenance note is removed from human output. `endpoint_source` stays in
  `--json`. The session-id half (an inferred Codex id is still flagged as
  inferred) is unchanged.

Nothing about what the verbs believe changes: `validateControlResponse` keeps
every refusal, and fail-closed `unknown` answers are untouched.
