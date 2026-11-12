# Codex

**Status:** Supported. **Setup id:** `codex`. **Backfill:** Yes.

HypAware records Codex CLI and the Codex desktop app from the session files
they share in `~/.codex/sessions`, imported every minute. Codex connects to its
provider directly; HypAware does not sit in its model traffic unless you turn on
gateway capture.

For hosted Codex tasks, see [Codex Cloud](codex-cloud.md), a separate
integration.

## What is recorded

Prompts, responses, tool calls, and token counts from Codex's session files, with
the working directory of each session. Codex does not report cost.

## Set it up

`hyp setup` offers Codex when it finds `~/.codex/config.toml`. To add it later:

```sh
hyp attach codex --dry-run
hyp attach codex
hyp client status codex
```

Attach covers both the CLI and the desktop app, installs HypAware's skills in
`~/.codex/skills`, and adds a hook that records each session's working
directory.

## Import existing history

```sh
hyp backfill codex --since 2026-09-01T00:00:00Z --dry-run
hyp backfill codex --since 2026-09-01T00:00:00Z
```

The one-minute import is Codex's only capture lane by default, so
`backfill.on_join: false` does not stop it. Use `hyp detach codex` to stop
recording.

### Large session files

The import reads each session file in pieces, so a long session does not have
to fit in memory. It records at most 128 messages or 4 MiB of session data at a
time; a single larger message is still recorded whole. Each file has fixed
limits:

- one line of at most 16 MiB
- at most 100,000 turns in one session
- an older single-document session file of at most 16 MiB

A file over a limit, or one HypAware cannot read, is never skipped silently.
The rest of the import still finishes, the failed file is left for the next
scheduled run to retry, and `hyp status` reports that the import failed (see
[History import failed](../TROUBLESHOOTING.md#history-import-failed)). Messages
Codex appends to a file while it is being read are picked up on the next run.

## Gateway capture

To record Codex's model traffic as it happens instead of from session files,
set `capture_mode` to `gateway` in the Codex plugin's configuration, then attach
again:

```json
{ "name": "@hypaware/codex", "config": { "capture_mode": "gateway" } }
```

Gateway capture routes Codex through HypAware's local gateway. The default,
`transcript`, removes any gateway route.

## Reopen chats saved with gateway capture

Codex 0.166.0 requires a saved chat's provider name to match the active
provider. Older chats saved as `hypaware` can therefore report
`modelProviderMismatch` after HypAware restores your normal provider.
The compatibility provider remains configured, but its presence alone no
longer allows those chats to resume.

After upgrading HypAware and starting the upgraded daemon, the normal
transcript sweep repairs these chats once, with local backups. If Codex
Desktop or any Codex CLI is open, it waits until all are closed and checks
again on the next scheduled sweep (normally within a minute). It never closes
Codex for you. Completed migrations are remembered across daemon restarts.

Automatic repair requires Codex recording to be enabled and the normal OpenAI
configuration described below. Gateway capture and detached clients are left
alone. Large histories or repair failures fall back to the manual command;
automatic repair warnings name that command in daemon logs. Capture continues
while repair is deferred or refused. If you do not run the daemon, use the
manual command too.

To preview or apply the repair yourself:

```sh
hyp codex repair --dry-run
```

Then close Codex Desktop and all Codex CLI sessions and run:

```sh
hyp codex repair
```

The command saves local backups, updates the affected chat provider identities
in history and native metadata, and prints the backup directory. Reopen Codex
normally afterward. Conversation IDs and content, names, permissions, and
your provider configuration are preserved. A repeated run makes no changes.

Repair supports the normal OpenAI configuration and the unchanged HypAware
compatibility provider. It refuses custom routes and profiles rather than
change their provider destination. Compressed archives need a Node version
with built-in Zstandard support. Desktop-only installations on macOS use the
bundled Codex executable; `--codex-bin /path/to/codex` selects another binary.

To undo a repair, close Codex again and use the printed backup path:

```sh
hyp codex repair --restore /path/to/backup-directory
```

Restore refuses to overwrite a conversation changed since repair, preserving
new messages. Backups remain private under
`$CODEX_HOME/hypaware-provider-repair` (normally
`~/.codex/hypaware-provider-repair`).

Each backup is a full, unmasked copy of the repaired chats and of Codex's
state database, private to your user account. HypAware never deletes it:
not after a successful repair or restore, and not on `hyp privacy purge`, detach, or
daemon uninstall. HypAware does not capture or export it. A chat you later
delete in Codex, or purge from HypAware, stays in the backup until you delete
the folder. Deleting it is safe once every repair has finished and you no
longer need `--restore`.

As a temporary CLI workaround, select the compatibility provider for that process:

```sh
codex -c 'model_provider="hypaware"' resume <chat-id>
```

After transcript attach, this provider connects directly to OpenAI using your
current Codex login. Every chat opened in that process uses that provider.
Your saved default and chat files are unchanged, so a later ordinary Codex
launch uses your normal provider. This does not repair an already running
Desktop process. New chats created in the overridden process also use the
`hypaware` identity and may need repair later. The repair runs only when you
invoke it or the upgraded daemon completes its one-time migration.
