---
title: "Approval gates & structured output"
parent: "Programmatic"
nav_order: 2
---

# Approval gates & structured output

This page covers three programmatic runtime capabilities that have no `mono-agent.config.json` knobs and are wired entirely in host code: human-in-the-loop tool approval, JSON-schema-enforced structured output, and live in-flight input steering. All three are **code-only** — they require building on the runtime directly via [composition](composition.md) rather than the `mono-agent` CLI.

The closest config-level lever is `runtime.permissionMode`, the declarative tool-permission posture for CLI backends. It is unrelated to the callback-driven approval gates below, but it is the right tool when you want a static posture rather than an interactive prompt — see [Execution effort & permissions](../runtime/execution-effort-permissions.md) and [Tool policy](../tools/policy.md).

## Human-in-the-loop approval gates

Approval gates let your host pause a tool call, ask a human (or another system) to approve or deny it, and resume. They are configured by passing options to `createMonoRuntime`. There is **no config key** for these — the runtime cannot answer an approval prompt on its own, so a host UI (TUI, web app, Slack message, etc.) must supply the answer.

`code` — coverage type. See `runtime.approval-gates` in [feature-registry.md](../feature-registry.md).

| Option | Purpose |
| --- | --- |
| `onToolApprovalRequest` | Async callback invoked per gated tool call; returns the approve/deny decision. This is the host UI hook. |
| `toolRiskTiers` | Map of tool name → risk tier, used to decide which calls require approval. |
| `approvalDefaultRiskTier` | Tier assigned to any tool not listed in `toolRiskTiers`. |
| `approvalTimeoutMs` | How long to wait for `onToolApprovalRequest` to resolve before falling back. |
| `approvalAlwaysAllowTools` | Tool names that bypass the gate entirely (auto-approved). |

```ts
import { createMonoRuntime } from "@mono-agent/agent-runtime";

const runtime = createMonoRuntime({
  // ...your normal runtime config...
  toolRiskTiers: {
    Bash: "high",
    Edit: "high",
    Read: "low",
  },
  approvalDefaultRiskTier: "medium",
  approvalAlwaysAllowTools: ["Read", "Grep"],
  approvalTimeoutMs: 60_000,
  onToolApprovalRequest: async (req) => {
    // req describes the tool call + its risk tier.
    // Surface it to a human and return their decision.
    const decision = await askHumanToApprove(req);
    return decision; // approve | deny
  },
});
```

If `onToolApprovalRequest` does not resolve within `approvalTimeoutMs`, the gate falls back rather than hanging the turn — design your host so a slow or absent reviewer produces a safe outcome (treat a timeout as a denial unless you have a reason not to).
{: .warning }

Use `approvalAlwaysAllowTools` for read-only tools so reviewers are only interrupted for genuinely risky actions. Pair it with `toolRiskTiers` so the bulk of your approval policy is declarative and `onToolApprovalRequest` only handles the cases that actually reach a human.
{: .tip }

### When to use `runtime.permissionMode` instead

If you do not need interactive, per-call decisions, the config-level posture is simpler and requires no host code:

```json
{
  "runtime": {
    "permissionMode": "default"
  }
}
```

Env var: `MONO_AGENT_PERMISSION_MODE` (`default` / `plan` / `acceptEdits` / `bypassPermissions`). This applies to CLI backends and is a static posture, not a callback. See [Execution effort & permissions](../runtime/execution-effort-permissions.md).

## Structured output

`runtimeOptions.outputSchema` enforces a JSON schema on the model's final output on capable backends. Provide it through the harness options when you build a turn.

`code` — coverage type. See `runtime.structured-output` in [feature-registry.md](../feature-registry.md).

```ts
const result = await runtime.run({
  // ...request...
  runtimeOptions: {
    outputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        priority: { type: "string", enum: ["low", "high"] },
      },
      required: ["summary", "priority"],
      additionalProperties: false,
    },
  },
});
```

Backend support varies. Schema enforcement is honored only on backends that expose a structured-output field; for example the **opencode** CLI backend has no structured-output field, so `outputSchema` is not enforced there. Confirm support for your chosen `runtime.model` backend before relying on it, and validate the returned payload host-side as a safety net.
{: .warning }

For per-request schemas in a hosted responder, set `outputSchema` from `runtimeOptionsForRequest` (the `harness.request-runtime-options` hook) so each request can carry its own schema. See [composition](composition.md) for the responder wiring.

## Live input steering

`runtimeOptions.liveInput` provides an in-flight queue for injecting additional user messages into a turn while the model is still working — useful for "stop, also do X" style steering from a host UI without cancelling and restarting the turn.

`code` — coverage type. See `runtime.live-input` in [feature-registry.md](../feature-registry.md).

```ts
const result = await runtime.run({
  // ...request...
  runtimeOptions: {
    liveInput: liveInputQueue, // host pushes steering messages here mid-turn
  },
});
```

Live input is a host-driven primitive: your UI owns the queue and decides when to push. Combine it with the per-request options hook so steering is available exactly on the turns that need it.

## Related

- [Composition](composition.md) — building on `createMonoRuntime` and configured responders.
- [Multi-agent](multi-agent.md) — orchestrating collaborator responders.
- [Execution effort & permissions](../runtime/execution-effort-permissions.md) — config-level `permissionMode` posture.
- [Tool policy](../tools/policy.md) — allow/deny lists and tool guards.
