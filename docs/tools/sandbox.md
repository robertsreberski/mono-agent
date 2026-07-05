---
title: "Sandbox"
sidebar:
  order: 3
---

# Sandbox

The sandbox confines the shell commands your agent runs (e.g. a code-exec tool) by wrapping them with `srt` (the native sandbox runtime) and a generated settings file: a filesystem scope (readable/writable roots, deny-write globs), a network policy, and a fallback for when the sandbox engine is unavailable. This page covers the `sandbox` config block, the matching `MONO_AGENT_SANDBOX_*` env vars, and the monotonic merge that lets request-scoped policies tighten — but never widen — the configured baseline.

The whole block is **config** coverage (`@mono-agent/sandbox`). Omit `sandbox` entirely for no sandboxing.

## Quick reference

```json
{
  "sandbox": {
    "mode": "native",
    "network": { "mode": "none", "allowlist": [] },
    "readableRoots": ["."],
    "writableRoots": ["."],
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"],
    "fallback": "fail-closed",
    "unsafeAllowHostProcess": false
  }
}
```

| Key | Type / values | Default | Env var |
| --- | --- | --- | --- |
| `sandbox.mode` | `native` (srt-wrapped) \| `off` | `native` | `MONO_AGENT_SANDBOX_MODE` |
| `sandbox.network.mode` | `none` \| `localhost` \| `allowlist` \| `all` | `none` | `MONO_AGENT_SANDBOX_NETWORK` |
| `sandbox.network.allowlist` | string[] of host suffixes (`*.suffix` wildcards) | `[]` | `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` |
| `sandbox.readableRoots` | string[] of paths | `["."]` (workspace) | `MONO_AGENT_SANDBOX_READABLE_ROOTS` |
| `sandbox.writableRoots` | string[] of paths | `["."]` (workspace) | `MONO_AGENT_SANDBOX_WRITABLE_ROOTS` |
| `sandbox.denyWrite` | string[] of globs | see defaults below | `MONO_AGENT_SANDBOX_DENY_WRITE` |
| `sandbox.fallback` | `fail-closed` \| `unsafe-host-process` | `fail-closed` | `MONO_AGENT_SANDBOX_FALLBACK` |
| `sandbox.unsafeAllowHostProcess` | boolean | `false` | `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS` |

The engine id is `srt` (the only built-in engine); `srt` must be on `PATH` for `mode: "native"` to take effect.

Check the engine before trusting a sandboxed recipe:

```bash
command -v srt
srt --version
mono-agent validate --recipe sandboxed-code-agent
```

`validate` reports the `Sandbox` section as `ok` only when the native engine is available. If `srt` is missing, a fail-closed policy reports `waiting` with `sandbox_unavailable`; an unsafe fallback reports `waiting` with a warning. The overall config can still validate because `waiting` is not a syntax error, so read the sandbox section and the recipe completeness block before starting.

## Mode

- **`native`** — every sandboxed command is rewritten to `srt --settings <generated-file> <command> ...`. The generated settings file encodes the network and filesystem policy below.
- **`off`** — commands run unwrapped on the host. Equivalent to omitting the `sandbox` block.

## Network policy

`sandbox.network.mode` controls egress from inside the sandbox:

| `network.mode` | Behavior |
| --- | --- |
| `none` | No network access (default). |
| `localhost` | Loopback only. |
| `allowlist` | Only hosts matching `network.allowlist`. |
| `all` | Unrestricted egress. |

Allowlist entries are matched as host suffixes. A leading `*.` is a wildcard suffix — `*.example.com` matches `api.example.com`. There is **no CIDR and no port syntax**; entries are hostnames/suffixes only.

```json
{
  "sandbox": {
    "mode": "native",
    "network": { "mode": "allowlist", "allowlist": ["*.githubusercontent.com", "registry.npmjs.org"] }
  }
}
```

```
MONO_AGENT_SANDBOX_NETWORK=allowlist
MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST=*.githubusercontent.com,registry.npmjs.org
```

## Filesystem scopes

- **`readableRoots`** / **`writableRoots`** — directories the sandboxed process may read from / write to. Relative entries (like `"."`) resolve against the workspace root. Both default to the workspace.
- **`denyWrite`** — write-deny globs applied on top of `writableRoots`. The defaults protect secrets and git internals:

```json
{
  "sandbox": {
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"]
  }
}
```

:::note
If you set `denyWrite` yourself, you replace the defaults — include the four entries above (or merge them in) if you still want that protection.
:::

## Fallback when the engine is unavailable

If `mode: "native"` but no `srt` engine is available (not installed, or `srt --version` fails), the `fallback` decides what happens:

- **`fail-closed`** (default) — the command is rejected with a `sandbox_unavailable` error. Nothing runs unsandboxed.
- **`unsafe-host-process`** — the command runs **unwrapped on the host**. This requires **both** `fallback: "unsafe-host-process"` **and** `unsafeAllowHostProcess: true`. Setting `fallback` to `unsafe-host-process` without the explicit `unsafeAllowHostProcess: true` is a config error.

```json
{
  "sandbox": {
    "mode": "native",
    "fallback": "unsafe-host-process",
    "unsafeAllowHostProcess": true
  }
}
```

:::caution
The `unsafe-host-process` fallback runs tool commands directly on the host with no isolation if the sandbox engine is missing. When it is active, mono-agent reports: `WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.` Use it only in trusted, controlled environments (e.g. CI you own end to end). Prefer `fail-closed` for anything handling untrusted input or running untrusted code.
:::

`mono-agent start` does not silently relax a fail-closed policy. It records the effective sandbox state at startup; `mono-agent status` prints `effective`, `engine`, `fallback`, and whether the fallback is active. For a fail-closed missing engine, sandboxed commands fail with `sandbox_unavailable`. For an unsafe fallback, `start`/`status` include the unsafe warning above so the operator can see that filesystem roots and `denyWrite` entries are not protecting the host process.

## Monotonic merge

When a request supplies its own sandbox policy, it is merged with the configured baseline so the result is **never more permissive** than the configured policy. A request-scoped policy can only tighten — it can never widen filesystem access or re-enable host execution:

- `readableRoots` / `writableRoots` are **intersected** (the request can shrink, not extend, the roots).
- `denyWrite` globs are **unioned** (more denials, never fewer).
- `network` access can only narrow.
- `fallback` collapses to `fail-closed` if either side is `fail-closed`.
- `unsafeAllowHostProcess` stays on only if **both** sides have it on.

This merge is **auto** (the harness performs it). Constructing request-scoped policies is a **code** path — see [Programmatic](/programmatic/).

## Gotcha: provider CLI bridges

:::caution
Some runtime backends are provider CLI bridges that run their own tool loops (their own shell, file, and exec tools) outside the mono-agent shell-command path. Commands those loops spawn are **not** `srt`-wrapped by this sandbox. To confine them, pair this config with the provider's own sandboxing controls. See [Runtime backends](/runtime/backends/) and [Tools and guards](/runtime/tools-and-guards/).
:::

## Related

- [Tool policy](/tools/policy/) — allow/deny which tools the agent can call at all.
- [MCP](/tools/mcp/) — external tool servers.
- [Playbook: sandboxed code agent](/playbooks/sandboxed-code-agent/) — an end-to-end config for an agent that runs untrusted code.
- [Environment variables](/config/env-vars/) — full `MONO_AGENT_*` reference.
