import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  ToolHistoryWriter,
  TOOL_HISTORY_APPLICATION_ID,
  TOOL_HISTORY_DATABASE,
  TOOL_HISTORY_DIRECTORY,
  TOOL_HISTORY_OWNER_DATABASE,
  TOOL_HISTORY_USER_VERSION,
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

  it("returns a bounded path-safe diagnostic when the configured history parent is not a directory", async () => {
    const root = await tempRoot();
    await writeFile(root, "private-content-must-not-escape");
    const configuredHistory = join(root, "private-history-child");

    const section = await sessionToolHistorySection({
      historyRoot: configuredHistory,
      requestScopedToolSupported: true,
    });

    expect(section).toEqual({
      id: "session-tool-history",
      label: "Session tool history",
      status: "error",
      details: ["Session tool history could not be inspected (ENOTDIR)."],
    });
    expect(section.details.join("\n")).not.toContain(configuredHistory);
    expect(section.details.join("\n")).not.toContain("private-content-must-not-escape");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "returns a bounded path-safe diagnostic when configured history is inaccessible",
    async () => {
      const root = await tempRoot();
      await mkdir(root, { mode: 0o700 });
      await chmod(root, 0o000);
      const section = await (async () => {
        try {
          return await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
        } finally {
          await chmod(root, 0o700);
        }
      })();

      expect(section).toEqual({
        id: "session-tool-history",
        label: "Session tool history",
        status: "error",
        details: ["Session tool history could not be inspected (EACCES)."],
      });
      expect(section.details.join("\n")).not.toContain(root);
    },
  );

  it("treats a crash-stale zero-byte content database as pristine and writer-recoverable", async () => {
    const root = await tempRoot();
    const initialized = await ToolHistoryWriter.open({ root });
    await initialized.close();
    const path = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    await writeFile(path, "", { mode: 0o600 });

    const pristine = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(pristine.status, pristine.details.join("\n")).toBe("ok");
    expect(pristine.details).toContain(
      "Tool history database is a pristine zero-byte file; the next writer can initialize it safely.",
    );
    expect(pristine.details.join("\n")).not.toMatch(/unsupported.*schema|downgrade/iu);

    const recovered = await ToolHistoryWriter.open({ root });
    await expect(recovered.stats()).resolves.toMatchObject({ calls: 0, records: 0 });
    await recovered.close();
    const healthy = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(healthy.status, healthy.details.join("\n")).toBe("ok");
  });

  it("treats a journal beside a pristine zero-byte database as stale recoverable state, not a foreign schema", async () => {
    const root = await tempRoot();
    const initialized = await ToolHistoryWriter.open({ root });
    await initialized.close();
    const path = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    await writeFile(path, "", { mode: 0o600 });
    const interrupted = new DatabaseSync(path);
    interrupted.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      PRAGMA application_id=${String(TOOL_HISTORY_APPLICATION_ID)};
      CREATE TABLE interrupted(value TEXT);
    `);
    const journalBytes = await readFile(`${path}-journal`);
    expect(journalBytes.byteLength).toBeGreaterThan(0);
    interrupted.exec("ROLLBACK");
    interrupted.close();
    await writeFile(path, "", { mode: 0o600 });
    await writeFile(`${path}-journal`, journalBytes, { mode: 0o600 });

    const stale = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(stale.status, stale.details.join("\n")).toBe("waiting");
    expect(stale.details).toContain(
      "A crash-stale DELETE journal accompanies the pristine tool-history database; the next writer can recover and initialize it safely.",
    );
    expect(stale.details.join("\n")).not.toMatch(/foreign tool-history schema|purged before adoption|downgrade/iu);

    const recovered = await ToolHistoryWriter.open({ root });
    await expect(recovered.stats()).resolves.toMatchObject({ calls: 0, records: 0 });
    await recovered.close();
  });

  it("reports zero-byte owner and live pristine initialization windows as waiting without false corruption", async () => {
    const root = await tempRoot();
    const toolDirectory = join(root, TOOL_HISTORY_DIRECTORY);
    const locksDirectory = join(root, ".locks");
    const contentPath = join(toolDirectory, TOOL_HISTORY_DATABASE);
    const ownerPath = join(locksDirectory, TOOL_HISTORY_OWNER_DATABASE);
    await mkdir(toolDirectory, { recursive: true, mode: 0o700 });
    await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
    await writeFile(contentPath, "", { mode: 0o600 });
    await writeFile(ownerPath, "", { mode: 0o600 });

    const unpublished = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(unpublished.status, unpublished.details.join("\n")).toBe("waiting");
    expect(unpublished.details.join("\n")).toContain("Tool history owner database is a pristine zero-byte file");
    expect(unpublished.details.join("\n")).not.toMatch(/owner database cannot be inspected|foreign tool-history schema|purge/iu);

    const owner = new DatabaseSync(ownerPath);
    owner.exec("CREATE TABLE writer_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL, acquired_at_ms INTEGER NOT NULL)");
    owner.prepare("INSERT INTO writer_owner (singleton,pid,token,acquired_at_ms) VALUES (1,?,?,?)")
      .run(process.pid, "doctor-live-initialization", Date.now());
    owner.close();
    await writeFile(`${contentPath}-journal`, "", { mode: 0o600 });

    const live = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(live.status, live.details.join("\n")).toBe("waiting");
    expect(live.details).toContain("A live writer is still initializing the pristine tool-history database.");
    expect(live.details).toContain(
      "An in-flight DELETE journal is present while the live writer initializes the pristine tool-history database.",
    );
    expect(live.details.join("\n")).not.toMatch(/cannot be inspected|foreign tool-history schema|purge/iu);
  });

  it("treats owner-before-content publication races as waiting but keeps a dead owner fail-visible", async () => {
    const root = await tempRoot();
    const toolDirectory = join(root, TOOL_HISTORY_DIRECTORY);
    const locksDirectory = join(root, ".locks");
    const ownerPath = join(locksDirectory, TOOL_HISTORY_OWNER_DATABASE);
    await mkdir(toolDirectory, { recursive: true, mode: 0o700 });
    await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
    await writeFile(ownerPath, "", { mode: 0o600 });

    const zeroByteOwner = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(zeroByteOwner.status, zeroByteOwner.details.join("\n")).toBe("waiting");
    expect(zeroByteOwner.details).toContain(
      "The zero-byte owner database is still initializing before the tool-history database is published.",
    );
    expect(zeroByteOwner.details.join("\n")).not.toContain("Tool history database must be");

    const owner = new DatabaseSync(ownerPath);
    owner.exec("CREATE TABLE writer_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL, acquired_at_ms INTEGER NOT NULL)");
    owner.prepare("INSERT INTO writer_owner (singleton,pid,token,acquired_at_ms) VALUES (1,?,?,?)")
      .run(process.pid, "doctor-owner-before-content", Date.now());
    owner.close();

    const liveOwner = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(liveOwner.status, liveOwner.details.join("\n")).toBe("waiting");
    expect(liveOwner.details).toContain(
      "A live writer owns the sidecar and is still initializing the tool-history database.",
    );
    expect(liveOwner.details.join("\n")).not.toContain("Tool history database must be");

    const staleOwner = new DatabaseSync(ownerPath);
    staleOwner.prepare("UPDATE writer_owner SET pid=? WHERE singleton=1").run(2_147_483_647);
    staleOwner.close();
    const stale = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(stale.status, stale.details.join("\n")).toBe("error");
    expect(stale.details).toContain(
      "Tool history database must be a single-link regular current-user file with mode 0600.",
    );
    expect(stale.details.join("\n")).toContain("Recorded writer owner PID 2147483647 is dead");
  });

  it("reports unresolved writer incidents and returns to healthy after matching operations succeed", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    await writer.persist(binding, {
      phase: "invocation", toolCallId: "conflicted-call", toolName: "Read", arguments: { path: "README.md" },
    });
    await writer.persist(binding, {
      phase: "invocation", toolCallId: "conflicted-call", toolName: "Bash", arguments: {},
    });
    await writer.persist(binding, {
      phase: "invocation", toolCallId: "missing-call", toolName: "", arguments: {},
    });
    await writer.close();

    const database = new DatabaseSync(join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE));
    const insertStat = database.prepare(`
      INSERT INTO writer_stats (key,value,last_detail,updated_at_ms) VALUES (?,?,?,?)
    `);
    try {
      insertStat.run("maintenance_failures", 1, "prior retention outage", Date.now());
      insertStat.run("recovery_failures", 1, "prior recovery outage", Date.now());
    } finally {
      database.close();
    }

    const degraded = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(degraded.status, degraded.details.join("\n")).toBe("error");
    expect(degraded.details.join("\n")).toContain("1 unresolved lifecycle write incident(s); only the matching tool-phase retry or a retry of the failed run finalization clears that incident.");
    expect(degraded.details.join("\n")).toContain("1 unresolved lifecycle idempotency conflict(s); only the matching tool-phase retry or canonical run-binding retry clears that incident.");
    expect(degraded.details.join("\n")).toContain("1 retention failure(s) remain");
    expect(degraded.details.join("\n")).toContain("1 recovery failure(s) remain");

    const unrelated = await ToolHistoryWriter.open({ root });
    await unrelated.persist({ ...binding, runId: "unrelated-run" }, {
      phase: "invocation", toolCallId: "healthy-call", toolName: "Read", arguments: { path: "README.md" },
    });
    await unrelated.persist({ ...binding, runId: "unrelated-run" }, {
      phase: "result", toolCallId: "healthy-call", state: "success", content: "ok",
    });
    await unrelated.close();

    const stillDegraded = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(stillDegraded.status, stillDegraded.details.join("\n")).toBe("error");
    expect(stillDegraded.details.join("\n")).toContain("1 unresolved lifecycle write incident(s)");
    expect(stillDegraded.details.join("\n")).toContain("1 unresolved lifecycle idempotency conflict(s)");
    expect(stillDegraded.details.join("\n")).not.toContain("retention failure(s) remain");
    expect(stillDegraded.details.join("\n")).not.toContain("recovery failure(s) remain");

    const recoveredWriter = await ToolHistoryWriter.open({ root });
    await recoveredWriter.persist(binding, {
      phase: "invocation", toolCallId: "conflicted-call", toolName: "Read", arguments: { path: "README.md" },
    });
    await recoveredWriter.persist(binding, {
      phase: "invocation", toolCallId: "missing-call", toolName: "Read", arguments: {},
    });
    await recoveredWriter.close();

    const recovered = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(recovered.status, recovered.details.join("\n")).toBe("ok");
    expect(recovered.details.join("\n")).not.toContain("unresolved lifecycle");
  });

  it("returns to healthy when reset retires conflicted and failed lifecycle identities", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    await writer.persist(binding, {
      phase: "invocation", toolCallId: "reset-call", toolName: "Read", arguments: {},
    });
    await writer.persist(binding, {
      phase: "invocation", toolCallId: "reset-call", toolName: "Bash", arguments: {},
    });
    await writer.persist(binding, {
      phase: "invocation", toolCallId: "failed-call", toolName: "", arguments: {},
    });
    await writer.close();

    const degraded = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(degraded.status, degraded.details.join("\n")).toBe("error");
    expect(degraded.details.join("\n")).toContain("1 unresolved lifecycle write incident(s)");
    expect(degraded.details.join("\n")).toContain("1 unresolved lifecycle idempotency conflict(s)");

    const reset = await ToolHistoryWriter.open({ root });
    await reset.resetConversation(binding.logicalConversationId);
    await reset.close();
    const healthy = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(healthy.status, healthy.details.join("\n")).toBe("ok");
    expect(healthy.details.join("\n")).not.toContain("unresolved lifecycle");
  });

  it("returns to healthy when retention makes a conflicted call unretryable", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({
      root,
      retention: { maxCompletedCalls: 1, maxBytes: 1024 * 1024, maxTombstones: 0 },
    });
    const victim = { ...binding, runId: "a-pruned-conflict" };
    const trigger = { ...binding, runId: "z-retention-trigger" };
    await writer.persist(victim, {
      phase: "invocation", toolCallId: "victim-call", toolName: "Read", arguments: {},
    });
    await writer.persist(victim, {
      phase: "result", toolCallId: "victim-call", state: "success", content: "victim",
    });
    await writer.persist(victim, {
      phase: "invocation", toolCallId: "victim-call", toolName: "Bash", arguments: {},
    });
    await writer.persist(trigger, {
      phase: "invocation", toolCallId: "trigger-call", toolName: "Read", arguments: {},
    });
    await writer.persist(trigger, {
      phase: "result", toolCallId: "trigger-call", state: "success", content: "trigger",
    });
    await writer.close();

    const healthy = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(healthy.status, healthy.details.join("\n")).toBe("ok");
    expect(healthy.details.join("\n")).not.toContain("unresolved lifecycle idempotency conflict");
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
    database.exec(`PRAGMA user_version=${String(TOOL_HISTORY_USER_VERSION + 1)}`);
    database.close();

    const section = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(section.status).toBe("error");
    expect(section.details.join("\n")).toContain("Downgrade hard-fails until persisted conversation state is purged.");
  });

  it("reports an older compatible schema as upgrade-pending rather than a blocked downgrade", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    await writer.close();
    const path = join(root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version=${String(TOOL_HISTORY_USER_VERSION - 1)}`);
    database.close();

    const pending = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(pending.status, pending.details.join("\n")).toBe("waiting");
    expect(pending.details.join("\n")).toContain("Tool-history schema upgrade is pending");
    expect(pending.details.join("\n")).not.toMatch(/downgrade/iu);

    const upgraded = await ToolHistoryWriter.open({ root });
    await upgraded.close();
    const healthy = await sessionToolHistorySection({ historyRoot: root, requestScopedToolSupported: true });
    expect(healthy.status, healthy.details.join("\n")).toBe("ok");
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
