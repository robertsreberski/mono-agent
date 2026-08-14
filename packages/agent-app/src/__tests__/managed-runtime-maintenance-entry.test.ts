import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { encodeManagedRuntimeLaunchProof } from "../managed-runtime-launch-proof.js";
import { verifyManagedRuntimeMaintenanceEntrypoint } from "../managed-runtime-maintenance-entry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("managed runtime maintenance entry attestation", () => {
  it("binds the canonical owner-private helper bytes to the shared launch proof", async () => {
    const fixture = await runtimeFixture();
    await expect(verifyManagedRuntimeMaintenanceEntrypoint({
      currentEntrypointPath: fixture.entryPath,
      launchProof: fixture.launchProof,
      homeDir: fixture.home,
    })).resolves.toBeUndefined();

    await writeFile(fixture.entryPath, "export const tampered = true;\n", "utf8");
    await expect(verifyManagedRuntimeMaintenanceEntrypoint({
      currentEntrypointPath: fixture.entryPath,
      launchProof: fixture.launchProof,
      homeDir: fixture.home,
    })).rejects.toThrow(/does not match its managed runtime launch proof/u);
  });

  it.each(["cli", "manifest"] as const)(
    "rejects a tampered sibling %s before the heavy graph loads",
    async (target) => {
      const fixture = await runtimeFixture();
      await writeFile(
        target === "cli" ? fixture.cliPath : fixture.manifestPath,
        target === "cli" ? "#!/usr/bin/env node\nthrow new Error('tampered');\n" : '{"tampered":true}\n',
        "utf8",
      );
      await expect(verifyManagedRuntimeMaintenanceEntrypoint({
        currentEntrypointPath: fixture.entryPath,
        launchProof: fixture.launchProof,
        homeDir: fixture.home,
      })).rejects.toThrow(/closure fingerprints do not match/u);
    },
  );

  it("rejects a valid-looking helper outside the canonical runtime layout", async () => {
    const fixture = await runtimeFixture();
    const outside = join(fixture.home, "outside", "dist", "launchd-maintenance-entry.js");
    await mkdir(join(fixture.home, "outside", "dist"), { recursive: true });
    await writeFile(outside, fixture.entryBytes);
    await expect(verifyManagedRuntimeMaintenanceEntrypoint({
      currentEntrypointPath: outside,
      launchProof: fixture.launchProof,
      homeDir: fixture.home,
    })).rejects.toThrow(/outside its canonical managed runtime closure/u);
  });

  it("rejects a canonical-looking closure path that disagrees with the pinned marker identity", async () => {
    const fixture = await runtimeFixture();
    const movedRoot = join(fixture.versionAbiDir, `${"c".repeat(64)}-${"d".repeat(64)}`);
    await rename(fixture.installRoot, movedRoot);
    const movedEntry = join(
      movedRoot,
      "node_modules",
      "@mono-agent",
      "agent-app",
      "dist",
      "launchd-maintenance-entry.js",
    );
    await expect(verifyManagedRuntimeMaintenanceEntrypoint({
      currentEntrypointPath: movedEntry,
      launchProof: fixture.launchProof,
      homeDir: fixture.home,
    })).rejects.toThrow(/does not match its marker's canonical runtime identity/u);
  });
});

async function runtimeFixture(): Promise<{
  readonly home: string;
  readonly entryPath: string;
  readonly entryBytes: string;
  readonly cliPath: string;
  readonly manifestPath: string;
  readonly versionAbiDir: string;
  readonly installRoot: string;
  readonly launchProof: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "mono-agent-maintenance-attestation-"));
  roots.push(home);
  const version = "1.2.3";
  const platformAbi = "darwin-arm64-abi-137";
  const entryBytes = "#!/usr/bin/env node\nexport const maintained = true;\n";
  const cliBytes = "#!/usr/bin/env node\nexport const cli = true;\n";
  const sourceClosureSha256 = "b".repeat(64);
  const closure = `${sha256(cliBytes)}-${sourceClosureSha256}`;
  const versionAbiDir = join(home, ".mono-agent", "runtimes", "agent-app", version, platformAbi);
  const installRoot = join(versionAbiDir, closure);
  const privateAncestors = [
    join(home, ".mono-agent"),
    join(home, ".mono-agent", "runtimes"),
    join(home, ".mono-agent", "runtimes", "agent-app"),
    join(home, ".mono-agent", "runtimes", "agent-app", version),
    join(home, ".mono-agent", "runtimes", "agent-app", version, platformAbi),
    installRoot,
  ];
  for (const path of privateAncestors) {
    await mkdir(path, { recursive: false, mode: 0o700 });
    await chmod(path, 0o700);
  }
  const entryPath = join(
    installRoot,
    "node_modules",
    "@mono-agent",
    "agent-app",
    "dist",
    "launchd-maintenance-entry.js",
  );
  await mkdir(join(installRoot, "node_modules", "@mono-agent", "agent-app", "dist"), { recursive: true });
  const manifestBytes = `${JSON.stringify({
    schema: "mono-agent.execution-closure.v1",
    entries: [],
  })}\n`;
  const cliPath = join(installRoot, "node_modules", "@mono-agent", "agent-app", "dist", "cli.js");
  const manifestPath = join(installRoot, ".mono-agent-closure.json");
  await writeFile(entryPath, entryBytes, "utf8");
  await writeFile(cliPath, cliBytes, "utf8");
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const installedAt = "2026-08-14T10:00:00.000Z";
  const markerBytes = `${JSON.stringify({
    schema: "mono-agent.managed-runtime.v5",
    packageName: "@mono-agent/agent-app",
    packageVersion: version,
    installedAt,
    cliSha256: sha256(cliBytes),
    sourceClosureSha256,
    nodeAbi: "137",
    platform: "darwin",
    arch: "arm64",
    closureManifestSha256: sha256(manifestBytes),
    executionProofSha256: "c".repeat(64),
    reuseProofSha256: "d".repeat(64),
  })}\n`;
  await writeFile(join(installRoot, ".mono-agent-runtime.json"), markerBytes, { mode: 0o600 });
  return {
    home,
    entryPath,
    entryBytes,
    cliPath,
    manifestPath,
    versionAbiDir,
    installRoot,
    launchProof: encodeManagedRuntimeLaunchProof({
      schema: "mono-agent.managed-runtime-launch.v2",
      markerSha256: sha256(markerBytes),
      maintenanceEntrySha256: sha256(entryBytes),
      installedAt,
    }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
