import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryCompletedTurn } from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CompletedTurnIntakeManager,
  auditCompletedTurnIntake,
  inspectCompletedTurnIntake,
  resolveCompletedTurnIntake,
  retryCompletedTurnIntake,
} from "../capture-intake.js";
import { parseDailyFile } from "../grammar.js";
import { createBujoMemoryStore } from "../store.js";
import { fakeEmbeddings } from "./helpers.js";

const FIXED = new Date("2026-07-12T09:00:00.000Z");

function root(): string {
  return mkdtempSync(join(tmpdir(), "bujo-intake-"));
}

function turn(overrides: Partial<MemoryCompletedTurn> = {}): MemoryCompletedTurn {
  return {
    runId: "run-0001",
    conversationId: "conversation-0001",
    summary: "User prefers durable memory admission.",
    captureText: "User: remember durable memory admission.\nAssistant: acknowledged.",
    ...overrides,
  };
}

function manager(
  memoryRoot: string,
  overrides: Partial<ConstructorParameters<typeof CompletedTurnIntakeManager>[0]> = {},
): CompletedTurnIntakeManager {
  return new CompletedTurnIntakeManager({
    root: memoryRoot,
    clock: () => FIXED,
    writeSummary: async () => {},
    capture: async () => "captured",
    ...overrides,
  });
}

