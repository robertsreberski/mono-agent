import { afterEach, expect, it, vi } from "vitest";

vi.mock("../process-incarnation.js", () => ({
  readHistoryProcessIncarnation: vi.fn(), historyProcessIncarnationFromJson: vi.fn(),
}));
import { readHistoryProcessIncarnation } from "../process-incarnation.js";
import { isProcessAlive } from "../history-process-liveness.js";

afterEach(() => vi.restoreAllMocks());
it.each(["EPERM", "EACCES", "EIO", undefined])("keeps an owner on inconclusive kill(0) error %s", (code) => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Fictional probe failure"), { code }); });
  expect(isProcessAlive(123)).toBe(true);
});
it("only ESRCH proves absence", () => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Absent"), { code: "ESRCH" }); });
  expect(isProcessAlive(123)).toBe(false);
});
it("retries a failed self-identity probe, but caches success", async () => {
  vi.resetModules();
  const identity = { schema: "mono-agent.process-incarnation.v2" as const, bootSessionId: "fictional-boot", processStartId: "123" };
  vi.mocked(readHistoryProcessIncarnation).mockRejectedValueOnce(new Error("Fictional transient failure")).mockResolvedValue(identity);
  const { currentHistoryProcessIncarnation } = await import("../history-process-liveness.js");
  expect(await currentHistoryProcessIncarnation()).toBeUndefined();
  expect(await currentHistoryProcessIncarnation()).toEqual(identity);
  expect(await currentHistoryProcessIncarnation()).toEqual(identity);
  expect(readHistoryProcessIncarnation).toHaveBeenCalledTimes(2);
});
