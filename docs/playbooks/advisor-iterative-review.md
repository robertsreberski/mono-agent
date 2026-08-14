---
title: "Iterative Advisor Review"
description: "Run a stable, bounded implementation-review loop from Codex or Claude Code through the Advisor MCP channel."
sidebar:
  order: 8
---

This playbook connects an implementation client to the plugin-tier Advisor MCP
channel, sends each patch iteration under one stable continuity key, and stops
only when the configured advisor reports no blocking findings.

## Who this is for

Developers who want an external implementation loop reviewed by one exact
mono-agent model without giving that reviewer filesystem, shell, MCP, or write
authority.

## Goal

Keep implementation in the caller, review in one bounded `review_iteration`
tool, and make model/effort selection, cancellation, and failures explicit.

## Features used

- [`advisor.mcp`](/channels/advisor/) — stateless Streamable HTTP MCP with
  bounded review continuity and a request-scoped no-tools policy.
- [`channel.plugins`](/programmatic/custom-channels/) — config-loaded external
  channel package.

## Setup

1. Install matching lockstep versions of `@mono-agent/agent-app` and
   `@mono-agent/advisor-mcp`.
2. Add the Advisor plugin config from the [channel guide](/channels/advisor/),
   selecting an enforcing route such as `pi:openai-codex:gpt-5.6-sol` and an
   explicit effort such as `max`. Keep the host primary in the same compatible
   runtime family; a direct `codex:*` primary cannot switch to this `pi:*` route.
3. Put a random bearer in `MONO_AGENT_ADVISOR_BEARER_TOKEN`, then run
   `mono-agent validate` and `mono-agent start --foreground`.
4. Register `http://127.0.0.1:4312/mcp` in Codex or Claude Code using the exact
   command in the channel guide.
5. Ask the client to list MCP tools. It must see exactly `review_iteration`.

## Review loop

Use one opaque, stable `session_key` for the logical task. Send actual patch
text and verification output—not paths or instructions to inspect the caller's
machine.

```json
{
  "session_key": "issue-634-advisor-loop",
  "intent": "Expose a hardened, bounded implementation-review MCP endpoint.",
  "patch": "diff --git a/extras/advisor-mcp/src/server.ts b/extras/advisor-mcp/src/server.ts\n...",
  "verification": "Package tests: 61 passed. Typecheck and build passed.",
  "metadata": {
    "iteration": 1,
    "head": "abc1234"
  }
}
```

Then iterate:

1. Implement only the concrete findings you accept.
2. Rerun the relevant checks.
3. Call `review_iteration` again with the same `session_key`, the new patch,
   fresh verification, and an incremented metadata iteration.
4. Treat every non-`ok` result as a visible failed review attempt. Do not infer
   approval from `advisor_busy`, timeout, cancellation, cleanup failure, or a
   provider failover.
5. Stop when the `ok` review has no blocking findings and the caller's own
   verification remains green.

The server serializes calls sharing one continuity id. If an earlier call is
still active, the next returns `advisor_busy`; retry after the first call
settles rather than changing the session key and losing continuity.

## Security expectations

- The caller owns repository access, patch application, commands, and commits.
- The advisor receives only the submitted bounded text plus endpoint-owned
  prompt policy.
- The advisor request overrides the host model/effort for that turn and replaces
  all host tools and MCP servers with an empty policy.
- The same authoritative seal suppresses automatic memory before any backend
  recall query, so prior private host notes cannot enter the review.
- The server hashes the normalized namespace and session key; it stores no
  review body, key, prompt, token, or model output in continuity state.
- The configured responder may retain payloads and reviews after the turn
  through the host's normal history, artifact, observability, or memory capture
  policy. Never submit
  credentials or other secrets.
- Keep the endpoint on loopback unless a separately reviewed authenticated
  exposure is necessary. Prefer private HTTPS through Tailscale Serve over a
  direct non-loopback application bind.

## Smoke test

Call the tool once with a small synthetic patch. Confirm `schema` is
`mono-agent.advisor.v1`, `code` is `ok`, `model` and `effort` exactly match the
plugin config, and no MCP session id is returned. Repeat with the same key and
confirm the same `continuity_id`.

## Related

- [Advisor MCP channel](/channels/advisor/)
- [Tool policy](/tools/policy/)
- [Sessions and concurrency](/runtime/sessions-concurrency/)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
