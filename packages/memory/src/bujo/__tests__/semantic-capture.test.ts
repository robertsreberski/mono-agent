import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCapturePlanStrict } from "../capture-batch.js";
import { reviewCapturePlan } from "../capture-review.js";
import { createBujoMemoryStore } from "../store.js";
import { fakeEmbeddings } from "./helpers.js";
import type { BujoTier } from "../types.js";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const observedAt = "2031-05-17T12:00:00.000Z";
const response = JSON.stringify({ memories: [{ type: "note", text: "Owner prefers numbered repair instructions.", source: "user",
  salience: 0.8, isInsight: false, entityIds: [], labels: [{ v: 1, kind: "preference", scope: "agent", attribution: "user-stated" }] }], entities: [], relations: [] });
const evidence = { ownerTurn: true as const, userText: "Owner prefers numbered repair instructions.", toolOutcomes: [] };

describe("semantic capture opt-in", () => {
  it("keeps flags-off review prompts and schemas byte-identical", async () => {
    const prompts: string[] = []; const schemas: unknown[] = [];
    const llm = { id: "fictional-review-bytes", complete: async (prompt: string, options?: { outputSchema?: Readonly<Record<string, unknown>> }) => {
      prompts.push(prompt); schemas.push(options?.outputSchema); return '{"decisions":[{"index":0,"decision":"keep"}]}';
    } };
    const plan = { candidates: [{ type: "note" as const, text: "The assistant reported a completed inspection.", source: "assistant" as const, salience: 0.8, isInsight: false }], entities: [], relations: [] };
    const absent = await reviewCapturePlan(plan, { llm }); const off = await reviewCapturePlan(plan, { llm, semanticOnly: false });
    expect(off).toEqual(absent); expect(prompts[0]).toBe(prompts[1]); expect(schemas[0]).toEqual(schemas[1]);
  });

  it("keeps a person-associated event a coarse fact: only-fact capture cannot solve episodic noise", async () => {
    const extraction = JSON.stringify({ memories: [{ type: "event", text: "Owner attended a pottery class.", source: "user", salience: 0.8, isInsight: false, entityIds: ["person:owner"] }],
      entities: [{ id: "person:owner", name: "Owner", type: "person" }], relations: [] });
    const plan = await extractCapturePlanStrict("User: Owner attended a pottery class.", { id: "fictional-event", complete: async (prompt) => {
      expect(prompt).toContain("OPERATOR CAPTURE FOCUS"); return extraction;
    } }, undefined, [], { observedAt, captureSpeakerKind: "human-turn", captureEvidence: { ...evidence, userText: "Owner attended a pottery class." } }, "Keep owner knowledge and useful episodes.", true);
    expect(plan.candidates[0]).toMatchObject({ type: "event", labels: [{ kind: "fact", attribution: "user-stated" }] });
  });

  it("keeps flags-off extraction prompt byte-identical; flag-on type judgments stay in the model", async () => {
    const prompts: string[] = [];
    const llm = { id: "fictional-capture", complete: async (prompt: string) => { prompts.push(prompt); return response; } };
    const observation = { observedAt, captureSpeakerKind: "human-turn" as const, captureEvidence: evidence };
    const absent = await extractCapturePlanStrict("fictional turn", llm, undefined, [], observation);
    const off = await extractCapturePlanStrict("fictional turn", llm, undefined, [], observation, undefined, false);
    const on = await extractCapturePlanStrict("fictional turn", llm, undefined, [], observation, undefined, true);
    expect(prompts[0]).toBe(prompts[1]); expect(absent).toEqual(off); expect(on).toEqual(off);
    expect(prompts[0]).not.toContain("SEMANTIC CAPTURE POLICY");
    expect(prompts[2]).toContain("Use event for what happened"); expect(prompts[2]).toContain("Skip pure progress chatter");
    expect(prompts[2]).toContain("160 Unicode code points");
  });

  it.each(["The assistant reported a bicycle inspection.", "Asystent zgłosił przegląd roweru.", "L'assistente ha riferito un controllo della bicicletta.", "El asistente informó de una revisión de la bicicleta."])("reviews consequential operations as searchable events: %s", async (text) => {
    const plan = { candidates: [{ type: "note" as const, text, source: "assistant" as const, salience: 0.8, isInsight: false }], entities: [], relations: [] };
    const reviewed = await reviewCapturePlan(plan, { semanticOnly: true, llm: { id: "fictional-review", complete: async (prompt) => {
      expect(prompt).toContain('decision "event"'); return '{"decisions":[{"index":0,"decision":"event"}]}';
    } } });
    expect(reviewed.candidates).toEqual([{ ...plan.candidates[0], type: "event" }]);
    const chatter = await reviewCapturePlan(plan, { semanticOnly: true, llm: { id: "fictional-chatter", complete: async () => '{"decisions":[{"index":0,"decision":"drop"}]}' } });
    expect(chatter.candidates).toEqual([]);
  });

  it.each(["lite", "journal", "bujo"] as BujoTier[])("keeps %s canonical stored bytes identical with the flag absent/off", async (tier) => {
    const canonical: Record<string, string>[] = []; const logical: string[] = []; const prompts: string[][] = [];
    for (const explicitOff of [false, true]) {
      const path = mkdtempSync(join(tmpdir(), "semantic-bytes-fixture-")); roots.push(path);
      const calls: string[] = []; prompts.push(calls);
      const store = createBujoMemoryStore({ root: path, tier, clock: () => new Date(observedAt),
        ...(tier === "lite" ? {} : { embeddings: fakeEmbeddings(16), dim: 16 }),
        ...(tier === "bujo" ? { llm: { id: "fictional-bytes", complete: async (prompt: string) => { calls.push(prompt); return response; } } } : {}),
        ...(explicitOff ? { recall: { semanticOnly: false } } : {}),
      });
      try {
        await store.persistCompletedTurn({ runId: "fictional-byte-run", conversationId: "fictional-chat", summary: "A bicycle repair was discussed.",
          ...(tier === "bujo" ? { captureText: "User: Owner prefers numbered repair instructions.", captureSpeakerKind: "human-turn" as const, captureEvidence: evidence } : {}) });
        await store.flush();
        const outcome = await store.recallWithOutcome(tier === "bujo"
          ? "Owner prefers numbered repair instructions." : "A bicycle repair was discussed.", { topK: 50, trackAccess: false });
        expect(outcome.hits.length).toBeGreaterThan(0);
        logical.push(JSON.stringify({ records: outcome.hits.map((hit) => hit.record),
          labels: store.labelsForMemories(outcome.hits.map((hit) => hit.record.id)) }));
        const files: Record<string, string> = {};
        for (const dir of ["daily", "audit"]) {
          try { for (const name of readdirSync(join(path, dir))) if (name.endsWith(".md")) files[`${dir}/${name}`] = readFileSync(join(path, dir, name), "utf8"); } catch { /* This tier has no such canonical directory. */ }
        }
        try { files["graph.jsonl"] = readFileSync(join(path, "graph.jsonl"), "utf8"); } catch { /* No graph on this tier. */ }
        canonical.push(files);
      } finally { await store.close(); }
    }
    expect(canonical[0]).toEqual(canonical[1]); expect(Object.keys(canonical[0]!).length).toBeGreaterThan(0);
    expect(logical[0]).toBe(logical[1]); expect(prompts[0]).toEqual(prompts[1]);
    if (tier === "bujo") expect(prompts[0]).toHaveLength(1);
  });
});
