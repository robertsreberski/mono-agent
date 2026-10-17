import { expect, it } from "vitest";

import type { BackgroundDeps, BackgroundLaunchResult, InstanceTarget } from "../service/background/types.js";
import type { RunWebCommandDeps, RunWebCommandOptions, TailscaleServeResult } from "../service/web/types.js";

function assertServiceContracts(
  target: InstanceTarget,
  background: BackgroundDeps,
  launch: BackgroundLaunchResult,
  web: RunWebCommandDeps,
  options: RunWebCommandOptions,
  route: TailscaleServeResult,
): void {
  // @ts-expect-error Target identity remains readonly.
  target.configPath = "replacement";
  // @ts-expect-error Operational environment entries remain readonly.
  target.environment.PATH = "replacement";
  // @ts-expect-error Exact optional properties cannot be explicitly undefined.
  const invalid: RunWebCommandDeps = { healthcheck: undefined };
  // @ts-expect-error Dependency ports remain readonly.
  background.runner = async () => ({ code: 0, stdout: "", stderr: "" });
  // @ts-expect-error Web dependency ports remain readonly.
  web.platform = "linux";
  // @ts-expect-error CLI positionals remain a readonly array.
  options.positionals.push("start");
  if (!launch.ok) {
    // @ts-expect-error The launch failure reason union stays closed.
    launch.reason = "unexpected";
  }
  if (route.kind === "unavailable") {
    // @ts-expect-error Cleanup outcomes stay readonly and closed.
    route.routeOutcome = "success";
  }
  void invalid;
}

it("retains readonly, exact optional and closed result contracts", () => {
  expect(typeof assertServiceContracts).toBe("function");
});
