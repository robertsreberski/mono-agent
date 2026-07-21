---
title: "Approval gates & structured output"
description: "Add host-driven tool approvals, structured output, and live in-flight steering through the runtime API."
sidebar:
  order: 2
---

This page covers three programmatic runtime capabilities that have no `mono-agent.config.json` knobs and are wired entirely in host code: human-in-the-loop tool approval, structured output on capable bridges, and live in-flight input steering. All three are **code-only** — they require building on the runtime directly via [composition](/programmatic/composition/) rather than the `mono-agent` CLI.

The closest config-level lever is `runtime.permissionMode`, the declarative tool-permission posture for CLI backends. It is unrelated to the callback-driven approval gates below, but it is the right tool when you want a static posture rather than an interactive prompt — see [Execution effort & permissions](/runtime/execution-effort-permissions/) and [Tool policy](/tools/policy/).

## Human-in-the-loop approval gates

Approval gates let your host pause a tool call, ask a human (or another system) to approve or deny it, and resume. They are configured by passing options to `createMonoRuntime`. There is **no config key** for these — the runtime cannot answer an approval prompt on its own, so a host UI (TUI, web app, Slack message, etc.) must supply the answer.

`code` — coverage type. See `runtime.approval-gates` in the [feature registry](/reference/feature-registry/).

| Option | Purpose |
| --- | --- |
| `onToolApprovalRequest` | Async callback invoked per gated tool call; returns `{ decision: "approve" \| "deny" \| "always", reason? }`. This is the host UI hook. |
| `toolRiskTiers` | Map of tool name → risk tier, used to decide which calls require approval. |
| `approvalDefaultRiskTier` | Tier assigned to any tool not listed in `toolRiskTiers`. |
| `approvalTimeoutMs` | How long to wait for `onToolApprovalRequest`; timeout always denies the call. |
| `approvalAlwaysAllowTools` | Tool names that bypass the gate entirely (auto-approved). |

<!-- doc-test:typescript -->

```ts
import {
  createMonoRuntime,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";

const runtime = createMonoRuntime({
  workspace: process.cwd(),
  toolRiskTiers: {
    Bash: "high",
    Edit: "high",
    Read: "low",
  },
  approvalDefaultRiskTier: "medium",
  approvalAlwaysAllowTools: ["Read", "Grep"],
  approvalTimeoutMs: 60_000,
  onToolApprovalRequest: async (req) => {
    console.log(req.toolName, req.riskTier, req.argumentsSummary);
    // Replace this policy with a prompt in your TUI, web UI, or chat adapter.
    return req.toolName === "Bash"
      ? { decision: "deny", reason: "Reviewer denied shell access." }
      : { decision: "approve" };
  },
});

const result = await runtime.run("You are a careful repository assistant.", {
  model: parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"),
  messages: [{ role: "user", content: "Inspect README.md." }],
  abortSignal: new AbortController().signal,
  cwd: process.cwd(),
  allowedTools: ["Read", "Bash"],
});
```

Approval fallback is deterministic, but it is backend-specific:

| Situation | Claude SDK and Pi managed tools | Direct OpenCode permission events |
| --- | --- | --- |
| No callback configured | No shared approval manager is installed; the backend's normal tool-permission behavior applies. | An explicit permission request is denied in `default` mode. `plan`, `acceptEdits`, and `bypassPermissions` apply their documented native rules. |
| Low-risk request with a callback | The shared manager auto-approves it without calling the callback. | OpenCode's explicit permission request always reaches the callback. |
| Callback times out or throws | Deny. | Deny. |
| Callback returns an invalid value | Approve low/medium risk; deny high risk. | Deny at every risk tier. |

`{ decision: "always" }` approves the current call and adds that tool to the
current run's allowlist. A timeout or callback exception for a gated call is
always reported as `tool_approval_denied`; it never falls back to approval.
When using the exported low-level `createApprovalManager()` directly without a
callback, its own defaults are low/medium approve and high deny. The Pi and
Claude SDK bridges do not construct that manager unless a callback is present,
so those low-level no-callback defaults are not bridge policy.