describe("completed-turn durable intake", () => {
  it("treats a pre-upgrade root with no intake tree as a valid empty state", () => {
    const memoryRoot = root();
    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
      valid: true,
      inspection: { snapshot: { pending: 0, dead: 0, resolved: 0, transitioning: 0 } },
    });
    expect(existsSync(join(memoryRoot, ".capture-intake"))).toBe(false);
  });

  it("publishes an owner-only pending record before admission returns", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot, { capture: async () => await new Promise<never>(() => {}) });

    const admitted = intake.admit(turn());

    expect(admitted.admissionStatus).toBe("admitted");
    expect(admitted.bytesWritten).toBeGreaterThan(0);
    expect(existsSync(admitted.source)).toBe(true);
    expect(lstatSync(admitted.source).mode & 0o777).toBe(0o600);
    for (const path of [
      join(memoryRoot, ".capture-intake"),
      join(memoryRoot, ".capture-intake", "pending"),
      join(memoryRoot, ".capture-intake", "dead"),
      join(memoryRoot, ".capture-intake", "resolved"),
    ]) expect(lstatSync(path).mode & 0o777).toBe(0o700);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 1, due: 1 });
    intake.abortForShutdown(false);
  });

  it("deduplicates exact run payloads and rejects conflicting reuse", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const first = intake.admit(turn());
    const duplicate = intake.admit(turn());

    expect(duplicate).toMatchObject({ id: first.id, admissionStatus: "duplicate", bytesWritten: 0 });
    expect(() => intake.admit(turn({ summary: "Conflicting summary." }))).toThrow(/conflicts/iu);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(1);
    intake.abortForShutdown(false);
  });

  it.each([
    ["reserved delimiter", { summary: "unsafe <!--mem summary" }],
    ["bidi control", { summary: "unsafe \u202e summary" }],
    ["Unicode line separator", { summary: "unsafe\u2028summary" }],
    ["Unicode paragraph separator", { summary: "unsafe\u2029summary" }],
    ["surrogate", { captureText: "unsafe \ud800 capture" }],
  ] as const)("rejects %s before publishing an intake record", (_label, overrides) => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    expect(() => intake.admit(turn(overrides))).toThrow(/completed-turn|reserved/iu);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(0);
    intake.abortForShutdown(false);
  });

  it("admits ordinary Unicode formatting used by joined emoji", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const input = turn({
      summary: "Family preference: 👨‍👩‍👧‍👦 trips.",
      captureText: "User: remember the 👨‍👩‍👧‍👦 trip preference.",
    });
    const admitted = intake.admit(input);
    expect(readFileSync(admitted.source, "utf8")).toContain("👨‍👩‍👧‍👦");
    await intake.flush();
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(true);
    intake.finishShutdown();
  });

  it("restarts after provider outage without rewriting an already durable summary", async () => {
    const memoryRoot = root();
    let now = FIXED;
    const summaries: string[] = [];
    const first = manager(memoryRoot, {
      clock: () => now,
      retryBaseMs: 5,
      writeSummary: async (_turn, id) => { summaries.push(id); },
      capture: async () => { throw new Error("provider unavailable"); },
    });
    first.admit(turn());
    await first.flush();
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot).toMatchObject({ pending: 1, due: 0 });
    first.finishShutdown();

    now = new Date(FIXED.getTime() + 5);
    const capture = vi.fn(async () => "captured" as const);
    const restarted = manager(memoryRoot, {
      clock: () => now,
      retryBaseMs: 5,
      writeSummary: async (_turn, id) => { summaries.push(id); },
      capture,
    });
    await restarted.flush();

    expect(capture).toHaveBeenCalledOnce();
    expect(summaries).toHaveLength(1);
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    restarted.finishShutdown();
  });

  it("retries a crash after summary persistence without duplicating the run-derived audit", async () => {
    const memoryRoot = root();
    const durableIds = new Set<string>();
    let calls = 0;
    const intake = manager(memoryRoot, {
      retryBaseMs: 1,
      writeSummary: async (_turn, id) => {
        calls += 1;
        durableIds.add(id);
      },
      afterSummaryPersisted: () => { throw new Error("crash after append"); },
    });
    intake.admit(turn());
    await intake.flush();
    intake.finishShutdown();
    expect(calls).toBe(1);
    expect(durableIds.size).toBe(1);

    const now = new Date(FIXED.getTime() + 1);
    const restarted = manager(memoryRoot, {
      clock: () => now,
      writeSummary: async (_turn, id) => {
        calls += 1;
        // The store callback uses this same run id to detect the already-appended bullet.
        durableIds.add(id);
      },
    });
    await restarted.flush();
    expect(calls).toBe(2);
    expect(durableIds.size).toBe(1);
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot.resolved).toBe(1);
    restarted.finishShutdown();
  });

  it("keeps every admitted record durable under worker pressure and rejects capacity explicitly", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot, {
      maxActiveRecords: 3,
      capture: async () => await new Promise<never>(() => {}),
    });
    for (let index = 0; index < 3; index += 1) {
      intake.admit(turn({ runId: `run-${index}`, conversationId: `c-${index}` }));
    }
    expect(() => intake.admit(turn({ runId: "run-overflow" }))).toThrow(/full/iu);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(3);
    intake.abortForShutdown(false);
  });

  it("bounds resolved receipts while retaining recent idempotency", async () => {
    const memoryRoot = root();
    let now = FIXED;
    const intake = manager(memoryRoot, { resolvedRetention: 2, clock: () => now });
    const admissions = [];
    for (let index = 0; index < 3; index += 1) {
      admissions.push(intake.admit(turn({ runId: `retained-${index}` })));
      await intake.flush();
      now = new Date(now.getTime() + 1);
    }
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot.resolved).toBe(2);
    expect(intake.admit(turn({ runId: "retained-2" }))).toMatchObject({ admissionStatus: "duplicate" });
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${admissions[0]!.id}.json`))).toBe(false);
    intake.finishShutdown();
  });

  it("moves exhausted work to dead, supports stopped-store retry, and resolves successfully", async () => {
    const memoryRoot = root();
    const first = manager(memoryRoot, {
      maxAttempts: 1,
      capture: async () => { throw new Error("offline"); },
    });
    const admitted = first.admit(turn());
    await first.flush();
    first.finishShutdown();
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, dead: 1 });

    expect(retryCompletedTurnIntake(memoryRoot, { id: admitted.id, now: FIXED })).toEqual({ retried: 1 });
    const restarted = manager(memoryRoot);
    await restarted.flush();
    restarted.finishShutdown();
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ dead: 0, resolved: 1 });
  });

  it("supports explicit stopped-store resolution without claiming capture", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn());
    intake.finishShutdown();

    expect(resolveCompletedTurnIntake(memoryRoot, admitted.id, "operator_accepted", FIXED)).toEqual({ resolved: true });
    const receiptPath = join(memoryRoot, ".capture-intake", "resolved", `${admitted.id}.json`);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      outcome: "operator_resolved",
      reason: "operator_accepted",
    });
    expect(readFileSync(receiptPath, "utf8")).not.toContain(turn().summary);
  });

  it("recovers a crash after resolved publication by keeping the higher transition revision", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn());
    intake.finishShutdown();
    const pending = JSON.parse(readFileSync(admitted.source, "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(memoryRoot, ".capture-intake", "resolved", `${admitted.id}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        state: "resolved",
        id: admitted.id,
        payloadHash: pending["payloadHash"],
        admittedAt: pending["admittedAt"],
        resolvedAt: FIXED.toISOString(),
        revision: 1,
        attempt: 0,
        outcome: "summary_only",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
      valid: true,
      inspection: { snapshot: { pending: 0, resolved: 1, transitioning: 1 } },
    });
    const recovered = manager(memoryRoot);
    expect(existsSync(admitted.source)).toBe(false);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    recovered.finishShutdown();
  });

  it("recovers a crash after dead-letter retry publication by keeping the newer pending revision", async () => {
    const memoryRoot = root();
    const first = manager(memoryRoot, {
      maxAttempts: 1,
      capture: async () => { throw new Error("offline"); },
    });
    const admitted = first.admit(turn());
    await first.flush();
    first.finishShutdown();
    const deadPath = join(memoryRoot, ".capture-intake", "dead", `${admitted.id}.json`);
    const dead = JSON.parse(readFileSync(deadPath, "utf8")) as Record<string, unknown>;
    const pending = { ...dead };
    delete pending["deadAt"];
    delete pending["lastError"];
    Object.assign(pending, {
      state: "pending",
      revision: Number(dead["revision"]) + 1,
      attempt: 0,
      nextAttemptAt: FIXED.toISOString(),
    });
    writeFileSync(
      join(memoryRoot, ".capture-intake", "pending", `${admitted.id}.json`),
      `${JSON.stringify(pending, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
      valid: true,
      inspection: { snapshot: { pending: 1, dead: 0, transitioning: 1 } },
    });
    const recovered = manager(memoryRoot);
    expect(existsSync(deadPath)).toBe(false);
    await recovered.flush();
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, dead: 0, resolved: 1 });
    recovered.finishShutdown();
  });

  it("rejects ambiguous equal-revision state duplicates", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn());
    intake.finishShutdown();
    const pending = JSON.parse(readFileSync(admitted.source, "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(memoryRoot, ".capture-intake", "resolved", `${admitted.id}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        state: "resolved",
        id: admitted.id,
        payloadHash: pending["payloadHash"],
        admittedAt: pending["admittedAt"],
        resolvedAt: FIXED.toISOString(),
        revision: 0,
        attempt: 0,
        outcome: "summary_only",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(() => manager(memoryRoot)).toThrow(/equal revision/iu);
  });

  it("rejects a forged gapped transition revision", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn());
    intake.finishShutdown();
    const pending = JSON.parse(readFileSync(admitted.source, "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(memoryRoot, ".capture-intake", "resolved", `${admitted.id}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        state: "resolved",
        id: admitted.id,
        payloadHash: pending["payloadHash"],
        admittedAt: pending["admittedAt"],
        resolvedAt: FIXED.toISOString(),
        revision: 9,
        attempt: 0,
        outcome: "summary_only",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({ valid: false, issues: ["state_conflict"] });
    expect(() => manager(memoryRoot)).toThrow(/revision gap/iu);
  });

  it.each(["corrupt", "symlink", "hardlink", "oversize", "permissions"] as const)(
    "fails intake audit for %s durable state",
    (kind) => {
      const memoryRoot = root();
      const intake = manager(memoryRoot);
      const admitted = intake.admit(turn());
      intake.finishShutdown();
      if (kind === "corrupt") writeFileSync(admitted.source, "not json\n", { mode: 0o600 });
      if (kind === "oversize") writeFileSync(admitted.source, "x".repeat(700 * 1024), { mode: 0o600 });
      if (kind === "permissions") chmodSync(admitted.source, 0o644);
      if (kind === "symlink") {
        const target = join(memoryRoot, "outside.json");
        writeFileSync(target, "{}\n", { mode: 0o600 });
        unlinkSync(admitted.source);
        symlinkSync(target, admitted.source);
      }
      if (kind === "hardlink") linkSync(admitted.source, join(memoryRoot, "outside-hardlink.json"));

      expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    },
  );

  it("rejects a symlinked intake ancestor", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn());
    intake.finishShutdown();
    const pending = join(memoryRoot, ".capture-intake", "pending");
    const moved = join(memoryRoot, "moved-pending");
    renameSync(pending, moved);
    symlinkSync(moved, pending);

    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({ valid: false, issues: ["invalid_layout"] });
  });

  it("rejects unknown entries at the intake root", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn());
    intake.finishShutdown();
    writeFileSync(join(memoryRoot, ".capture-intake", "unexpected"), "x", { mode: 0o600 });
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
  });

  it("validates and retires an orphan atomic temp during writable startup", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn());
    intake.finishShutdown();
    const temp = join(
      memoryRoot,
      ".capture-intake",
      "pending",
      ".0000000000000000000000000000000000000000000000000000000000000000.json-00000000-0000-4000-8000-000000000000.tmp",
    );
    writeFileSync(temp, '{"partial":', { mode: 0o600 });
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(true);

    const recovered = manager(memoryRoot);
    expect(existsSync(temp)).toBe(false);
    recovered.finishShutdown();
  });
});

