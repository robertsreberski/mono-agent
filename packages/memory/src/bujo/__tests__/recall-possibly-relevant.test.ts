import { describe, expect, it } from "vitest";
import type { MemoryDb } from "../../store/index.js";

import {
  composeRecallBlock,
  formatPossiblyRelevantBlock,
  POSSIBLY_RELEVANT_HEADING,
  POSSIBLY_RELEVANT_MAX_LINES,
  POSSIBLY_RELEVANT_MIN_SCORE,
  POSSIBLY_RELEVANT_WINDOW,
  recallLineStatus,
  selectPossiblyRelevantRecallHits,
} from "../recall.js";

const hit = (score: number, text: string, record: Record<string, string> = {}) => ({ score, record: { text, ...record } });

describe("possibly-relevant selection", () => {
  it("uses scores only, so any language selects the same way", () => {
    for (const text of ["Morgan prefers green tea.", "Morgan woli zieloną herbatę.", "Morgan prefiere el té verde."]) {
      expect(selectPossiblyRelevantRecallHits([hit(0.8, text)]).map((h) => h.record.text)).toEqual([text]);
    }
  });

  it("applies the floor to the strongest line and the window below it", () => {
    expect(selectPossiblyRelevantRecallHits([hit(POSSIBLY_RELEVANT_MIN_SCORE - 0.01, "Weak chess note.")])).toEqual([]);
    const selected = selectPossiblyRelevantRecallHits([
      hit(0.9, "Maple book club meets on Tuesdays."),
      hit(0.9 - POSSIBLY_RELEVANT_WINDOW / 2, "The book club reads a mystery next."),
      hit(0.9 - POSSIBLY_RELEVANT_WINDOW * 2, "Morgan rode the cycling loop."),
    ]);
    expect(selected.map((h) => h.record.text)).toEqual(["Maple book club meets on Tuesdays.", "The book club reads a mystery next."]);
  });

  it("caps lines at K, shows identical text once and never returns more than the maximum", () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit(0.9 - i * 0.001, `Zorbel Labs chess ladder round ${i % 5}.`));
    const selected = selectPossiblyRelevantRecallHits(hits);
    expect(selected).toHaveLength(POSSIBLY_RELEVANT_MAX_LINES);
    expect(new Set(selected.map((h) => h.record.text)).size).toBe(selected.length);
    expect(selectPossiblyRelevantRecallHits(hits, { maxLines: 99 })).toHaveLength(POSSIBLY_RELEVANT_MAX_LINES);
    expect(selectPossiblyRelevantRecallHits(hits, { maxLines: 1 })).toHaveLength(1);
  });

  it("keeps the current copy when identical text is also superseded", () => {
    const selected = selectPossiblyRelevantRecallHits([
      hit(0.9, "Morgan plays chess on Fridays.", { supersededBy: "NEW" }),
      hit(0.89, "Morgan plays chess on Fridays."),
    ]);
    expect(selected).toHaveLength(1);
    expect((selected[0]?.record as { supersededBy?: string } | undefined)?.supersededBy).toBeUndefined();
  });

  it("prefers current lines and orders the chosen lines oldest first", () => {
    const selected = selectPossiblyRelevantRecallHits([
      hit(0.9, "Morgan drinks oolong tea.", { createdAt: "2026-03-01T00:00:00Z", supersededBy: "new" }),
      hit(0.89, "Morgan drinks green tea.", { createdAt: "2026-05-01T00:00:00Z" }),
      hit(0.89, "Morgan's tea club ran until spring.", { createdAt: "2026-01-01T00:00:00Z", validTo: "2026-04-01" }),
      hit(0.88, "Morgan brews tea at seven.", { createdAt: "2026-02-01T00:00:00Z" }),
    ], { asOf: "2026-09-24", maxLines: 2 });
    expect(selected.map((h) => h.record.text)).toEqual(["Morgan brews tea at seven.", "Morgan drinks green tea."]);
  });

  it("standalone composition never injects degraded/lexical results and bounds multilingual hybrid context", async () => {
    const accessed: string[][] = [];
    let retrievalMode: "hybrid" | "lexical_only" = "hybrid";
    const rows = [
      { score: 0.91, record: { id: "a", text: "Morgan prefiere el té verde.", type: "note", status: "open" } },
      { score: 0.9, record: { id: "b", text: "Morgan woli zieloną herbatę.", type: "note", status: "open" } },
      { score: 0.89, record: { id: "c", text: "Morgan prefers green tea.", type: "note", status: "open" } },
      { score: 0.88, record: { id: "d", text: "Maple tea club.", type: "note", status: "open" } },
    ];
    const requests: unknown[] = [];
    const db = {
      recallWithOutcome: async (_query: string, options: unknown) => { requests.push(options); return { retrievalMode, hits: rows }; },
      recordAccess: (ids: string[]) => { accessed.push(ids); },
    } as unknown as MemoryDb;
    const block = await composeRecallBlock(db, "¿Qué té bebe Morgan?", { topK: 50 });
    expect(block?.content).toContain("possibly relevant");
    expect(block?.content).toContain("prefiere el té verde");
    expect(block?.content).toContain("woli zieloną herbatę");
    expect(block?.content).not.toContain("Maple tea club");
    expect(accessed).toEqual([["a", "b", "c"]]);
    expect(requests[0]).toMatchObject({ topK: 50, trackAccess: false });
    retrievalMode = "lexical_only";
    expect(await composeRecallBlock(db, "¿Qué té bebe Morgan?")).toBeUndefined();
  });

  it("keeps task history available without implying an open task to the reader", () => {
    const rows = [
      { score: 0.94, record: { id: "open", text: "Maple planned a report.", type: "task" as const,
        status: "open" as const, createdAt: "2026-01-01T00:00:00Z", isInsight: true } },
      { score: 0.92, record: { id: "done", text: "Maple finished a report.", type: "task" as const,
        status: "done" as const, createdAt: "2026-02-01T00:00:00Z" } },
    ];
    expect(selectPossiblyRelevantRecallHits(rows)).toEqual(rows);
    const block = formatPossiblyRelevantBlock(rows, new Map([["open", "you said"]]), 800);
    expect(block?.content).toContain("- Maple planned a report. (recorded 2026-01-01; task/plan recorded)");
    expect(block?.content).toContain("- Maple finished a report. (recorded 2026-02-01; task/plan recorded)");
    expect(block?.content).not.toMatch(/\[ \]|\[x\]|you said|\*/u);
  });

  it("shares note markers, currency, and source with standalone composition", async () => {
    const rows = [
      { score: 0.94, record: { id: "done", text: "Maple note recorded.", type: "note" as const,
        status: "open" as const, isInsight: true, createdAt: "2026-01-01T00:00:00Z" } },
      { score: 0.93, record: { id: "ended", text: "Maple event ended.", type: "event" as const,
        status: "scheduled" as const, validTo: "2026-02-01", createdAt: "2026-01-02T00:00:00Z" } },
    ];
    const db = { recallWithOutcome: async () => ({ retrievalMode: "hybrid", hits: rows }),
      recordAccess: () => undefined } as unknown as MemoryDb;
    const block = await composeRecallBlock(db, "Maple", { asOf: "2026-03-01" });
    expect(block).toMatchObject({ kind: "markdown", source: "memory-bujo", truncated: false });
    expect(block?.content).toContain(POSSIBLY_RELEVANT_HEADING);
    expect(block?.content).toContain("- – Maple note recorded. * (recorded 2026-01-01; current)");
    expect(block?.content).toContain("Maple event ended. (recorded 2026-01-02; ended 2026-02-01)");
  });

  it("clamps UTF-8 lines safely and drops whole excess lines with a truncation flag", async () => {
    const long = { record: { id: "long", text: "é".repeat(300), type: "note" as const, status: "open" as const } };
    const short = { record: { id: "short", text: "Maple kept the note.", type: "note" as const, status: "open" as const } };
    const clamped = formatPossiblyRelevantBlock([long], new Map(), 800);
    expect(clamped).toMatchObject({ truncated: false, shown: [long] });
    expect(clamped?.content).toContain("é…");
    expect(clamped?.content).not.toContain("�");
    const bounded = formatPossiblyRelevantBlock([short, long], new Map(), 180);
    expect(bounded).toMatchObject({ truncated: true, shown: [short] });
    expect(bounded?.content).toContain("Maple kept the note.");
    expect(bounded?.content).not.toContain("é");
    expect(Buffer.byteLength(bounded!.content, "utf8")).toBeLessThanOrEqual(180);
    const db = { recallWithOutcome: async () => ({ retrievalMode: "hybrid", hits: [
      { ...short, score: 0.9 }, { ...long, score: 0.89 },
    ] }), recordAccess: () => undefined } as unknown as MemoryDb;
    expect(await composeRecallBlock(db, "Maple", { maxBytes: 180 })).toMatchObject({
      source: "memory-bujo", truncated: true, content: bounded!.content,
    });
  });

  it("reports each line's currency", () => {
    expect(recallLineStatus({ text: "a" }, "2026-09-24")).toBe("current");
    expect(recallLineStatus({ text: "a", supersededBy: "b" })).toBe("superseded");
    expect(recallLineStatus({ text: "a", status: "invalidated" })).toBe("superseded");
    expect(recallLineStatus({ text: "a", validTo: "2026-04-01" }, "2026-09-24")).toBe("ended");
    expect(recallLineStatus({ text: "a", validTo: "2026-12-01" }, "2026-09-24")).toBe("current");
    expect(recallLineStatus({ text: "a", type: "event", dueAt: "2026-04-01T10:00:00Z" }, "2026-09-24")).toBe("ended");
    expect(recallLineStatus({ text: "a", type: "note", dueAt: "2026-04-01" }, "2026-09-24")).toBe("current");
    expect(recallLineStatus({ text: "a", type: "event", dueAt: "2026-02-30" }, "2026-09-24")).toBe("current");
    const event = { record: { id: "event", text: "Maple attended a gathering.", type: "event" as const,
      status: "open" as const, dueAt: "2026-04-01" } };
    expect(formatPossiblyRelevantBlock([event], new Map(), 500, "2026-09-24")?.content)
      .toContain("ended 2026-04-01");
  });
});
