import { afterEach, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ mutation: vi.fn(), config: vi.fn(), dotenv: vi.fn() }));
vi.mock("../cli/commands/memory-command.js", () => {
  loaded.mutation();
  throw new Error("mutation dispatcher must not load for early refusal");
});
vi.mock("../composition/app-config.js", async (original) => ({
  ...await original<typeof import("../composition/app-config.js")>(),
  loadAppCoreConfig: loaded.config,
}));
vi.mock("../cli/cli-args.js", async (original) => ({
  ...await original<typeof import("../cli/cli-args.js")>(),
  loadCliEnvFile: loaded.dotenv,
}));

import { runCli } from "../cli.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([
  ["adopt-replay", ["--unknown-memory-flag"], "replay_adoption_usage", undefined],
  ["adopt-replay", ["--limit", "2"], "replay_adoption_usage", undefined],
  ["forget", ["apply", "--unknown-memory-flag"], "forget_usage", "forget-apply"],
  ["forget", ["apply", "--limit", "2"], "forget_usage", "forget-apply"],
] as const)("refuses %s %j before dotenv/config or mutation loading", async (command, args, code, operation) => {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
  expect(await runCli(["memory", command, ...args, "--json"])).toBe(2);
  const message = command === "adopt-replay"
    ? "Usage: mono-agent memory adopt-replay [--json] [--config <path>] [--env-file <path>]."
    : "Memory forget arguments are invalid.";
  const result = command === "adopt-replay"
    ? { schemaVersion: 1, operation: "adopt-replay", status: "failed", code, message }
    : { schemaVersion: 1, operation, status: "failed", code, message };
  expect(stdout).toBe(`${JSON.stringify(result, null, 2)}\n`);
  expect(stderr).toBe("");
  expect(loaded.mutation).not.toHaveBeenCalled();
  expect(loaded.config).not.toHaveBeenCalled();
  expect(loaded.dotenv).not.toHaveBeenCalled();
});
