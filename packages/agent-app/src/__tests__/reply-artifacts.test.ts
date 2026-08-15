import { access, mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AgentResponseCancelledError,
  type AgentMessageStream,
  type AgentReplyAttachmentPart,
  type AgentResponder,
} from "@mono-agent/agent-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createReplyArtifactService,
  isPublishReplyFileToolAllowed,
  PUBLISH_REPLY_FILE_TOOL_NAME,
  REPLY_ARTIFACT_MCP_SERVER_NAME,
  type ReplyArtifactService,
} from "../reply-artifacts.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-reply-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

async function openPublisher(service: ReplyArtifactService, runId: string, conversationId: string) {
  const extension = await service.createExtension({
    runId,
    request: { conversationId },
    context: {},
  } as never);
  const servers = extension.runtimeOptions?.mcpServers as
    | Readonly<Record<string, { readonly url: string }>>
    | undefined;
  const spec = servers?.[REPLY_ARTIFACT_MCP_SERVER_NAME];
  if (spec === undefined) throw new Error("Reply artifact MCP server was not configured.");
  const client = new Client({ name: "reply-artifact-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
  return {
    client,
    url: spec.url,
    serializedSpec: JSON.stringify(spec),
    privateCapability: (spec as Record<PropertyKey, unknown>)[
      Symbol.for("@mono-agent/private-capability-url")
    ] === true,
    close: async () => {
      await client.close();
      await extension.cleanup?.();
    },
    settle: async () => await extension.settleCleanup?.(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function responder(runId: string): AgentResponder {
  return {
    async respond() {
      return { text: "Done", metadata: { runId } };
    },
  };
}

const stream: AgentMessageStream = { async append() {} };

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("reply artifact policy", () => {
  it("honors canonical, MCP-prefixed, wildcard, and denial spellings", () => {
    expect(isPublishReplyFileToolAllowed({ allowedTools: ["*"] })).toBe(true);
    expect(isPublishReplyFileToolAllowed({ allowedTools: [PUBLISH_REPLY_FILE_TOOL_NAME] })).toBe(true);
    expect(isPublishReplyFileToolAllowed({
      allowedTools: [`mcp__${REPLY_ARTIFACT_MCP_SERVER_NAME}__*`],
    })).toBe(true);
    expect(isPublishReplyFileToolAllowed({ allowedTools: ["*"], disallowedTools: [PUBLISH_REPLY_FILE_TOOL_NAME] }))
      .toBe(false);
  });
});

describe("reply artifact publication", () => {
  it("publishes duplicate names as isolated durable references and streams only to the owning conversation", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "one.txt"), "first");
    await writeFile(join(workspace, "two.txt"), "second");
    const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
    const publisher = await openPublisher(service, "run-1", "bucketed-conversation");
    try {
      await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "one.txt", name: "report.txt", mediaType: "text/plain" },
      });
      await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "two.txt", name: "report.txt", mediaType: "text/plain" },
      });
    } finally {
      await publisher.close();
    }

    const wrapped = service.wrapResponder(responder("run-1"));
    const response = await wrapped.respond({
      conversationId: "delivery-conversation",
      text: "make files",
      abortSignal: new AbortController().signal,
    }, stream);
    const attachments = response.parts?.filter(
      (part): part is AgentReplyAttachmentPart => part.type === "attachment",
    ) ?? [];
    expect(attachments).toHaveLength(2);
    expect(attachments.map((part) => part.name)).toEqual(["report.txt", "report.txt"]);
    expect(new Set(attachments.map((part) => part.reference.id)).size).toBe(2);
    expect(attachments.every((part) => !("path" in part) && !("data" in part))).toBe(true);

    await expect(wrapped.openReplyArtifact?.({
      conversationId: "different-conversation",
      reference: attachments[0]!.reference,
      expectedIntegrityId: attachments[0]!.integrityId,
    })).rejects.toMatchObject({ code: "artifact_forbidden" });

    const opened = await wrapped.openReplyArtifact?.({
      conversationId: "delivery-conversation",
      reference: attachments[0]!.reference,
      expectedIntegrityId: attachments[0]!.integrityId,
    });
    expect(opened).toBeDefined();
    expect(await collect(opened!.body)).toEqual(Buffer.from("first"));
  });

  it("records traversal, symlink, oversized, and missing-file failures without losing successful parts", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(join(workspace, "ok.txt"), "ok");
    await writeFile(join(workspace, "large.txt"), "too large");
    await writeFile(outside, "secret");
    await symlink(outside, join(workspace, "link.txt"));
    const service = createReplyArtifactService({
      artifactDir: join(root, "artifacts"),
      workspace,
      maxFileBytes: 3,
    });
    const publisher = await openPublisher(service, "run-2", "conversation");
    try {
      for (const path of ["ok.txt", "../outside.txt", "link.txt", "large.txt", "missing.txt"]) {
        await publisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path } });
      }
    } finally {
      await publisher.close();
    }

    const response = await service.wrapResponder(responder("run-2")).respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.text).toBe("Done");
    expect(response.parts?.map((part) => part.type)).toEqual([
      "attachment",
      "failure",
      "failure",
      "failure",
      "failure",
    ]);
    expect(response.parts?.[3]).toMatchObject({ type: "failure", code: "artifact_too_large" });
    expect(JSON.stringify(response.parts)).not.toContain(outside);
  });

  it("rejects oversized owner metadata before publishing an unreadable manifest", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "report.txt"), "report");
    const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
    const publisher = await openPublisher(service, "run-manifest-boundary", "c".repeat(20 * 1024));
    let result: Awaited<ReturnType<typeof publisher.client.callTool>>;
    try {
      result = await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "report.txt" },
      });
    } finally {
      await publisher.close();
    }

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { published: false, code: "artifact_publish_failed" },
    });
    const response = await service.wrapResponder(responder("run-manifest-boundary")).respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.parts).toEqual([
      expect.objectContaining({ type: "failure", code: "artifact_publish_failed" }),
    ]);
  });

  it("fails closed for expired, missing, and integrity-mismatched references", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "report.txt"), "report");
    let clock = new Date("2026-08-14T12:00:00.000Z");
    const service = createReplyArtifactService({
      artifactDir: join(root, "artifacts"),
      workspace,
      retentionDays: 1,
      now: () => clock,
    });
    const publisher = await openPublisher(service, "run-3", "conversation");
    try {
      await publisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path: "report.txt" } });
    } finally {
      await publisher.close();
    }
    const wrapped = service.wrapResponder(responder("run-3"));
    const response = await wrapped.respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    const attachment = response.parts?.[0] as AgentReplyAttachmentPart;

    await expect(wrapped.openReplyArtifact?.({
      conversationId: "conversation",
      reference: attachment.reference,
      expectedIntegrityId: `sha256:${"0".repeat(64)}`,
    })).rejects.toMatchObject({ code: "artifact_integrity_failed" });
    await expect(wrapped.openReplyArtifact?.({
      conversationId: "conversation",
      reference: { scheme: "mono-agent-artifact", id: "00000000-0000-4000-8000-000000000000" },
    })).rejects.toMatchObject({ code: "artifact_missing" });

    clock = new Date("2026-08-16T12:00:00.000Z");
    await expect(wrapped.openReplyArtifact?.({
      conversationId: "conversation",
      reference: attachment.reference,
    })).rejects.toMatchObject({ code: "artifact_expired" });
  });

  it("uses a high-entropy loopback-only, request-scoped capability URL", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
    const first = await openPublisher(service, "sensitive-run", "sensitive-conversation");
    const second = await openPublisher(service, "other-run", "other-conversation");
    try {
      const firstUrl = new URL(first.url);
      expect(firstUrl.hostname).toBe("127.0.0.1");
      expect(firstUrl.pathname).toMatch(/^\/mcp\/[0-9a-f]{8}-[0-9a-f-]{27,35}$/u);
      expect(first.url).not.toContain("sensitive-run");
      expect(first.url).not.toContain("sensitive-conversation");
      expect(first.url).not.toContain(workspace);
      expect(second.url).not.toBe(first.url);
      expect(first.privateCapability).toBe(true);
      expect(first.serializedSpec).toBe('{"type":"http"}');
      expect(first.serializedSpec).not.toContain(first.url);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("keeps an in-flight staged publication through cleanup and exposes only the atomic completed directory", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "report.txt"), "atomic");
    const entered = deferred();
    const release = deferred();
    const clock = new Date("2026-08-15T12:00:00.000Z");
    const service = createReplyArtifactService({
      artifactDir: join(root, "artifacts"),
      workspace,
      now: () => clock,
      stagingGraceMs: 60_000,
      beforePublicationCommit: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const publisher = await openPublisher(service, "run-atomic", "conversation");
    const publishing = publisher.client.callTool({
      name: PUBLISH_REPLY_FILE_TOOL_NAME,
      arguments: { path: "report.txt" },
    });
    await entered.promise;
    const artifactRoot = join(root, "artifacts", "reply-files");
    expect((await readdir(artifactRoot)).filter((entry) => entry !== ".staging")).toEqual([]);
    const staged = await readdir(join(artifactRoot, ".staging"));
    expect(staged).toHaveLength(1);
    await service.cleanupExpired();
    await expect(access(join(artifactRoot, ".staging", staged[0]!))).resolves.toBeUndefined();

    release.resolve();
    const result = await publishing;
    await publisher.close();
    const artifactId = (result.structuredContent as { attachmentId?: string } | undefined)?.attachmentId;
    expect(artifactId).toMatch(/^[0-9a-f]{8}-/u);
    expect((await readdir(join(artifactRoot, artifactId!))).sort()).toEqual(["content", "metadata.json"]);
    expect(await readdir(join(artifactRoot, ".staging"))).toEqual([]);

    const stale = "00000000-0000-4000-8000-000000000001";
    const recent = "00000000-0000-4000-8000-000000000002";
    await mkdir(join(artifactRoot, ".staging", stale));
    await mkdir(join(artifactRoot, ".staging", recent));
    await utimes(join(artifactRoot, ".staging", stale), new Date(clock.getTime() - 120_000), new Date(clock.getTime() - 120_000));
    await utimes(join(artifactRoot, ".staging", recent), clock, clock);
    await service.cleanupExpired();
    await expect(access(join(artifactRoot, ".staging", stale))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(artifactRoot, ".staging", recent))).resolves.toBeUndefined();
  });

  it("rejects a swapped directory component before any adversarial bytes are copied", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const sourceDirectory = join(workspace, "source");
    const outsideDirectory = join(root, "outside");
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(outsideDirectory);
    await writeFile(join(sourceDirectory, "report.txt"), "safe");
    await writeFile(join(outsideDirectory, "report.txt"), "private-secret");
    const service = createReplyArtifactService({
      artifactDir: join(root, "artifacts"),
      workspace,
      beforeSourceOpen: async () => {
        await rename(sourceDirectory, join(workspace, "source-original"));
        await symlink(outsideDirectory, sourceDirectory);
      },
    });
    const publisher = await openPublisher(service, "run-swap", "conversation");
    try {
      const result = await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "source/report.txt" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private-secret");
      expect(JSON.stringify(result)).not.toContain(outsideDirectory);
    } finally {
      await publisher.close();
    }
    const response = await service.wrapResponder(responder("run-swap")).respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.parts).toEqual([
      expect.objectContaining({ type: "failure", code: "artifact_publish_failed" }),
    ]);
  });

  it("deduplicates retry publication by integrity id and preserves first-seen response parts", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "report.txt"), "same bytes");
    const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
    const publisher = await openPublisher(service, "run-retry", "conversation");
    let first: Awaited<ReturnType<typeof publisher.client.callTool>>;
    let second: Awaited<ReturnType<typeof publisher.client.callTool>>;
    try {
      first = await publisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path: "report.txt" } });
      second = await publisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path: "report.txt" } });
    } finally {
      await publisher.close();
    }
    expect(second.structuredContent).toEqual(first.structuredContent);
    const published = first.structuredContent as {
      attachmentId: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      integrityId: string;
    };
    const existing: AgentReplyAttachmentPart = {
      type: "attachment",
      id: published.attachmentId,
      reference: { scheme: "mono-agent-artifact", id: published.attachmentId },
      name: published.name,
      mediaType: published.mediaType,
      sizeBytes: published.sizeBytes,
      integrityId: published.integrityId,
    };
    const response = await service.wrapResponder({
      async respond() { return { text: "done", metadata: { runId: "run-retry" }, parts: [existing] }; },
    }).respond({ conversationId: "conversation", text: "publish", abortSignal: new AbortController().signal }, stream);
    expect(response.parts).toEqual([existing]);
    const live = (await readdir(join(root, "artifacts", "reply-files")))
      .filter((entry) => /^[0-9a-f]{8}-/u.test(entry));
    expect(live).toEqual([published.attachmentId]);
  });

  it("accepts exactly the shared rich-part boundary and returns a capability error for the next file", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await Promise.all(Array.from({ length: 21 }, async (_, index) => {
      await writeFile(join(workspace, `file-${String(index)}.txt`), `content-${String(index)}`);
    }));
    const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
    const publisher = await openPublisher(service, "run-limit", "conversation");
    let overCap: Awaited<ReturnType<typeof publisher.client.callTool>> | undefined;
    try {
      for (let index = 0; index < 21; index += 1) {
        const result = await publisher.client.callTool({
          name: PUBLISH_REPLY_FILE_TOOL_NAME,
          arguments: { path: `file-${String(index)}.txt` },
        });
        if (index === 20) overCap = result;
      }
    } finally {
      await publisher.close();
    }
    expect(overCap).toMatchObject({ isError: true, structuredContent: { code: "artifact_publish_failed" } });
    const response = await service.wrapResponder(responder("run-limit")).respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.parts).toHaveLength(20);
    expect(response.parts?.every((part) => part.type === "attachment")).toBe(true);
  });

  it.each(["throw", "cancel", "missing metadata"] as const)(
    "releases run state and published files on terminal %s",
    async (terminal) => {
      const root = await tempDir();
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      await writeFile(join(workspace, "report.txt"), "report");
      const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
      const base: AgentResponder = {
        async respond(request) {
          const publisher = await openPublisher(service, "run-terminal", request.conversationId);
          try {
            await publisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path: "report.txt" } });
          } finally {
            await publisher.close();
            await publisher.settle();
          }
          if (terminal === "throw") throw new Error("responder failed");
          if (terminal === "cancel") throw new AgentResponseCancelledError("cancelled");
          return { text: "no run metadata" };
        },
      };
      const wrapped = service.wrapResponder(base);
      const request = { conversationId: "conversation", text: "publish", abortSignal: new AbortController().signal };
      if (terminal === "missing metadata") await wrapped.respond(request, stream);
      else await expect(wrapped.respond(request, stream)).rejects.toThrow();
      const entries = await readdir(join(root, "artifacts", "reply-files"));
      expect(entries.filter((entry) => /^[0-9a-f]{8}-/u.test(entry))).toEqual([]);
    },
  );

  it("retains files after request-extension settlement only when matching run metadata succeeds", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "report.txt"), "report");
    const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
    const base: AgentResponder = {
      async respond(request) {
        const publisher = await openPublisher(service, "run-retained", request.conversationId);
        try {
          await publisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path: "report.txt" } });
        } finally {
          await publisher.close();
          await publisher.settle();
        }
        return { text: "done", metadata: { runId: "run-retained" } };
      },
    };
    const response = await service.wrapResponder(base).respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    const attachment = response.parts?.[0] as AgentReplyAttachmentPart;
    await expect(access(join(root, "artifacts", "reply-files", attachment.reference.id, "metadata.json")))
      .resolves.toBeUndefined();
  });
});
