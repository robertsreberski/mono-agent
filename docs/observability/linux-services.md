---
title: "Linux background services"
description: "Use systemd user services to run agents and the web console on Linux, with explicit unmanaged-runtime provenance."
---

On Linux with a running systemd user manager, the regular lifecycle commands
install user services. No root access is needed to install the units:

```bash
mono-agent start
mono-agent status --json
mono-agent logs --follow --lines 100
mono-agent restart
mono-agent stop
```

Each canonical config path gets a distinct `mono-agent-<hash>.service` in
`$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user` by default.
`--config` and `--env-file` select the same inputs as foreground mode. The unit
pins the current Node executable, CLI file, working directory, and dotenv path.
Keep that installation available after reboot. Moving or deleting the CLI or
Node installation breaks the service until it is reinstalled with `restart`.

The service directories must belong to the current user and must not be
group/world-writable or symlinks. Unsafe existing paths are reported without
replacing their contents.

The worker runs with a selected operational environment and reads provider
credentials and config overrides from its dotenv file. Export-only secrets and
config overrides are not persisted. The systemd manager's ambient environment
is cleared before starting the CLI. Unit files contain no provider credentials.

`start` waits for a running PID and its matching completed-startup trace. A
healthy active service is left running; changed inputs require `restart`.
Failed starts remove their unit; failed restarts attempt to restore the prior
definition and running state. Failures are reported rather than claimed ready.
`status` reports the supervisor state, PID, start time, boot enablement, and
agent readiness. `logs` uses journald, whose retention policy controls disk use.
`stop` disables and removes only a recognized Mono unit, preserving agent data.
Concurrent lifecycle mutations are serialized per unit.

Enable linger to start user services at boot and keep them running after logout:

```bash
loginctl enable-linger
loginctl show-user "$USER" --property=Linger
```

Depending on host policy, enabling linger may require an administrator. Mono
prints a hint when linger cannot be confirmed; it does not change login policy.
A machine without systemd or a usable user bus can still use
`mono-agent start --foreground` and `mono-agent web run`.

## Web console

```bash
mono-agent web start --loopback --theme plum
mono-agent web status
mono-agent web logs --follow
mono-agent web restart
mono-agent web stop
```

The console uses `mono-agent-web.service`. Restart preserves its host, port,
theme, and allowed-host setting unless explicitly overridden. Bare
`mono-agent web` is read-only. The unit uses the existing web state store;
stopping the service does not delete conversations. Stop it before using
`mono-agent web reset --all --yes`.

Linux HTTPS routes are externally managed in this first lifecycle backend.
For Tailscale Serve, start with loopback binding and set
`MONO_AGENT_WEB_ALLOWED_HOSTS` to the full Tailscale DNS hostname when installing
the web service. Then configure Serve to proxy to `http://127.0.0.1:5050`.
Mono preserves external routes during start, restart, stop, and reset; use
`tailscale serve status` to inspect them. The console has no application login:
keep access restricted to trusted devices. See [Web console](./web-console.md).

## Scope and migration

The runtime is reported as **dev (unmanaged)**. Systemd supervision does not
provide the copied-runtime integrity proofs or managed configuration authority
of the macOS backend. Fleet verification must not treat these as managed
LaunchAgents. Linux `restart --clear-sessions`, automatic guided-init startup,
and managed configuration chat remain outside this first operator-commands PR.
After guided initialization, use `mono-agent start` and ordinary `mono-agent tui`.

Existing hand-written services are not adopted or stopped automatically. Stop
and disable the exact old service before installing a Mono-owned replacement;
the foreground singleton lease also prevents duplicate agents. Do not delete
the agent folder or the web state directory during migration. Keep your old
unit available until the new service is proven ready.