describe("BujoMemoryStore completed-turn integration", () => {
  it("rejects admission from read-only and closed stores", async () => {
    const memoryRoot = root();
    const writable = createBujoMemoryStore({ root: memoryRoot, clock: () => FIXED });
    await writable.close();
    await expect(writable.persistCompletedTurn(turn())).rejects.toThrow(/closing or closed/iu);

    const readOnly = createBujoMemoryStore({ root: memoryRoot, readOnly: true, clock: () => FIXED });
    await expect(readOnly.persistCompletedTurn(turn())).rejects.toThrow(/read-only/iu);
    await readOnly.close();
  });

  it("requires stopped-store ownership for retry and resolve operations", async () => {
    const memoryRoot = root();
    const store = createBujoMemoryStore({ root: memoryRoot, clock: () => FIXED });
    await expect(Promise.resolve().then(() => retryCompletedTurnIntake(memoryRoot))).rejects.toThrow(/active memory writer/iu);
    await store.close();
  });

  it.each(["lite", "journal", "bujo"] as const)(
    "persists a run-derived summary exactly once in the %s tier",
    async (tier) => {
      const memoryRoot = root();
      const llm = { id: "strict-empty", complete: async () => JSON.stringify({ memories: [], entities: [], relations: [] }) };
      const store = createBujoMemoryStore({
        root: memoryRoot,
        tier,
        clock: () => FIXED,
        ...(tier === "lite" ? {} : { embeddings: fakeEmbeddings(64), dim: 64 }),
        ...(tier === "bujo" ? { llm } : {}),
      });
      const input = tier === "bujo"
        ? turn({ runId: `run-${tier}` })
        : {
            runId: `run-${tier}`,
            conversationId: "conversation-0001",
            summary: "User prefers durable memory admission.",
          };
      const admitted = await store.persistCompletedTurn(input);
      await store.flush();
      const duplicate = await store.persistCompletedTurn(input);
      await store.flush();

      expect(admitted.admissionStatus).toBe("admitted");
      expect(duplicate.admissionStatus).toBe("duplicate");
      const directory = tier === "bujo" ? "audit" : "daily";
      const bullets = parseDailyFile(readFileSync(join(memoryRoot, directory, "2026-07-12.md"), "utf8")).bullets;
      expect(bullets.filter((bullet) => bullet.id === `R-${admitted.id}`)).toHaveLength(1);
      if (tier !== "bujo") {
        const hits = await store.recall("User prefers durable memory admission", { topK: 5 });
        expect(hits.some((hit) => hit.record.text.includes("durable memory admission"))).toBe(true);
      }
      expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, resolved: 1 });
      await store.close();
    },
  );

  it("bounds hung provider teardown and leaves the admitted turn pending for restart", async () => {
    const memoryRoot = root();
    const warnings: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: {
        id: "hung",
        complete: async () => {
          await gate; // deliberately ignores the intake abort signal
          return JSON.stringify({ memories: [], entities: [], relations: [] });
        },
      },
      clock: () => FIXED,
      backgroundDrainTimeoutMs: 20,
      logger: { warn: (message) => warnings.push(message) },
    });
    const admission = await store.persistCompletedTurn(turn({ runId: "run-hung" }));
    await waitUntil(() => store.queueSnapshot().intake?.retrying === 1);
    const pendingBefore = readFileSync(admission.source, "utf8");

    const started = performance.now();
    await store.close();

    expect(performance.now() - started).toBeLessThan(500);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(1);
    expect(store.queueSnapshot().intake).toMatchObject({ pending: 1, shutdown: "timed_out" });
    expect(warnings.join(" ")).not.toContain(turn().captureText);
    release();
    await waitUntil(() => store.queueSnapshot().intake?.retrying === 0);
    expect(readFileSync(admission.source, "utf8")).toBe(pendingBefore);
  });

  it("keeps malformed strict output pending as a whole retry with sanitized health", async () => {
    const memoryRoot = root();
    const warnings: string[] = [];
    const store = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: {
        id: "partial",
        complete: async () => JSON.stringify({
          memories: [
            { type: "note", text: "Valid-looking secret marker.", salience: 0.7, isInsight: false, entityIds: [] },
            { type: "note" },
          ],
          entities: [],
          relations: [],
        }),
      },
      clock: () => FIXED,
      logger: { warn: (message) => warnings.push(message) },
    });
    await store.persistCompletedTurn(turn({ runId: "strict-partial" }));
    await store.flush();

    const inspection = inspectCompletedTurnIntake(memoryRoot, FIXED);
    expect(inspection.snapshot).toMatchObject({ pending: 1, resolved: 0, due: 0 });
    expect(inspection.items[0]).toMatchObject({ attempt: 1, lastError: "model_output" });
    expect(warnings.join(" ")).not.toContain("Valid-looking secret marker");
    expect(existsSync(join(memoryRoot, "daily"))).toBe(false);
    await store.close();
  });

  it("does not duplicate the real audit bullet after a crash-window summary replay", async () => {
    const memoryRoot = root();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: {
        id: "crash-window",
        complete: async () => {
          await gate;
          return JSON.stringify({ memories: [], entities: [], relations: [] });
        },
      },
      clock: () => FIXED,
      backgroundDrainTimeoutMs: 20,
    });
    const admitted = await first.persistCompletedTurn(turn({ runId: "run-audit-crash-window" }));
    await waitUntil(() => first.queueSnapshot().intake?.retrying === 1);
    await first.close();
    release();
    await waitUntil(() => first.queueSnapshot().intake?.retrying === 0);

    const pending = JSON.parse(readFileSync(admitted.source, "utf8")) as Record<string, unknown>;
    pending["summaryWritten"] = false;
    pending["revision"] = 0;
    pending["attempt"] = 0;
    pending["nextAttemptAt"] = FIXED.toISOString();
    delete pending["lastError"];
    writeFileSync(admitted.source, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
    const auditPath = join(memoryRoot, "audit", "2026-07-12.md");
    expect(parseDailyFile(readFileSync(auditPath, "utf8")).bullets).toHaveLength(1);

    const restarted = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: { id: "crash-window", complete: async () => JSON.stringify({ memories: [], entities: [], relations: [] }) },
      clock: () => FIXED,
    });
    await restarted.flush();

    expect(parseDailyFile(readFileSync(auditPath, "utf8")).bullets).toHaveLength(1);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    await restarted.close();
  });

  it("does not duplicate semantic capture after commit-before-resolution failure", async () => {
    const memoryRoot = root();
    let now = FIXED;
    let llmCalls = 0;
    const llm = {
      id: "semantic-crash-window",
      complete: async (prompt: string) => {
        llmCalls += 1;
        return prompt.includes("Extract one bounded") ? JSON.stringify({
            memories: [{
              type: "note",
              text: "Morgan prefers deterministic semantic replay.",
              salience: 0.8,
              isInsight: false,
              entityIds: [],
            }],
            entities: [],
            relations: [],
          })
          : JSON.stringify([{ index: 0, action: "add" }]);
      },
    };
    const store = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm,
      clock: () => now,
    });
    type CaptureCallback = (
      input: MemoryCompletedTurn,
      id: string,
      admittedAt: string,
      signal: AbortSignal,
    ) => Promise<"captured" | "summary_only">;
    const internal = store as unknown as {
      completedTurnIntake: { capture: CaptureCallback };
    };
    const original = internal.completedTurnIntake.capture.bind(internal.completedTurnIntake);
    internal.completedTurnIntake.capture = async (...args) => {
      const outcome = await original(...args);
      throw new Error(`simulated crash after ${outcome}`);
    };

    await store.persistCompletedTurn(turn({ runId: "semantic-commit-crash" }));
    await store.flush();
    const dailyPath = join(memoryRoot, "daily", "2026-07-12.md");
    const first = parseDailyFile(readFileSync(dailyPath, "utf8")).bullets;
    expect(first).toHaveLength(1);

    await store.close();
    now = new Date(FIXED.getTime() + 60_000);
    let restartLlmCalls = 0;
    const restarted = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: {
        id: llm.id,
        complete: async () => {
          restartLlmCalls += 1;
          throw new Error("retained plan replay must not call the model");
        },
      },
      clock: () => now,
    });
    await restarted.flush();

    const replayed = parseDailyFile(readFileSync(dailyPath, "utf8")).bullets;
    expect(replayed).toEqual(first);
    expect(llmCalls).toBe(1);
    expect(restartLlmCalls).toBe(0);
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    await restarted.close();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
