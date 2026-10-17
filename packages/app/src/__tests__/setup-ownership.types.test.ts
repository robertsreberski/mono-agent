import { expect, it } from "vitest";

import type { runInit } from "../cli-init-command.js";
import type { runProviderSetupBeforeInit } from "../setup/provider-setup-gate.js";
import type { initChangeDisplayRows, secretChecklistDisplayRows } from "../setup/render.js";
import type { RunInitEnvironmentContext } from "../setup/types.js";

function setupTypes(
  environment: RunInitEnvironmentContext,
  options: Parameters<typeof runProviderSetupBeforeInit>[0],
  changes: ReturnType<typeof initChangeDisplayRows>,
  checklist: ReturnType<typeof secretChecklistDisplayRows>,
): void {
  const originalEnvironment: Parameters<typeof runInit>[1] = environment;
  void originalEnvironment;
  // @ts-expect-error the environment context remains readonly
  environment.dotenvPath = "another.env";
  // @ts-expect-error the environment map remains readonly
  environment.shellEnv.FIXTURE = "changed";
  // @ts-expect-error optional paths cannot be explicitly undefined
  const invalid: typeof options = { modelRefs: [], cwd: ".", auth: false, dryRun: false, piAuthPath: undefined };
  void invalid;
  // @ts-expect-error provider model references remain readonly
  options.modelRefs.push("fixture:model");
  // @ts-expect-error display rows remain readonly
  changes.push({ label: "created", path: ".", unchanged: false });
  // @ts-expect-error checklist states remain a closed union
  const status: (typeof checklist)[number]["status"] = "verified";
  void status;
}
void setupTypes;

it("keeps setup contracts available to compile-time consumers", () => {
  expect(true).toBe(true);
});
