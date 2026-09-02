import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { migrateRetiredSearxng, parseArgs } from "../migrate-retired-searxng.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("migrate-retired-searxng", () => {
  it("atomically creates a restart-compatible operator bundle without a Docker side effect", async () => {
    const { root, repoRoot, destination } = await fixture();
    const logs = [];

    const result = migrateRetiredSearxng({ repoRoot, destination, log: (line) => logs.push(line) });

    expect(result).toEqual({
      destination,
      projectName: "mono-agent-searxng",
      volumeName: "mono-agent-searxng_cache",
    });
    const [compose, settings, env] = await Promise.all([
      readFile(join(destination, "compose.yaml"), "utf8"),
      readFile(join(destination, "settings.yml"), "utf8"),
      readFile(join(destination, ".env"), "utf8"),
    ]);
    const parsedCompose = parseYaml(compose);
    const parsedSettings = parseYaml(settings);
    expect(parsedCompose.name).toBe("mono-agent-searxng");
    expect(parsedCompose.services.searxng.ports).toEqual(["127.0.0.1:8088:8080"]);
    expect(parsedCompose.services.searxng.volumes).toContain("cache:/var/cache/searxng");
    expect(parsedSettings.search.formats).toContain("json");
    expect(env).toBe("SEARXNG_SECRET=configured-secret\n");
    expect(await readFile(join(repoRoot, "demos/searxng/.env"), "utf8")).toBe(env);
    expect((await stat(join(destination, ".env"))).mode & 0o777).toBe(0o600);
    expect(logs.at(-1)).toBe("No container was started or stopped, and no Docker volume was removed.");
    expect((await readdir(root)).filter((entry) => entry.startsWith(".operator.migrating-"))).toEqual([]);
  });

  it("fails closed before creating the destination when the legacy secret is unavailable", async () => {
    const { repoRoot, destination } = await fixture({ writeEnv: false });

    expect(() => migrateRetiredSearxng({ repoRoot, destination, log: () => {} })).toThrow(
      "Legacy SearXNG .env not found",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects placeholder secrets, in-repository destinations, and existing destinations", async () => {
    const placeholder = await fixture({
      env: "SEARXNG_SECRET=replace-with-a-random-64-character-hex-value\n",
    });
    expect(() => migrateRetiredSearxng({
      repoRoot: placeholder.repoRoot,
      destination: placeholder.destination,
      log: () => {},
    })).toThrow("does not contain a configured SEARXNG_SECRET");
    expect(existsSync(placeholder.destination)).toBe(false);

    const nested = await fixture();
    expect(() => migrateRetiredSearxng({
      repoRoot: nested.repoRoot,
      destination: join(nested.repoRoot, "operator"),
      log: () => {},
    })).toThrow("must be outside");

    await mkdir(nested.destination);
    expect(() => migrateRetiredSearxng({
      repoRoot: nested.repoRoot,
      destination: nested.destination,
      log: () => {},
    })).toThrow("already exists");
  });

  it("requires an explicit destination and accepts an explicit legacy env path", async () => {
    expect(() => parseArgs([])).toThrow("--destination is required");
    expect(parseArgs(["--destination", "/operator", "--env-file", "/secrets/searxng.env"])).toEqual({
      help: false,
      destination: "/operator",
      envFile: "/secrets/searxng.env",
    });
  });
});

async function fixture({ env = "SEARXNG_SECRET=configured-secret\n", writeEnv = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-searxng-migration-"));
  tempDirs.push(root);
  const repoRoot = join(root, "repo");
  const envFile = join(repoRoot, "demos/searxng/.env");
  await mkdir(dirname(envFile), { recursive: true });
  if (writeEnv) await writeFile(envFile, env, { mode: 0o600 });
  return { root, repoRoot, destination: join(root, "operator") };
}
