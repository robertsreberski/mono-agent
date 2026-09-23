import { describe, expect, it, vi } from "vitest";
import { startTuiAdapter } from "@mono-agent/operator-adapter";
import { createSupervisedRestartAuthority } from "../supervised-restart-authority.js";
import { createSupervisedRestartLatch, AGENT_RESTART_EXIT_CODE } from "../supervised-restart-latch.js";
import { systemdUnitName } from "../systemd.js";

const CONFIG = "/work/demo/mono-agent.config.json";

describe("actual host acceptance across operator HTTP", () => {
  it("answers /v1/info promptly and refuses restart when the real authority's fake supervisor never answers", async () => {
    const latch = createSupervisedRestartLatch();
    const authority = createSupervisedRestartAuthority({ configPath: CONFIG, startedAt: "boot-1", platform: "linux",
      pid: 777, systemdRun: () => new Promise(() => undefined) }, latch);
    const adapter = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
    try {
      const at = Date.now();
      const info = await fetch(adapter.infoUrl, { headers: { authorization: "Bearer owner" } });
      expect(info.status).toBe(200);
      expect((await info.json() as { capabilities: { restart: { supported: boolean } } }).capabilities.restart.supported).toBe(false);
      expect(Date.now() - at).toBeLessThan(500);
      const response = await fetch(`${adapter.baseUrl}/v1/restart`, {
        method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { message: "Supervisor verification timed out." } });
      expect(latch.exitCode).toBe(0);
    } finally { await adapter.stop(); }
  });
  it("gives concurrent callers one committed operation, one 202, one 409 and one stop", async () => {
    const latch = createSupervisedRestartLatch();
    const stop = vi.fn();
    latch.onStop(stop);
    const run = vi.fn(async () => ({ code: 0, stderr: "", stdout: [
      "LoadState=loaded", "ActiveState=active", "MainPID=777",
      `FragmentPath=/home/u/.config/systemd/user/${systemdUnitName(CONFIG)}`,
      `ExecStart=argv[]=/node /cli start --foreground --config ${CONFIG} --expected-background-snapshot proof`,
      "Restart=on-failure", "RestartPreventExitStatus=", "SuccessExitStatus=",
    ].join("\n") }));
    const authority = createSupervisedRestartAuthority({ configPath: CONFIG, startedAt: "boot-1", platform: "linux",
      pid: 777, systemdRun: run }, latch);
    const adapter = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
    try {
      const request = () => fetch(`${adapter.baseUrl}/v1/restart`, {
        method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}",
      });
      const responses = await Promise.all([request(), request()]);
      expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
      const bodies = await Promise.all(responses.map(async (response) => await response.json())) as Array<{
        operation: { id: string };
      }>;
      expect(bodies[0]!.operation.id).toBe(bodies[1]!.operation.id);
      expect(latch.exitCode).toBe(AGENT_RESTART_EXIT_CODE);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalled();
    } finally { await adapter.stop(); }
  });
});
