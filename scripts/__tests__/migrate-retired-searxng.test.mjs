import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
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
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { migrateRetiredSearxng, parseArgs } from "../migrate-retired-searxng.mjs";

const tempDirs = [];
const VALID_SECRET = "a".repeat(64);
const MIGRATION_SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrate-retired-searxng.mjs",
);
const MIGRATION_MODULE_URL = pathToFileURL(MIGRATION_SCRIPT_PATH).href;

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
    let cleanupError;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination,
        log: () => {},
        beforePublish: () => {
          renameSync(outsideParent, movedParent);
          symlinkSync(movedParent, outsideParent, "dir");
        },
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toMatchObject({
      name: "RetiredSearxngUnpublishedStagingCleanupError",
      code: "SEARXNG_UNPUBLISHED_STAGING_CLEANUP_FAILED",
      published: false,
      destination,
      stagingPath: expect.stringContaining(".operator.migrating-"),
      stagingState: "indeterminate",
    });
    expect(cleanupError.message).toContain("post-error staging state is indeterminate");
    expect(cleanupError.message).toContain("Do not assume the path is absent, unchanged, or protected");
    expect(cleanupError.operationCause.message)
      .toContain("Destination parent changed after validation");
    expect(cleanupError.cleanupCause.message)
      .toContain("Destination parent changed after validation");

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

  it("does not report success when cleanup removes the concurrently completed destination", async () => {
    const migration = await fixture();
    const logs = [];
    let migrationError;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: (line) => logs.push(line),
        beforeAtomicPublish: () => {
          publishConcurrentBundle(migration);
        },
        removeStaging: (stagingPath, options) => {
          rmSync(migration.destination, { recursive: true, force: true });
          rmSync(stagingPath, options);
        },
      });
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({
      name: "RetiredSearxngDestinationRevalidationError",
      code: "SEARXNG_DESTINATION_REVALIDATION_FAILED",
      published: false,
      destination: migration.destination,
      destinationState: "indeterminate",
      stagingState: "removed",
    });
    expect(migrationError.message).toContain("no valid published destination is claimed");
    expect(migrationError.destinationCause.message).toContain("changed identity");
    expect(logs).toEqual([]);
    expect(existsSync(migration.destination)).toBe(false);
    expect(existsSync(migrationError.stagingPath)).toBe(false);
  });

  it("rejects an exact-content destination whose identity changes during cleanup", async () => {
    const migration = await fixture();
    const movedWinner = `${migration.destination}.moved-winner`;
    let migrationError;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: () => {},
        beforeAtomicPublish: () => {
          publishConcurrentBundle(migration);
        },
        removeStaging: (stagingPath, options) => {
          renameSync(migration.destination, movedWinner);
          publishConcurrentBundle(migration);
          rmSync(stagingPath, options);
        },
      });
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({
      code: "SEARXNG_DESTINATION_REVALIDATION_FAILED",
      published: false,
      destinationState: "indeterminate",
      stagingState: "removed",
    });
    expect(migrationError.destinationCause.message).toContain("changed identity");
    expect((await readdir(migration.destination)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
    expect((await readdir(movedWinner)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
  });

  it("reports published true when pre-rename concurrent-winner cleanup fails", async () => {
    const migration = await fixture();
    const logs = [];
    const cleanupCause = new Error("injected private staging cleanup failure");
    cleanupCause.code = "EIO";
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
          throw cleanupCause;
        },
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toMatchObject({
      name: "RetiredSearxngStagingCleanupError",
      code: "SEARXNG_STAGING_CLEANUP_FAILED",
      published: true,
      destination: migration.destination,
      stagingPath: expect.stringContaining(".operator.migrating-"),
      stagingState: "retained",
      cleanupCause,
      cause: cleanupCause,
    });
    expect(cleanupError.message).toContain("valid SearXNG bundle is published");
    expect(cleanupError.message).toContain("same staging directory was observed");
    expect(cleanupError.message).toContain("expected owner and mode 0700");
    expect(cleanupError.message).toContain("contents may be partial or changed");
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

  it("reports published true when lost-rename-race cleanup fails", async () => {
    const migration = await fixture();
    const logs = [];
    const cleanupCause = new Error("injected private staging cleanup failure");
    cleanupCause.code = "EIO";
    const renameCause = new Error("injected lost atomic rename race");
    renameCause.code = "EEXIST";
    let concurrentResult;
    let cleanupError;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: (line) => logs.push(line),
        renameStaging: () => {
          concurrentResult = publishConcurrentBundle(migration);
          throw renameCause;
        },
        removeStaging: () => {
          throw cleanupCause;
        },
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toMatchObject({
      name: "RetiredSearxngStagingCleanupError",
      code: "SEARXNG_STAGING_CLEANUP_FAILED",
      published: true,
      destination: migration.destination,
      stagingPath: expect.stringContaining(".operator.migrating-"),
      stagingState: "retained",
      cleanupCause,
      cause: cleanupCause,
    });
    expect(cleanupError.message).toContain("valid SearXNG bundle is published");
    expect(logs).toEqual([]);
    expect(concurrentResult.destination).toBe(migration.destination);
    expect((await readdir(migration.destination)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
    expect(await readFile(join(migration.destination, ".env"), "utf8"))
      .toBe(`SEARXNG_SECRET=${VALID_SECRET}\n`);
    expect(existsSync(cleanupError.stagingPath)).toBe(true);
    expect((await stat(cleanupError.stagingPath)).mode & 0o777).toBe(0o700);
  });

  it("reports a remove-then-throw anomaly without claiming staging was retained", async () => {
    const migration = await fixture();
    const cleanupCause = new Error("injected error after private staging removal");
    cleanupCause.code = "EIO";
    let concurrentResult;
    let cleanupError;
    let removedPath;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: () => {},
        beforeAtomicPublish: () => {
          concurrentResult = publishConcurrentBundle(migration);
        },
        removeStaging: (stagingPath, options) => {
          removedPath = stagingPath;
          rmSync(stagingPath, options);
          throw cleanupCause;
        },
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toMatchObject({
      name: "RetiredSearxngStagingCleanupError",
      code: "SEARXNG_STAGING_CLEANUP_FAILED",
      published: true,
      destination: migration.destination,
      stagingPath: removedPath,
      stagingState: "removed",
      cleanupCause,
      cause: cleanupCause,
    });
    expect(cleanupError.message).toContain("staging path was confirmed absent");
    expect(cleanupError.message).toContain("No retained staging directory is claimed");
    expect(cleanupError.message).not.toContain("protected staging path");
    expect(existsSync(cleanupError.stagingPath)).toBe(false);
    expect(concurrentResult.destination).toBe(migration.destination);
    expect((await readdir(migration.destination)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
  });

  it("reports indeterminate when the canonical parent is swapped during staging removal", async () => {
    const migration = await fixture();
    const operatorParent = join(migration.root, "operator-parent");
    const movedParent = join(migration.root, "moved-operator-parent");
    await mkdir(operatorParent, { mode: 0o700 });
    migration.destination = join(operatorParent, "operator");
    const cleanupCause = new Error("injected parent swap during private staging cleanup");
    cleanupCause.code = "EIO";
    let racedStaging;
    let migrationError;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: () => {},
        beforeAtomicPublish: () => {
          publishConcurrentBundle(migration);
        },
        removeStaging: (stagingPath) => {
          racedStaging = stagingPath;
          renameSync(operatorParent, movedParent);
          mkdirSync(operatorParent, { mode: 0o700 });
          throw cleanupCause;
        },
      });
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({
      code: "SEARXNG_DESTINATION_REVALIDATION_FAILED",
      published: false,
      destinationState: "indeterminate",
      stagingState: "indeterminate",
      cleanupCause,
      inspectionCause: expect.any(Error),
    });
    expect(migrationError.message).toContain("post-error staging state is indeterminate");
    expect(migrationError.message).toContain(
      "Do not assume the path is absent, unchanged, or protected",
    );
    expect(existsSync(racedStaging)).toBe(false);
    const movedStaging = join(movedParent, basename(racedStaging));
    expect(await readFile(join(movedStaging, ".env"), "utf8"))
      .toBe(`SEARXNG_SECRET=${VALID_SECRET}\n`);
  });

  it("classifies a partially removed same private directory as retained", async () => {
    const migration = await fixture();
    const cleanupCause = new Error("injected error after partial private staging removal");
    cleanupCause.code = "EIO";
    let cleanupError;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: () => {},
        beforeAtomicPublish: () => {
          publishConcurrentBundle(migration);
        },
        removeStaging: (stagingPath) => {
          unlinkSync(join(stagingPath, "compose.yaml"));
          throw cleanupCause;
        },
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toMatchObject({
      code: "SEARXNG_STAGING_CLEANUP_FAILED",
      published: true,
      stagingState: "retained",
      cleanupCause,
    });
    expect(cleanupError.message).toContain("contents may be partial or changed");
    expect((await readdir(cleanupError.stagingPath)).sort()).toEqual([".env", "settings.yml"]);
    expect((await stat(cleanupError.stagingPath)).mode & 0o777).toBe(0o700);
    expect((await readdir(migration.destination)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
  });

  it("classifies a changed non-private staging directory as indeterminate", async () => {
    const migration = await fixture();
    const cleanupCause = new Error("injected error after staging mode changed");
    cleanupCause.code = "EIO";
    let cleanupError;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: () => {},
        beforeAtomicPublish: () => {
          publishConcurrentBundle(migration);
        },
        removeStaging: (stagingPath) => {
          chmodSync(stagingPath, 0o755);
          throw cleanupCause;
        },
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toMatchObject({
      code: "SEARXNG_STAGING_CLEANUP_FAILED",
      published: true,
      stagingState: "indeterminate",
      cleanupCause,
    });
    expect(cleanupError.message).toContain("post-error staging state is indeterminate");
    expect(cleanupError.message).toContain("Do not assume the path is absent, unchanged, or protected");
    expect((await stat(cleanupError.stagingPath)).mode & 0o777).toBe(0o755);
    expect((await readdir(migration.destination)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
  });

  it("preserves both causes when unpublished staging cleanup fails", async () => {
    const migration = await fixture();
    const logs = [];
    const operationCause = new Error("injected pre-publication operation failure");
    operationCause.code = "EOPERATION";
    const cleanupCause = new Error("injected private staging cleanup failure");
    cleanupCause.code = "EIO";
    let retainedError;
    let cleanupPath;

    try {
      migrateRetiredSearxng({
        repoRoot: migration.repoRoot,
        destination: migration.destination,
        log: (line) => logs.push(line),
        beforeAtomicPublish: () => {
          throw operationCause;
        },
        removeStaging: (stagingPath) => {
          cleanupPath = stagingPath;
          throw cleanupCause;
        },
      });
    } catch (error) {
      retainedError = error;
    }

    expect(retainedError).toMatchObject({
      name: "RetiredSearxngUnpublishedStagingCleanupError",
      code: "SEARXNG_UNPUBLISHED_STAGING_CLEANUP_FAILED",
      published: false,
      destination: migration.destination,
      stagingPath: expect.stringContaining(".operator.migrating-"),
      stagingState: "retained",
      operationCause,
      cleanupCause,
      cause: operationCause,
      errors: [operationCause, cleanupCause],
    });
    expect(retainedError.message).toContain("did not publish a bundle");
    expect(retainedError.message).toContain("same staging directory was observed");
    expect(retainedError.message).toContain("expected owner and mode 0700");
    expect(retainedError.message).toContain("contents may be partial or changed");
    expect(cleanupPath).toBe(retainedError.stagingPath);
    expect(logs).toEqual([]);
    expect(existsSync(migration.destination)).toBe(false);
    expect(existsSync(retainedError.stagingPath)).toBe(true);
    expect((await readdir(retainedError.stagingPath)).sort())
      .toEqual([".env", "compose.yaml", "settings.yml"]);
    expect((await stat(retainedError.stagingPath)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(retainedError.stagingPath, ".env"), "utf8"))
      .toBe(`SEARXNG_SECRET=${VALID_SECRET}\n`);
    expect((await stat(join(retainedError.stagingPath, ".env"))).mode & 0o777)
      .toBe(0o600);
  });

  it("prints bounded redacted operation and cleanup causes through the real CLI", async () => {
    const migration = await fixture();
    const envFile = join(migration.repoRoot, "demos/searxng/.env");
    const childSource = [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      "const [scriptPath, destination, envFile] = process.argv.slice(1);",
      'fs.renameSync = () => {',
      '  const error = new Error(`injected atomic rename failure ${"a".repeat(64)} ${"x".repeat(300)}`);',
      '  error.code = "EACCES";',
      '  throw error;',
      '};',
      'fs.rmSync = () => {',
      '  const error = new Error(`injected cleanup failure SEARXNG_SECRET=${"a".repeat(64)}`);',
      '  error.code = "EIO";',
      '  throw error;',
      '};',
      "syncBuiltinESMExports();",
      "process.argv = [process.execPath, scriptPath, '--destination', destination, '--env-file', envFile];",
      "await import(pathToFileURL(scriptPath).href);",
    ].join("\n");

    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      childSource,
      MIGRATION_SCRIPT_PATH,
      migration.destination,
      envFile,
    ], { encoding: "utf8" });

    expect(child.status).toBe(1);
    expect(child.signal).toBeNull();
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("[SEARXNG_UNPUBLISHED_STAGING_CLEANUP_FAILED]");
    const operationLine = child.stderr.split("\n").find((line) => line.startsWith("Operation cause:"));
    expect(operationLine).toContain(
      "Operation cause: Error (EACCES): injected atomic rename failure [redacted-64-hex]",
    );
    expect(operationLine.endsWith("…")).toBe(true);
    expect(operationLine.length).toBeLessThanOrEqual(240);
    expect(child.stderr).toContain(
      "Cleanup cause: Error (EIO): injected cleanup failure SEARXNG_SECRET=[redacted]",
    );
    expect(child.stderr).not.toContain(VALID_SECRET);
    expect(existsSync(migration.destination)).toBe(false);
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

function publishConcurrentBundle(migration) {
  return migrateRetiredSearxng({
    repoRoot: migration.repoRoot,
    destination: migration.destination,
    log: () => {},
  });
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
