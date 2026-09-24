import { describe, expect, it } from "vitest";
import type { MemoryLabelHit } from "@mono-agent/memory/store";
import { formatMemoryBackground, type LabelRecallStore } from "../memory-guidance.js";
import { MemoryRetrievalService, type SharedRecallStore } from "../memory-retrieval.js";

const token = "a".repeat(32);
const lesson = (scope: string, text: string, id: string, verified = true, active = true): MemoryLabelHit => ({
  memoryId: id, ordinal: 0, text, status: active ? "open" : "invalidated", createdAt: "2026-09-06T00:00:00Z",
  active, conflict: false, label: { v: 1, kind: "lesson", scope, verified },
});
const preference = (scope: string, text: string, id: string): MemoryLabelHit => ({
  ...lesson(scope, text, id), label: { v: 1, kind: "preference", scope, attribution: "user-stated" },
});
const fact = (id: string, date: string, conflict = false, active = true): MemoryLabelHit => ({
  memoryId: id, ordinal: 0, text: `Morgan was born ${date}.`, status: active ? "open" : "invalidated",
  createdAt: "2026-09-06T00:00:00Z", active, conflict, currentAt: active,
  label: { v: 1, kind: "fact", entityId: "person:morgan", key: "birth_date",
    value: { type: "date", date }, attribution: "user-stated" },
});
const hits = ["scoped", "other-user", "other-conversation", "other-project", "unverified", "inactive", "irrelevant"]
  .map((id) => ({ score: id === "irrelevant" ? 0.1 : 0.81, record: { id, text: "Please make the relevant note concise." } }));

function store(rows: MemoryLabelHit[], facts: MemoryLabelHit[] = []): LabelRecallStore {
  return {
    guidanceForScope(scope) { return rows.filter((row) => row.label.kind !== "fact" && row.label.scope === scope); },
    labelsForEntity() { return facts; },
    listMemoryEntities() { return [{ id: "person:morgan", name: "Morgan", createdAt: "2026-09-06T00:00:00Z" }]; },
  };
}
const options = { senderToken: token, hostDate: "2026-09-24", projectId: "current" };

describe("automatic labelled background", () => {
  it("injects only relevant live guidance for this speaker/conversation/project", () => {
    const rows = [
      preference(`user:${token}`, "Keep the relevant note concise.", "scoped"),
      preference(`user:${"b".repeat(32)}`, "Other speaker's note.", "other-user"),
      preference("conversation:other", "Other conversation note.", "other-conversation"),
      preference("project:other", "Other project note.", "other-project"),
      lesson("agent", "Unverified retry.", "unverified", false),
      lesson("agent", "Inactive retry.", "inactive", true, false),
      lesson("agent", "Irrelevant retry.", "irrelevant"),
    ];
    const text = formatMemoryBackground(store(rows), "Please make the note concise", "current", options, hits);
    expect(text).toContain("Working preferences & lessons");
    expect(text).toContain("Keep the relevant note concise.");
    for (const hidden of ["Other speaker", "Other conversation", "Other project", "Unverified", "Inactive", "Irrelevant"]) {
      expect(text).not.toContain(hidden);
    }
    expect(formatMemoryBackground(store(rows), "Please make the note concise", "current", {
      hostDate: options.hostDate,
    }, hits)).toBeUndefined();
  });

  it("derives age at birthday and leap-year boundaries and omits conflicting values", () => {
    const person = store([], [fact("birth", "2000-02-29")]);
    expect(formatMemoryBackground(person, "Morgan", "current", { hostDate: "2024-02-28" }, [])).toContain("age 23");
    expect(formatMemoryBackground(person, "Morgan", "current", { hostDate: "2024-02-29" }, [])).toContain("age 24");
    expect(formatMemoryBackground(person, "Morgan", "current", { hostDate: "2026-09-24" }, [])).toContain("age 26");
    const conflict = formatMemoryBackground(store([], [fact("one", "1990-05-17", true), fact("two", "1991-05-17", true)]),
      "Morgan", "current", { hostDate: "2026-09-24" }, []);
    expect(conflict).toContain("conflicting values — ask");
    expect(conflict).not.toContain("born:");
    expect(conflict).not.toContain("age ");
  });

  it("abstains on contradictory advice and ambiguous names but permits explicit entity IDs", () => {
    const yes = preference("agent", "Do check the concise note.", "yes");
    const no = preference(`user:${token}`, "Do not check the concise note.", "no");
    const relevant = [yes, no].map((hit) => ({ score: 0.9, record: { id: hit.memoryId, text: hit.text } }));
    expect(formatMemoryBackground(store([yes, no]), "Check the concise note", "current", options, relevant)).toBeUndefined();
    const duplicated: LabelRecallStore = {
      guidanceForScope: () => [], labelsForEntity: () => [fact("birth", "1990-05-17")],
      listMemoryEntities: () => [
        { id: "person:morgan", name: "Morgan", createdAt: "2026-09-06T00:00:00Z" },
        { id: "person:morgan-two", name: "Mórgan", createdAt: "2026-09-06T00:00:00Z" },
      ],
    };
    expect(formatMemoryBackground(duplicated, "Morgan", "current", options, [])).toBeUndefined();
    expect(formatMemoryBackground(duplicated, "person:morgan", "current", options, [])).toContain("age 36");
    expect(formatMemoryBackground({ guidanceForScope: () => [], labelsForEntity: () => [fact("birth", "1990-05-17")] },
      "person:morgan", "current", options, [])).toContain("age 36");
  });

  it("keeps the direct-fact gate and remote-store shape unchanged", async () => {
    const remote: SharedRecallStore = {
      async load() { return undefined; }, async close() {},
      async recall() { return [{ score: 0.9, record: { id: "hint", text: "Morgan likes blue sky." } }]; },
    };
    const remoteBlock = await new MemoryRetrievalService(remote).load("current", "What is Morgan's birthday?", { hostDate: "2026-09-24" });
    expect(remoteBlock).toBeUndefined();
    const labelled = Object.assign(remote, store([], [fact("birth", "1990-05-17")]));
    const block = await new MemoryRetrievalService(labelled).load("current", "What is Morgan's birthday?", { hostDate: "2026-09-24" });
    expect(block?.content).toContain("Memory (background — not direct evidence)");
    expect(block?.content).toContain("age 36");
    expect(block?.content).not.toContain("likes blue sky");
  });
});
