import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWebInstances } from "../discovery.js";
import type { DiscoveredWebInstance } from "../discovery.js";
import { listInstanceSessionSummaries, readInstanceSession } from "../history.js";
import { makeTmpDir, registerSource, removeDir, seedRun } from "./helpers.js";

const tmpDirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const dir = await makeTmpDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(removeDir));
});

/** Register + discover a single instance whose artifact dir already holds runs. */
async function discoverOne(artifactDir: string): Promise<DiscoveredWebInstance> {
  const registryDir = await tmp("reg");
  await registerSource({ registryDir, sourceId: "hist-agent", label: "History Agent", artifactDir });
  const [discovered] = await discoverWebInstances({ registryDirs: [registryDir] });
  if (discovered === undefined) {
    throw new Error("expected a discovered instance");
  }
  return discovered;
}

describe("listInstanceSessionSummaries", () => {
  it("maps recorded summaries to step-less sessions, newest-first", async () => {
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await seedRun({
      artifactDir,
      runId: "run-older",
      conversationId: "cron:daily",
      userInput: "Summarize yesterday",
      text: "Older answer.",
      source: "cron",
      at: 1_000_000,
    });
    await seedRun({
      artifactDir,
      runId: "run-newer",
      conversationId: "chat:1",
      userInput: "What is the weather?",
      text: "Newer answer.",
      source: "chat",
      at: 2_000_000,
    });

    const discovered = await discoverOne(artifactDir);
    const sessions = (await listInstanceSessionSummaries(discovered, { maxRuns: 50 }))
      .map((entry) => entry.session);

    expect(sessions.map((session) => session.id).sort()).toEqual(["run-newer", "run-older"]);
    // Newest-first: run-newer (startedAt 2_000_000) precedes run-older.
    expect(sessions[0]?.id).toBe("run-newer");

    const newer = sessions[0];
    expect(newer?.sourceId).toBe(discovered.instance.sourceId);
    expect(newer?.instance).toBe("History Agent");
    expect(newer?.source).toBe("chat");
    expect(newer?.finalText).toBe("");
    expect(newer?.outcome).toBe("notified");
    expect(newer?.status).toBe("succeeded");
    expect(newer?.steps).toEqual([]);
    expect(newer?.toolCounts).toEqual({});
    expect(newer?.totals.steps).toBeGreaterThan(0);
    expect(newer?.instr).toBe("");
    expect(newer?.title).toBe("What is the weather?");
  });

  it("returns summary signatures for reconcile short-circuiting", async () => {
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await seedRun({
      artifactDir,
      runId: "run-signature",
      conversationId: "chat:signature",
      userInput: "Read the summary",
      text: "Summary answer.",
      source: "chat",
      at: 4_000_000,
    });
    const discovered = await discoverOne(artifactDir);

    const [entry] = await listInstanceSessionSummaries(discovered, { maxRuns: 50 });

    expect(entry?.session.id).toBe("run-signature");
    expect(entry?.session.steps).toEqual([]);
    expect(entry?.signature.summaryMtimeMs).toBeGreaterThan(0);
    expect(entry?.signature.status).toBe("succeeded");
    expect(entry?.signature.eventCount).toBeGreaterThan(0);
  });

  it("keeps runs whose artifact filename is sanitized from the runId", async () => {
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await seedRun({
      artifactDir,
      runId: "Run:Detail",
      conversationId: "chat:sanitized",
      userInput: "Read sanitized summary",
      text: "Sanitized answer.",
      source: "chat",
      at: 5_000_000,
    });
    const discovered = await discoverOne(artifactDir);

    const [entry] = await listInstanceSessionSummaries(discovered, { maxRuns: 50 });

    expect(entry?.session.id).toBe("Run:Detail");
    expect(entry?.signature.summaryFileName).toBe("run-detail.summary.json");
    expect(entry?.session.steps).toEqual([]);
  });

  it("defaults to agent runs and includes memory runs only when opted in", async () => {
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await seedRun({
      artifactDir,
      runId: "run-agent",
      conversationId: "chat:agent",
      text: "agent answer",
      source: "chat",
      at: 6_000_000,
    });
    await seedRun({
      artifactDir,
      runId: "mem-new",
      conversationId: "memory:capture:distill",
      text: "new memory",
      source: "memory",
      artifactKind: "memory",
      at: 7_000_000,
    });
    await seedRun({
      artifactDir,
      runId: "mem-legacy",
      conversationId: "memory:legacy",
      text: "legacy memory",
      source: "memory",
      at: 8_000_000,
    });
    const discovered = await discoverOne(artifactDir);

    const defaultSessions = (await listInstanceSessionSummaries(discovered, { maxRuns: 50 }))
      .map((entry) => entry.session);
    expect(defaultSessions).toMatchObject([
      { id: "run-agent" },
    ]);
    await expect(readInstanceSession(discovered, "mem-new")).resolves.toBeUndefined();
    await expect(readInstanceSession(discovered, "mem-legacy")).resolves.toBeUndefined();

    const withMemory = (await listInstanceSessionSummaries(discovered, {
      maxRuns: 50,
      includeMemory: true,
    })).map((entry) => entry.session);
    expect(withMemory.map((session) => session.id).sort()).toEqual(["mem-legacy", "mem-new", "run-agent"]);
    await expect(readInstanceSession(discovered, "mem-new", { includeMemory: true })).resolves.toMatchObject({
      id: "mem-new",
      source: "memory",
      finalText: "new memory",
    });
    await expect(readInstanceSession(discovered, "mem-legacy", { includeMemory: true })).resolves.toMatchObject({
      id: "mem-legacy",
      source: "memory",
      finalText: "legacy memory",
    });
  });
});

