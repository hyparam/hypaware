# Factory Droid

**Status:** Supported. **Setup id:** `droid`. **Backfill:** Yes.

HypAware records Factory Droid's local CLI sessions through
[native hooks](https://docs.factory.com/harness/hooks). A
hook tells the local daemon when a transcript changes; HypAware reads that
transcript and recovers missed activity every five minutes. Model traffic
continues to go directly to your provider.

## What is recorded

Prompts, responses, tool calls and results, model and provider where available,
and each session's working directory. Tool results can include file contents
and command output. Both live capture and history imports write to
`ai_gateway_messages` with the client name `droid`.

Billed token usage and cost are not available from this integration. Droid's
context estimates and cumulative session totals are not treated as per-message
usage. Attachments retain placeholders rather than image bytes or referenced
file contents; HypAware does not read Factory credentials or session settings
sidecars.

## Requirements

Run HypAware next to Droid on macOS or Linux, with access to Droid's local
session files. Capture was validated with Factory CLI 0.245.0 and its version-2
JSONL transcripts. Hosted Factory sessions without local transcripts are not
captured by this adapter.

The default paths below are under `~/.factory`. If you use
`FACTORY_HOME_OVERRIDE`, it names the home **containing** `.factory`, not the
`.factory` directory itself. Use the same value for Droid, HypAware commands,
and the collector process; setting it in a shell does not change an already
running daemon's environment.

Skill installation still uses `~/.factory/skills` under HypAware's `HOME`, even
when `FACTORY_HOME_OVERRIDE` relocates hooks and transcripts. For a relocated
Factory home, copy the installed skills to that home's `.factory/skills` if
you want Droid to discover them there.

## Set it up

`hyp setup` offers Factory Droid when it finds `~/.factory/settings.json`.
Choose it during setup. To add it later:

```sh
hyp attach droid --dry-run
hyp attach droid
hyp client status droid
hyp daemon status
```

Attach adds managed command hooks to `~/.factory/hooks.json`, preserves your
other hooks, and installs HypAware's skills in `~/.factory/skills`. Where a
managed event would override hooks in `settings.json`, attach preserves those
handlers in `hooks.json` too. Start a new Droid process so it loads the hooks.
No gateway or provider credential changes are required.

## Verify recording

Complete a short Droid turn containing a distinctive phrase, then search for
it:

```sh
hyp query grep 'your distinctive phrase'
```

Allow time for capture and cache visibility to settle. If a notification was
missed, scheduled recovery normally picks it up within five minutes. An attach
marker alone does not prove that a conversation was recorded.

## Import existing history

Apply your [privacy markings](../PRIVACY.md#marking-directories) before importing
sensitive history. Eligible imported rows can be exported or synced if those
destinations are configured.

```sh
hyp backfill droid --dry-run
hyp backfill droid
```

Imports read native JSONL files one project-directory level beneath
`~/.factory/sessions`. Repeated imports and live capture share message
identities, so importing a captured transcript does not duplicate its messages.

A positive `backfill.window_days` in the `@hypaware/droid` plugin's config
limits both setup-time imports and scheduled recovery. Without it, the cache
retention window applies. Setting `backfill.on_join` to `false` disables both
automatic imports and scheduled recovery; live hooks and explicit
`hyp backfill droid` still work. See the
[recovery reference](../CLI_REFERENCE.md#scheduled-recovery-sweeps-and-backfillwindow_days)
for window and schedule settings.

## Privacy and stopping capture

Both hooks and history imports honor directory exclusions and saved session
exclusions. To exclude one session, pass its verified native Droid session ID:

```sh
hyp session ignore <session-id>
hyp session status <session-id>
hyp session unignore <session-id>
```

Droid does not support automatic session-ID resolution. Saved exclusions
survive restarts. Unignoring makes the transcript eligible for import again,
including turns written while ignored. See [privacy controls](../PRIVACY.md)
for keeping recordings local and deleting earlier records.

To stop Droid recording entirely:

```sh
hyp detach droid --dry-run
hyp detach droid
```

Detach stops live capture and scheduled recovery and removes the managed
hooks, retaining your other handlers and existing recordings. Restart Droid
to reload its hook configuration. Run `hyp attach droid` to resume recording.

## Troubleshooting and limits

- If attach reports legacy `~/.factory/hooks/hooks.json`, migrate it to the
  current `~/.factory/hooks.json` format first. The modern file maps event names
  directly to matcher arrays; it is not wrapped in a `hooks` object. Attach
  refuses malformed or incompatible hook configuration instead of replacing it.
- If hooks report `HypAware Droid capture unavailable`, check
  `hyp daemon status` and `hyp client status droid`. The hook exits successfully
  without changing Droid's permission decisions; recovery can import the saved
  transcript after the collector returns.
- If no hook runs, use Droid's `/hooks` UI to inspect the effective configuration.
  Disabled hooks or Factory's `allowManagedHooksOnly` policy can prevent user
  hooks from loading. See [Factory's hook guide](https://docs.factory.com/harness/hooks#debugging).
  Scheduled transcript recovery still works when enabled.
- If history stays missing, check the Factory home, directory and session
  exclusions, and the recovery window, then run a backfill dry run. Capture
  requires a version-2 header with an absolute working directory and complete
  JSONL records. Pending tool results wait for Droid to finish writing them.
- Reads are bounded: files above 64 MiB or lines above 1 MiB are refused.
  Discovery refuses scans exceeding 10,000 entries and does not follow directory
  symlinks. A recovery pass has a 256 MiB file budget; scheduled passes rotate
  through files deferred by that byte budget, so these can need multiple passes.

For shared diagnostic steps and log locations, see
[troubleshooting](../TROUBLESHOOTING.md#no-new-recordings).
