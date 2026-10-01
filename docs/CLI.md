[← All documentation](README.md)

---

# Install and maintain HypAware

Install HypAware, check its background service, and keep the installation up to date.

For the syntax and behavior of every command, see the
[HypAware CLI command reference](./CLI_REFERENCE.md).

## Contents

- [Requirements](#requirements)
- [Install HypAware](#install-hypaware)
- [Check the installation](#check-the-installation)
- [Manage the background service](#manage-the-background-service)
- [Reconfigure an installation](#reconfigure-an-installation)
- [Update HypAware](#update-hypaware)
- [Reinstall or recover the current version](#reinstall-or-recover-the-current-version)
- [Uninstall](#uninstall)

## Requirements

- Node.js 22.12 or later.
- macOS with `launchd` or Linux with a `systemd` user service.
- An interactive terminal for the guided setup.

## Install HypAware

Install the CLI globally, then run the guided setup:

```sh
npm i -g hypaware
hyp setup
```

Select **Sync to the cloud** to store your recordings on HypAware Cloud or
choose **Local only** to keep recordings on your machine. To change this later,
see [connect a machine](TEAM_SETUP.md#connect-a-machine).

Setup then asks which AI clients to record, installs the background service,
connects the clients you selected, and imports their supported session history.

If a valid configuration already exists, `hyp setup` lets you reconfigure the setup.

For an unattended local installation, specify each choice:

```sh
hyp setup --yes \
    --source claude \
    --source otel \
    --client claude \
    --export keep-local \
    --retention-days 90
```

`--dry-run` currently still writes the configuration, so it is not a read-only
preview. If a configuration already exists, add `--force` to replace it.
HypAware backs up the existing configuration before replacement.

## Check the installation

```sh
hyp status
```

Status reports the background service, clients, storage, and anything that needs
attention, with guidance to help resolve problems. For capture checks, see
[clients and history](CLIENTS.md); for failures, see [troubleshooting](TROUBLESHOOTING.md).

## Manage the background service

The daemon keeps capture and scheduled sync running after you close the terminal.
Setup installs it as a per-user service. On macOS, its LaunchAgent runs while
you are logged in. On Linux, its systemd user service requires user-session
support; see [headless deployment](TEAM_SETUP.md#long-lived-headless-machines)
for hosts that must keep running after logout.

```sh
hyp daemon status
hyp daemon restart
```

Use the [daemon reference](CLI_REFERENCE.md#manage-the-daemon) for start, stop,
install, and foreground operation.

## Reconfigure an installation

For an ordinary interactive reconfiguration, run:

```sh
hyp setup
```

Select **Reconfigure** in the menu. HypAware preserves a centrally managed
configuration layer and changes only the choices this machine owns.

For unattended replacements and configuration files, see
[repeatable configuration](CONFIGURATION.md#make-a-repeatable-setup).

## Update HypAware

HypAware updates automatically by default when installed globally and running
as a background service. To update now:

```sh
hyp update
```

The command installs the latest release and restarts the background service.

## Reinstall or recover the current version

If the CLI binary or service definition is missing but your state is intact,
reinstall the package and service:

```sh
npm install -g hypaware
hyp daemon install
hyp status
```

To restore a known-good configuration, follow
[repeatable configuration](CONFIGURATION.md#make-a-repeatable-setup).

Use `hyp attach <client>` for any configured client that status reports as
detached, replacing `<client>` with its name, such as `claude` or `codex`.

## Uninstall

```sh
hyp leave                  # if this machine is enrolled in Cloud
hyp daemon uninstall
npm uninstall -g hypaware
```

Daemon uninstall restores managed client settings and retains local configuration
and recordings. To delete recorded data, see [privacy](PRIVACY.md#deleting-what-was-already-recorded).
Copies already synced to Cloud or exported to files are not removed by uninstall.
