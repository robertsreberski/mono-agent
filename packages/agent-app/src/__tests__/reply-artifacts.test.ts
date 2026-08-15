import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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
  replyArtifactStorageBudgetFor,
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

async function padJsonFileToLimit(path: string, maxBytes: number): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  let low = 0;
  let high = maxBytes;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const serialized = `${JSON.stringify({ ...value, padding: "x".repeat(middle) })}\n`;
    if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
      best = serialized;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best.length === 0) throw new Error("Test manifest could not be padded to its byte boundary.");
  await writeFile(path, best, "utf8");
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

  it("allows ordinary workspace and exact current-run output files while excluding every private namespace", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const artifactDir = join(workspace, "runtime-records");
    const currentRunOutput = join(artifactDir, "outbound", "run-scope");
    const otherRunOutput = join(artifactDir, "outbound", "run-other");
    const memoryRoot = join(workspace, "knowledge-store");
    const stateRoot = join(workspace, "runtime-state");
    const nestedPrivateRoot = join(currentRunOutput, "nested-private");
    await Promise.all([
      mkdir(join(workspace, "exports"), { recursive: true }),
      mkdir(currentRunOutput, { recursive: true }),
      mkdir(otherRunOutput, { recursive: true }),
      mkdir(memoryRoot, { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
      mkdir(nestedPrivateRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspace, "exports", "ordinary.txt"), "ordinary-public"),
      writeFile(join(currentRunOutput, "current.txt"), "current-run-public"),
      writeFile(join(otherRunOutput, "other.txt"), "other-run-private"),
      writeFile(join(memoryRoot, "harmless-name.txt"), "memory-private"),
      writeFile(join(stateRoot, "harmless-name.txt"), "state-private"),
      writeFile(join(nestedPrivateRoot, "harmless-name.txt"), "nested-private"),
      writeFile(join(artifactDir, "run-private.events.jsonl"), "transcript-private"),
    ]);
    const service = createReplyArtifactService({
      artifactDir,
      workspace,
      privateRoots: [memoryRoot, stateRoot, nestedPrivateRoot],
    });
    const publisher = await openPublisher(service, "run-scope", "origin-conversation");
    const failures: unknown[] = [];
    try {
      const ordinary = await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "exports/ordinary.txt" },
      });
      const outbound = await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: join(currentRunOutput, "current.txt") },
      });
      expect(ordinary).toMatchObject({ structuredContent: { published: true } });
      expect(outbound).toMatchObject({ structuredContent: { published: true } });

      const firstArtifactId = (ordinary.structuredContent as { attachmentId: string }).attachmentId;
      for (const path of [
        join(otherRunOutput, "other.txt"),
        join(memoryRoot, "harmless-name.txt"),
        join(stateRoot, "harmless-name.txt"),
        join(nestedPrivateRoot, "harmless-name.txt"),
        join(artifactDir, "run-private.events.jsonl"),
        join(artifactDir, "reply-files", firstArtifactId, "content"),
      ]) {
        failures.push(await publisher.client.callTool({
          name: PUBLISH_REPLY_FILE_TOOL_NAME,
          arguments: { path },
        }));
      }
    } finally {
      await publisher.close();
    }

    expect(failures).toHaveLength(6);
    expect(failures).toEqual(failures.map(() => expect.objectContaining({
      isError: true,
      structuredContent: { published: false, code: "artifact_publish_failed" },
    })));
    const serializedFailures = JSON.stringify(failures);
    for (const secret of [
      "other-run-private",
      "memory-private",
      "state-private",
      "nested-private",
      "transcript-private",
      artifactDir,
    ]) expect(serializedFailures).not.toContain(secret);

    const response = await service.wrapResponder(responder("run-scope")).respond({
      conversationId: "delivery-conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.text).toBe("Done");
    expect(response.parts?.filter((part) => part.type === "attachment")).toHaveLength(2);
    expect(response.parts?.filter((part) => part.type === "failure")).toHaveLength(6);
  });

  it("rejects hidden, credential, key-store, state-database, and Unicode-disguised names at any depth", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "nested", ".hidden"), { recursive: true });
    const blocked = [
      ".env",
      ".ENV.local",
      "．ｅｎｖ",
      "nested/.hidden/value.txt",
      "nested/mono-agent.config.json",
      "nested/MCP.JSON",
      "nested/auth.json",
      "nested/provider-credentials.toml",
      "nested/ＳＥＣＲＥＴＳ.yaml",
      "nested/To\u200Dken.json",
      "nested/npmrc",
      "nested/id_ED25519",
      "nested/server.PEM",
      "nested/private.KEY",
      "nested/client.CRT",
      "nested/store.P12",
      "nested/vault.JKS",
      "nested/key-store.json",
      "nested/trust‍store.txt",
      "nested/OAuth2.json",
      "nested/cacerts",
      "nested/KUBECONFIG",
      "nested/memory.SQLite",
      "nested/passwords.KDBX",
    ] as const;
    for (const path of blocked) await writeFile(join(workspace, path), `private:${path}`);
    const allowed = ["nested/re\u0301sume\u0301.txt", "nested/authors-notes.txt", "nested/tokenizer.txt"] as const;
    for (const path of allowed) await writeFile(join(workspace, path), `public:${path}`);

    const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
    const publisher = await openPublisher(service, "run-names", "conversation");
    const blockedResults: unknown[] = [];
    const allowedResults: unknown[] = [];
    try {
      for (const path of blocked) {
        blockedResults.push(await publisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path } }));
      }
    } finally {
      await publisher.close();
    }
    const allowedPublisher = await openPublisher(service, "run-harmless-names", "conversation");
    try {
      for (const path of allowed) {
        allowedResults.push(await allowedPublisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path } }));
      }
    } finally {
      await allowedPublisher.close();
    }

    expect(blockedResults).toEqual(blockedResults.map(() => expect.objectContaining({
      isError: true,
      structuredContent: { published: false, code: "artifact_publish_failed" },
    })));
    for (const result of allowedResults) expect(result).toMatchObject({
      structuredContent: { published: true },
    });
    const serialized = JSON.stringify(blockedResults);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(32 * 1024);
    expect(serialized).not.toContain("private:");
    expect(serialized).not.toContain(workspace);
  });

  it("rejects hardlink aliases and a hardlink swapped in after canonical authorization", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const privateRoot = join(root, "private-root");
    await mkdir(workspace);
    await mkdir(privateRoot);
    const privateFile = join(privateRoot, "payload.txt");
    const alias = join(workspace, "ordinary-report.txt");
    await writeFile(privateFile, "hardlink-private-sentinel");
    await link(privateFile, alias);
    const directService = createReplyArtifactService({ artifactDir: join(root, "artifacts-direct"), workspace });
    const directPublisher = await openPublisher(directService, "run-hardlink", "conversation");
    try {
      const result = await directPublisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: alias },
      });
      expect(result).toMatchObject({ isError: true, structuredContent: { code: "artifact_publish_failed" } });
      expect(JSON.stringify(result)).not.toContain("hardlink-private-sentinel");
      expect(JSON.stringify(result)).not.toContain(privateRoot);
    } finally {
      await directPublisher.close();
    }

    const swapped = join(workspace, "swapped-report.txt");
    await writeFile(swapped, "initial-public");
    const swapService = createReplyArtifactService({
      artifactDir: join(root, "artifacts-swap"),
      workspace,
      beforeSourceOpen: async () => {
        await rm(swapped);
        await link(privateFile, swapped);
      },
    });
    const swapPublisher = await openPublisher(swapService, "run-hardlink-swap", "conversation");
    try {
      const result = await swapPublisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: swapped },
      });
      expect(result).toMatchObject({ isError: true, structuredContent: { code: "artifact_publish_failed" } });
      expect(JSON.stringify(result)).not.toContain("hardlink-private-sentinel");
      expect(JSON.stringify(result)).not.toContain(privateRoot);
    } finally {
      await swapPublisher.close();
    }
  });

  it("normalizes harmless display names, strips bidi controls, and truncates only at Unicode code-point boundaries", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "one.txt"), "one");
    await writeFile(join(workspace, "two.txt"), "two");
    const service = createReplyArtifactService({ artifactDir: join(root, "artifacts"), workspace });
    const publisher = await openPublisher(service, "run-display", "conversation");
    try {
      await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "one.txt", name: `Cafe\u0301\u202e\u2066-${"😀".repeat(80)}.txt` },
      });
      await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "two.txt", name: "quarterly report.txt" },
      });
    } finally {
      await publisher.close();
    }
    const response = await service.wrapResponder(responder("run-display")).respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    const attachments = response.parts?.filter(
      (part): part is AgentReplyAttachmentPart => part.type === "attachment",
    ) ?? [];
    expect(attachments[0]?.name.startsWith("Café-")).toBe(true);
    expect(attachments[0]?.name).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(attachments[0]?.name).not.toContain("�");
    expect(Buffer.byteLength(attachments[0]!.name, "utf8")).toBeLessThanOrEqual(240);
    expect(attachments[1]?.name).toBe("quarterly report.txt");
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

  it("turns only a delivery-binding overflow into a bounded failure and preserves text plus good files", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const artifactDir = join(root, "artifacts");
    await mkdir(workspace);
    await writeFile(join(workspace, "bad.txt"), "bad-content");
    await writeFile(join(workspace, "good.txt"), "good-content");
    const service = createReplyArtifactService({ artifactDir, workspace });
    const publisher = await openPublisher(service, "run-binding", "origin");
    let badId = "";
    let goodId = "";
    try {
      const bad = await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "bad.txt" },
      });
      const good = await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "good.txt" },
      });
      badId = (bad.structuredContent as { attachmentId: string }).attachmentId;
      goodId = (good.structuredContent as { attachmentId: string }).attachmentId;
    } finally {
      await publisher.close();
    }
    await padJsonFileToLimit(join(artifactDir, "reply-files", badId, "metadata.json"), 16 * 1024);

    const response = await service.wrapResponder(responder("run-binding")).respond({
      conversationId: "delivery",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);

    expect(response.text).toBe("Done");
    expect(response.parts).toEqual([
      expect.objectContaining({
        type: "failure",
        code: "artifact_publish_failed",
        relatedPartId: badId,
        message: "The generated file could not be finalized for delivery.",
      }),
      expect.objectContaining({ type: "attachment", id: goodId }),
    ]);
    expect(Buffer.byteLength(JSON.stringify(response.parts?.[0]), "utf8")).toBeLessThan(1_024);
    expect(JSON.stringify(response.parts)).not.toContain("padding");
    await expect(access(join(artifactDir, "reply-files", badId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(artifactDir, "reply-files", goodId, "metadata.json"))).resolves.toBeUndefined();
    expect((await readdir(join(artifactDir, "reply-files", goodId))).some((name) => name.endsWith(".partial")))
      .toBe(false);
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

  it("serializes aggregate admission across service instances without deleting another active staging directory", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const artifactDir = join(root, "artifacts");
    await mkdir(workspace);
    await writeFile(join(workspace, "first.txt"), "12345678");
    await writeFile(join(workspace, "second.txt"), "x");
    const entered = deferred();
    const release = deferred();
    let commits = 0;
    const storageBudget = replyArtifactStorageBudgetFor(artifactDir, (16 * 1024) + 8);
    const firstService = createReplyArtifactService({
      artifactDir,
      workspace,
      storageBudget,
      stagingGraceMs: 1,
      now: () => new Date(Date.now() + 60_000),
      beforePublicationCommit: async () => {
        commits += 1;
        if (commits !== 1) return;
        entered.resolve();
        await release.promise;
      },
    });
    const secondService = createReplyArtifactService({
      artifactDir,
      workspace,
      storageBudget,
      stagingGraceMs: 1,
      now: () => new Date(Date.now() + 60_000),
    });
    const firstPublisher = await openPublisher(firstService, "run-cap-first", "conversation");
    const secondPublisher = await openPublisher(secondService, "run-cap-second", "conversation");
    const firstPublishing = firstPublisher.client.callTool({
      name: PUBLISH_REPLY_FILE_TOOL_NAME,
      arguments: { path: "first.txt" },
    });
    await entered.promise;
    const staged = await readdir(join(artifactDir, "reply-files", ".staging"));
    expect(staged).toHaveLength(1);
    await secondService.cleanupExpired();
    await expect(access(join(artifactDir, "reply-files", ".staging", staged[0]!))).resolves.toBeUndefined();

    const rejected = await secondPublisher.client.callTool({
      name: PUBLISH_REPLY_FILE_TOOL_NAME,
      arguments: { path: "second.txt" },
    });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: { published: false, code: "artifact_publish_failed" },
      content: [{ text: "Reply artifact storage is full; this file was not published." }],
    });
    release.resolve();
    const accepted = await firstPublishing;
    await firstPublisher.close();
    await secondPublisher.close();
    expect(accepted).toMatchObject({ structuredContent: { published: true } });
    const acceptedId = (accepted.structuredContent as { attachmentId: string }).attachmentId;
    await expect(access(join(artifactDir, "reply-files", acceptedId, "content"))).resolves.toBeUndefined();
  });

  it("does not expire committed current-run content before responder finalization", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const artifactDir = join(root, "artifacts");
    await mkdir(workspace);
    await writeFile(join(workspace, "report.txt"), "current-run");
    let clock = new Date("2026-08-15T12:00:00.000Z");
    const storageBudget = replyArtifactStorageBudgetFor(artifactDir);
    const publishingService = createReplyArtifactService({
      artifactDir,
      workspace,
      storageBudget,
      retentionDays: 1,
      now: () => clock,
    });
    const cleanupService = createReplyArtifactService({
      artifactDir,
      workspace,
      storageBudget,
      retentionDays: 1,
      now: () => clock,
    });
    const publisher = await openPublisher(publishingService, "run-current", "conversation");
    let artifactId = "";
    try {
      const result = await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "report.txt" },
      });
      artifactId = (result.structuredContent as { attachmentId: string }).attachmentId;
    } finally {
      await publisher.close();
    }
    const directory = join(artifactDir, "reply-files", artifactId);
    clock = new Date("2026-08-17T12:00:00.000Z");
    await cleanupService.cleanupExpired();
    await expect(access(directory)).resolves.toBeUndefined();

    const response = await publishingService.wrapResponder(responder("run-current")).respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.parts).toEqual([expect.objectContaining({ type: "attachment", id: artifactId })]);
    await cleanupService.cleanupExpired();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inventories both durable namespaces after restart and fails closed without evicting stored content", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const artifactDir = join(root, "artifacts");
    const replySeed = join(artifactDir, "reply-files", "restart-seed", "content");
    const appSeed = join(artifactDir, "mcp-apps", "restart-seed", "resource.html");
    await mkdir(workspace);
    await mkdir(join(replySeed, ".."), { recursive: true });
    await mkdir(join(appSeed, ".."), { recursive: true });
    await writeFile(replySeed, "r".repeat(1_024));
    await writeFile(appSeed, "a".repeat(1_024));
    await writeFile(join(workspace, "new.txt"), "x");
    const storageBudget = replyArtifactStorageBudgetFor(artifactDir, (16 * 1024) + 1_024);
    const service = createReplyArtifactService({ artifactDir, workspace, storageBudget });
    const publisher = await openPublisher(service, "run-restart-inventory", "conversation");
    try {
      const result = await publisher.client.callTool({
        name: PUBLISH_REPLY_FILE_TOOL_NAME,
        arguments: { path: "new.txt" },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [{ text: "Reply artifact storage is full; this file was not published." }],
      });
    } finally {
      await publisher.close();
    }
    await expect(access(replySeed)).resolves.toBeUndefined();
    await expect(access(appSeed)).resolves.toBeUndefined();
  });

  it("does not expire an authorized stream until its pinned body finishes", async () => {
    const root = await tempDir();
    const workspace = join(root, "workspace");
    const artifactDir = join(root, "artifacts");
    await mkdir(workspace);
    await writeFile(join(workspace, "report.txt"), "authorized-stream");
    let clock = new Date("2026-08-15T12:00:00.000Z");
    const service = createReplyArtifactService({
      artifactDir,
      workspace,
      retentionDays: 1,
      now: () => clock,
    });
    const publisher = await openPublisher(service, "run-stream", "conversation");
    try {
      await publisher.client.callTool({ name: PUBLISH_REPLY_FILE_TOOL_NAME, arguments: { path: "report.txt" } });
    } finally {
      await publisher.close();
    }
    const wrapped = service.wrapResponder(responder("run-stream"));
    const response = await wrapped.respond({
      conversationId: "conversation",
      text: "publish",
      abortSignal: new AbortController().signal,
    }, stream);
    const attachment = response.parts?.[0] as AgentReplyAttachmentPart;
    const opened = await wrapped.openReplyArtifact?.({
      conversationId: "conversation",
      reference: attachment.reference,
    });
    clock = new Date("2026-08-17T12:00:00.000Z");
    await service.cleanupExpired();
    const directory = join(artifactDir, "reply-files", attachment.reference.id);
    await expect(access(directory)).resolves.toBeUndefined();
    expect(await collect(opened!.body)).toEqual(Buffer.from("authorized-stream"));
    await service.cleanupExpired();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
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
