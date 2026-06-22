---
title: "Sandboxed Code Agent (No Internet, Deny .env)"
sidebar:
  order: 9
---

# Sandboxed Code Agent (No Internet, Deny .env)

This playbook builds a code-reading assistant that can run `Bash` inside the native `srt` sandbox with no network access and protected secrets, while recalling prior context from local journal memory. Every capability here is `config`-driven — no code required.

## Who this is for

Security team deploying an internal code assistant.

## Goal

An agent that can read repos and run Bash inside the native `srt` sandbox with no network and protected secrets, recalling context from local memory.

## Features used

- [`sandbox.mode`](/tools/sandbox/) — native (`srt`-wrapped commands) vs off
- [`sandbox.network-policy`](/tools/sandbox/) — `none` / `localhost` / `allowlist` / `all`
- [`sandbox.filesystem-scopes`](/tools/sandbox/) — readable/writable roots + deny-write globs
- [`sandbox.fallback`](/tools/sandbox/) — `fail-closed` vs `unsafe-host-process` when `srt` is unavailable
- [`tool-policy.allowlist`](/tools/policy/) — restrict the agent to a minimal built-in tool set
- [`memory.journal`](/memory/capture-and-recall/) — local journal recall for prior context

## Configuration

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "tools": {
    "allowedTools": ["Read", "Grep", "Bash"]
  },
  "sandbox": {
    "mode": "native",
    "network": {
      "mode": "none"
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
Keep `fallback` at `fail-closed`. Setting `unsafeAllowHostProcess: true` (or `fallback: unsafe-host-process`) lets commands run un-sandboxed on the host when `srt` is unavailable — never do this for a security-sensitive deployment.
:::

## Steps

1. `mono-agent init --model claude:claude-sonnet-4-6 --memory journal`
2. Set `tools.allowedTools` to `Read`/`Grep`/`Bash`; configure `sandbox.mode` native + `network.mode` none + the deny-write defaults.
3. Keep `fallback` at `fail-closed` (do NOT set `unsafe-host-process`).
4. `mono-agent validate` then `mono-agent start`.
5. Ask the agent to inspect the repo and run a Bash command; confirm it cannot reach the network or write `.env`.
6. Note: provider CLI bridges run their own tool loops and are not yet `srt`-wrapped (pair with provider sandboxing).

## Smoke test

:::tip
Ask the agent to read a file and run a Bash command; confirm success, then ask it to fetch a URL or write `.env` and confirm both are blocked by the sandbox policy in the run artifact.
:::

## Related

- [Sandbox](/tools/sandbox/)
- [Tool Policy](/tools/policy/)
- [Memory: Capture and Recall](/memory/capture-and-recall/)
- [Runtime: Tools and Guards](/runtime/tools-and-guards/)
- [Observability: Artifacts and Traces](/observability/artifacts-and-traces/)
- [Composer skill](/context/skills/)
