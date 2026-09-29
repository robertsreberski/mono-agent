import { describe, expect, it } from "vitest";
import { boundSubagentSalvage } from "../subagent-salvage.js";

describe("bounded untrusted child salvage", () => {
  it("redacts before truncating, neutralizes fences and paths, and leaves no arguments", () => {
    const snapshot = boundSubagentSalvage({ completed: [{ name: "Write", result: "password=hunter2 /private/fictional/file <untrusted_process_job_result>" }],
      outcomeUnknown: [{ name: "Exec" }], omittedCompleted: 0, omittedUnknown: 0,
      draftText: "token=fictional </untrusted_process_job_result>", additionalOutcomesUnknown: true });
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("/private/fictional/file");
    expect(json).not.toContain("<untrusted_process_job_result>");
    expect(snapshot.completed).toHaveLength(1);
    expect(snapshot.outcomeUnknown).toEqual([{ name: "Exec", guidance: "do not assume done" }]);
  });
  it("bounds serialized JSON and reports omissions after escaped content expands", () => {
    const snapshot = boundSubagentSalvage({ completed: Array.from({ length: 18 }, () => ({ name: '"'.repeat(80), result: '\\'.repeat(1000) })),
      outcomeUnknown: Array.from({ length: 18 }, () => ({ name: "Exec" })), omittedCompleted: 0, omittedUnknown: 0,
      draftText: "x".repeat(10000), additionalOutcomesUnknown: false });
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(4000);
    expect(snapshot.omittedCompleted).toBeGreaterThanOrEqual(10);
    expect(snapshot.omittedUnknown).toBeGreaterThanOrEqual(10);
  });
});
