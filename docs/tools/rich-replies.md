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
Host-private roots are refused even when they are located inside the configured
workspace.

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
| OpenAI-compatible API | Keeps assistant `content` byte-for-byte unchanged and returns sanitized failures in `mono_agent.reply_part_outcomes`. | Non-stream JSON and a metadata-only SSE chunk use the same bounded shape. |
| Webhook | Keeps `text` byte-for-byte unchanged and returns sanitized `replyPartOutcomes`. | Sync responses, async status reads, and result callbacks retain the outcomes. |
| A2A | Keeps answer text byte-for-byte unchanged and adds an A2A structured data `Part` to the final artifact. | Attachments and MCP Apps become explicit `unsupported_destination` failures; no file bytes or private references cross A2A. |
| Cron / verbatim notification | Keeps answer text byte-for-byte unchanged and retains sanitized `replyPartOutcomes` on `CronJobResult`. | The app records one outcome audit for the run; native notification carries text only and never claims a file was sent. |

## Machine delivery outcome wire contract

Every machine adapter uses the shared
`AgentReplyPartDeliveryOutcome` sanitizer. It emits a dense array with at most
20 entries and this exact ordinary record shape:

```json
{
  "partIndex": 0,
  "partType": "attachment",
  "status": "failed",
  "code": "unsupported_destination",
  "message": "Attachment reply parts are unsupported on this destination."
}
```

- `partIndex` is rewritten to the dense zero-based output position.
- `partType` is exactly `attachment`, `mcp_app`, `failure`, or `unknown`.
- `status` is the terminal literal `failed`.
- `code` is exactly one of `app_capability_mismatch`,
  `app_connection_closed`, `app_resource_invalid`, `artifact_expired`,
  `artifact_integrity_failed`, `artifact_missing`,
  `artifact_publish_failed`, `artifact_too_large`, `reply_part_too_large`, or
  `unsupported_destination`.
- `message` is reconstructed from the accepted type/code. Producer text is
  never copied.
- `affectedPartCount` is forbidden on ordinary records. Only the final overflow
  record has it: index 19, `partType: "unknown"`,
  `code: "reply_part_too_large"`, and the fixed message "Additional reply parts
  exceeded the bounded delivery outcome limit."

Sparse holes, `undefined`, `null`, primitives, accessor-backed values, failed
descriptor reads, extra fields, unknown types/codes, and non-terminal statuses
cannot place unsafe values or literal JSON `null` into the array. Each malformed
entry becomes an independent fixed `unknown` failure, so it cannot mutate or
erase valid siblings. Non-array and empty inputs omit the field. An off-contract
array above 20 entries becomes the first 19 individual records plus the counted
aggregate; its count is the full source length minus 19.

The response locations are exact and additive:

| Producer or reader | Exact envelope / projection |
| --- | --- |
| OpenAI-compatible non-stream | Top-level `mono_agent.reply_part_outcomes` on the `chat.completion`; `choices[].message.content` is unchanged. |
| OpenAI-compatible stream | One metadata-only `chat.completion.chunk` carries `mono_agent.reply_part_outcomes` before the ordinary `finish_reason: "stop"` chunk and `[DONE]`. |
| Webhook | Top-level `replyPartOutcomes` on successful sync JSON, terminal async status JSON, programmatic `getStatus()`, and the result callback. Store, callback, and each read receive independent arrays. |
| A2A | A final artifact data `Part` with media type `application/vnd.mono-agent.reply-part-outcomes+json` and value `{ "schemaVersion": 1, "replyPartOutcomes": [...] }`, beside the unchanged text `Part`. |
| Cron adapter | Optional top-level `CronJobResult.replyPartOutcomes`; a cancelled responder that resolves late may retain sanitized part outcomes but never its late text. |
| Cron durable/operator projection | Private SQLite column `cron_runs.reply_part_outcomes_json` stores `{ "schemaVersion": 1, "replyPartOutcomes": [...] }`. Legacy `NULL` rows mean absent outcomes. Detail `CronOperatorRun.replyPartOutcomes` retains all 20 records; compact summaries retain the first eight in stable part order so a 100-run page stays below the operator response ceiling. The web client strictly reparses both projections after restart. |

The version applies to the A2A and SQLite envelopes. Direct OpenAI, webhook,
cron result, operator, and web projections are unversioned additive fields and
must be feature-detected. No outcome envelope copies part ids, filenames, local
or host-only URLs, capability values, integrity ids, producer error messages,
or payload bytes. Cron run rows retain the sanitized outcomes, while rollback-safe
run-now idempotency receipts omit them. Replay derives outcomes from a retained
row and accepts their absence after row eviction. The first terminal cron state
cannot be overwritten by a late callback or event.

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
a 256 KiB file ceiling and two retained rotations. Durable rich-reply payloads
and audit files stay within a 256 MiB aggregate ceiling; configured composition
reserves 1 MiB for independently admitted audit records and uses fair-share,
oldest-segment reclamation when that reserve fills. One bounded inventory per
artifact-root lifecycle restores accounting after a restart; later appends
update exact in-memory ownership under one process-wide gate instead of
rescanning every invocation. Reclamation removes rotated history first, then
inactive and unprotected owners' active files only as a last resort. A live or
protected owner's active `audit.jsonl`, including an in-flight confirmation, is
never a candidate. Foreign owners that cannot be inspected are isolated under
bounded conservative accounting and re-inventoried only when the same verified
directory identity recovers; symlinked or replacement owners remain
quarantined. Append, rotation, cleanup, and quota reclamation revalidate the
audit root, owner directory, and singly linked file identities after the
operation hook and before using a child path. Admission is rejected before
deletion when the available candidates cannot safely create enough room,
preserving unrelated and out-of-root history. Audit entries
contain only host-owned identity, method, timestamp, and phase fields—never
model-filled tool names, arguments, resource URIs, URLs, or tool results.

Filling the model-visible budget fails only the new rich-reply part without
evicting retained content or blocking a later audited bridge action. Stable
errors distinguish oversize, rate-limited, forbidden, confirmation-required,
audit-failed, audit-incomplete, expired, and closed connection outcomes. Failure
to admit the pre-action confirmation and its bounded completion record returns
`app_audit_failed` and refuses execution. The completion bytes remain reserved
until the tool returns. If their real filesystem write then fails, the operator
and web transports preserve `app_audit_incomplete` as a conflict outcome rather
than a generic gateway failure. The side effect may have happened, so callers
must not retry automatically.

The operator producer continues to cap each NDJSON frame at 256 KiB. The web
consumer accepts up to the legacy 8 MiB boundary so a new console remains
compatible with an older running agent.
