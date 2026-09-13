import { describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_ATTACHMENT_MAX_BYTES, type AgentResponder } from "@mono-agent/agent-contracts";

import {
  loadWebhookAdapterConfig,
  startWebhookAdapter,
  type WebhookInvocationRequest,
} from "../index.js";

const M4A_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

function capturingResponder(seen: WebhookInvocationRequest[]): AgentResponder {
  return {
    async respond(request, stream) {
      seen.push(request as WebhookInvocationRequest);
      await stream.append(`got:${request.text}`);
      return {};
    },
  };
}

async function multipartBody(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const wire = new Response(form);
  const contentType = wire.headers.get("content-type");
  if (contentType === null) {
    throw new Error("Expected undici to set a multipart content-type.");
  }
  return { body: Buffer.from(await wire.arrayBuffer()), contentType };
}

function audioForm(fields: {
  readonly fileField?: string;
  readonly fileName?: string;
  readonly fileType?: string;
  readonly fileBytes?: Buffer;
  readonly extraFiles?: Array<{ field: string; name: string; type: string; bytes: Buffer }>;
  readonly text?: string;
  readonly conversationId?: string;
  readonly mode?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly metadata?: string;
}): FormData {
  const form = new FormData();
  const fileBytes = fields.fileBytes ?? M4A_BYTES;
  if (fields.fileField !== "(none)") {
    form.append(
      fields.fileField ?? "audio",
      new File([fileBytes], fields.fileName ?? "recording.m4a", { type: fields.fileType ?? "audio/x-m4a" }),
    );
  }
  for (const extra of fields.extraFiles ?? []) {
    form.append(extra.field, new File([extra.bytes], extra.name, { type: extra.type }));
  }
  if (fields.text !== undefined) form.append("text", fields.text);
  if (fields.conversationId !== undefined) form.append("conversationId", fields.conversationId);
  if (fields.mode !== undefined) form.append("mode", fields.mode);
  if (fields.model !== undefined) form.append("model", fields.model);
  if (fields.effort !== undefined) form.append("effort", fields.effort);
  if (fields.metadata !== undefined) form.append("metadata", fields.metadata);
  return form;
}

