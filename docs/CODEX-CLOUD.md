# Experimental hosted Codex and Work collector

HypAware can discover and import selected categories of hosted chats from a local collector,
using the existing local ChatGPT login. It does not need a browser extension
or an agent to export history. **This integration is experimental:** it uses
an observed hosted interface that may change. Hosted collection is a separate choice from local Codex recording.
The Codex desktop app is not required; the collector uses the Codex CLI and
runs while the collector computer and HypAware daemon are running.

By default only `codex_cloud` coding chats are collected. Three origin categories
can be selected independently, alone or together:

| Origin | Hosted activity |
| --- | --- |
| `codex_cloud` | Codex cloud coding chats (default) |
| `codex_work_web` | Work/dot conversations whose origin is labeled web |
| `codex_work_mobile` | Work/dot conversations whose origin is labeled mobile |

The origin identifies the originating client, not a restriction to where you
later view the chat. These labels are observed backend metadata, not a documented
third-party contract. Web/mobile collection can include everyday personal
assistant conversations. Delegated `codex_work_cca`, hidden/unknown origins and
all unselected categories are excluded, including when you supply explicit IDs.

Requirements: Node 22.12 or newer, the `@hypaware/codex-cloud` plugin enabled in HypAware, an
installed `codex` executable on the collector's PATH, and a file-backed ChatGPT
login in `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). The collector
adds the running Node executable's directory to its helper PATH, so a Codex
installed beside Node remains discoverable under launchd or systemd.
The collector checks the effective Codex credential-store setting and rejects `keyring`,
`auto`, `ephemeral` and API-key authentication. It does not change that setting.

## Choose during setup

`hyp setup` offers two hosted choices:

- **Codex Cloud (experimental)** is a separate row from local **Codex**.
  On first setup it is checked when Codex is detected and included in
  **Record everything** (or **Record and sync everything**).
- **ChatGPT Work (experimental)** bundles Work web and Work mobile. It starts
  unchecked and is only added through **Customize**.

Choosing either hosted row enables its collector without enabling local Codex
recording. Both use the existing file-backed Codex ChatGPT login. If that login
is unavailable or unsupported, setup reports the incomplete step and continues;
sign in through Codex and rerun setup to select the desired hosted rows.

Reconfigure shows the choices saved by the hosted plugin. Clearing a hosted row stops future
collection for that category. Keeping a row preserves existing thread IDs,
history bounds and a narrower web-only or mobile-only CLI grant. Cancel and Back
do not save changes. Unattended setup does not authenticate or grant hosted access.

## Upgrading an earlier install

Earlier builds ran hosted collection inside the `@hypaware/codex` plugin and
kept its grant at `~/.hyp/hypaware/plugins/@hypaware/codex/cloud-connection.json`
(under `$HYP_HOME` when set). The collector now lives in `@hypaware/codex-cloud`,
which reads only its own grant, so after upgrading hosted collection stops until
you choose it again. Rerun setup and select **Codex Cloud (experimental)**,
**ChatGPT Work (experimental)** or both:

```sh
hyp setup
```

The old grant is left in place. It is not read, migrated or deleted, and you can
remove that file once the new selection is saved. A narrow scope saved at the old
location (specific chats, only Work web or only Work mobile, or a `--from-now`
bound) is not migrated either: rerunning setup re-selects hosted collection with
a new account-wide grant. To narrow it again, run `hyp codex-cloud connect` with
the options you want after setup.

## Connect and import

For automatic account-wide discovery, using your existing history window:

```sh
hyp codex-cloud connect --all
```

Select a different category or a comma-separated combination explicitly:

```sh
hyp codex-cloud connect --all --origins codex_work_web
hyp codex-cloud connect --all --origins codex_work_mobile
hyp codex-cloud connect --all --origins codex_cloud,codex_work_web,codex_work_mobile
```

Add `--from-now` only to exclude older activity. To collect specific chats
instead, use UUIDs from their hosted URLs:

```sh
hyp codex-cloud connect <thread-id> [thread-id...] [--origins <origin,...>]
hyp codex-cloud status
hyp backfill codex-cloud --dry-run --json
hyp backfill codex-cloud --json
```

`connect` replaces the previous grant and binds it to the current ChatGPT
user and account. Explicit selection supports up to 20 chats; `--all` discovers
active and archived chats within the selected origins automatically. It does not import
immediately. The daemon checks connected chats every five minutes. Restart an
older daemon after upgrading. Imported records follow the existing HypAware
export settings, including prompts and tool outputs from any selected Work/dot
chats. Status shows the active origin selection. No credentials are sent to HypAware servers.

The import supports the normal backfill `--since`, `--until` and retention
options. Scheduled runs also honor the hosted plugin's `backfill.window_days`
when configured. Repeat imports deduplicate against recorded part IDs.

```sh
hyp query sql "select count(*) from ai_gateway_messages where entrypoint = 'codex-cloud'"
hyp codex-cloud disconnect
```

Disconnect prevents future collection; it does not delete recorded data.
`hyp session ignore <thread-id>` persists a session exclusion that both manual
imports and scheduled sweeps reload at the start of each run. An import already
in flight uses its run-start snapshot. Local `hyp detach codex` is independent
of hosted recording. Use setup to clear a hosted row, or `hyp codex-cloud
disconnect` to stop both. None of these deletes prior rows.

## Capture and limits

This first version imports completed user text, assistant text, command calls
and their full outputs, and MCP calls with their results, including structured
content. Tool calls and results occupy separate rows. Reasoning content is
excluded. Unfinished items are deferred, and unsupported items or content parts
are reported as skipped. Image inputs, file-change items and other native item
types are not yet mapped.

Usage is unknown when the history response lacks it. This collector neither
subscribes to live usage events nor estimates tokens. Thread-level model
metadata is retained in attributes, not presented as a per-request model.
The native originator is retained in `attributes.codex.originator`; all rows
from this collector use `entrypoint = codex-cloud`. `client_name` is
`codex-cloud` for coding chats and `chatgpt-work` for Work chats, so their
source export policies are independent.
Cloud filesystem paths are metadata: local `.hypignore` rules cannot classify
the remote `/workspace` directory.

The collector opens one authenticated connection per pass, with serial requests,
a two-minute pass deadline, a 64 MiB received-message budget and at most 20
pages of 100 items per chat. If a chat exceeds the limits or pagination fails,
that chat is not partially imported. Earlier successfully imported chats remain.
Limits are reported as errors rather than silently truncating history. Large
chats beyond these bounds currently require a later implementation extension.

Automatic discovery permits at most 20 list pages per archive state (up to
4000 metadata entries across all origins), filters the selected origins locally,
and reads up to 20 eligible chats per sweep. Unselected chat messages are not fetched. Batches
rotate, with newly discovered chats prioritized. Existing chats are revisited;
updates can wait a full rotation. Restarting the daemon resets rotation.
Chat-specific read failures are reported and skipped for that pass; other
chats continue. Discovery or connection failures stop the pass visibly.

## Authentication and troubleshooting

HypAware keeps the access token in memory. Near expiry, it asks the installed
Codex app-server to renew the existing login; Codex updates its own credential
store. There is no separate HypAware refresh-token copy. A dry run refuses a
needed renewal rather than explicitly rotating tokens. Generic network failures
do not trigger renewal loops.

If the account changes, collection stops until you reconnect the desired chats.
If credentials are revoked, sign in through Codex normally and reconnect.
HypAware never automatically logs you out or deletes your credentials.

Failures emit `codex.cloud.failed` with a fixed `error_kind` and the failed step.
Account-mode chat failures emit `codex.cloud.chat_failed` and the
`cloud_chat_failed` progress event. Other chats continue, then the pass reports
`some_chats_failed` with a failed-chat count and a nonzero exit status. Discovery logs discovered, eligible, selected and deferred
counts. Network errors and upstream rejection bodies are not logged. Success emits
`codex.cloud.completed`; `hyp backfill ... --json` reports actual rows written.

The hosted WebSocket interface is an implementation observed and tested with a
personal account, not a documented third-party hosted API contract. Upstream
support for commercial integrations remains unresolved. Simultaneous refreshes
by independent Codex processes and natural-expiry recovery still need broader
acceptance testing. This implementation does not claim cross-process locking.

## Validation and remaining limits

Tested on macOS with Node 24.2.0, Codex CLI 0.159.0 and a personal ChatGPT login:
complete long command output and MCP results, repeat-import deduplication,
growing-chat capture through launchd, restart, pagination, recovery after a
connection drop, Codex-managed refresh with a simulated near-expiry clock,
strict originator discovery and central export. The filtered live inventory
contained four Codex Cloud chats, and the remote query matched 494 local rows.

Linux service behavior, natural token expiry, simultaneous refresh by separate
Codex processes and managed-workspace accounts remain unverified. Token counts
are unavailable from the persisted history responses tested so far.

Design: [LLP 0511](../llp/0511-local-codex-cloud-collector.rfc.md).
