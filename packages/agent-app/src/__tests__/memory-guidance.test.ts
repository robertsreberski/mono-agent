import { describe, expect, it } from "vitest";
import type { MemoryDb } from "@mono-agent/memory/store";
type MemoryLabelHit = ReturnType<MemoryDb["labelsForEntity"]>[number];
import { ageAt, formatMemoryBackground as formatBlock, type LabelRecallStore } from "../memory-guidance.js";
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
  .map((id) => ({ score: id === "irrelevant" ? 0.1 : 0.81, record: { id, text: "Please make the relevant note concise." } }))
  // Ordinary unlabelled candidates: guidance must lead their median score.
  .concat([1, 2, 3, 4, 5].map((n) => ({ score: 0.6, record: { id: `filler-${n}`, text: "Unrelated note." } })));

function store(rows: MemoryLabelHit[], facts: MemoryLabelHit[] = []): LabelRecallStore {
  return {
    guidanceForScope(scope) { return rows.filter((row) => row.label.kind !== "fact" && row.label.scope === scope); },
    labelsForEntity() { return facts; },
    findMemoryEntitiesByNames(names) { return names.includes("morgan")
      ? [{ id: "person:morgan", name: "Morgan", createdAt: "2026-09-06T00:00:00Z" }] : []; },
  };
}
const options = { senderToken: token, hostDate: "2026-09-24" };
const owner = { ...options, ownerTurn: true as const };
const labelled = (key: string, text: string, id: string): MemoryLabelHit => ({
  ...fact(id, "1990-05-17"), text: `Morgan's ${key} is ${text}.`,
  label: { v: 1, kind: "fact", entityId: "person:morgan", key, value: { type: "text", text }, attribution: "user-stated" },
});

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

  it("shows opposite advice together for the model to judge, abstains on ambiguous names, permits explicit entity IDs", () => {
    const yes = preference("agent", "Do check the concise note.", "yes");
    const no = preference(`user:${token}`, "Do not check the concise note.", "no");
    const relevant = [yes, no].map((hit) => ({ score: 0.9, record: { id: hit.memoryId, text: hit.text } }));
    const both = formatMemoryBackground(store([yes, no]), "Check the concise note", "current", options, relevant);
    expect(both).toContain("Do check the concise note.");
    expect(both).toContain("Do not check the concise note.");
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

  it("shows remote lines only on owner turns, as possibly relevant, next to the card", async () => {
    const remote: SharedRecallStore = {
      async load() { return undefined; }, async close() {},
      async recall() { return [{ score: 0.9, record: { id: "hint", text: "Morgan likes green tea." } }]; },
    };
    // Non-owner turns (groups, other senders) get no automatic memory at all.
    expect(await new MemoryRetrievalService(remote).load("current", "What does Morgan drink?", { hostDate: "2026-09-24" }))
      .toBeUndefined();
    const labelled = Object.assign(remote, store([], [fact("birth", "1990-05-17")]));
    expect(await new MemoryRetrievalService(labelled).load("current", "What does Morgan drink?", { hostDate: "2026-09-24" }))
      .toBeUndefined();
    const owned = await new MemoryRetrievalService(labelled).load("current", "What does Morgan drink?",
      { hostDate: "2026-09-24", ownerTurn: true });
    expect(owned?.content).toContain("## Memory (possibly relevant — may be unrelated; verify before relying)\n\n- Morgan likes green tea. (current)");
    expect(owned?.content).toContain("Memory (background — not direct evidence)");
    expect(owned?.content).toContain("age 36");
    expect(owned?.content).not.toContain("## Memory (recalled)");
  });

  it("shows a named person's whole card whatever the question's language or wording", () => {
    const person = store([], [fact("birth", "1990-05-17"), labelled("other:home-town", "Maple Harbor", "town"),
      labelled("other:employer", "Zorbel Labs", "job")]);
    for (const query of ["Where does Morgan work?", "¿Dónde trabaja Morgan?", "Gdzie pracuje Morgan?", "Morgan"]) {
      const card = formatMemoryBackground(person, query, "conv", owner, []);
      expect(card).toContain("Person card:");
      expect(card).toContain("home town: Maple Harbor (you said, recorded 2026-09-06)");
      expect(card).toContain("employer: Zorbel Labs");
      expect(card).toContain("born: 1990-05-17");
      expect(card).not.toContain("other:");
      expect(card).not.toContain("{");
    }
    // No name, no card: first-person wording never selects the owner's card.
    expect(formatMemoryBackground(person, "Where do I work?", "conv", owner, [])).toBeUndefined();
  });

  it("preserves the possibly-relevant block when a label lookup fails", async () => {
    const base: SharedRecallStore = { async load() { return undefined; }, async close() {},
      async recall() { return [{ score: 0.95, record: { id: "direct", text: "Morgan picked the cobalt chess set." } }]; },
    };
    const options = { hostDate: "2026-09-24", ownerTurn: true as const };
    const ordinary = await new MemoryRetrievalService(base).load("conv", "Which chess set did Morgan pick?", options);
    const broken: SharedRecallStore = { ...base, guidanceForScope() { throw new Error("label DB temporarily unavailable"); },
      labelsForEntity() { return []; }, labelsForMemories() { throw new Error("label DB temporarily unavailable"); } };
    const protectedBlock = await new MemoryRetrievalService(broken).load("conv", "Which chess set did Morgan pick?", options);
    expect(protectedBlock).toEqual(ordinary);
    expect(ordinary?.content).toContain("cobalt");
  });

  it("counts background against the configured recall budget and marks omitted lines truncated", async () => {
    const base: SharedRecallStore = { async load() { return undefined; }, async close() {},
      async recall() { return [{ score: 0.95, record: { id: "direct", text: "Morgan picked the cobalt chess set." } },
        { score: 0.9, record: { id: "pref", text: "A useful but long background preference about concise notes." } }]; },
    };
    const query = "Which chess set did Morgan pick?";
    const owner = { ...options, ownerTurn: true as const };
    const ordinary = await new MemoryRetrievalService(base, { maxBytes: 160 }).load("conv", query, owner);
    const labelled: SharedRecallStore = { ...base,
      guidanceForScope: () => [preference("agent", "A useful but long background preference about concise notes.", "pref")],
      labelsForEntity: () => [],
    };
    const full = await new MemoryRetrievalService(labelled, { maxBytes: 512 }).load("conv", query, owner);
    const fullOrdinary = await new MemoryRetrievalService(base, { maxBytes: 512 }).load("conv", query, owner);
    expect(full?.content.startsWith(`${fullOrdinary?.content}\n\n`)).toBe(true);
    expect(full?.content).toContain("Working preferences & lessons");
    const block = await new MemoryRetrievalService(labelled, { maxBytes: 160 }).load("conv", query, owner);
    expect(block?.content).toBe(ordinary?.content);
    expect(block?.truncated).toBe(true);
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(160);
  });

  it("injects nothing from lexical-only recall, even with a person card", async () => {
    const degraded: SharedRecallStore = { ...store([], [fact("birth", "1990-05-17")]),
      async load() { return undefined; }, async close() {}, async recall() { return []; },
      async recallWithOutcome() { return { hits: [{ score: 0.99, record: { id: "lex", text: "Morgan plays chess." } }],
        retrievalMode: "lexical_only" as const, degradation: { code: "embedding_unavailable" as const } }; },
    };
    await expect(new MemoryRetrievalService(degraded).load("conv", "Morgan", { ...options, ownerTurn: true }))
      .rejects.toThrow(/semantic memory retrieval is unavailable/iu);
    expect(await new MemoryRetrievalService(degraded).load("conv", "Morgan", options)).toBeUndefined();
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

  it("never lets keyless person lines push a structured conflict past the cut", async () => {
    const { readLabelSections } = await import("../memory-label-sections.js");
    const keyless = Array.from({ length: 14 }, (_, index): MemoryLabelHit => ({ ...fact(`note-${index}`, "1990-05-17"),
      text: `Morgan visited the fictional garden ${index}.`, createdAt: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00Z`,
      label: { v: 1, kind: "fact", entityId: "person:morgan", attribution: "assistant-inferred" } }));
    const sections = readLabelSections(store([], [...keyless, fact("one", "1990-05-17", true), fact("two", "1991-05-17", true)]),
      { query: "Morgan", kind: "fact" }, { hostDate: "2026-09-24" });
    expect(sections?.factSheet).toHaveLength(12);
    expect(sections?.factSheet?.slice(0, 2)).toMatchObject([{ key: "birth_date", conflict: true }, { key: "birth_date", conflict: true }]);
    expect(sections?.factSheet?.[2]).toMatchObject({ text: expect.stringContaining("fictional garden") });
    expect(sections?.factSheetTruncated).toBe(true);
    expect(sections?.text).toContain("conflicting values");
  });
});

describe("person card values", () => {
  it("treats two current distinct values for one key as a conflict to ask about", () => {
    const person = store([], [labelled("other:home-town", "Maple Harbor", "one"), labelled("other:home-town", "Birchfield", "two")]);
    const result = formatBlock(person, "Morgan", "conv", owner, []);
    expect(result?.content).toContain("home town: conflicting values — ask");
    expect(result?.content).not.toContain("Maple Harbor");
  });

  it("keeps the card background-only on every turn", () => {
    const person = store([], [labelled("other:home-town", "Maple Harbor", "town")]);
    for (const opts of [options, owner]) {
      const result = formatBlock(person, "What is Morgan's home town?", "conv", opts, []);
      expect(result?.content).toContain("Person card:");
      expect(result?.content).not.toContain("## Memory (recalled)");
    }
  });
});

describe("ageAt", () => {
  it("renders infants in months, weeks or days, never age 0", () => {
    expect(ageAt("2026-01-10", "2026-09-25")).toBe("age 8 months");
    expect(ageAt("2026-08-24", "2026-09-25")).toBe("age 1 month");
    expect(ageAt("2026-09-01", "2026-09-25")).toBe("age 3 weeks");
    expect(ageAt("2026-09-22", "2026-09-25")).toBe("age 3 days");
    expect(ageAt("2025-09-25", "2026-09-25")).toBe("age 1");
    expect(ageAt("2026-09-26", "2026-09-25")).toBeUndefined();
  });
});

describe("guidance score floor", () => {
  const guidance = [preference(`user:${token}`, "Keep replies short.", "pref")];
  const background = (score: number, others: readonly number[]) => formatMemoryBackground(store(guidance), "Reply to Morgan", "current", options,
    [{ score, record: { id: "pref", text: "Keep replies short." } },
      ...others.map((value, n) => ({ score: value, record: { id: `other-${n}`, text: "Unrelated note." } }))]);

  it("injects a preference only when it clearly leads the candidate median", () => {
    expect(background(0.86, [0.8, 0.79, 0.78, 0.78, 0.77])).toBeUndefined();
    expect(background(0.92, [0.8, 0.79, 0.78, 0.78, 0.77])).toContain("Keep replies short.");
  });

  it("requires the preference to rank among the top hits", () => {
    expect(background(0.95, Array.from({ length: 9 }, () => 0.97).concat([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]))).toBeUndefined();
  });
});

describe("possibly-relevant block format", () => {
  it("shows date, currency and attribution, stays within the tiny budget and never claims to answer", async () => {
    const long = "Zorbel Labs chess ladder notes ".repeat(30);
    const records = [
      { score: 0.9, record: { id: "said", text: "Morgan prefiere el té verde.", createdAt: "2026-05-01T08:00:00Z" } },
      { score: 0.89, record: { id: "noted", text: "Morgan woli zieloną herbatę.", createdAt: "2026-04-01T08:00:00Z" } },
      { score: 0.88, record: { id: "old", text: long, createdAt: "2026-03-01T08:00:00Z", supersededBy: "said" } },
    ];
    const label = (memoryId: string, attribution: "user-stated" | "assistant-inferred"): MemoryLabelHit => ({
      memoryId, ordinal: 0, text: "", status: "open", createdAt: "2026-05-01T08:00:00Z", active: true, conflict: false,
      label: { v: 1, kind: "fact", entityId: "person:morgan", attribution } });
    const store: SharedRecallStore = { async load() { return undefined; }, async close() {},
      async recall() { return records; },
      labelsForMemories: (ids) => [label("said", "user-stated"), label("noted", "assistant-inferred")].filter((row) => ids.includes(row.memoryId)),
    };
    const block = await new MemoryRetrievalService(store).load("conv", "¿Qué té bebe Morgan?", { ...options, ownerTurn: true });
    const lines = block?.content.split("\n") ?? [];
    expect(lines[0]).toBe("## Memory (possibly relevant — may be unrelated; verify before relying)");
    expect(block?.content).not.toMatch(/recalled|answer/iu);
    // Current lines first, then ordered by time; the superseded long line is capped.
    expect(lines.slice(2)).toEqual([
      expect.stringMatching(/^- Zorbel Labs chess ladder notes .*… \(recorded 2026-03-01; superseded\)$/u),
      "- Morgan woli zieloną herbatę. (recorded 2026-04-01; current; assistant noted)",
      "- Morgan prefiere el té verde. (recorded 2026-05-01; current; you said)",
    ]);
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(1_500);
    const tiny = await new MemoryRetrievalService(store, { maxBytes: 200 }).load("conv", "¿Qué té bebe Morgan?", { ...options, ownerTurn: true });
    expect(tiny?.truncated).toBe(true);
    expect(Buffer.byteLength(tiny?.content ?? "", "utf8")).toBeLessThanOrEqual(200);
    expect(tiny?.content).not.toContain("Zorbel");
  });
});
