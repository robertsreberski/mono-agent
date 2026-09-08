import type { AgentMessageStream } from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  MessengerAdapter,
  attachmentUrlPolicyRejection,
  isPublicUnicastAddress,
  type AgentRequest,
  type AgentResponder,
  type MessengerAttachmentIngestOptions,
} from "../adapter.js";
import type { MessengerGraphClientLike } from "../graph-client.js";

const CDN_ADDRESS = "31.13.64.35";

function silentClient(): MessengerGraphClientLike {
  return {
    async sendText() {
      return { messageIds: ["m1"] };
    },
    async sendAttachmentUrl() {
      return { messageIds: [] };
    },
    async senderAction() {
      // no-op
    },
  };
}

function captureResponder(): AgentResponder & { readonly requests: AgentRequest[] } {
  const requests: AgentRequest[] = [];
  return {
    requests,
    async respond(request: AgentRequest, _stream: AgentMessageStream) {
      requests.push(request);
      return { text: "ok" };
    },
  };
}

/** Run one image attachment through the adapter and return the resulting request. */
async function ingest(
  url: string,
  attachments: MessengerAttachmentIngestOptions,
): Promise<AgentRequest> {
  const responder = captureResponder();
  const adapter = new MessengerAdapter({
    client: silentClient(),
    responder,
    allowedUserIds: ["42"],
    attachments: { resolveAddresses: async () => [CDN_ADDRESS], ...attachments },
  });
  await adapter.handleWebhookPayload({
    object: "page",
    entry: [{
      messaging: [{
        sender: { id: "42" },
        message: { mid: `mid-${Math.random()}`, attachments: [{ type: "image", payload: { url } }] },
      }],
    }],
  });
  return responder.requests[0]!;
}

/** A 200 response whose body streams `chunks` and records whether it was cancelled. */
function streamingResponse(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "image/png", ...headers } }),
    cancelled: () => cancelled,
  };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe("attachment URL policy", () => {
  it("accepts Meta CDN https URLs and rejects everything else", () => {
    expect(attachmentUrlPolicyRejection("https://lookaside.fbsbx.com/file.pdf")).toBeUndefined();
    expect(attachmentUrlPolicyRejection("https://scontent.xx.fbcdn.net/p.png")).toBeUndefined();
    expect(attachmentUrlPolicyRejection("http://lookaside.fbsbx.com/f.pdf")).toBe("not_https");
    expect(attachmentUrlPolicyRejection("https://user:pw@lookaside.fbsbx.com/f")).toBe("embedded_credentials");
    expect(attachmentUrlPolicyRejection("https://evil.example.com/f.png")).toBe("host_not_allowed");
    // A lookalike suffix must not match by substring.
    expect(attachmentUrlPolicyRejection("https://notfbcdn.net/f.png")).toBe("host_not_allowed");
    expect(attachmentUrlPolicyRejection("https://fbcdn.net.evil.com/f.png")).toBe("host_not_allowed");
    expect(attachmentUrlPolicyRejection("https://127.0.0.1/secret")).toBe("ip_literal_host");
    expect(attachmentUrlPolicyRejection("https://[::1]/secret")).toBe("ip_literal_host");
    expect(attachmentUrlPolicyRejection("not a url")).toBe("unparseable_url");
    // A trailing dot names the same host and must not slip past suffix matching.
    expect(attachmentUrlPolicyRejection("https://lookaside.fbsbx.com./f")).toBeUndefined();
  });
});

describe("isPublicUnicastAddress", () => {
  it("rejects loopback, private, link-local, CGNAT, and reserved ranges", () => {
    expect(isPublicUnicastAddress("31.13.64.35")).toBe(true);
    expect(isPublicUnicastAddress("8.8.8.8")).toBe(true);
    expect(isPublicUnicastAddress("127.0.0.1")).toBe(false);
    expect(isPublicUnicastAddress("10.1.2.3")).toBe(false);
    expect(isPublicUnicastAddress("172.16.0.1")).toBe(false);
    expect(isPublicUnicastAddress("172.32.0.1")).toBe(true); // just outside 172.16/12
    expect(isPublicUnicastAddress("192.168.1.1")).toBe(false);
    expect(isPublicUnicastAddress("169.254.169.254")).toBe(false); // cloud metadata
    expect(isPublicUnicastAddress("100.64.0.1")).toBe(false); // CGNAT
    expect(isPublicUnicastAddress("0.0.0.0")).toBe(false);
    expect(isPublicUnicastAddress("224.0.0.1")).toBe(false);
    expect(isPublicUnicastAddress("255.255.255.255")).toBe(false);
  });

  it("classifies IPv6, including IPv4-mapped forms", () => {
    expect(isPublicUnicastAddress("2606:4700::1111")).toBe(true);
    expect(isPublicUnicastAddress("::1")).toBe(false);
    expect(isPublicUnicastAddress("::")).toBe(false);
    expect(isPublicUnicastAddress("fd00::1")).toBe(false); // unique local
    expect(isPublicUnicastAddress("fe80::1")).toBe(false); // link-local
    expect(isPublicUnicastAddress("ff02::1")).toBe(false); // multicast
    expect(isPublicUnicastAddress("2001:db8::1")).toBe(false); // documentation
    expect(isPublicUnicastAddress("::ffff:127.0.0.1")).toBe(false); // mapped loopback
    expect(isPublicUnicastAddress("::ffff:169.254.169.254")).toBe(false); // mapped metadata
    expect(isPublicUnicastAddress("garbage")).toBe(false);
  });
});

