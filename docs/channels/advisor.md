---
title: "Advisor MCP"
description: "Expose one bounded review_iteration tool over hardened Streamable HTTP MCP for iterative external-agent review."
sidebar:
  order: 7
---

The plugin-tier `@mono-agent/advisor-mcp` package gives Codex, Claude Code, or
another Streamable HTTP MCP client one review-only tool: `review_iteration`.
Each call submits bounded intent, patch text, and verification evidence to one
explicit mono-agent model and effort. The endpoint cannot read a caller path,
apply a patch, run a command, or inherit the host's tools and MCP servers.

Coverage: **config**. Install the package at the same lockstep version as
`@mono-agent/agent-app`, then load it through `channels.plugins[]`.

## Install and configure

```bash
pnpm add @mono-agent/agent-app@latest @mono-agent/advisor-mcp@latest
```

Add this to `mono-agent.config.json`:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/advisor-mcp",
        "id": "advisor",
        "label": "Advisor MCP",
        "config": {
          "enabled": true,
          "host": "127.0.0.1",
          "port": 4312,
          "path": "/mcp",
          "requireBearer": true,
          "model": "pi:openai-codex:gpt-5.6-sol",
          "effort": "max",
          "namespace": "review-production",
          "maxConcurrentReviews": 2
        }
      }
    ]
  }
}
```

Keep the token outside source config:

```bash
export MONO_AGENT_ADVISOR_BEARER_TOKEN='replace-with-a-random-secret'
mono-agent validate
mono-agent start --foreground
```

The endpoint is `http://127.0.0.1:4312/mcp`. Plugin environment values override
the matching nested `config` values. Adding or removing the package requires a
host restart because channel plugins are resolved at startup.

:::caution
Use an advisor model route that can enforce an empty tool set. A Pi SDK route
such as `pi:openai-codex:gpt-5.6-sol` is the recommended Codex-backed form.
Direct `codex:*`, direct `opencode:*`, and Claude CLI routes reject this
boundary. Claude SDK can enforce it when the host's execution mode is `sdk`.
The selected advisor route must also be compatible with the host primary's
runtime family: a direct `codex:*` host cannot switch an advisor turn to `pi:*`.
An advisor chain containing a direct OpenCode fallback is rejected because that
chain cannot preserve the configured effort on every attempt.
Invalid model/effort metadata fails the turn instead of using the host default.
If the provider router emits a failover, the fallback answer is discarded and
the call returns `advisor_run_failed`.
:::

## Register the client

### Codex

Codex accepts a Streamable HTTP URL and reads the bearer from an environment
variable, so the token is not copied into its config:

```bash
codex mcp add advisor --url http://127.0.0.1:4312/mcp --bearer-token-env-var MONO_AGENT_ADVISOR_BEARER_TOKEN
codex mcp get advisor
```

