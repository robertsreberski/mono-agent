import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWebInstances } from "../discovery.js";
import type { DiscoveredWebInstance } from "../discovery.js";
import { listInstanceSessionSummaries, listInstanceSessions, readInstanceSession } from "../history.js";
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

describe("listInstanceSessions", () => {
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
    const sessions = await listInstanceSessions(discovered, { maxRuns: 50 });

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
});
