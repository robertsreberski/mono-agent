---
title: "Computer use"
description: "Opt into local desktop control through TryCua's separately installed cua-driver MCP server."
---

Computer use lets an agent inspect screenshots and accessibility trees, then
click, type, scroll, and interact with local applications. It uses TryCua's
[MIT-licensed Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)
over the existing run-scoped stdio [MCP integration](/tools/mcp/). No cloud
desktop, bundled driver, runtime installer, or additional backend is involved.
Without `tools.computerUse`, nothing is registered.

:::caution
This grants control of your local desktop. External MCP tools bypass
`tools.allowedTools` and `tools.disallowedTools`; these lists are **not** a
computer-use restriction. Standard mode permits routine input without a Cua
confirmation prompt. Use a dedicated machine/user for unattended automation.
:::

## Install and check

Install the driver yourself using the
[upstream installation instructions](https://cua.ai/docs/cua-driver).
For macOS/Linux, download and inspect the upstream installer before executing it:

```bash
curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh -o install-cua-driver.sh
# Review install-cua-driver.sh, then run it only if you trust it.
bash install-cua-driver.sh
cua-driver --version
cua-driver doctor --json
cua-driver telemetry disable
```

On Windows, use the upstream PowerShell installer from an interactive user
session. The normal executable location is
`%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\cua-driver.exe`. Windows desktop
control requires a logged-in interactive desktop, not a Session 0 service.
On Linux, run within the graphical session; X11/Wayland support and portal or
compositor requirements depend on the installed upstream build. Follow its
platform guide and run `cua-driver doctor` in that session. Mono-agent's doctor
checks the installation, but does not prove every Linux/Windows input adapter.

The integration was checked against cua-driver **0.31.0**. Upstream can change
its tool surface independently of mono-agent; review driver upgrades. The
optional `cua-perception` extension is not required or installed by mono-agent.
Telemetry is enabled by upstream by default; the opt-out above is operator-owned.

### macOS permissions

Install `CuaDriver.app`. Grant **Accessibility** and **Screen Recording** to
**CuaDriver**, bundle identity `com.trycua.driver`, in System Settings →
Privacy & Security. The app daemon owns these grants; the agent process does
not need separate grants for this integration. From an interactive session:

```bash
cua-driver permissions grant
cua-driver permissions status --json
```

The framework never grants OS permissions. Its invocation is `cua-driver mcp`
without `--direct`; on macOS this proxies to the app daemon and can start the
app if necessary. Do not replace it with `--direct`: that changes TCC identity
to the spawning host. If grants are unknown/pending, doctor reports **waiting**,
even when a daemon socket is listening. Complete the interactive grant flow,
check System Settings, then rerun doctor. Merely ticking the permission boxes
is not proof that a running daemon has confirmed readiness.

## Configuration

Add one entry to `mono-agent.config.json`:

```json
{
  "tools": {
    "computerUse": { "backend": "cua-driver" }
  }
}
```

Optionally pin the executable:

```json
{
  "tools": {
    "computerUse": {
      "backend": "cua-driver",
      "command": "/opt/tools/cua-driver"
    }
  }
}
```

`command` is an executable name or path, not a shell command with flags.
Relative paths resolve against the config workspace; `~` paths are expanded.
An explicit override never falls back to a different installation. Otherwise
resolution checks `PATH`, then `~/.local/bin/cua-driver` on macOS/Linux,
`/Applications/CuaDriver.app/Contents/MacOS/cua-driver` on macOS, or the Windows
installer location above. This works with the minimal PATH of supervised workers.
`mono-agent doctor` reports the resolved path and version.
If the driver is missing or moved, the agent still starts: it omits this server,
logs one startup warning per config, and doctor reports waiting. Subagent profiles
that explicitly select `computer-use` then fail the ordinary undefined-server
check instead of receiving desktop tools.

The reserved MCP server name is `computer-use`; an entry with that name in
`tools.mcpConfigPath` is an error while this integration is enabled. Ordinary
subagent MCP selection can include `computer-use` in its server-name list.
The framework merges it with existing MCP servers and uses their normal
runtime/sandbox lifecycle. The original `tools.mcpConfigPath` is still forwarded in
the tool policy, but only the inline server map contains the injected entry;
the current Pi runtime uses that map, whereas a custom CLI/runtime integration
that reads the original file directly will not see `computer-use`. Native subprocess sandboxing may prevent a driver
from reaching its daemon or desktop; it does not restrict a separately running
desktop daemon. Do not treat the process sandbox as an application/UI allowlist.

## Restricting cua-driver

V1 uses the upstream **standard invocation** and does not configure or verify
permission mode, tools, applications, browser profiles, origins, or file roots.
`permissionMode`, `capabilityManifest`, and unrestricted-mode switches are
**not supported config keys** and are rejected. No dangerous approval bypass
or existing-profile launch grant is passed by mono-agent. A daemon you already
run, and inherited upstream launch settings, can have different authority;
mono-agent cannot attest that it is standard or bounded.

Upstream offers `standard`, `bounded`, and `unrestricted` permission modes.
Standard permits routine observation/input; attaching existing logged-in browser
profiles requires upstream launch authorization. Bounded requires a reviewed,
deny-by-default capability manifest. Unrestricted requires
`--dangerously-bypass-approvals` and is not exposed by this integration.

An operator may run a daemon they own in upstream bounded mode:

```bash
cua-driver serve --permission-mode bounded \
  --capability-manifest ./cua-capabilities.yaml \
  --approve-capability-manifest
```

On macOS, `cua-driver mcp` proxies to that daemon. The mode is fixed at daemon
launch: passing different environment to a client does **not** change an
already-running daemon. Stop/restart your own daemon according to upstream
instructions when changing its mode. **Mono-agent neither configures nor
verifies this restriction**. Review the exact manifest before asserting approval.

A minimal upstream v3 manifest for observing one macOS application is:

```yaml
version: 3
expires_after: 1h
idle_timeout: 10m
allow:
  tools:
    - list_windows
resources:
  apps:
    - bundle_id: com.apple.TextEdit
      windows: all
  desktop:
    display: false
```

This intentionally grants no screenshot/input tools. Expand it only using
[upstream permission-mode and manifest guidance](https://cua.ai/docs/reference/cua-driver/permission-modes).
On Windows/Linux use canonical absolute executable identities instead of
`bundle_id`. Browser-origin scopes constrain typed browser tools, not generic
click/type; upstream rejects manifests combining origin scopes with generic
input or window-observation tools. Separate runtimes are not mutual isolation.

## Safe use and limits

- Screenshots and accessibility-tree text are sent to the **model provider** as
  tool results. Close sensitive windows; never expose secrets or private records.
- Ask the agent to obtain confirmation before payments, sending messages,
  deleting data, changing permissions, or other risky/irreversible UI actions.
  This is guidance, not an enforced per-action approval engine.
- Prefer a dedicated desktop/user and an independently reviewed upstream bounded
  daemon for unattended work; monitor the session and know how to stop it.
- Other same-user processes and malicious desktop content remain outside the
  driver's security boundary. Prompt injection can induce unintended actions.
- Image tool results already reach vision-capable models through MCP. The web
  console currently shows generic tool-result JSON, not a dedicated screenshot
  viewer. Computer use does not add a new console renderer or Codex backend.

See the [config reference](/config/reference/) for configuration fields and
[MCP server policy notes](/tools/mcp/) for the external-tool boundary.
