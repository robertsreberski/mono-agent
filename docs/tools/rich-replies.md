---
title: "Reply files and MCP Apps"
description: "Publish generated files and interactive MCP App replies with bounded storage, native channel delivery, and a hardened web bridge."
sidebar:
  order: 5
---

mono-agent can return more than answer text without placing file bytes, local
paths, or app HTML in the reply stream. A response may carry an opaque file
reference, an MCP App reference, or a visible per-part failure. These parts are
additive: valid text and earlier parts remain deliverable when a later part
fails.

## Publishing a reply file

When `PublishReplyFile` is allowed by `tools.allowedTools`, the model can write a
file under the configured workspace (or its run-owned outbound directory) and
call the request-scoped tool with:

```json
{
  "path": "reports/weekly.csv",
  "name": "weekly.csv",
  "mediaType": "text/csv"
}
```

The host resolves the source inside an authorized root, rejects symlinks and
non-files, opens it without following swapped path components where the
platform supports that primitive, verifies the opened inode, and copies from
the descriptor into an owner-private staging directory. It hashes while
copying, writes the manifest, then atomically renames the whole finished
directory into the live namespace. The reply contains only the sanitized name,
media type, byte count, SHA-256 integrity id, expiry, and an opaque id.

The default per-file limit is 20 MiB. Files and apps share one limit of 20 rich
parts per run. A retry with the same integrity identity reuses the first part;
the twenty-first distinct producer request returns a visible capability failure
to the model without replacing the first twenty.

`PublishReplyFile` is request-scoped. Its random loopback endpoint is
high-entropy, closes with the request, is not logged, and does not contain the
run id, conversation id, workspace, or artifact path. The tool is removed by
the sealed local self-configuration policy and is not installed on a route that
cannot safely receive its MCP server.

## Channel delivery and fallback

| Destination | Reply-file behavior | Other unsupported rich parts |
| --- | --- | --- |
| Slack | Uses `files.getUploadURLExternal`, uploads bytes to Slack's returned URL, then confirms with `files.completeUploadExternal` in the exact channel/thread. | Concise human-readable warning. |
| Telegram | Sends a native `sendDocument` to the exact chat/reply target and preserves silent proactive delivery. | Concise human-readable warning. |
| Web console | Shows a message-bound download control after server-side authorization and integrity verification. | MCP Apps render as described below; failures remain individual message parts. |
| Terminal and other human channels | Preserve the answer and render a safe warning when a part has no native representation. | Same. |
| OpenAI-compatible API, webhook, A2A, and cron/verbatim delivery | Never append fallback prose to machine or verbatim output. | The text contract remains byte-for-byte unchanged. |

Slack and Telegram remove a file part from textual fallback only after the
platform confirms its native upload. The deduplication key binds the file
integrity id to the destination and thread/reply target, so a retry does not
post the same file twice and delivery to another destination remains distinct.
Upload failures retain the safe fallback and never include the artifact path or
private capability URL.

Downloads are authorized against the exact message/conversation ownership and
expected integrity id, rehash the retained bytes, set `Accept-Ranges: none`, and
stream only after the manifest, size, and hash agree.

## MCP Apps

MCP Apps are enabled only when every possible runtime route supports the
host-owned bridge. Today that means a Pi-native route with no direct-runtime
fallback. The MCP client advertises the standard
`text/html;profile=mcp-app` capability to the server; the browser bridge then
explicitly intersects the App's requested revision with the two revisions
reviewed from `@modelcontextprotocol/ext-apps` 1.7.5 (`2026-01-26` and
`2025-11-21`). Unsupported routes do not receive the extension and do not
advertise an operator capability.

For one successful MCP tool result, the Pi bridge reads only the tool's declared
`ui://` resource through that originating MCP connection. The app host stores
the exact resource, bounded tool input/result, app-visible tool names, and one
declared resource URI. It does not enumerate server resources. A later
`resources/read` request is allowed only for that exact declared URI and exact
connection; cross-resource and cross-connection reads are denied.

The web console uses two nested iframes. Both are opaque-origin sandboxes with
`allow-scripts` only—no same-origin, popups, forms, or top navigation. The
trusted outer proxy binds the parent and inner frame by source window, host
origin where available, invocation id, connection id, a random nonce, and
bounded JSON-RPC messages. A second inner-frame navigation removes the frame.

Server-declared network, image, frame, and resource origins are intersected
with a host allowlist; the default is empty. Resource origins never enter
`script-src`, so a declaration such as `evil.com` cannot grant remote script,
connect, image, frame, or base access. Inline script is permitted only inside
the isolated app document because MCP App HTML is executable UI.

Tool calls, external links, and model-context requests require an explicit web
confirmation. Tool dialogs show a 2 KiB, depth- and item-bounded argument
preview with token, credential, password, cookie, and similar keys redacted.
While the dialog is pending, the app iframe and header are inert and removed
from keyboard navigation; focus is trapped in the dialog and restored after a
decision. Exact declared resource reads are read-only and do not prompt.

## Lifetime and limits

Configured agents use `artifacts.retention.maxAgeDays` for stored reply files
and app resources (365 days by default); direct service composition defaults to
30 days. Cleanup removes expired complete publications and old abandoned
staging directories, but tracks active staging ids so a concurrent cleanup
cannot delete an in-flight publish.

An MCP App's live originating connection is shorter-lived than its stored
record. The host retains at most eight connections by least-recently-used order,
evicts one after ten idle minutes, and closes the underlying MCP client and
transport on eviction or shutdown. A stored app whose connection is gone
reports `connected: false` and cannot call tools or read resources.

Bridge requests are limited to 64 KiB, results to 1 MiB, and each connection to
60 requests per minute. Each app keeps a rotating owner-private audit log with
a 256 KiB file ceiling and two retained rotations. Stable errors distinguish
oversize, rate-limited, forbidden, confirmation-required, expired, and closed
connection outcomes.

The operator producer continues to cap each NDJSON frame at 256 KiB. The web
consumer accepts up to the legacy 8 MiB boundary so a new console remains
compatible with an older running agent.
