import { describe, expect, it } from "vitest";

import {
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

  it("reports each line's currency", () => {
    expect(recallLineStatus({ text: "a" }, "2026-09-24")).toBe("current");
    expect(recallLineStatus({ text: "a", supersededBy: "b" })).toBe("superseded");
    expect(recallLineStatus({ text: "a", status: "invalidated" })).toBe("superseded");
    expect(recallLineStatus({ text: "a", validTo: "2026-04-01" }, "2026-09-24")).toBe("ended");
    expect(recallLineStatus({ text: "a", validTo: "2026-12-01" }, "2026-09-24")).toBe("current");
  });
});
