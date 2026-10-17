import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { parseCliArgs } from "../cli-args.js";
import { effectiveFirstRunEnvironment } from "../first-run-readiness.js";
import { runFlagsInit } from "../setup/flags-init.js";
import { createMonoAgentConfigExclusively } from "../setup/scaffold-files.js";
import { runProviderSetupBeforeInit } from "../setup/provider-setup-gate.js";

const publication = vi.hoisted(() => ({ target: "", contents: "", writes: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (publication.target && String(args[0]).endsWith(".tmp")) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          // The competing writer commits after staging, but before publication.
          // This barrier runs for both link and a copyFile mutant.
          await fs.writeFile(publication.target, publication.contents, { flag: "wx", mode: 0o600 });
          publication.writes += 1;
        };
      }
      return handle;
    },
  };
});
vi.mock("../setup/provider-setup-gate.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../setup/provider-setup-gate.js")>(),
  runProviderSetupBeforeInit: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  publication.target = "";
  publication.contents = "";
  publication.writes = 0;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("runs flags provider setup in the exact environment and restores it on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-flags-guarantee-"));
  roots.push(root);
  vi.stubEnv("MONO_AGENT_GUARANTEE_AMBIENT", "not-persisted");
  const original = { ...process.env };
  const shellEnv = { PATH: "/usr/bin:/bin" };
  const dotenvEnv = { MONO_AGENT_GUARANTEE_PERSISTED: "fixture-value" };
  const piAuthPath = join(root, ".pi", "agent", "auth.json");
  const failure = new Error("controlled setup failure");
  let observed: Record<string, string | undefined> | undefined;
  vi.mocked(runProviderSetupBeforeInit).mockImplementation(async () => {
    observed = { ...process.env };
    process.env.MONO_AGENT_GUARANTEE_LEAK = "must-be-restored";
    throw failure;
  });
  await expect(runFlagsInit(parseCliArgs(["init", "--model", "pi:ollama:fixture"]), {
    shellEnv: { ...shellEnv, MONO_AGENT_PI_AUTH_PATH: piAuthPath }, dotenvEnv, dotenvPath: join(root, ".env"),
  }, root)).rejects.toBe(failure);
  expect(observed).toEqual(effectiveFirstRunEnvironment({
    shellEnv: { ...shellEnv, MONO_AGENT_PI_AUTH_PATH: piAuthPath }, dotenvEnv, resolvedPiAuthPath: piAuthPath,
  }));
  expect(process.env).toEqual(original);
  expect(await readdir(root)).toEqual([]);
});

it("preserves a concurrent config writer at the no-clobber publication boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-scaffold-guarantee-"));
  roots.push(root);
  const path = join(root, "mono-agent.config.json");
  publication.target = path;
  publication.contents = "{\"name\":\"concurrent fixture\"}\n";
  await expect(createMonoAgentConfigExclusively(path, {})).rejects.toMatchObject({ code: "EEXIST" });
  expect(publication.writes).toBe(1);
  expect(await readFile(path, "utf8")).toBe(publication.contents);
  expect(await readdir(root)).toEqual(["mono-agent.config.json"]);
});
