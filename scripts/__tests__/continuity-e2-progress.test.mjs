import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeE2Progress, readE2Progress, writeE2PartialScore } from "../lib/continuity-e2-progress.mjs";
import { freezeCheckpoint, restoreCheckpoint } from "../lib/continuity-e2-replay.mjs";
import { e2FailureCause, e2ProviderCause, validE2FailureCause } from "../lib/continuity-e2-cause.mjs";
const roots = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("recovers completed checkpoints after restore and a torn unpublished next answer, without a gate score", async () => {
  const output = await mkdtemp(join(tmpdir(), "e2-progress-")); roots.push(output);
  const work = join(output, "branch-0/work"), snapshot = join(output, "snapshot");
  await mkdir(work, { recursive: true, mode: 0o700 }); await writeFile(join(work, "seed"), "Fictional baseline");
  const receipt = await freezeCheckpoint(work, snapshot), binding = "a".repeat(64), slotId = "b".repeat(64);
  const state = { binding, slots: [{ slotId, holds: [] }] };
  const evaluator = { schema: "continuity-recorded-evaluator-keys-v1", keys: ["B4", "END"].map(checkpoint => ({ id: checkpoint, checkpoint, kind: "exact", expected: "Fictional answer", availability: "available", rate: true, dependsOnSteps: [], forbidden: [] })) };
  for (let i = 1; i <= 3; i++) {
    const checkpoint = i <= 2 ? 2 : 3, payloadDigest = String(i).repeat(64);
    state.slots[0].holds.push({ round: i, checkpoint, payloadDigest, paidRole: "probe", consumed: true, settlement: { kind: "settled" } });
    await writeE2Progress(output, i, { registrationSha256: binding, slotId, checkpoint, round: i, payloadDigest },
      { id: i <= 2 ? "B4" : "END", repeat: i === 2 ? 2 : 1, text: "Fictional answer", witness: true, excludedSteps: [] });
    await writeFile(join(work, "probe-only"), "Fictional transient answer"); await restoreCheckpoint(work, snapshot, receipt);
    await expect(readFile(join(work, "probe-only"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(output, "answer-progress", `${String(i).padStart(6, "0")}.json`))).mode & 0o077).toBe(0);
  }
  await writeFile(join(output, "answer-progress/.pending-00000000-0000-0000-0000-000000000000"), '{"torn":', { mode: 0o600 });
  const answers = await readE2Progress(output, state, 0), score = await writeE2PartialScore(output, answers, evaluator);
  expect(answers.answers).toHaveLength(3); expect(score).toMatchObject({ informational: true, qualityMeasured: false, completedAnswers: 3, plannedAnswers: 4, totals: { ratePass: 3, inconclusive: 1 } });
  expect(score).not.toHaveProperty("gate"); expect(score.byCheckpointAndRepeat[0].counts.ratePass).toBe(1);
  expect(await writeE2PartialScore(output, answers, evaluator)).toEqual(score);
  await expect(writeE2Progress(output, 1, {}, {})).rejects.toMatchObject({ code: "EEXIST" });
  state.binding = "c".repeat(64); await expect(readE2Progress(output, state, 0)).rejects.toMatchObject({ code: "E2_ANSWER_PROGRESS_INVALID" });
});
it("accepts only a closed, hold-bound cause record, never exception text or unknown code strings", () => {
  const h = { round: 4, paidRole: "probe", checkpoint: 2, payloadDigest: "a".repeat(64) }, slot = { holds: [h] };
  const binding = { round: 4, role: "probe", checkpoint: 2, payloadDigest: h.payloadDigest };
  const cause = e2FailureCause(binding, { sourceStage: "dispatch", providerClass: "PRIVATE-CANARY", httpStatus: "PRIVATE-CANARY" }, { stopReason: "PRIVATE-CANARY", errorMessage: "PRIVATE-CANARY" }, true);
  expect(JSON.stringify(cause)).not.toContain("PRIVATE-CANARY"); expect(cause).toMatchObject({ providerClass: "unknown", sdkStopReason: "unknown", httpStatus: null });
  expect(validE2FailureCause(cause, slot)).toBe(true);
  for (const bad of [{ ...cause, round: 5 }, { ...cause, checkpoint: 3 }, { ...cause, payloadDigest: "b".repeat(64) }, { ...cause, message: "PRIVATE-CANARY" }]) expect(validE2FailureCause(bad, slot)).toBe(false);
  expect(e2ProviderCause("PRIVATE-CANARY")).toBe("unknown");
  expect(e2ProviderCause("ERR_STREAM_PREMATURE_CLOSE")).toBe("stream");
});
