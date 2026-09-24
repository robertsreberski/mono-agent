import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendBullet } from "../daily.js";
import { curateEstimate, inspectCurateSource, proposeCurate, validateCurateProposal } from "../curate.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), "curate-fixture-")); roots.push(path); return path; }
function seed(path: string, id: string, text: string) {
  appendBullet(path, { id, text, type: "note", status: "open", salience: 0.5, isInsight: false,
    createdAt: "2026-07-12T10:00:00.000Z", refs: [] }, new Date("2026-07-12T10:00:00.000Z"));
}
describe("curation preparation", () => {
  it("reads bounded canonical live lines in order and estimates without a model call", () => {
    const path = root(); seed(path, "fictional-a", "Morgan completed the example."); seed(path, "fictional-b", "The demo status is transient.");
    const snapshot = inspectCurateSource(path, 1);
    expect(snapshot.lines.map(({ id }) => id)).toEqual(["fictional-a"]);
    expect(curateEstimate(snapshot)).toMatchObject({ lines: 1, calls: 1, cost: "unknown" });
  });
  it("rejects unsupported legacy label authority and invalid rewrites", () => {
    const path = root(); seed(path, "fictional-a", "Morgan completed the example.");
    const source = inspectCurateSource(path).lines[0]!;
    expect(() => validateCurateProposal({ source, action: "label", accepted: true, labels: [{ v: 1, kind: "lesson", scope: "agent", verified: true }] })).toThrow();
    expect(() => validateCurateProposal({ source, action: "rewrite", text: "Unsafe\ntext", accepted: true })).toThrow();
  });
  it("batches fake-model proposals and fails closed on unknown IDs", async () => {
    const path = root(); seed(path, "fictional-a", "Generic demo advice."); seed(path, "fictional-b", "Morgan completed the example.");
    const snapshot = inspectCurateSource(path);
    let calls = 0;
    const proposals = await proposeCurate(snapshot, { id: "fake", complete: async () => {
      calls++;
      return JSON.stringify([{ id: "fictional-a", action: "drop", reason: "generic-advice" }, { id: "fictional-b", action: "keep" }]);
    } });
    expect(calls).toBe(1);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ accepted: false, reason: "generic-advice" });
    await expect(proposeCurate(snapshot, { id: "fake", complete: async () => JSON.stringify([{ id: "outside", action: "keep" }, { id: "fictional-b", action: "keep" }]) })).rejects.toThrow();
  });
});