describe("readInstanceSession", () => {
  it("reads one run in full and returns undefined for a missing run", async () => {
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await seedRun({
      artifactDir,
      runId: "run-solo",
      conversationId: "chat:solo",
      userInput: "Hello there",
      text: "General Kenobi.",
      at: 3_000_000,
    });
    const discovered = await discoverOne(artifactDir);

    const session = await readInstanceSession(discovered, "run-solo");
    expect(session?.id).toBe("run-solo");
    expect(session?.sourceId).toBe(discovered.instance.sourceId);
    expect(session?.finalText).toBe("General Kenobi.");
    expect((session?.steps.length ?? 0)).toBeGreaterThanOrEqual(2);
    expect(session?.cwd).toBe(discovered.instance.cwd);

    expect(await readInstanceSession(discovered, "run-does-not-exist")).toBeUndefined();
  });

  it("strips per-turn context from list rows but surfaces it on the detail read", async () => {
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await seedRun({
      artifactDir,
      runId: "run-ctx",
      conversationId: "chat:ctx",
      userInput: "Carry the turn context",
      text: "Context answer.",
      source: "chat",
      systemPrompt: "You are the compiled system prompt for this run.",
      turnContext: {
        historyCount: 2,
        historyOmitted: false,
        history: [
          { role: "user", content: "earlier question", timestamp: "2026-07-04T00:00:00.000Z" },
          { role: "assistant", content: "earlier answer" },
        ],
        memory: { content: "recalled memory block", source: "bujo" },
      },
      at: 9_500_000,
    });
    const discovered = await discoverOne(artifactDir);

    // List rows stay light: no ctx / sysPrompt / sysPromptTr leaks into snapshots.
    const [rowEntry] = await listInstanceSessionSummaries(discovered, { maxRuns: 50 });
    const row = rowEntry?.session;
    expect(row?.id).toBe("run-ctx");
    expect(row?.ctx).toBeUndefined();
    expect(row?.sysPrompt).toBeUndefined();
    expect(row?.sysPromptTr).toBeUndefined();

    // The lazy detail read surfaces both the compiled prompt and the folded context.
    const detail = await readInstanceSession(discovered, "run-ctx");
    expect(detail?.sysPrompt).toBe("You are the compiled system prompt for this run.");
    expect(detail?.ctx).toEqual({
      histCount: 2,
      hist: [
        { role: "user", text: "earlier question", ts: "2026-07-04T00:00:00.000Z" },
        { role: "assistant", text: "earlier answer" },
      ],
      mem: { text: "recalled memory block", src: "bujo" },
    });
  });

  it("maps persisted session identity fields into summary and detail sessions", async () => {
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await seedRun({
      artifactDir,
      runId: "run-identity",
      conversationId: "chat:identity",
      userInput: "Carry session identity",
      text: "Identity answer.",
      source: "chat",
      providerSessionId: "provider-identity",
      isolated: true,
      at: 9_000_000,
    });
    const discovered = await discoverOne(artifactDir);

    const [summaryEntry] = await listInstanceSessionSummaries(discovered, { maxRuns: 50 });
    const summary = summaryEntry?.session;
    expect(summary).toMatchObject({
      id: "run-identity",
      conversationId: "chat:identity",
      providerSessionId: "provider-identity",
      isolated: true,
    });

    const detail = await readInstanceSession(discovered, "run-identity");
    expect(detail).toMatchObject({
      id: "run-identity",
      conversationId: "chat:identity",
      providerSessionId: "provider-identity",
      isolated: true,
      finalText: "Identity answer.",
    });
  });
});
