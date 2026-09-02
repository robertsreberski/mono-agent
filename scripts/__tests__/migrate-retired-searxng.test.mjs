import {
  existsSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { migrateRetiredSearxng, parseArgs } from "../migrate-retired-searxng.mjs";

const tempDirs = [];
const VALID_SECRET = "a".repeat(64);
const MIGRATION_MODULE_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../migrate-retired-searxng.mjs"),
).href;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("migrate-retired-searxng", () => {
  it("safely publishes a restart-compatible operator bundle without a Docker side effect", async () => {
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
    expect(env).toBe(`SEARXNG_SECRET=${VALID_SECRET}\n`);
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

  it("fails before staging when POSIX ownership proof is unavailable", async () => {
    const migration = await fixture();
    const unsupportedParent = join(migration.root, "unsupported-parent");

    expect(() => migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: join(unsupportedParent, "operator"),
      log: () => {},
      getCurrentUid: null,
    })).toThrow("requires POSIX ownership and mode checks; unsupported platform");

    expect(existsSync(unsupportedParent)).toBe(false);
    expect(await readdir(migration.root)).toEqual(["repo"]);
  });

  it("rejects placeholder secrets, in-repository destinations, and existing destinations", async () => {
    const placeholder = await fixture({
      env: "SEARXNG_SECRET=replace-with-a-random-64-character-hex-value\n",
    });
    expect(() => migrateRetiredSearxng({
      repoRoot: placeholder.repoRoot,
      destination: placeholder.destination,
      log: () => {},
    })).toThrow("exactly one 64-hex SEARXNG_SECRET");
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

  it("rejects a destination whose existing symlink parent resolves into the repository", async () => {
    const migration = await fixture();
    const target = join(migration.repoRoot, "operator-target");
    const linkedParent = join(migration.root, "operator-link");
    await mkdir(target);
    await symlink(target, linkedParent, "dir");
    const destination = join(linkedParent, "bundle");

    expect(() => migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination,
      log: () => {},
    })).toThrow("must be outside");
    expect(existsSync(join(target, "bundle"))).toBe(false);
  });

  it("rejects a group/world-writable canonical destination parent", async () => {
    const migration = await fixture();
    const unsafeParent = join(migration.root, "unsafe-parent");
    await mkdir(unsafeParent);
    await chmod(unsafeParent, 0o777);

    expect(() => migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: join(unsafeParent, "operator"),
      log: () => {},
    })).toThrow("must not be group- or world-writable");
    expect(await readdir(unsafeParent)).toEqual([]);
  });

  it("publishes only the validated secret so Compose control variables cannot fork the project", async () => {
    const migration = await fixture({
      env: [
        `SEARXNG_SECRET=${VALID_SECRET}`,
        "COMPOSE_PROJECT_NAME=parallel-project",
        "COMPOSE_FILE=parallel.yaml",
        "UNRELATED=value",
        "",
      ].join("\n"),
    });

    migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: migration.destination,
      log: () => {},
    });

    expect(await readFile(join(migration.destination, ".env"), "utf8")).toBe(
      `SEARXNG_SECRET=${VALID_SECRET}\n`,
    );
    expect(parseYaml(await readFile(join(migration.destination, "compose.yaml"), "utf8")).name)
      .toBe("mono-agent-searxng");
  });

  it("does not replace a destination claimed between staging and publication", async () => {
    const migration = await fixture();

    expect(() => migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: migration.destination,
      log: () => {},
      beforePublish: () => {
        mkdirSync(migration.destination, { mode: 0o700 });
        writeFileSync(join(migration.destination, "claimant.txt"), "owned by claimant");
      },
    })).toThrow("Destination already exists");

    expect(await readFile(join(migration.destination, "claimant.txt"), "utf8"))
      .toBe("owned by claimant");
    expect((await readdir(migration.root)).filter((entry) => entry.startsWith(".operator.migrating-")))
      .toEqual([]);
  });

  it("fails closed when an already validated parent is moved and replaced by a symlink", async () => {
    const migration = await fixture();
    const outsideParent = join(migration.root, "outside-parent");
    const movedParent = join(migration.repoRoot, "moved-outside-parent");
    const destination = join(outsideParent, "operator");
    await mkdir(outsideParent);

    expect(() => migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination,
      log: () => {},
      beforePublish: () => {
        renameSync(outsideParent, movedParent);
        symlinkSync(movedParent, outsideParent, "dir");
      },
    })).toThrow("Destination parent changed after validation");

    expect(existsSync(join(movedParent, "operator"))).toBe(false);
    const movedEntries = await readdir(movedParent);
    const movedStaging = movedEntries.find((entry) => entry.includes(".migrating-"));
    expect(movedStaging).toBeDefined();
    expect(await readdir(join(movedParent, movedStaging))).toEqual([]);
  });

  it("rejects a lexical parent symlink retargeted into the repository without leaving a secret", async () => {
    const migration = await fixture();
    const externalParent = join(migration.root, "external-operator-parent");
    const repositoryTarget = join(migration.repoRoot, "retargeted-operator-parent");
    const linkedParent = join(migration.root, "operator-parent-link");
    await mkdir(externalParent);
    await mkdir(repositoryTarget);
    await symlink(externalParent, linkedParent, "dir");

    expect(() => migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: join(linkedParent, "operator"),
      log: () => {},
      beforePublish: () => {
        unlinkSync(linkedParent);
        symlinkSync(repositoryTarget, linkedParent, "dir");
      },
    })).toThrow("Destination path changed or resolves inside");

    expect(existsSync(join(repositoryTarget, "operator"))).toBe(false);
    expect(await readdir(repositoryTarget)).toEqual([]);
    expect(await readdir(externalParent)).toEqual([]);
  });

  it("does not follow a destination symlink raced before atomic publication", async () => {
    const migration = await fixture();
    const target = join(migration.repoRoot, "raced-destination-target");
    await mkdir(target);
    await writeFile(join(target, "sentinel"), "external target\n");

    expect(() => migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: migration.destination,
      log: () => {},
      beforeAtomicPublish: () => {
        mkdirSync(migration.destination, { mode: 0o700 });
        renameSync(migration.destination, `${migration.destination}.claimant`);
        symlinkSync(target, migration.destination, "dir");
      },
    })).toThrow("Destination path changed or resolves inside");

    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("external target\n");
    expect(existsSync(join(target, "compose.yaml"))).toBe(false);
    expect(existsSync(`${migration.destination}.claimant`)).toBe(true);
  });

  it("retries after process interruption before atomic publication without exposing a partial destination", async () => {
    const migration = await fixture();
    const childSource = [
      `import { migrateRetiredSearxng } from ${JSON.stringify(MIGRATION_MODULE_URL)};`,
      "const gate = new Int32Array(new SharedArrayBuffer(4));",
      "migrateRetiredSearxng({",
      "  repoRoot: process.argv[1],",
      "  destination: process.argv[2],",
      "  log: () => {},",
      "  beforeAtomicPublish: () => {",
      "    process.stdout.write('STAGING_READY\\n');",
      "    Atomics.wait(gate, 0, 0);",
      "  },",
      "});",
    ].join("\n");
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      childSource,
      migration.repoRoot,
      migration.destination,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForOutput(child, "STAGING_READY");
    expect(existsSync(migration.destination)).toBe(false);
    const exit = once(child, "exit");
    expect(child.kill("SIGKILL")).toBe(true);
    const [, signal] = await exit;
    expect(signal).toBe("SIGKILL");
    expect(existsSync(migration.destination)).toBe(false);

    const result = migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: migration.destination,
      log: () => {},
    });

    expect(result.destination).toBe(migration.destination);
    expect(await readFile(join(migration.destination, ".env"), "utf8"))
      .toBe(`SEARXNG_SECRET=${VALID_SECRET}\n`);
    const orphanedStaging = (await readdir(migration.root)).filter((entry) =>
      entry.includes(".migrating-"));
    expect(orphanedStaging).toHaveLength(1);
    expect((await stat(join(migration.root, orphanedStaging[0], ".env"))).mode & 0o777)
      .toBe(0o600);
  });

  it("idempotently accepts the complete bundle after interruption immediately following atomic publication", async () => {
    const migration = await fixture();
    const childSource = [
      `import { migrateRetiredSearxng } from ${JSON.stringify(MIGRATION_MODULE_URL)};`,
      "const gate = new Int32Array(new SharedArrayBuffer(4));",
      "migrateRetiredSearxng({",
      "  repoRoot: process.argv[1],",
      "  destination: process.argv[2],",
      "  log: () => {},",
      "  afterAtomicPublish: () => {",
      "    process.stdout.write('PUBLISH_READY\\n');",
      "    Atomics.wait(gate, 0, 0);",
      "  },",
      "});",
    ].join("\n");
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      childSource,
      migration.repoRoot,
      migration.destination,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForOutput(child, "PUBLISH_READY");
    const exit = once(child, "exit");
    expect(child.kill("SIGKILL")).toBe(true);
    const [, signal] = await exit;
    expect(signal).toBe("SIGKILL");

    expect((await readdir(migration.destination)).sort()).toEqual([
      ".env",
      "compose.yaml",
      "settings.yml",
    ]);
    const result = migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: migration.destination,
      log: () => {},
    });

    expect(result.destination).toBe(migration.destination);
    expect(await readFile(join(migration.destination, ".env"), "utf8"))
      .toBe(`SEARXNG_SECRET=${VALID_SECRET}\n`);
    expect((await readdir(migration.root)).some((entry) => entry.includes(".migrating-"))).toBe(false);
  });

  it("converges when a normal concurrent invocation publishes the same complete bundle", async () => {
    const migration = await fixture();
    let concurrentResult;

    const result = migrateRetiredSearxng({
      repoRoot: migration.repoRoot,
      destination: migration.destination,
      log: () => {},
      beforeAtomicPublish: () => {
        concurrentResult = migrateRetiredSearxng({
          repoRoot: migration.repoRoot,
          destination: migration.destination,
          log: () => {},
        });
      },
    });

    expect(result.destination).toBe(migration.destination);
    expect(concurrentResult.destination).toBe(migration.destination);
    expect((await readdir(migration.destination)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
    expect((await readdir(migration.root)).some((entry) => entry.includes(".migrating-"))).toBe(false);
  });

  it("fails explicitly and retains protected staging when concurrent-winner cleanup fails", async () => {
    const migration = await fixture();
    const logs = [];
    let concurrentResult;
    let cleanupError;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: (line) => logs.push(line),
        beforeAtomicPublish: () => {
          concurrentResult = migrateRetiredSearxng({
            repoRoot: migration.repoRoot,
            destination: migration.destination,
            log: () => {},
          });
        },
        removeStaging: () => {
          const error = new Error("injected private staging cleanup failure");
          error.code = "EIO";
          throw error;
        },
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toMatchObject({
      name: "RetiredSearxngStagingCleanupError",
      code: "SEARXNG_STAGING_CLEANUP_FAILED",
      destination: migration.destination,
      stagingPath: expect.stringContaining(".operator.migrating-"),
    });
    expect(cleanupError.message).toContain("valid SearXNG bundle is published");
    expect(cleanupError.message).toContain(cleanupError.stagingPath);
    expect(logs).toEqual([]);
    expect(concurrentResult.destination).toBe(migration.destination);
    expect((await readdir(migration.destination)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
    expect(await readFile(join(migration.destination, ".env"), "utf8"))
      .toBe(`SEARXNG_SECRET=${VALID_SECRET}\n`);
    expect(existsSync(cleanupError.stagingPath)).toBe(true);
    expect((await stat(cleanupError.stagingPath)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(cleanupError.stagingPath, ".env"), "utf8"))
      .toBe(`SEARXNG_SECRET=${VALID_SECRET}\n`);
    expect((await stat(join(cleanupError.stagingPath, ".env"))).mode & 0o777)
      .toBe(0o600);
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

async function fixture({ env = `SEARXNG_SECRET=${VALID_SECRET}\n`, writeEnv = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-searxng-migration-"));
  tempDirs.push(root);
  const repoRoot = join(root, "repo");
  const envFile = join(repoRoot, "demos/searxng/.env");
  await mkdir(dirname(envFile), { recursive: true });
  if (writeEnv) await writeFile(envFile, env, { mode: 0o600 });
  return { root, repoRoot, destination: join(root, "operator") };
}

async function waitForOutput(child, expected) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for child output ${expected}; stderr: ${stderr}`));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Migration child exited early (${code ?? signal}): ${stderr}`));
    });
  });
}
