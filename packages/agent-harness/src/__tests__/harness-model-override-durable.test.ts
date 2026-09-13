import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const worker = fileURLToPath(new URL("./fixtures/model-override-session-worker.mjs", import.meta.url));
const dirs: string[] = [];
interface Evidence {
  pid: number;
  boundaries: Array<{ reason: string; providerSessionId: string }>;
  notices: string[];
  contexts: Array<{ systemPrompt: string; messages: Array<Record<string, unknown>> }>;
  requests: Array<{ owner: string; messages: unknown[]; sessionId: string }>;
  events: Array<{ kind: string; reason: string }>;
  sessionEvents: Array<{ kind: string; reason?: string; modelKey?: string; snapshot?: Array<{ modelKey?: string }> }>;
  records: Array<{ providerSession: { epoch: string; revision: number; modelKey: string } }>;
  jsonl: string[][];
  trace: Array<{ method: string; owner: string; id: string }>;
}
async function root(): Promise<string> {
  const parent = fileURLToPath(new URL("../../../../.worklab-tmp/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "override-pi-"));
  dirs.push(dir);
  return dir;
}
async function run(dir: string, sequence: Array<string | null>, origin = "web", start = 0, defaultName = "base", unrouted = false, legacyUnbound = false): Promise<Evidence> {
  const result = await exec(process.execPath, [worker, dir, origin, JSON.stringify(sequence), String(start), defaultName, String(unrouted), String(legacyUnbound)],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout) as Evidence;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function assertWarm(value: Evidence): void {
  expect(new Set(value.requests.map((request) => request.sessionId)).size).toBe(1);
  expect(value.records.map((record) => record.providerSession.revision)).toEqual([1, 2, 3]);
  for (let i = 1; i < value.contexts.length; i++) {
    const previous = value.contexts[i - 1]!;
    const current = value.contexts[i]!;
    expect(JSON.stringify(current.messages.slice(0, previous.messages.length))).toBe(JSON.stringify(previous.messages));
    expect(current.systemPrompt).toBe(previous.systemPrompt);
  }
  const last = value.contexts.at(-1)!;
  expect(JSON.stringify(last.messages)).toContain("signature-0");
  expect(JSON.stringify(last.messages)).toContain("read-0");
  expect(JSON.stringify(last.messages.filter((message) => message.role === "toolResult"))).toContain("NATIVE-EVIDENCE");
  expect(value.jsonl.every((files) => files.length === 1)).toBe(true);
  expect(value.events).toEqual([]);
}

describe("durable model override native sessions", () => {
  it.each(["web", "tui", "telegram", "slack"])("preserves signed reasoning and tool results across three durable override turns for %s", async (origin) => {
    const value = await run(await root(), ["override", "override", "override"], origin);
    assertWarm(value);
    expect(value.records.every((record) => record.providerSession.modelKey === "faux:override")).toBe(true);
    expect(value.trace.filter((call) => call.method === "syncSession").map((call) => call.owner))
      .toEqual(["faux:override", "faux:override", "faux:override"]);
  });

  it.each([["base", "override"], ["override", "third"], ["override", "base"]])(
    "rotates and canonically reseeds %s to %s on the old owning runtime", async (before, after) => {
      const value = await run(await root(), [before!, after!, after!]);
      const oldId = value.requests[0]!.sessionId;
      const newId = value.requests[1]!.sessionId;
      expect(newId).not.toBe(oldId);
      expect(value.requests[2]!.sessionId).toBe(newId);
      expect(value.records.map((record) => record.providerSession.revision)).toEqual([1, 1, 2]);
      const seed = JSON.stringify(value.contexts[1]!.messages);
      expect(seed).toContain("ask-0");
      expect(seed).toContain("answer-0");
      expect(seed).not.toContain("signature-0");
      expect(seed).not.toContain("NATIVE-EVIDENCE");
      expect(value.jsonl[1]).not.toEqual(value.jsonl[0]);
      expect(value.jsonl.every((files) => files.length === 1)).toBe(true);
      expect(value.events).toMatchObject([{ kind: "resume_replay", reason: "model_change" }]);
      for (const method of ["invalidateSession", "disposeSession", "retireDurableSession"]) {
        expect(value.trace).toContainEqual({ method, owner: `faux:${before}`, id: oldId });
      }
      expect(value.trace.filter((call) => call.id === oldId).every((call) => call.owner === `faux:${before}`)).toBe(true);
      expect(value.trace).toContainEqual({ method: "refreshSession", owner: `faux:${after}`, id: newId });
    },
  );

  it("resumes a bound override transcript in a new process", async () => {
    const dir = await root();
    const first = await run(dir, ["override", "override"]);
    const next = await run(dir, ["override"], "web", 2);
    expect(next.pid).not.toBe(first.pid);
    expect(next.requests[0]!.sessionId).toBe(first.requests[0]!.sessionId);
    expect(next.records[0]!.providerSession.revision).toBe(3);
    expect(JSON.stringify(next.contexts[0]!.messages)).toContain("signature-0");
    expect(JSON.stringify(next.contexts[0]!.messages)).toContain("NATIVE-EVIDENCE");
    expect(next.events).toEqual([]);
  });

  it("rotates a persisted binding when the configured default changes", async () => {
    const dir = await root();
    const first = await run(dir, ["base"]);
    const next = await run(dir, [null], "web", 1, "third");
    expect(next.requests[0]!.sessionId).not.toBe(first.requests[0]!.sessionId);
    expect(next.events).toMatchObject([{ reason: "model_change" }]);
    expect(next.trace).toContainEqual({ method: "retireDurableSession", owner: "faux:base", id: first.requests[0]!.sessionId });
  });

  it("emits one model-change cold event and boundary when a fresh process overrides a bound record", async () => {
    const dir = await root();
    await run(dir, ["base"]);
    const next = await run(dir, ["override"], "web", 1);
    expect(next.sessionEvents.filter((event) => event.kind === "cold")).toEqual([
      expect.objectContaining({ kind: "cold", reason: "model_change", modelKey: "faux:override" }),
    ]);
    expect(next.events).toMatchObject([{ kind: "resume_replay", reason: "model_change" }]);
    expect(next.events).toHaveLength(1);
  });

  it("marks the one-time cold migration from a legacy unbound durable record", async () => {
    const next = await run(await root(), ["override"], "web", 0, "base", false, true);
    expect(next.sessionEvents.filter((event) => event.kind === "cold")).toEqual([
      expect.objectContaining({ kind: "cold", reason: "legacy_unbound_model", modelKey: "faux:override" }),
    ]);
    expect(next.events).toMatchObject([{ kind: "resume_replay", reason: "legacy_unbound_model" }]);
    expect(next.events).toHaveLength(1);
    expect(next.sessionEvents.filter((event) => event.kind === "saved").at(-1)?.snapshot?.[0])
      .toMatchObject({ modelKey: "faux:override" });
  });

  it.each(["cron", "webhook"])("keeps pinned %s models warm when proactive isolation is off", async (origin) => {
    assertWarm(await run(await root(), ["override", "override", "override"], origin));
  });

  it("supports warm model binding without a runtimeForModel factory", async () => {
    const value = await run(await root(), ["override", "override", "override"], "web", 0, "base", true);
    assertWarm(value);
    expect(value.requests.every((request) => request.owner === "faux:base")).toBe(true);
    expect(value.records[0]!.providerSession.modelKey).toBe("faux:override");
  });

  it("round-trips model binding and model-change boundaries through built packages", async () => {
    const dir = await root();
    const first = await run(dir, ["override"]);
    const next = await run(dir, ["override", "third"], "web", 1);
    expect(next.pid).not.toBe(first.pid);
    expect(next.requests[0]!.sessionId).toBe(first.requests[0]!.sessionId);
    expect(next.records[1]!.providerSession.modelKey).toBe("faux:third");
    expect(next.boundaries).toMatchObject([{ reason: "model_change", providerSessionId: next.requests[1]!.sessionId }]);
    expect(next.notices).toEqual([`session boundary: resume replay · model change · provider ${next.requests[1]!.sessionId}`]);
    expect(next.events).toMatchObject([{ kind: "resume_replay", reason: "model_change" }]);
  });
});
