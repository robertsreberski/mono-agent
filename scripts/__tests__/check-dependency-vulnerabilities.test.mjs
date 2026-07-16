import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadDependencyVulnerabilityDispositions,
  parsePnpmLicenseInventory,
  runDependencyVulnerabilityCheck,
} from "../check-dependency-vulnerabilities.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("dependency vulnerability gate", () => {
  it("normalizes unique production package versions from pnpm's license inventory", () => {
    const inventory = parsePnpmLicenseInventory(JSON.stringify({
      MIT: [
        { name: "ws", versions: ["8.20.1", "8.20.1"] },
        { name: "hono", versions: ["4.12.18"] },
      ],
      ISC: [{ name: "ws", versions: ["8.19.0"] }],
    }));

    expect(inventory).toEqual({
      hono: ["4.12.18"],
      ws: ["8.19.0", "8.20.1"],
    });
  });

  it("fails an ephemeral deliberately vulnerable package and advisory", async () => {
    const root = temporaryProject({ lodash: "4.17.20" });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const stderr = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      cwd: root,
      inventory: Object.fromEntries(
        Object.entries(manifest.dependencies).map(([name, version]) => [name, [version]]),
      ),
      dispositions: emptyDispositions(),
      queryAdvisories: async (inventory) => {
        expect(inventory).toEqual({ lodash: ["4.17.20"] });
        return {
          lodash: [{
            id: 1106913,
            severity: "high",
            title: "Command Injection in lodash",
            url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
            vulnerable_versions: "<4.17.21",
          }],
        };
      },
      stdout: sink(),
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("UNREVIEWED [high] lodash@4.17.20");
    expect(stderr.text).toContain("GHSA-35jh-r3h4-6jhm");
  });

  it("passes only when advisory metadata and exact installed versions are dispositioned", async () => {
    const stdout = sink();
    const advisory = {
      id: 1123259,
      severity: "high",
      title: "ws: Memory exhaustion DoS from tiny fragments and data chunks",
      url: "https://github.com/advisories/GHSA-96hv-2xvq-fx4p",
      vulnerable_versions: ">=8.0.0 <8.21.0",
    };
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      inventory: { ws: ["8.20.1"] },
      dispositions: dispositionFor("ws", "8.20.1", advisory),
      queryAdvisories: async () => ({ ws: [advisory] }),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("1 high-or-critical advisories, all exactly dispositioned");
    expect(stdout.text).toContain("DISPOSITIONED [high] ws@8.20.1");
  });

  it("fails closed on version drift, stale dispositions, and registry errors", async () => {
    const advisory = {
      id: 1123259,
      severity: "high",
      title: "ws: Memory exhaustion DoS from tiny fragments and data chunks",
      url: "https://github.com/advisories/GHSA-96hv-2xvq-fx4p",
      vulnerable_versions: ">=8.0.0 <8.21.0",
    };
    const mismatchStderr = sink();
    const mismatch = await runDependencyVulnerabilityCheck({
      argv: [],
      inventory: { ws: ["8.20.2"] },
      dispositions: dispositionFor("ws", "8.20.1", advisory),
      queryAdvisories: async () => ({ ws: [advisory] }),
      stdout: sink(),
      stderr: mismatchStderr,
    });
    expect(mismatch.exitCode).toBe(1);
    expect(mismatchStderr.text).toContain("MISMATCH");
    expect(mismatchStderr.text).toContain("exact versions changed");

    const staleStderr = sink();
    const stale = await runDependencyVulnerabilityCheck({
      argv: [],
      inventory: { ws: ["8.20.1"] },
      dispositions: dispositionFor("ws", "8.20.1", advisory),
      queryAdvisories: async () => ({}),
      stdout: sink(),
      stderr: staleStderr,
    });
    expect(stale.exitCode).toBe(1);
    expect(staleStderr.text).toContain("STALE [high] ws@8.20.1");

    const transportStderr = sink();
    const transport = await runDependencyVulnerabilityCheck({
      argv: [],
      inventory: { ws: ["8.20.1"] },
      dispositions: emptyDispositions(),
      queryAdvisories: async () => {
        throw new Error("registry unavailable");
      },
      stdout: sink(),
      stderr: transportStderr,
    });
    expect(transport.exitCode).toBe(1);
    expect(transportStderr.text).toContain("FAILED — registry unavailable");
  });

  it("keeps the committed current-tree dispositions structurally valid", async () => {
    const dispositions = await loadDependencyVulnerabilityDispositions();
    expect(dispositions.minimumSeverity).toBe("high");
    expect(dispositions.advisories).toHaveLength(4);
    expect(new Set(dispositions.advisories.map((entry) => `${entry.package}:${entry.id}`)).size).toBe(4);
  });
});

function temporaryProject(dependencies) {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-vulnerable-dependency-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "ephemeral-vulnerability-fixture",
    private: true,
    dependencies,
  }, null, 2)}\n`);
  return root;
}

function emptyDispositions() {
  return {
    schemaVersion: 1,
    minimumSeverity: "high",
    reviewedAt: "2026-07-16",
    advisories: [],
  };
}

function dispositionFor(packageName, version, advisory) {
  return {
    schemaVersion: 1,
    minimumSeverity: "high",
    reviewedAt: "2026-07-16",
    advisories: [{
      package: packageName,
      versions: [version],
      id: advisory.id,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
      vulnerableVersions: advisory.vulnerable_versions,
      disposition: "accepted-temporarily",
      dependencyPaths: [`fixture -> ${packageName}@${version}`],
      rationale: "Exact test-only disposition.",
    }],
  };
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