describe("Webhook adapter audio input", () => {
  it("accepts multipart audio with text and forwards a document attachment", async () => {
    const seen: WebhookInvocationRequest[] = [];
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: capturingResponder(seen),
    });
    try {
      const { body, contentType } = await multipartBody(audioForm({
        text: "transcribe this",
        conversationId: "voice-1",
        mode: "sync",
      }));
      const response = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(200);
      const status = await response.json() as Record<string, unknown>;
      expect(status).toMatchObject({ status: "succeeded", text: "got:transcribe this" });
      // The status JSON stays small: attachment bytes never ride along.
      expect(JSON.stringify(status).length).toBeLessThan(2_000);

      expect(seen).toHaveLength(1);
      const request = seen[0]!;
      expect(request.conversationId).toBe("voice-1");
      expect(request.text).toBe("transcribe this");
      expect(request.attachments).toHaveLength(1);
      const attachment = request.attachments![0]!;
      expect(attachment.kind).toBe("document");
      // Apple Shortcuts posts audio/x-m4a; the adapter normalizes it.
      expect(attachment.mimeType).toBe("audio/mp4");
      expect(attachment.data).toBe(M4A_BYTES.toString("base64"));
      expect(attachment.sizeBytes).toBe(M4A_BYTES.byteLength);
      expect(attachment.name).toBe("recording.m4a");
      expect(request.metadata.webhook).toMatchObject({ hasAttachments: true, attachmentCount: 1 });
    } finally {
      await server.stop();
    }
  });

  it("falls back to a fixed prompt for textless audio, or the endpoint prompt when configured", async () => {
    const seenFallback: WebhookInvocationRequest[] = [];
    const fallback = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: capturingResponder(seenFallback),
    });
    try {
      const { body, contentType } = await multipartBody(audioForm({}));
      const response = await fetch(fallback.invokeUrl, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "succeeded",
        text: "got:Voice message attached.",
      });
      expect(seenFallback[0]?.text).toBe("Voice message attached.");
      expect(seenFallback[0]?.attachments).toHaveLength(1);
    } finally {
      await fallback.stop();
    }

    const seenPrompt: WebhookInvocationRequest[] = [];
    const prompted = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [{ name: "voice", path: "/voice", mode: "sync", prompt: "Transcribe the attached voice note." }],
      responder: capturingResponder(seenPrompt),
    });
    try {
      const { body, contentType } = await multipartBody(audioForm({}));
      const response = await fetch(`${prompted.url}/voice`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(200);
      // Endpoint prompt is used as-is, not doubled by the prepend helper.
      expect(seenPrompt[0]?.text).toBe("Transcribe the attached voice note.");
    } finally {
      await prompted.stop();
    }
  });

  it("accepts a raw audio/x-m4a body with query params and normalizes the mime", async () => {
    const seen: WebhookInvocationRequest[] = [];
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: capturingResponder(seen),
    });
    try {
      const url = new URL(server.invokeUrl);
      url.searchParams.set("text", "raw note");
      url.searchParams.set("conversationId", "voice-raw");
      url.searchParams.set("mode", "sync");
      url.searchParams.set("model", "test-model");
      url.searchParams.set("effort", "low");
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "audio/x-m4a", "x-file-name": "shortcut-recording.m4a" },
        body: M4A_BYTES,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded", text: "got:raw note" });
      const request = seen[0]!;
      expect(request.attachments).toHaveLength(1);
      expect(request.attachments![0]).toMatchObject({
        kind: "document",
        mimeType: "audio/mp4",
        data: M4A_BYTES.toString("base64"),
        sizeBytes: M4A_BYTES.byteLength,
        name: "shortcut-recording.m4a",
      });
      expect(request.metadata.webhook).toMatchObject({
        model: "test-model",
        effort: "low",
        hasAttachments: true,
        attachmentCount: 1,
      });
    } finally {
      await server.stop();
    }
  });

  it("generates a voice-<requestId> name when the upload has no usable filename", async () => {
    const seen: WebhookInvocationRequest[] = [];
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: capturingResponder(seen),
    });
    try {
      // A bare Blob part carries no filename: undici parses it as "blob".
      const form = new FormData();
      form.append("audio", new Blob([M4A_BYTES], { type: "audio/mp4" }));
      const { body, contentType } = await multipartBody(form);
      const response = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(200);
      const name = seen[0]?.attachments?.[0]?.name;
      expect(name).toMatch(/^voice-[0-9a-f-]{36}\.m4a$/u);
      expect(seen[0]?.attachments?.[0]?.mimeType).toBe("audio/mp4");
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["audio/x-wav", "audio/wav"],
    ["audio/m4a", "audio/mp4"],
    ["audio/mp3", "audio/mpeg"],
  ])("normalizes %s to %s", async (posted, canonical) => {
    const seen: WebhookInvocationRequest[] = [];
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: capturingResponder(seen),
    });
    try {
      const response = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": posted },
        body: M4A_BYTES,
      });
      expect(response.status).toBe(200);
      expect(seen[0]?.attachments?.[0]?.mimeType).toBe(canonical);
    } finally {
      await server.stop();
    }
  });

  it("parses a JSON-string metadata field and rejects an unparsable one with 400", async () => {
    const seen: WebhookInvocationRequest[] = [];
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: capturingResponder(seen),
    });
    try {
      const valid = await multipartBody(audioForm({ text: "meta", metadata: JSON.stringify({ source: "shortcut" }) }));
      const ok = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": valid.contentType },
        body: valid.body,
      });
      expect(ok.status).toBe(200);
      expect(seen[0]?.metadata.webhook).toMatchObject({ payloadMetadata: { source: "shortcut" } });

      const invalid = await multipartBody(audioForm({ text: "meta", metadata: "{not json" }));
      const bad = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": invalid.contentType },
        body: invalid.body,
      });
      expect(bad.status).toBe(400);
      await expect(bad.json()).resolves.toMatchObject({ status: "failed" });
      expect(seen).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("keeps requiring text for JSON-only requests", async () => {
    const responder = { respond: vi.fn(async () => ({ text: "must not run" })) } satisfies AgentResponder;
    const server = await startWebhookAdapter({ host: "127.0.0.1", port: 0, responder });
    try {
      const response = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "json-1", mode: "sync" }),
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
      expect(responder.respond).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("rejects oversize audio with 413 in both formats without running the responder", async () => {
    const responder = { respond: vi.fn(async () => ({ text: "must not run" })) } satisfies AgentResponder;
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      maxAttachmentBytes: 8,
      responder,
    });
    try {
      const oversized = Buffer.alloc(9, 1);
      const raw = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": "audio/mp4" },
        body: oversized,
      });
      expect(raw.status).toBe(413);
      await expect(raw.json()).resolves.toMatchObject({ status: "failed" });

      const multipart = await multipartBody(audioForm({ fileBytes: oversized, fileType: "audio/mp4" }));
      const form = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": multipart.contentType },
        body: multipart.body,
      });
      expect(form.status).toBe(413);
      await expect(form.json()).resolves.toMatchObject({ status: "failed" });

      // A body far past the ceiling is rejected at the parser, still without a run.
      const huge = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": "audio/mp4" },
        body: Buffer.alloc(4 * 1024 * 1024, 1),
      });
      expect(huge.status).toBe(413);
      expect(responder.respond).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("rejects non-audio mimes with 415 in both formats", async () => {
    const responder = { respond: vi.fn(async () => ({ text: "must not run" })) } satisfies AgentResponder;
    const server = await startWebhookAdapter({ host: "127.0.0.1", port: 0, responder });
    try {
      const raw = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": "audio/foobar" },
        body: M4A_BYTES,
      });
      expect(raw.status).toBe(415);
      await expect(raw.json()).resolves.toMatchObject({ status: "failed" });

      const multipart = await multipartBody(audioForm({ fileType: "text/plain", fileName: "note.txt" }));
      const form = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": multipart.contentType },
        body: multipart.body,
      });
      expect(form.status).toBe(415);
      await expect(form.json()).resolves.toMatchObject({ status: "failed" });
      expect(responder.respond).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["no file part", { fileField: "(none)", text: "hello" }],
    ["two file parts", {
      extraFiles: [{ field: "file", name: "second.m4a", type: "audio/mp4", bytes: M4A_BYTES }],
    }],
    ["unexpected file field", { fileField: "video" }],
    ["empty file", { fileBytes: Buffer.alloc(0) }],
  ])("rejects malformed multipart bodies with 400 (%s)", async (_label, fields) => {
    const responder = { respond: vi.fn(async () => ({ text: "must not run" })) } satisfies AgentResponder;
    const server = await startWebhookAdapter({ host: "127.0.0.1", port: 0, responder });
    try {
      const { body, contentType } = await multipartBody(audioForm(fields));
      const response = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
      expect(responder.respond).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("rejects empty raw audio bodies with 400", async () => {
    const responder = { respond: vi.fn(async () => ({ text: "must not run" })) } satisfies AgentResponder;
    const server = await startWebhookAdapter({ host: "127.0.0.1", port: 0, responder });
    try {
      const response = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": "audio/mp4" },
        body: Buffer.alloc(0),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
      expect(responder.respond).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("authenticates binary bodies before parsing them", async () => {
    const responder = { respond: vi.fn(async () => ({ text: "must not run" })) } satisfies AgentResponder;
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      apiKey: "fixture-audio-key",
      maxAttachmentBytes: 8,
      responder,
    });
    try {
      const oversized = Buffer.alloc(4 * 1024 * 1024, 1);
      for (const authorization of [undefined, "Bearer wrong-key"]) {
        const raw = await fetch(server.invokeUrl, {
          method: "POST",
          headers: {
            "content-type": "audio/mp4",
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: oversized,
        });
        expect(raw.status).toBe(401);

        const multipart = await multipartBody(audioForm({ fileBytes: oversized }));
        const form = await fetch(server.invokeUrl, {
          method: "POST",
          headers: {
            "content-type": multipart.contentType,
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: multipart.body,
        });
        expect(form.status).toBe(401);
      }
      expect(responder.respond).not.toHaveBeenCalled();

      const authorized = await fetch(server.invokeUrl, {
        method: "POST",
        headers: { "content-type": "audio/mp4", authorization: "Bearer fixture-audio-key" },
        body: M4A_BYTES,
      });
      expect(authorized.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("runs audio invocations in async mode with the same status flow", async () => {
    const seen: WebhookInvocationRequest[] = [];
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: capturingResponder(seen),
    });
    try {
      const url = new URL(server.invokeUrl);
      url.searchParams.set("mode", "async");
      const accepted = await fetch(url, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: M4A_BYTES,
      });
      expect(accepted.status).toBe(202);
      const acceptedBody = await accepted.json() as { requestId: string; statusUrl: string };
      await expect.poll(() => server.getStatus(acceptedBody.requestId)?.status).toBe("succeeded");
      expect(seen[0]?.text).toBe("Voice message attached.");
      expect(seen[0]?.attachments).toHaveLength(1);
      const statusResponse = await fetch(`${server.url}${acceptedBody.statusUrl}`);
      const statusBody = await statusResponse.json() as Record<string, unknown>;
      expect(statusBody).toMatchObject({ status: "succeeded", text: "got:Voice message attached." });
      expect(JSON.stringify(statusBody).length).toBeLessThan(2_000);
    } finally {
      await server.stop();
    }
  });

  it("validates the programmatic attachment ceiling", async () => {
    const responder: AgentResponder = { async respond() { return {}; } };
    await expect(startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      maxAttachmentBytes: 0,
      responder,
    })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("loads webhook.maxAttachmentBytes from JSON and env", async () => {
    const fromJson = await loadWebhookAdapterConfig({
      env: {},
      json: { webhook: { enabled: true, maxAttachmentBytes: 1024 } },
    });
    expect(fromJson.maxAttachmentBytes).toBe(1024);

    const fromEnv = await loadWebhookAdapterConfig({
      env: { MONO_AGENT_WEBHOOK_MAX_ATTACHMENT_BYTES: "2048" },
      json: {},
    });
    expect(fromEnv.maxAttachmentBytes).toBe(2048);

    const unset = await loadWebhookAdapterConfig({ env: {}, json: {} });
    expect(unset.maxAttachmentBytes).toBeUndefined();
    expect(DEFAULT_AGENT_ATTACHMENT_MAX_BYTES).toBe(20 * 1024 * 1024);

    await expect(loadWebhookAdapterConfig({
      env: { MONO_AGENT_WEBHOOK_MAX_ATTACHMENT_BYTES: "0" },
      json: {},
    })).rejects.toThrow("MONO_AGENT_WEBHOOK_MAX_ATTACHMENT_BYTES");
  });
});
