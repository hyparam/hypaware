# HypAware for Pi

Records persisted Pi conversations through a local HypAware daemon. Includes
messages, tool calls/results and reported usage. The extension has no runtime
dependencies and does not change provider routing or credentials.

## Setup

Enable **Pi** in `hyp init` and start the HypAware daemon. Normal HypAware setup
installs a managed copy of this extension. Restart Pi or use `/reload`.

To use Pi's package manager instead, from a checkout of this repository:

```sh
pi install /absolute/path/to/hypaware/packages/pi-extension
```

The package is also independently packable with `npm pack` in this directory.
After publication its npm install command will be
`pi install npm:@hypaware/pi-extension`. This repository change does not publish it.
Prefer one installation method. If both are loaded, only one extension instance
records in a Pi process. Pi owns package installs; HypAware detach removes only
its marker-owned managed file.

The default endpoint is `http://127.0.0.1:4322`. Managed attach embeds the
adapter's configured `listen_port`. A package-managed install with a different
port uses `HYP_PI_ENDPOINT=http://127.0.0.1:<port>` in Pi's environment. Only
HTTP on IPv4 loopback is accepted. `/hypaware` reports delivery status.

## Collection and privacy

Completed entries are sent asynchronously in bounded batches. Delivery failures
fall back to HypAware's scheduled import of native Pi JSONL sessions (normally
every five minutes). An existing history is imported by the daemon, not uploaded
in full by the extension. Print, JSON, RPC and interactive modes use the same
extension. `--no-session` remains unrecorded. Image bytes are not copied; image
parts retain their type and MIME type. Arbitrary internal model calls made by
other extensions may not appear in session history.

Both capture paths honor `hyp session ignore`, `.hypignore`, machine policy and
local-only export withholding. Inside Pi's shell tools, the session commands
recognize `PI_SESSION_ID`. Disabling Pi in HypAware stops both capture paths;
removing this extension alone does not stop native-history import.

Recovery reads `PI_CODING_AGENT_SESSION_DIR`, or `sessions/` under
`PI_CODING_AGENT_DIR` (default `~/.pi/agent`). Set overrides in both Pi and the
HypAware daemon environment. A custom `--session-dir` visible only to one Pi
process works for live capture, but requires the corresponding collector root
override for recovery after that process exits.

Forked inherited context carries no additive usage after recovery verifies its
parent. A missing, excluded or unsupported parent refuses fork recovery and
emits `pi.backfill.file_failed`; newly generated live child entries still work.
Tool-result usage is retained as `attributes.raw_usage`, since it can aggregate
separately recorded children. Assistant and summary usage uses the ordinary
additive `attributes.usage` fields.

Recovery refuses files over 64 MiB, lines over 1 MiB, sessions/parent indexes
over 100,000 entries, or discovery beyond 10,000 directory entries. Scheduled
sweeps reserve at most 256 MiB of session and parent input per run, rotating
their starting file so later history progresses even when earlier files keep
changing or failing. `pi.backfill.scan` reports deferred scans. Manual imports
are not subject to this total sweep budget.

Live payloads
are at most 512 KiB, with a 4 MiB queue; a lifecycle traversal is limited to
4,096 entries. Encoding is bounded before allocating the final JSON, and stops
when its per-hook work budget or the queue is exhausted. Limits and unavailable
input surface through status/diagnostics.
Very large entries can therefore require a later deliberate increase in limits.

Baseline: Pi 0.85.1. The acceptance procedure in `docs/ACCEPTANCE.md` checks real
Pi behavior when either adapter or upstream changes. This package does not
install HypAware, start services or transmit directly to a cloud destination.
