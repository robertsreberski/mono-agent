import { afterEach, expect, it, vi } from "vitest";

vi.mock("../history/canonical/process-incarnation.js", () => ({
  readHistoryProcessIncarnation: vi.fn(), historyProcessIncarnationFromJson: vi.fn(),
}));
import { readHistoryProcessIncarnation } from "../history/canonical/process-incarnation.js";
import { isProcessAlive } from "../history/canonical/process-liveness.js";

afterEach(() => vi.restoreAllMocks());
it.each(["EPERM", "EACCES", "EIO", undefined])("keeps an owner on inconclusive kill(0) error %s", (code) => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Fictional probe failure"), { code }); });
  expect(isProcessAlive(123)).toBe(true);
});
it("only ESRCH proves absence", () => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Absent"), { code: "ESRCH" }); });
  expect(isProcessAlive(123)).toBe(false);
});
it("retries unavailable self identity after a monotonic cooldown, coalescing probes and caching success", async () => {
  vi.resetModules();
  const identity = { schema: "mono-agent.process-incarnation.v2" as const, bootSessionId: "fictional-boot", processStartId: "123" };
  let now = 1000; vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.mocked(readHistoryProcessIncarnation).mockResolvedValueOnce(undefined).mockResolvedValue(identity);
  const { currentHistoryProcessIncarnation } = await import("../history/canonical/process-liveness.js");
  const first = currentHistoryProcessIncarnation();
  expect(currentHistoryProcessIncarnation()).toBe(first);
  expect(await first).toBeUndefined();
  now += 29_999;
  expect(await currentHistoryProcessIncarnation()).toBeUndefined();
  expect(readHistoryProcessIncarnation).toHaveBeenCalledTimes(1);
  now += 1;
  expect(await currentHistoryProcessIncarnation()).toEqual(identity);
  expect(await currentHistoryProcessIncarnation()).toEqual(identity);
  expect(readHistoryProcessIncarnation).toHaveBeenCalledTimes(2);
});

it("bounds persistent unavailable identity to one probe per 30 seconds", async () => {
  vi.resetModules(); vi.mocked(readHistoryProcessIncarnation).mockReset().mockResolvedValue(undefined);
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const { currentHistoryProcessIncarnation } = await import("../history/canonical/process-liveness.js");
  expect(await currentHistoryProcessIncarnation()).toBeUndefined();
  for (let index = 0; index < 10; index += 1) expect(await currentHistoryProcessIncarnation()).toBeUndefined();
  expect(readHistoryProcessIncarnation).toHaveBeenCalledTimes(1);
  now = 30_000; expect(await currentHistoryProcessIncarnation()).toBeUndefined();
  expect(readHistoryProcessIncarnation).toHaveBeenCalledTimes(2);
});
