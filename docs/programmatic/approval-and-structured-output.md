---
title: "Approval gates & structured output"
description: "Add host-driven tool approvals, structured output, and live in-flight steering through the runtime API."
sidebar:
  order: 2
---

This page covers three runtime capabilities that have no `mono-agent.config.json`
knobs: human-in-the-loop tool approval, structured output on capable bridges,
and live in-flight input steering. The direct runtime APIs are **code-only**.
The managed Slack, Telegram, and web-console hosts additionally expose live
steering automatically when the selected backend supports it.

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
  model: parseMonoRuntimeModelReference("openai-codex:gpt-5.6-terra"),
  messages: [{ role: "user", content: "Inspect README.md." }],
  abortSignal: new AbortController().signal,
  cwd: process.cwd(),
  allowedTools: ["Read", "Bash"],
});
```

Approval fallback is deterministic:

| Situation | Pi managed tools |
| --- | --- |
| No callback configured | No shared approval manager is installed; the Pi runtime's normal tool-permission behavior applies. |
| Low-risk request with a callback | The shared manager auto-approves it without calling the callback. |
| Callback times out or throws | Deny. |
| Callback returns an invalid value | Approve low/medium risk; deny high risk. |

`{ decision: "always" }` approves the current call and adds that tool to the
current run's allowlist. A timeout or callback exception for a gated call is
always reported as `tool_approval_denied`; it never falls back to approval.
The Pi runtime only constructs the approval manager when a callback is present
(`onToolApprovalRequest`), so the manager's no-callback defaults are not bridge
policy.

Bridge coverage is uniform: the Pi runtime gates managed tool dispatch through
the shared approval manager when a callback is present. There are no separate
backend-native approval seams.

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

Env var: `MONO_AGENT_PERMISSION_MODE` (`default` / `plan` / `acceptEdits` / `bypassPermissions`). This is a static posture, but the Pi runtime does not consume it — supervision is driven by the direct tool policy and the per-call approval manager. See [Execution effort & permissions](/runtime/execution-effort-permissions/).

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
  model: parseMonoRuntimeModelReference("openai-codex:gpt-5.6-terra"),
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
  throw new Error("The selected provider did not return captured structured output.");
}
console.log(result.structuredResult);
```

:::caution
The Pi runtime enforces `outputSchema` through its `StructuredOutput` tool and
returns the captured JSON in `structuredResult` for every provider. A run that
stops without text and without calling the tool is re-prompted once with only
`StructuredOutput` enabled; `structuredResult` can still be absent after an
external abort, when `maxTurns` is hit, after an error/aborted stop reason, or
when explanatory text is produced. Validate the value in host code before using
it for state changes.
:::

For per-request schemas in a hosted responder, set `outputSchema` from `runtimeOptionsForRequest` (the `harness.request-runtime-options` hook) so each request can carry its own schema. See [composition](/programmatic/composition/) for the responder wiring.

## Live input steering

`RuntimeRunOptions.liveInput` accepts an async iterable of
`RuntimeLiveInputMessage` values that inject additional user messages while a
turn is running — useful for "stop, also do X" guidance from a host UI without
cancelling and restarting the turn. Native queue acceptance and consumption are
different facts: `accepted()` reports only the former, while `acknowledge()` is
reserved for exact evidence that the owned Pi operation appended that entry to
its transcript. This does not prove provider receipt, use, or adherence.
`reject(error)` reports proved pre-consumption non-delivery; `uncertain()` fences
delivery that may have happened and must not be retried automatically.

`auto + code` — coverage type. See `runtime.live-input` in the [feature registry](/reference/feature-registry/).

<!-- doc-test:typescript -->

```ts
import {
  createMonoRuntime,
  parseMonoRuntimeModelReference,
  type RuntimeLiveInputMessage,
} from "@mono-agent/runtime-adapter";

async function* steeringMessages(): AsyncIterable<RuntimeLiveInputMessage> {
  yield {
    id: "steer-1",
    body: "Also list any unresolved questions.",
    accepted: () => console.log("Accepted by the native queue."),
    acknowledge: () => {
      console.log("Consumed by the active run.");
      return "recorded";
    },
    uncertain: () => "recorded",
  };
}

const runtime = createMonoRuntime();
const result = await runtime.run("You are a careful analyst.", {
  model: parseMonoRuntimeModelReference("openai-codex:gpt-5.6-terra"),
  messages: [{ role: "user", content: "Analyze this incident." }],
  abortSignal: new AbortController().signal,
  liveInput: steeringMessages(),
});
```

The generator above demonstrates the provider-facing shape. A custom host
usually backs the iterable with a queue that its UI can push to during the run.
A direct runtime call fails capability checks when the active provider cannot
represent live input instead of silently dropping the stream; the Pi runtime
supports it on every provider.

Exact consumption publishes one metadata-only `live_input_consumed` event.
Only when the host callback returns the exact synchronous value `"recorded"`
does the runtime also publish the compatible `live_input_applied` event. The
standard responder then projects `↪️ Steered: “<safe preview>”`, with result
`Consumed by current run`. Events never contain the guidance body. The preview
is one line, secret-redacted, path-collapsed, and capped at 40 Unicode code
points; the full text remains the human message.

The standard agent responder owns that queue for ordinary interactive turns.
Slack and Telegram reserve the incoming message's normal per-conversation queue
position before offering it; the web console persists the same fallback in
SQLite. Only proved non-delivery becomes the next normal turn. Once native
delivery may have happened, uncertainty is permanent and no automatic fallback
runs. Attachments, commands, and `AskUser` answers retain their existing
non-steering paths.

Stable, unique `id` values enable safe replay only after proved rejection. The
first occurrence owns its body and callbacks; later occurrences of that ID are
suppressed. A retryable first owner may be replayed when a later iterator exposes
the same ID. Values without an ID are accepted only from the first iterator
generation because a naive iterable cannot identify them safely across retries.

Callbacks retain an `unknown` return type for source compatibility. The runtime
recognizes only exact synchronous `"recorded"` and `"ignored"` values; `void`,
promises/thenables, other values, and exceptions do not confirm host settlement
and never reopen runtime replay. Hosts should return `"recorded"` only after an
atomic settlement transition.

## Related

- [Composition](/programmatic/composition/) — building on `createMonoRuntime` and configured responders.
- [Multi-agent](/programmatic/multi-agent/) — orchestrating collaborator responders.
- [Execution effort & permissions](/runtime/execution-effort-permissions/) — config-level `permissionMode` (validated and forwarded, not consumed by the Pi runtime).
- [Tool policy](/tools/policy/) — allow/deny lists and tool guards.