For a deliberately unauthenticated same-user loopback endpoint, omit
`--bearer-token-env-var`. See the official [Codex MCP documentation](https://developers.openai.com/codex/mcp/).

### Claude Code

Claude Code expands environment variables in HTTP MCP headers. Single quotes
below preserve the placeholder while writing the configuration:

```bash
claude mcp add-json advisor \
  '{"type":"http","url":"http://127.0.0.1:4312/mcp","headers":{"Authorization":"Bearer ${MONO_AGENT_ADVISOR_BEARER_TOKEN}"}}'
claude mcp get advisor
```

`streamable-http` is also accepted as the JSON `type`. See Anthropic's
[Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

## Tool contract

The endpoint creates a fresh stateless MCP server/transport for each HTTP POST.
It never issues or accepts an MCP session id. Review continuity is separate:
the normalized `(namespace, session_key)` pair maps to a one-way
`advisor:<32 hex characters>` conversation id. The bounded cache retains only
that id plus creation/last-use timestamps and a call count—never the key,
patch, prompt, model output, token, or runtime handle.

```json
{
  "session_key": "issue-634-review",
  "intent": "Add a bounded external implementation-review endpoint.",
  "patch": "diff --git a/src/server.ts b/src/server.ts\n...",
  "verification": "Focused tests and typecheck pass.",
  "metadata": {
    "iteration": 1,
    "commit": "abc1234"
  }
}
```

| Argument | Required | Bound | Meaning |
| --- | --- | --- | --- |
| `session_key` | yes | 512 UTF-16 code units / 2048 UTF-8 bytes | Stable caller key for review continuity; normalized before hashing and never sent in the prompt. |
| `intent` | yes | `maxIntentChars` | What the implementation is meant to achieve. |
| `patch` | yes | `maxPatchChars` | Patch **content**, not a path. The advisor has no caller filesystem access. |
| `verification` | no | `maxVerificationChars` | Test/build/smoke evidence supplied as untrusted text. |
| `metadata` | no | 32 entries | Scalar or bounded string-array facts. Keys and values are independently bounded. |

Unknown arguments, malformed metadata, and a serialized argument object over
`maxRequestBytes` are rejected at the MCP schema boundary. Input text is marked
as untrusted inside an endpoint-owned containment prompt; caller prose cannot
change the model, effort, tool policy, or operator prompt.

A success has stable schema `mono-agent.advisor.v1`:

```json
{
  "schema": "mono-agent.advisor.v1",
  "status": "succeeded",
  "code": "ok",
  "continuity_id": "advisor:0123456789abcdef0123456789abcdef",
  "model": "pi:openai-codex:gpt-5.6-sol",
  "effort": "max",
  "review": "1. ...",
  "truncated": false
}
```

Review text is normalized, redacts high-confidence credentials and private home
or temporary paths, and is fitted to both `maxOutputChars` and
`maxResponseBytes`. Server logs contain endpoint facts and generic lifecycle
messages, not request bodies, bearer values, raw model errors, or caller keys.
The package-owned continuity cache also stores metadata only. The configured
responder remains subject to the host's ordinary conversation-history,
run-artifact, observability, and memory policies, which can retain submitted
payloads and reviews. Never submit credentials or secrets to the tool.

## Configuration reference

| Plugin `config` key | Default | Allowed values / behavior |
| --- | --- | --- |
| `enabled` | `false` | Opt in to the listener. An enabled endpoint requires `model` and `effort`. |
| `host` | `127.0.0.1` | Bind host. Exact loopback is safe by default. |
| `port` | `4312` | Integer 0–65535; `0` selects an ephemeral test/programmatic port. |
| `path` | `/mcp` | Exact absolute literal path, with no query, fragment, controls, or Express router metacharacters (`: * ( ) { } ? + [ ] ! \\`). |
| `allowNonLoopback` | `false` | Explicitly permit a non-loopback bind; also requires bearer auth and an explicit host allowlist. |
| `requireBearer` | `false` | Require one `Authorization: Bearer` header. Non-loopback binds require auth regardless. |
| `bearerToken` | — | Expected token; prefer `MONO_AGENT_ADVISOR_BEARER_TOKEN`. Maximum 4096 characters. |
| `allowedHosts` | loopback names/literals | Exact DNS-rebinding defense for the HTTP `Host` hostname. Up to 64 entries; no ports or schemes. |
| `allowedOrigins` | `[]` | Exact HTTP(S) origins permitted when an `Origin` header is present. Requests without Origin remain valid. |
| `model` | — | Required explicit mono-agent runtime model reference. Maximum 512 characters. |
| `effort` | — | Required: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. |
| `maxRequestBytes` | `4194304` | 1024–4194304. Hard HTTP and tool-argument ceiling (4 MiB maximum). |
| `maxIntentChars` | `4000` | 1–100000. |
| `maxPatchChars` | `400000` | 1–25000000; the byte ceiling still applies first over HTTP. |
| `maxVerificationChars` | `120000` | 1–25000000; the byte ceiling still applies first over HTTP. |
| `maxOutputChars` | `64000` | 1024–250000. |
| `maxResponseBytes` | `524288` | 16384–1048576; includes duplicated text plus structured content. |
| `maxRunMs` | `900000` | 0–86400000; `0` disables the run timer, not disconnect/shutdown cancellation. |
| `maxConcurrentReviews` | `2` | 1–64 active reviews. A second active call for the same continuity is always busy. |
| `maxSessions` | `64` | 1–10000 metadata-only continuity entries. |
| `sessionTtlMs` | `21600000` | 60000–86400000; idle-entry TTL. |
| `namespace` | `default` | Deployment/principal isolation salt; bounded to 128 characters and normalized before hashing. |
| `operatorPrompt` | — | Optional endpoint-owned review instructions, maximum 16000 characters. |

## Environment variables

Every public plugin field has a matching override:

| Environment variable | Plugin `config` key |
| --- | --- |
| `MONO_AGENT_ADVISOR_ENABLED` | `enabled` |
| `MONO_AGENT_ADVISOR_HOST` | `host` |
| `MONO_AGENT_ADVISOR_PORT` | `port` |
| `MONO_AGENT_ADVISOR_PATH` | `path` |
| `MONO_AGENT_ADVISOR_ALLOW_NON_LOOPBACK` | `allowNonLoopback` |
| `MONO_AGENT_ADVISOR_REQUIRE_BEARER` | `requireBearer` |
| `MONO_AGENT_ADVISOR_BEARER_TOKEN` | `bearerToken` |
| `MONO_AGENT_ADVISOR_ALLOWED_HOSTS` | `allowedHosts` (comma-separated) |
| `MONO_AGENT_ADVISOR_ALLOWED_ORIGINS` | `allowedOrigins` (comma-separated) |
| `MONO_AGENT_ADVISOR_MODEL` | `model` |
| `MONO_AGENT_ADVISOR_EFFORT` | `effort` |
| `MONO_AGENT_ADVISOR_MAX_REQUEST_BYTES` | `maxRequestBytes` |
| `MONO_AGENT_ADVISOR_MAX_INTENT_CHARS` | `maxIntentChars` |
| `MONO_AGENT_ADVISOR_MAX_PATCH_CHARS` | `maxPatchChars` |
| `MONO_AGENT_ADVISOR_MAX_VERIFICATION_CHARS` | `maxVerificationChars` |
| `MONO_AGENT_ADVISOR_MAX_OUTPUT_CHARS` | `maxOutputChars` |
| `MONO_AGENT_ADVISOR_MAX_RESPONSE_BYTES` | `maxResponseBytes` |
| `MONO_AGENT_ADVISOR_MAX_RUN_MS` | `maxRunMs` |
| `MONO_AGENT_ADVISOR_MAX_CONCURRENT_REVIEWS` | `maxConcurrentReviews` |
| `MONO_AGENT_ADVISOR_MAX_SESSIONS` | `maxSessions` |
| `MONO_AGENT_ADVISOR_SESSION_TTL_MS` | `sessionTtlMs` |
| `MONO_AGENT_ADVISOR_NAMESPACE` | `namespace` |
| `MONO_AGENT_ADVISOR_OPERATOR_PROMPT` | `operatorPrompt` |

## Network boundary

The listener uses plaintext HTTP and defaults to exact loopback. Before JSON
parsing it validates one Host header against `allowedHosts`, an optional Origin
against `allowedOrigins`, one constant-time bearer digest, JSON content type,
unambiguous request framing, bounded MCP headers, and declared body size. The
streaming parser enforces the same body ceiling when `Content-Length` is absent.
The server disables Express identity headers and sets `trust proxy` to `false`:
`X-Forwarded-Host`, `X-Forwarded-For`, and `X-Forwarded-Proto` are never
authentication or routing authority.

Non-loopback binding is deliberately harder: set `allowNonLoopback: true`, a
bearer token, and a non-empty explicit `allowedHosts` list. Startup also checks
the address that DNS/listen actually produced, so a loopback-looking hostname
cannot silently resolve to an external interface.

### Private HTTPS with Tailscale Serve

Keep the advisor itself on loopback and let Tailscale terminate private HTTPS.
Assume `reviewer.example.ts.net` is the exact MagicDNS name reported by Serve:

```json
{
  "host": "127.0.0.1",
  "port": 4312,
  "requireBearer": true,
  "allowedHosts": ["127.0.0.1", "localhost", "reviewer.example.ts.net"]
}
```

```bash
tailscale serve --bg http://127.0.0.1:4312
tailscale serve status
```

Register `https://reviewer.example.ts.net/mcp` in the remote client. Do not set
`allowNonLoopback`: the application is still bound only to loopback. Tailnet
access policy and HTTPS are additional boundaries; keep bearer auth enabled.
Tailscale documents that `serve` proxies a local service privately within the
tailnet and terminates HTTPS with an automatically provisioned certificate; use
`funnel` only if intentional public exposure is separately reviewed. See
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Cancellation, shutdown, and errors

Client disconnect, MCP cancellation, configured timeout, and server shutdown
share one first-cause-wins abort path. An admitted run is stopped at most once,
then drained at most once. Both cleanup steps and HTTP component close have hard
deadlines; a stalled `start()` is also bounded after cancellation. Shutdown
closes admission first, aborts active reviews, force-closes sockets after its
grace period, and returns within a bounded wait.

| Code | Status | Meaning |
| --- | --- | --- |
| `ok` | `succeeded` | Configured route returned a non-empty bounded review. |
| `advisor_busy` | `busy` | Global capacity or same-continuity exclusion rejected admission. |
| `advisor_cancelled` | `cancelled` | Client cancellation, disconnect, or request abort won. |
| `advisor_shutdown` | `cancelled` | Server shutdown won. |
| `advisor_timeout` | `timed_out` | `maxRunMs` elapsed. |
| `advisor_run_start_failed` | `failed` | The responder run could not start. |
| `advisor_run_failed` | `failed` | Runtime failed or changed to a fallback route. |
| `advisor_run_invalid` | `failed` | Runtime returned an invalid result shape. |
| `advisor_empty_output` | `failed` | Runtime returned no review text. |
| `advisor_cleanup_failed` | `failed` | Stop/drain rejected or missed its deadline. |

Raw runtime exceptions are never returned. Invalid tool arguments use the MCP
SDK's `-32602` error; HTTP policy errors use bounded JSON-RPC envelopes with a
null id.

## Related

- [Iterative advisor review playbook](/playbooks/advisor-iterative-review/)
- [Channels overview](/channels/)
- [Environment variables](/config/env-vars/)
- [Write your own channel adapter](/programmatic/custom-channels/)
- [Sessions and concurrency](/runtime/sessions-concurrency/)
