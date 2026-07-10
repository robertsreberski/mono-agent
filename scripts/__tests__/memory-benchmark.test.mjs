import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runMemoryBenchmark } from "../memory-benchmark.mjs";

describe("memory benchmark", () => {
  it("covers every required fast-suite scenario and passes the offline gates", async () => {
    const report = await runMemoryBenchmark();

    expect(report.disposableStore).toBe(true);
    expect(report.categories).toEqual(expect.arrayContaining([
      "fact",
      "paraphrase",
      "update",
      "temporal",
      "abstention",
      "recurring-noise",
      "alternating",
      "duplicates",
      "entity-hop",
    ]));
    expect(report.gates.passed).toBe(true);
    expect(report.quality.recallAt5).toBeGreaterThanOrEqual(0.9);
    expect(report.quality.mrr).toBeGreaterThanOrEqual(0.8);
    expect(report.quality.staleRecallRate).toBeLessThanOrEqual(0.05);
    expect(report.quality.falseRecallRate).toBeLessThanOrEqual(0.05);
    expect(report.efficiency).toMatchObject({
      contextBytes: expect.any(Object),
      indexingLatencyMs: expect.any(Object),
      searchLatencyMs: expect.any(Object),
      storageBytes: expect.any(Number),
      embeddings: expect.any(Object),
      llm: expect.any(Object),
      queueDrainMs: expect.any(Number),
    });
  });

  it("adapts opt-in LongMemEval session ids and LoCoMo dialogue evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-datasets-"));
    const longMemEval = join(dir, "longmemeval.json");
    const locomo = join(dir, "locomo.json");
    try {
      await writeFile(longMemEval, JSON.stringify([{
        question_type: "fact",
        question: "Where is the launch office?",
        haystack_session_ids: ["session-alpha"],
        haystack_sessions: [[{ content: "The launch office is in Amsterdam." }]],
        answer_session_ids: ["session-alpha"],
      }]));
      await writeFile(locomo, JSON.stringify([{
        conversation: {
          speaker_a: "Morgan",
          session_1: [{ dia_id: "D1:1", text: "The launch office is in Amsterdam." }],
        },
        qa: [{
          category: "fact",
          question: "Where is the launch office?",
          evidence: ["D1:1"],
        }],
      }]));

      const longReport = await runMemoryBenchmark({ suite: "longmemeval", datasetPath: longMemEval });
      const locomoReport = await runMemoryBenchmark({ suite: "locomo", datasetPath: locomo });

      expect(longReport).toMatchObject({ cases: 1, quality: { answerableCases: 1 } });
      expect(locomoReport).toMatchObject({ cases: 1, quality: { answerableCases: 1 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