Bridge coverage is capability-specific. Claude SDK and Pi gate managed tool
dispatch through the shared approval manager when a callback is present.
Direct OpenCode translates its native permission events through an isolated
provider server and deliberately rejects invalid callback answers. Claude CLI
and Codex app-server use their backend-native permission or approval posture
rather than the shared per-call gate.

:::tip
Use `approvalAlwaysAllowTools` for read-only tools so reviewers are only interrupted for genuinely risky actions. Pair it with `toolRiskTiers` so the bulk of your approval policy is declarative and `onToolApprovalRequest` only handles the cases that actually reach a human.
:::

### When to use `runtime.permissionMode` instead

If you do not need interactive, per-call decisions, the config-level posture is simpler and requires no host code:

```json
{
  "runtime": {
    "permissionMode": "default"
  }
}
```

Env var: `MONO_AGENT_PERMISSION_MODE` (`default` / `plan` / `acceptEdits` / `bypassPermissions`). This applies to CLI backends and is a static posture, not a callback. See [Execution effort & permissions](/runtime/execution-effort-permissions/).

## Structured output

`RuntimeRunOptions.outputSchema` supplies a JSON schema to capable backends.
Provide it directly to `run()` or through harness request options.

`code` — coverage type. See `runtime.structured-output` in the [feature registry](/reference/feature-registry/).

<!-- doc-test:typescript -->

```ts
import {
  createMonoRuntime,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";

const runtime = createMonoRuntime();
const result = await runtime.run("Return only the requested structured result.", {
  model: parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"),
  messages: [{ role: "user", content: "Summarize the incident and assign low or high priority." }],
  abortSignal: new AbortController().signal,
  outputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      priority: { type: "string", enum: ["low", "high"] },
    },
    required: ["summary", "priority"],
    additionalProperties: false,
  },
});

if (result.structuredResult === undefined) {
  throw new Error("The selected bridge did not return captured structured output.");
}
console.log(result.structuredResult);
```

:::caution
Backend support varies. Claude SDK, Claude CLI, and Pi return captured JSON in
`structuredResult`. Codex app-server enforces the schema but returns the JSON in
`text`, so the host must parse it. Direct OpenCode rejects `outputSchema` with a
typed capability mismatch. In every case, validate the value in host code before
using it for state changes.
:::

For per-request schemas in a hosted responder, set `outputSchema` from `runtimeOptionsForRequest` (the `harness.request-runtime-options` hook) so each request can carry its own schema. See [composition](/programmatic/composition/) for the responder wiring.

## Live input steering

`RuntimeRunOptions.liveInput` accepts an
`AsyncIterable<{ body: string; id?: string }>` that injects additional user
messages while a turn is running — useful for "stop, also do X" steering from a
host UI without cancelling and restarting the turn.

`code` — coverage type. See `runtime.live-input` in the [feature registry](/reference/feature-registry/).

<!-- doc-test:typescript -->

```ts
import {
  createMonoRuntime,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";

async function* steeringMessages(): AsyncIterable<{ body: string; id?: string }> {
  yield { id: "steer-1", body: "Also list any unresolved questions." };
}

const runtime = createMonoRuntime();
const result = await runtime.run("You are a careful analyst.", {
  model: parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"),
  messages: [{ role: "user", content: "Analyze this incident." }],
  abortSignal: new AbortController().signal,
  liveInput: steeringMessages(),
});
```

The generator above demonstrates the wire shape. A real host usually backs the
async iterable with a queue that its UI can push to during the run. Combine it
with the per-request options hook so steering is available exactly on the turns
that need it. A bridge that cannot represent live input fails capability checks
instead of silently dropping the stream.

## Related

- [Composition](/programmatic/composition/) — building on `createMonoRuntime` and configured responders.
- [Multi-agent](/programmatic/multi-agent/) — orchestrating collaborator responders.
- [Execution effort & permissions](/runtime/execution-effort-permissions/) — config-level `permissionMode` posture.
- [Tool policy](/tools/policy/) — allow/deny lists and tool guards.
