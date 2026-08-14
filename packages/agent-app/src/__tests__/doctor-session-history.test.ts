import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  ToolHistoryWriter,
  TOOL_HISTORY_DATABASE,
  TOOL_HISTORY_DIRECTORY,
} from "@mono-agent/agent-harness";
import { afterEach, describe, expect, it } from "vitest";

import { sessionToolHistorySection } from "../doctor-session-history.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-history-doctor-"));
  tempDirs.push(dir);
  return join(dir, "history");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

const binding = {
  conversationId: "chat:42",
  logicalConversationId: "chat:42",
  runId: "prior-run",
  isolated: false,
} as const;

describe("sessionToolHistorySection", () => {
  it("reports separate zero-byte stores before first use and flags only unsupported direct routes", async () => {
    const root = await tempRoot();
    const supported = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(supported).toMatchObject({ id: "session-tool-history", status: "ok" });
    expect(supported.details).toContain("Message history: 0 files, 0 bytes.");
    expect(supported.details).toContain("Tool history: not created yet (0 bytes).");

    const unsupported = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: false });
    expect(unsupported.status).toBe("waiting");
    expect(unsupported.details.join("\n")).toMatch(/unsupported_route.*persist.*cold-project.*cannot expose SessionHistory/iu);
  });

  it("reports message bytes separately from retained payload and physical tool-history bytes", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "conversation.history.json"), "{}\n");
    const writer = await ToolHistoryWriter.open({ root });
    await writer.persist(binding, { phase: "invocation", toolCallId: "call-1", toolName: "Read", arguments: { path: "README.md" } });
    await writer.persist(binding, { phase: "result", toolCallId: "call-1", state: "success", content: "ok" });
    await writer.close();

    const section = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(section.status, section.details.join("\n")).toBe("ok");
    expect(section.details).toContain("Message history: 1 files, 3 bytes.");
    expect(section.details.join("\n")).toMatch(/Tool history physical storage: 2 files, \d+ bytes/iu);
    expect(section.details.join("\n")).toMatch(/Tool history: 1 calls, 2 records, 0 tombstones, \d+ retained payload bytes, \d+ database bytes/iu);
  });

  it("does not classify a graceful close of a dangling invocation as crash recovery", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    await writer.persist(binding, { phase: "invocation", toolCallId: "dangling", toolName: "Bash", arguments: {} });
    await writer.close();

    const section = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(section.status, section.details.join("\n")).toBe("ok");
    expect(section.details.join("\n")).toContain("Tool history: 1 calls, 2 records");
    expect(section.details.join("\n")).not.toContain("recovered as interrupted");
  });

  it.skipIf(process.platform === "win32")("reports an actual writer crash as recovered and waiting", async () => {
    const root = await tempRoot();
    const fixture = fileURLToPath(new URL(
      "../../../agent-harness/src/__tests__/fixtures/tool-history-child.mjs",
      import.meta.url,
    ));
    const child = spawn(process.execPath, [fixture, root, "2000", "hold"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    try {
      await waitForChildOutput(child, () => output, "READY");
      child.kill("SIGKILL");
      await once(child, "exit");

      const recoveringWriter = await ToolHistoryWriter.open({ root, ownerAcquireCeilingMs: 1_000 });
      await recoveringWriter.close();
      const section = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });

      expect(section.status, section.details.join("\n")).toBe("waiting");
      expect(section.details.join("\n")).toContain("Tool history: 1 calls, 2 records");
      expect(section.details.join("\n")).toContain("1 invocation(s) were recovered as interrupted without rerun.");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => undefined);
      }
    }
  }, 10_000);

  it.skipIf(process.platform === "win32")("reports a secure live DELETE transaction as waiting instead of error", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const contentPath = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const journalPath = `${contentPath}-journal`;
    const blocker = new DatabaseSync(contentPath);
    blocker.exec("PRAGMA busy_timeout=0; BEGIN");
    blocker.prepare("SELECT count(*) FROM metadata").get();
    const persistence = writer.persist(binding, {
      phase: "invocation",
      toolCallId: "live-transaction",
      toolName: "Read",
      arguments: { path: "README.md" },
    });
    try {
      const journal = await waitForFile(journalPath);
      expect(Number(journal.mode) & 0o777).toBe(0o600);

      const section = await sessionToolHistorySection({
        historyRoot: root,
        requestScopedToolSupported: true,
      });
      expect(section.status).toBe("waiting");
      expect(section.details).toContain(
        "An in-flight DELETE journal is present under the protected 0700 tool-history directory.",
      );
      expect(section.details.join("\n")).not.toMatch(/journal must be.*0600/iu);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    await persistence;
    await writer.close();
  }, 10_000);

  it("hard-fails newer schema state with the documented purge-only downgrade path", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    await writer.close();
    const path = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version=2");
    database.close();

    const section = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(section.status).toBe("error");
    expect(section.details.join("\n")).toContain("Downgrade hard-fails until persisted conversation state is purged.");
  });

  it.skipIf(process.platform === "win32")("rejects a content database that is not owner-only", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    await writer.close();
    await chmod(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE), 0o644);

    const section = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(section.status).toBe("error");
    expect(section.details).toContain("Tool history database must be a single-link regular current-user file with mode 0600.");
  });
});

async function waitForFile(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
}

async function waitForChildOutput(
  child: ChildProcess,
  output: () => string,
  marker: string,
): Promise<void> {
  if (output().includes(marker)) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for child marker ${marker}: ${output()}`));
    }, 5_000);
    const onData = (): void => {
      if (!output().includes(marker)) return;
      cleanup();
      resolvePromise();
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectPromise(new Error(`Child exited ${String(code)} before ${marker}: ${output()}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}