describe("MessengerAdapter attachment download", () => {
  it("never contacts a host outside the CDN allowlist", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("x"), { status: 200 }));
    const request = await ingest("https://evil.example.com/p.png", {
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(request.attachments ?? []).toHaveLength(0);
    expect(request.text).toContain("[image attachment: https://evil.example.com/p.png]");
  });

  it("re-validates every redirect hop and refuses one leaving the allowlist", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://internal.example.com/secret"));
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: fetchImpl as unknown as typeof fetch,
    });

    // The first hop was fetched; the redirect target was never contacted.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(request.attachments ?? []).toHaveLength(0);
  });

  it("refuses a redirect to loopback even when the target is on an allowlisted name", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://lookaside.fbsbx.com/rebound"));
    // The name is allowlisted, but it resolves inside the deployment.
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveAddresses: async (hostname) => (hostname.startsWith("scontent") ? [CDN_ADDRESS] : ["127.0.0.1"]),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(request.attachments ?? []).toHaveLength(0);
  });

  it("refuses a host whose DNS answer includes any non-public address", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("x"), { status: 200 }));
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: fetchImpl as unknown as typeof fetch,
      // One public and one private answer: we do not control which is dialled.
      resolveAddresses: async () => [CDN_ADDRESS, "169.254.169.254"],
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(request.attachments ?? []).toHaveLength(0);
  });

  it("follows an in-policy redirect and ingests the final body", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? redirect("https://lookaside.fbsbx.com/final.png")
        : new Response(Buffer.from("png-bytes"), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
    });
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(request.attachments?.[0]).toMatchObject({ kind: "image", mimeType: "image/png", name: "final.png" });
  });

  it("abandons a redirect loop at the hop cap", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://lookaside.fbsbx.com/next"));
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: fetchImpl as unknown as typeof fetch,
    });

    // Initial request plus MAX_ATTACHMENT_REDIRECTS (3) follow-ups, then stop.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(request.attachments ?? []).toHaveLength(0);
  });

  it("rejects a body over the cap with no Content-Length, cancelling the stream", async () => {
    const chunk = new Uint8Array(64).fill(1);
    const { response, cancelled } = streamingResponse([chunk, chunk, chunk, chunk]);
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: (async () => response) as unknown as typeof fetch,
      maxBytes: 100,
    });

    expect(request.attachments ?? []).toHaveLength(0);
    expect(cancelled()).toBe(true);
  });

  it("rejects a body that exceeds a falsely small Content-Length", async () => {
    const chunk = new Uint8Array(64).fill(1);
    const { response, cancelled } = streamingResponse([chunk, chunk, chunk], { "content-length": "10" });
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: (async () => response) as unknown as typeof fetch,
      maxBytes: 100,
    });

    expect(request.attachments ?? []).toHaveLength(0);
    expect(cancelled()).toBe(true);
  });

  it("rejects a declared Content-Length over the cap without reading the body", async () => {
    const chunk = new Uint8Array(8).fill(1);
    const { response } = streamingResponse([chunk], { "content-length": "999999" });
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: (async () => response) as unknown as typeof fetch,
      maxBytes: 100,
    });

    expect(request.attachments ?? []).toHaveLength(0);
  });

  it("accepts a body exactly at the cap", async () => {
    const { response } = streamingResponse([new Uint8Array(100).fill(7)]);
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: (async () => response) as unknown as typeof fetch,
      maxBytes: 100,
    });

    expect(request.attachments?.[0]).toMatchObject({ kind: "image", sizeBytes: 100 });
  });

  it("drops an attachment whose download aborts", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(request.attachments ?? []).toHaveLength(0);
    expect(request.text).toContain("[image attachment:");
  });

  it("drops an attachment when the body stream errors mid-read", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: (async () => new Response(body, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch,
    });

    expect(request.attachments ?? []).toHaveLength(0);
  });

  it("downloads nothing when the host policy is empty", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("x"), { status: 200 }));
    const request = await ingest("https://scontent.xx.fbcdn.net/p.png", {
      fetch: fetchImpl as unknown as typeof fetch,
      allowedHostSuffixes: [],
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(request.attachments ?? []).toHaveLength(0);
  });
});
