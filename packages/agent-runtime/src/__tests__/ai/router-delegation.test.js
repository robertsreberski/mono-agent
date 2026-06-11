import { describe, expect, it, vi } from "vitest";

const configureToolsMock = vi.fn();
const disposeSessionMock = vi.fn().mockResolvedValue(true);
const disposeAllSessionsMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../runtime.js", () => ({
  createRuntime: () => ({
    run: vi.fn(),
    configureTools: configureToolsMock,
    disposeSession: disposeSessionMock,
    disposeAllSessions: disposeAllSessionsMock,
  }),
}));

const { createRouterRuntime } = await import("../../ai/runtime/router.js");

describe("createRouterRuntime — inner runtime delegation", () => {
  it("delegates configureTools, disposeSession, and disposeAllSessions", async () => {
    const router = createRouterRuntime({
      chain: [{ sdk: "claude", model: "claude-sonnet-4-6" }],
    });

    router.configureTools({ workspace: "/tmp/w" });
    expect(configureToolsMock).toHaveBeenCalledWith({ workspace: "/tmp/w" });

    await expect(router.disposeSession("session-1")).resolves.toBe(true);
    expect(disposeSessionMock).toHaveBeenCalledWith("session-1");

    await router.disposeAllSessions();
    expect(disposeAllSessionsMock).toHaveBeenCalledTimes(1);
  });
});
