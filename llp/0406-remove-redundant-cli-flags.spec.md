# LLP 0406: Remove redundant CLI flags

**Type:** Spec
**Status:** Active
**Systems:** CLI, Daemon, Config, Usage-Policy
**Date:** 2026-09-14
**Related:** LLP 0009, LLP 0017, LLP 0111, LLP 0293

## Request

Remove the clearly redundant flags, retaining the existing positional and
privacy command forms. This extends LLP 0111's deprecated-alias contract
and LLP 0009's CLI surface without changing policy storage or enforcement.

## Surface

- `hyp client attach [client]` and `hyp client detach [client]` reject
  `--client`, including the equals form. Setup and skills keep their own
  `--client` options.
- `hyp privacy ignore [path]` and `hyp privacy unignore [path]` only manage
  dotfiles. Remove `--check`, `--private`, `--local-only`, and `--sync`.
  Remove ignore's `--json`, which only served the removed check operation.
  Use `privacy show [path] [--json]`, `privacy set <path> <class>`, and
  `privacy unset <path> [class]`. Set requires an explicit path, so callers
  needing the old repo-root default must pass that root.
- `hyp config validate [file]` replaces `--path <file>`. With no file, keep
  the existing environment and default-path precedence. There is no new
  `--file` option.
- Removed forms fail with exit 2 before changing state.

## Installed services

`hyp daemon run` always runs in the current process. Help, new service
rendering, and examples omit `--foreground`. Existing installed service
units still contain that token, so the parser retains it and `-f` as
unadvertised compatibility inputs. Removing their acceptance would prevent
an already-installed daemon from restarting after an update. This is the
only retained flag alias in this request. `daemon start` continues to start
the installed service.

## Validation

Keep deterministic policy and dotfile tests through the surviving commands,
assert removed inputs have no side effects, validate config path precedence,
and check both new daemon invocation and installed-service compatibility.
Run the traditional suite, typecheck, and affected hermetic smokes. The real
macOS LaunchAgent acceptance gate remains a release requirement when the
rendered plist changes, per AGENTS.md.

## CPU and memory

This removes argument branches and adds no recurring work, storage, or runtime
dependencies. Parsing remains linear in the small argv input. Policy scans,
cache reads, and daemon lifetime behavior retain their existing bounds.
