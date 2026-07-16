import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultManagedBackgroundRuntimeDeps, ensureManagedBackgroundRuntime } from "../background-runtime.js";
import { agentAppPackageVersion } from "../package-version.js";
import { runtimeProvenanceDetail } from "../runtime-provenance.js";

const UNMANAGED_DETAIL = "Runtime provenance: dev (unmanaged).";
const INSTALLED_AT = "2026-07-16T12:34:56.000Z";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "agent-app-runtime-provenance-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface ManagedFixture {
  readonly packageRoot: string;
  readonly installRoot: string;
  readonly markerPath: string;
  readonly marker: Record<string, unknown>;
  readonly closureId: string;
  readonly dependencyPath: string;
}

async function managedFixture(name: string): Promise<ManagedFixture> {
  const packageVersion = agentAppPackageVersion();
  if (packageVersion === undefined) throw new Error("agent-app version unavailable in test");
  const sourceRoot = join(dir, name, "source");
  const homeDir = join(dir, name, "home");
  await mkdir(join(sourceRoot, "dist"), { recursive: true });
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify({
    name: "@mono-agent/agent-app",
    version: packageVersion,
    type: "module",
    bin: { "mono-agent": "./dist/cli.js" },
  }), "utf8");
  await writeFile(join(sourceRoot, "dist", "cli.js"), `import "./dependency.js";\n// ${name}\n`, "utf8");
  await writeFile(join(sourceRoot, "dist", "dependency.js"), `export const fixture = ${JSON.stringify(name)};\n`, "utf8");

  let now = Date.parse(INSTALLED_AT);
  const defaults = defaultManagedBackgroundRuntimeDeps();
  const runtime = await ensureManagedBackgroundRuntime({
    currentCliPath: join(sourceRoot, "dist", "cli.js"),
    nodePath: process.execPath,
    homeDir,
    packageVersion,
    packageSource: sourceRoot,
  }, {
    ...defaults,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    randomId: () => name,
    currentProcessIncarnation: async () => ({
      schema: "mono-agent.process-incarnation.v1",
      bootSessionId: "runtime-provenance-test",
      processStartId: name,
    }),
    isSameProcessIncarnation: () => true,
  });
  const installRoot = runtime.installRoot;
  const packageRoot = dirname(dirname(runtime.cliPath));
  const markerPath = join(installRoot, ".mono-agent-runtime.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  return {
    packageRoot,
    installRoot,
    markerPath,
    marker,
    closureId: basename(installRoot),
    dependencyPath: join(packageRoot, "dist", "dependency.js"),
  };
}

async function writeMarker(path: string, marker: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(marker), { mode: 0o600 });
  await chmod(path, 0o600);
}

describe("runtimeProvenanceDetail", () => {
  it("names the full closure and sanitized install metadata for a valid managed snapshot", async () => {
    const fixture = await managedFixture("managed");

    const detail = await runtimeProvenanceDetail(fixture.packageRoot);

    expect(detail).toBe(
      `Runtime provenance: managed closure ${fixture.closureId} (`
      + `@mono-agent/agent-app ${agentAppPackageVersion()}; ${process.platform}-${process.arch}; `
      + `Node ABI ${process.versions.modules}; installed ${INSTALLED_AT}).`,
    );
    expect(detail).not.toContain(dir);
    expect(detail).not.toContain(fixture.installRoot);
  });

  it("reports dev (unmanaged) outside the canonical managed layout", async () => {
    const packageRoot = join(dir, "workspace", "packages", "agent-app");
    await mkdir(packageRoot, { recursive: true });

    await expect(runtimeProvenanceDetail(packageRoot)).resolves.toBe(UNMANAGED_DETAIL);
  });

  it("does not claim a managed closure after a non-CLI closure file changes", async () => {
    const fixture = await managedFixture("tampered-closure");
    await writeFile(fixture.dependencyPath, "export const fixture = 'tampered';\n", "utf8");

    await expect(runtimeProvenanceDetail(fixture.packageRoot)).resolves.toBe(UNMANAGED_DETAIL);
  });

  it("fails closed without echoing malformed or untrusted marker contents", async () => {
    const malformed = await managedFixture("malformed-json");
    await writeFile(malformed.markerPath, "{\"operatorSecret\":", { mode: 0o600 });

    const wrongSchema = await managedFixture("wrong-schema");
    await writeMarker(wrongSchema.markerPath, { ...wrongSchema.marker, schema: "attacker-schema" });

    const missingCliHash = await managedFixture("missing-cli-hash");
    const { cliSha256: _removedCliHash, ...withoutCliHash } = missingCliHash.marker;
    await writeMarker(missingCliHash.markerPath, withoutCliHash);

    const missingClosureHash = await managedFixture("missing-closure-hash");
    const { sourceClosureSha256: _removedClosureHash, ...withoutClosureHash } = missingClosureHash.marker;
    await writeMarker(missingClosureHash.markerPath, withoutClosureHash);

    const mismatchedLayout = await managedFixture("mismatched-layout");
    await writeMarker(mismatchedLayout.markerPath, {
      ...mismatchedLayout.marker,
      sourceClosureSha256: "d".repeat(64),
    });

    const invalidClosureManifest = await managedFixture("invalid-closure-manifest");
    const invalidManifest = Buffer.from(JSON.stringify({ schema: "attacker-manifest", entries: [] }), "utf8");
    await writeFile(join(invalidClosureManifest.installRoot, ".mono-agent-closure.json"), invalidManifest, { mode: 0o600 });
    await writeMarker(invalidClosureManifest.markerPath, {
      ...invalidClosureManifest.marker,
      closureManifestSha256: sha256(invalidManifest),
    });

    const extraKey = await managedFixture("extra-key");
    await writeMarker(extraKey.markerPath, {
      ...extraKey.marker,
      operatorSecret: "DO-NOT-ECHO-this-marker-content",
    });

    const permissiveMarker = await managedFixture("permissive-marker");
    await chmod(permissiveMarker.markerPath, 0o644);

    const symlinkMarker = await managedFixture("symlink-marker");
    const symlinkTarget = join(dir, "untrusted-marker-target.json");
    await writeFile(symlinkTarget, "DO-NOT-ECHO-symlink-target", { mode: 0o600 });
    await unlink(symlinkMarker.markerPath);
    await symlink(symlinkTarget, symlinkMarker.markerPath);

    const permissiveRoot = await managedFixture("permissive-root");
    await chmod(permissiveRoot.installRoot, 0o755);

    for (const [name, fixture] of Object.entries({
      malformed,
      wrongSchema,
      missingCliHash,
      missingClosureHash,
      mismatchedLayout,
      invalidClosureManifest,
      extraKey,
      permissiveMarker,
      symlinkMarker,
      permissiveRoot,
    })) {
      const detail = await runtimeProvenanceDetail(fixture.packageRoot);
      expect(detail, name).toBe(UNMANAGED_DETAIL);
      expect(detail, name).not.toContain("DO-NOT-ECHO");
      expect(detail, name).not.toContain(dir);
    }
  });
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
