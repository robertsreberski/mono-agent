---
title: "Sandboxed Code Agent (Loopback Only, Deny .env)"
sidebar:
  order: 9
---

# Sandboxed Code Agent (Loopback Only, Deny .env)

This playbook builds a code-reading assistant that can run `Bash` inside the native `srt` sandbox with loopback-only network access and protected secrets, while recalling prior context from local journal memory. Every capability here is `config`-driven — no code required.

Prerequisite: `srt` must be installed and on `PATH`. This recipe uses `fallback: "fail-closed"`, so a missing engine makes sandboxed commands fail with `sandbox_unavailable` instead of running unsandboxed.

## Who this is for

Security team deploying an internal code assistant.

## Goal

An agent that can read repos and run Bash inside the native `srt` sandbox with loopback-only network access and protected secrets, recalling context from local memory.

## Features used

- [`sandbox.mode`](/tools/sandbox/) — native (`srt`-wrapped commands) vs off
- [`sandbox.network-policy`](/tools/sandbox/) — `none` / `localhost` / `allowlist` / `all`
- [`sandbox.filesystem-scopes`](/tools/sandbox/) — readable/writable roots + deny-write globs
- [`sandbox.fallback`](/tools/sandbox/) — `fail-closed` vs `unsafe-host-process` when `srt` is unavailable
- [`tool-policy.allow-all`](/tools/policy/) — allow-all tools (`["*"]`); the sandbox, not an allowlist, is what constrains the code tools
- [`memory.journal`](/memory/capture-and-recall/) — local journal recall for prior context

## Configuration

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "tools": {
    "allowedTools": ["*"]
  },
  "sandbox": {
    "mode": "native",
    "network": {
      "mode": "localhost"
    },
    "readableRoots": ["."],
    "writableRoots": ["."],
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"],
    "fallback": "fail-closed"
  }
}
```

The `denyWrite` globs above are the built-in defaults — listed explicitly here to make the secret-protection contract obvious. Relative `readableRoots`/`writableRoots` entries resolve against the workspace. The matching env vars are `MONO_AGENT_SANDBOX_MODE`, `MONO_AGENT_SANDBOX_NETWORK`, `MONO_AGENT_SANDBOX_READABLE_ROOTS`, `MONO_AGENT_SANDBOX_WRITABLE_ROOTS`, `MONO_AGENT_SANDBOX_DENY_WRITE`, and `MONO_AGENT_SANDBOX_FALLBACK`.

:::caution
Keep `fallback` at `fail-closed`. Setting `fallback: "unsafe-host-process"` plus `unsafeAllowHostProcess: true` lets commands run unsandboxed on the host when `srt` is unavailable. When that fallback is active, mono-agent reports `WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.` Never use that fallback for a security-sensitive deployment.
:::

## Steps

1. `mono-agent init --model claude:claude-sonnet-4-6 --memory journal`
2. Run `command -v srt && srt --version`; install/fix `srt` before treating the sandbox as available.
3. Leave `tools.allowedTools` at the allow-all default (`["*"]`) — under allow-all the code tools (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`Bash`) are already available, and the **sandbox**, not an allowlist, is what constrains them. Configure `sandbox.mode` native + `network.mode` localhost + the deny-write defaults. (To harden further you *can* still narrow `allowedTools` to a specific set, but it is not what makes this agent safe.)
4. Keep `fallback` at `fail-closed` (do NOT set `unsafe-host-process`).
5. `mono-agent validate --preset code-sandbox`; the `Sandbox` section should be `ok`. If it is `waiting` with `sandbox_unavailable`, `start` will not silently relax the policy — sandboxed commands will fail closed until `srt` is available.
6. `mono-agent start`, then `mono-agent status`; confirm the sandbox line reports `effective: native`, the `srt` engine present, and `fallback active: no`.
7. Ask the agent to inspect the repo and run a Bash command; confirm external network calls are blocked while loopback still works, and confirm it cannot write `.env`.
8. Note: provider CLI bridges run their own tool loops and are not yet `srt`-wrapped (pair with provider sandboxing).

## Smoke test

:::tip
Ask the agent to read a file and run a Bash command; confirm success, then ask it to fetch an external URL or write `.env` and confirm both are blocked by the sandbox policy in the run artifact.
:::

## Related

- [Sandbox](/tools/sandbox/)
- [Tool Policy](/tools/policy/)
- [Memory: Capture and Recall](/memory/capture-and-recall/)
- [Runtime: Tools and Guards](/runtime/tools-and-guards/)
- [Observability: Artifacts and Traces](/observability/artifacts-and-traces/)
- [Composer skill](/context/skills/)
