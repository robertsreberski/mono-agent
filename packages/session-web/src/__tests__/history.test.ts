import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWebInstances } from "../discovery.js";
import type { DiscoveredWebInstance } from "../discovery.js";
import { listInstanceSessions, readInstanceSession } from "../history.js";
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
  it("maps recorded runs to sessions, newest-first, with full steps", async () => {
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
    expect(newer?.instance).toBe("History Agent");
    expect(newer?.source).toBe("chat");
    expect(newer?.finalText).toBe("Newer answer.");
    expect(newer?.outcome).toBe("notified");
    expect(newer?.status).toBe("succeeded");
    // A prompt step + an assistant step at minimum.
    expect((newer?.steps.length ?? 0)).toBeGreaterThanOrEqual(2);
    expect(newer?.instr).toBe("What is the weather?");
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
    expect(session?.finalText).toBe("General Kenobi.");
    expect(session?.cwd).toBe(discovered.instance.cwd);

    expect(await readInstanceSession(discovered, "run-does-not-exist")).toBeUndefined();
  });
});
