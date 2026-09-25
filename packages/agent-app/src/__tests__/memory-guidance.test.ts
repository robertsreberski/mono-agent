import { describe, expect, it } from "vitest";
import type { MemoryDb } from "@mono-agent/memory/store";
type MemoryLabelHit = ReturnType<MemoryDb["labelsForEntity"]>[number];
import { formatMemoryBackground as formatBlock, type LabelRecallStore } from "../memory-guidance.js";
const formatMemoryBackground = (...args: Parameters<typeof formatBlock>) => formatBlock(...args)?.content || undefined;
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
    findMemoryEntitiesByNames(names) { return names.includes("morgan")
      ? [{ id: "person:morgan", name: "Morgan", createdAt: "2026-09-06T00:00:00Z" }] : []; },
  };
}
const options = { senderToken: token, hostDate: "2026-09-24" };

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
    expect(formatMemoryBackground(person, "Morgan", "current", { hostDate: "2025-02-28" }, [])).toContain("age 24");
    expect(formatMemoryBackground(person, "Morgan", "current", { hostDate: "2025-03-01" }, [])).toContain("age 25");
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
      findMemoryEntitiesByNames: () => [
        { id: "person:morgan", name: "Morgan", createdAt: "2026-09-06T00:00:00Z" },
        { id: "person:morgan-two", name: "Mórgan", createdAt: "2026-09-06T00:00:00Z" },
        { id: "person:morgan-three", name: "Morgan", createdAt: "2026-09-06T00:00:00Z" },
        { id: "person:morgan-four", name: "Mórgan", createdAt: "2026-09-06T00:00:00Z" },
      ],
    };
    expect(formatMemoryBackground(duplicated, "Morgan", "current", options, [])).toBeUndefined();
    expect(formatMemoryBackground(duplicated, "person:morgan", "current", options, [])).toContain("age 36");
    expect(formatMemoryBackground({ guidanceForScope: () => [], labelsForEntity: () => [fact("birth", "1990-05-17")] },
      "person:morgan", "current", options, [])).toContain("age 36");
  });

  it("ignores non-person graph rows and uncapitalized short names", () => {
    const names: string[][] = [];
    const local: LabelRecallStore = {
      guidanceForScope: () => [], labelsForEntity: (id) => {
        expect(id).toBe("person:morgan"); return [fact("birth", "1990-05-17")];
      },
      findMemoryEntitiesByNames: (candidates) => {
        names.push([...candidates]);
        return [{ id: "project:fictional", name: "Morgan", createdAt: "2026-09-06T00:00:00Z" },
          { id: "person:morgan", name: "Morgan", createdAt: "2026-09-06T00:00:00Z" }];
      },
    };
    expect(formatMemoryBackground(local, "Morgan", "conv", options, [])).toContain("age 36");
    expect(names[0]).toContain("morgan");
    expect(formatMemoryBackground(store([], [fact("birth", "1990-05-17")]), "mark may morgan", "conv", options, [])).toBeUndefined();
    expect(formatMemoryBackground(store([], [fact("birth", "1990-05-17")]), "Morgan", "conv", options, [])).toContain("age 36");
  });

  it("uses an atomic section budget without orphan headings or partial lines", () => {
    const rows = [preference("agent", "A lengthy concise fictional preference for the current report.", "long"),
      preference("agent", "Be brief.", "short")];
    const scored = rows.map((row) => ({ score: 0.9, record: { id: row.memoryId, text: row.text } }));
    const result = formatBlock(store(rows), "brief report", "conv", options, scored, 120);
    expect(result?.content).toContain("Be brief.");
    expect(result?.content).not.toContain("lengthy");
    expect(result?.truncated).toBe(true);
    expect(Buffer.byteLength(result?.content ?? "", "utf8")).toBeLessThanOrEqual(120);
    expect(formatBlock(store(rows), "brief report", "conv", options, scored, 40)?.content).toBe("");
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
    // A labelled fact whose key the question asks about answers directly.
    expect(block?.content).toBe("## Memory (recalled)\n\n- Morgan — born: 1990-05-17 (you said, recorded 2026-09-06); age 36");
    expect(block?.content).not.toContain("likes blue sky");
  });

  it("injects only the labelled keys a question asks about, rendered as text", () => {
    const labelled = (key: string, text: string, id: string): MemoryLabelHit => ({
      ...fact(id, "1990-05-17"), text: `Morgan's ${key} is ${text}.`,
      label: { v: 1, kind: "fact", entityId: "person:morgan", key, value: { type: "text", text }, attribution: "user-stated" },
    });
    const person = store([], [fact("birth", "1990-05-17"), labelled("other:home-city", "Lisbon", "city"),
      labelled("other:employer", "Initech", "job")]);
    const asked = formatBlock(person, "Where is Morgan's home city?", "conv", options, []);
    expect(asked?.facts).toEqual(["Morgan — home city: Lisbon (you said, recorded 2026-09-06)"]);
    expect(asked?.content).toBe("");
    // An unrelated question about the same person injects nothing.
    expect(formatBlock(person, "What is Morgan's phone number?", "conv", options, [])).toBeUndefined();
    expect(formatBlock(person, "How old is Morgan?", "conv", options, [])?.facts)
      .toEqual(["Morgan — born: 1990-05-17 (you said, recorded 2026-09-06); age 36"]);
    // A bare mention keeps the whole background card, without `other:` or JSON.
    const card = formatMemoryBackground(person, "Tell me about Morgan", "conv", options, []);
    expect(card).toContain("Person card:");
    expect(card).toContain("home city: Lisbon");
    expect(card).toContain("employer: Initech");
    expect(card).not.toContain("other:");
    expect(card).not.toContain("{");
  });

  it("preserves byte-identical ordinary recall when a label lookup fails", async () => {
    const base: SharedRecallStore = { async load() { return undefined; }, async close() {},
      async recall() { return [{ score: 0.95, record: { id: "direct", text: "Morgan selected cobalt as the launch color." } }]; },
    };
    const options = { hostDate: "2026-09-24" };
    const ordinary = await new MemoryRetrievalService(base).load("conv", "What launch color did Morgan select?", options);
    const broken: SharedRecallStore = { ...base, guidanceForScope() { throw new Error("label DB temporarily unavailable"); },
      labelsForEntity() { return []; } };
    const protectedBlock = await new MemoryRetrievalService(broken).load("conv", "What launch color did Morgan select?", options);
    expect(protectedBlock).toEqual(ordinary);
    expect(ordinary?.content).toContain("cobalt");
  });

  it("counts background against the configured recall budget and marks omitted lines truncated", async () => {
    const base: SharedRecallStore = { async load() { return undefined; }, async close() {},
      async recall() { return [{ score: 0.95, record: { id: "direct", text: "Morgan selected cobalt as the launch color." } }]; },
    };
    const query = "What launch color did Morgan select?";
    const ordinary = await new MemoryRetrievalService(base, { maxBytes: 100 }).load("conv", query, options);
    const labelled: SharedRecallStore = { ...base,
      guidanceForScope: () => [preference("agent", "A useful but long background preference about concise notes.", "direct")],
      labelsForEntity: () => [],
    };
    const full = await new MemoryRetrievalService(labelled, { maxBytes: 512 }).load("conv", query, options);
    const fullOrdinary = await new MemoryRetrievalService(base, { maxBytes: 512 }).load("conv", query, options);
    expect(full?.content.startsWith(`${fullOrdinary?.content}\n\n`)).toBe(true);
    expect(full?.content).toContain("Working preferences & lessons");
    const block = await new MemoryRetrievalService(labelled, { maxBytes: 100 }).load("conv", query, options);
    expect(block?.content).toBe(ordinary?.content);
    expect(block?.truncated).toBe(true);
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(100);
  });

  it("does not conceal degraded recall with a person card", async () => {
    const degraded: SharedRecallStore = { ...store([], [fact("birth", "1990-05-17")]),
      async load() { return undefined; }, async close() {}, async recall() { return []; },
      async recallWithOutcome() { return { hits: [], retrievalMode: "lexical_only" as const,
        degradation: { code: "embedding_unavailable" as const } }; },
    };
    await expect(new MemoryRetrievalService(degraded).load("conv", "Morgan", options))
      .rejects.toThrow(/semantic memory retrieval is unavailable/iu);
  });
});

describe("explicit fact sheet rendering", () => {
  it("renders reader-facing keys and value text instead of JSON", async () => {
    const { readLabelSections } = await import("../memory-label-sections.js");
    const city: MemoryLabelHit = { ...fact("city", "1990-05-17"), text: "Morgan's home city is Lisbon.",
      label: { v: 1, kind: "fact", entityId: "person:morgan", key: "other:home-city",
        value: { type: "text", text: "Lisbon" }, attribution: "user-stated" } };
    const sections = readLabelSections(store([], [city]), { query: "Morgan", kind: "fact" }, { hostDate: "2026-09-24" });
    expect(sections?.text).toContain("Morgan [person:morgan] home city: Lisbon (user-stated");
    expect(sections?.text).not.toContain("{");
    // The structured entry keeps the stored key and typed value.
    expect(sections?.factSheet?.[0]).toMatchObject({ key: "other:home-city", value: { type: "text", text: "Lisbon" } });
  });
});
