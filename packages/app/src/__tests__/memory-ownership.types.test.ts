import { expect, it } from "vitest";

import type { MemoryCommandContext, PreviewRecallHit, RunMemoryCommandInput, StrictMemoryHealthReport } from "../cli/commands/memory/types.js";
import type { writeMemoryForgetFailure } from "../cli/commands/memory/forget-failure.js";
import type { writeReplayAdoptionCliFailure } from "../cli/commands/memory/replay-failure.js";

function memoryTypes(input: RunMemoryCommandInput, context: MemoryCommandContext, hit: PreviewRecallHit, health: StrictMemoryHealthReport): void {
  // @ts-expect-error input members remain readonly
  input.strict = true;
  // @ts-expect-error positionals remain readonly
  input.positionals.push("apply");
  // @ts-expect-error reviewed merge inputs remain readonly
  input.curateMerges?.push("fictional-a=fictional-b");
  // @ts-expect-error exact optional inputs cannot be explicitly undefined
  const invalid: RunMemoryCommandInput = { cwd: ".", env: {}, positionals: [], json: true, strict: false, planPath: undefined };
  void invalid;
  // @ts-expect-error context identity remains readonly
  context.configPath = "unowned";
  // @ts-expect-error preview source remains readonly
  hit.record.source!.file = "unowned";
  // @ts-expect-error published health statuses remain a closed union
  const status: typeof health.status = "probably_healthy";
  void status;
  // @ts-expect-error replay failures remain a closed contract
  const replay: Parameters<typeof writeReplayAdoptionCliFailure>[1] = "raw_error";
  // @ts-expect-error forget failures remain a distinct closed contract
  const forget: Parameters<typeof writeMemoryForgetFailure>[2] = "replay_adoption_failed";
  void replay;
  void forget;
}
void memoryTypes;

it("preserves readonly and exact optional memory command contracts", () => {
  expect(true).toBe(true);
});
