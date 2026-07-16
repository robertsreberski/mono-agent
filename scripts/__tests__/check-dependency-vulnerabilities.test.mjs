import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateDependencyVulnerabilities,
  loadDependencyVulnerabilityDispositions,
  normalizeDispositions,
  parsePnpmProductionInventory,
  queryBulkAdvisories,
  runDependencyVulnerabilityCheck,
} from "../check-dependency-vulnerabilities.mjs";

const temporaryRoots = [];
const REVIEWED_AT = "2026-07-16";
const EXPIRES_AT = "2026-08-15";
const NOW = new Date("2026-07-16T12:00:00Z");

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("dependency vulnerability gate", () => {
  it("normalizes the flattened cross-platform inventory and excludes workspace paths", () => {
    const inventory = parsePnpmProductionInventory([
      "/repo/packages/runtime-adapter",
      "/repo/node_modules/.pnpm/ws@8.20.1/node_modules/ws",
      "/repo/node_modules/.pnpm/ws@8.20.1/node_modules/ws",
      "/repo/node_modules/.pnpm/@img+sharp-win32-arm64@0.34.5/node_modules/@img/sharp-win32-arm64",
      "C:\\repo\\node_modules\\.pnpm\\@vscode+ripgrep-win32-x64@1.18.0\\node_modules\\@vscode\\ripgrep-win32-x64",
      "",
    ].join("\n"));

    expect(inventory).toEqual({
      "@img/sharp-win32-arm64": ["0.34.5"],
      "@vscode/ripgrep-win32-x64": ["1.18.0"],
      ws: ["8.20.1"],
    });
  });

  it("pins production/optional inclusion and dev/peer/workspace exclusion at the pnpm boundary", async () => {
    const calls = [];
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      pnpmCommand: "pnpm-fixture",
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        return {
          exitCode: 0,
          stdout: [
            "/repo/packages/portable-fixture",
            "/repo/node_modules/.pnpm/prod-only@1.0.0/node_modules/prod-only",
            "/repo/node_modules/.pnpm/optional-win32@2.0.0/node_modules/optional-win32",
          ].join("\n"),
          stderr: "",
        };
      },
      rootPackageNames: ["portable-fixture"],
      dispositions: emptyDispositions(),
      fetchImpl: async (_url, request) => {
        expect(JSON.parse(request.body)).toEqual({
          "optional-win32": ["2.0.0"],
          "prod-only": ["1.0.0"],
        });
        return httpResponse({});
      },
      now: NOW,
      stdout: sink(),
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{
      command: "pnpm-fixture",
      args: ["list", "--prod", "--recursive", "--depth", "Infinity", "--parseable"],
      options: { cwd: process.cwd() },
    }]);
    // `pnpm list --prod` supplies dependencies + optionalDependencies only.
    // devDependencies and peer-only declarations never enter this flattened output;
    // local workspace paths are explicitly ignored by the parser above.
  });

  it("drives the real collector and HTTP parser for a deliberately vulnerable package", async () => {
    const root = temporaryProject({ lodash: "4.17.20" });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const stderr = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      cwd: root,
      rootPackageNames: [manifest.name],
      runCommand: async (_command, args) => {
        if (args[0] === "list") {
          expect(args).toEqual(["list", "--prod", "--recursive", "--depth", "Infinity", "--parseable"]);
          return commandResult(
            `${root}/node_modules/.pnpm/lodash@${manifest.dependencies.lodash}/node_modules/lodash\n`,
          );
        }
        expect(args).toEqual(["why", "lodash", "--prod", "--recursive", "--json"]);
        return commandResult(JSON.stringify([{
          name: manifest.name,
          dependencies: { lodash: { version: manifest.dependencies.lodash } },
        }]));
      },
      dispositions: emptyDispositions(),
      fetchImpl: async (url, request) => {
        expect(url.href).toBe("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk");
        expect(request.method).toBe("POST");
        expect(request.headers["content-type"]).toBe("application/json");
        expect(JSON.parse(request.body)).toEqual({ lodash: ["4.17.20"] });
        expect(request.signal).toBeInstanceOf(AbortSignal);
        return httpResponse({
          lodash: [lodashAdvisory()],
        });
      },
      now: NOW,
      stdout: sink(),
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("UNREVIEWED [high] lodash@4.17.20");
    expect(stderr.text).toContain("GHSA-35jh-r3h4-6jhm");
  });

  it("submits and trips on a non-runner-platform optional production package", async () => {
    const packageName = "@fixture/native-win32-arm64";
    const stderr = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      rootPackageNames: ["portable-fixture"],
      runCommand: async (_command, args) => {
        if (args[0] === "list") {
          return commandResult(
            `/repo/node_modules/.pnpm/@fixture+native-win32-arm64@1.2.3/node_modules/${packageName}\n`,
          );
        }
        expect(args).toEqual(["why", packageName, "--prod", "--recursive", "--json"]);
        return commandResult(JSON.stringify([{
          name: "portable-fixture",
          optionalDependencies: {
            [packageName]: { version: "1.2.3" },
          },
        }]));
      },
      dispositions: emptyDispositions(),
      fetchImpl: async (_url, request) => {
        expect(JSON.parse(request.body)).toEqual({ [packageName]: ["1.2.3"] });
        return httpResponse({
          [packageName]: [{
            id: "GHSA-cross-platform",
            severity: "critical",
            title: "Cross-platform fixture advisory",
            url: "https://github.com/advisories/GHSA-cross-platform",
            vulnerable_versions: "<1.2.4",
          }],
        });
      },
      now: NOW,
      stdout: sink(),
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain(`UNREVIEWED [critical] ${packageName}@1.2.3`);
  });

  it("passes only when advisory metadata, exact versions, paths, and a live expiry match", async () => {
    const stdout = sink();
    const advisory = wsAdvisory();
    const graph = graphFor("ws", "8.20.1", "fixture -> ws@8.20.1");
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, graph.dependencyPaths["ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: NOW,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("1 high-or-critical advisories, all exactly dispositioned");
    expect(stdout.text).toContain("DISPOSITIONED [high] ws@8.20.1");
  });

  it("fails closed on invented paths, version drift, stale entries, and expiry", async () => {
    const advisory = wsAdvisory();
    const graph = graphFor("ws", "8.20.1", "fixture -> ws@8.20.1");

    const pathStderr = sink();
    const pathMismatch = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["invented -> ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: NOW,
      stdout: sink(),
      stderr: pathStderr,
    });
    expect(pathMismatch.exitCode).toBe(1);
    expect(pathStderr.text).toContain("production dependency paths changed");

    const versionGraph = graphFor("ws", "8.20.2", "fixture -> ws@8.20.2");
    const versionStderr = sink();
    const versionMismatch = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: versionGraph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: NOW,
      stdout: sink(),
      stderr: versionStderr,
    });
    expect(versionMismatch.exitCode).toBe(1);
    expect(versionStderr.text).toContain("exact versions changed");

    const staleStderr = sink();
    const stale = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]),
      queryAdvisories: async () => ({}),
      now: NOW,
      stdout: sink(),
      stderr: staleStderr,
    });
    expect(stale.exitCode).toBe(1);
    expect(staleStderr.text).toContain("STALE [high] ws@8.20.1");

    const expiredStderr = sink();
    const expired = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: new Date(`${EXPIRES_AT}T00:00:00Z`),
      stdout: sink(),
      stderr: expiredStderr,
    });
    expect(expired.exitCode).toBe(1);
    expect(expiredStderr.text).toContain(`temporary acceptance expired ${EXPIRES_AT}`);
  });

  it("strictly validates review and expiry dates and caps temporary acceptance at 90 days", () => {
    const advisory = wsAdvisory();
    const valid = dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]);

    expect(() => normalizeDispositions({ ...valid, reviewedAt: "not-a-date" }))
      .toThrow("reviewedAt must be a valid YYYY-MM-DD date");
    expect(() => normalizeDispositions({ ...valid, reviewedAt: "2026-02-30" }))
      .toThrow("reviewedAt must be a valid YYYY-MM-DD date");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...valid.advisories[0], expiresAt: "2026-02-30" }],
    })).toThrow("expiresAt must be a valid YYYY-MM-DD date");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...valid.advisories[0], expiresAt: "2026-10-15" }],
    })).toThrow("within 90 days");
  });

  it("uses the real bulk HTTP boundary and fails closed on transport, non-2xx, malformed JSON, and timeout", async () => {
    const inventory = { ws: ["8.20.1"] };
    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    })).rejects.toThrow("bulk advisory request failed: connection refused");

    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => httpResponse("registry unavailable", { status: 503, raw: true }),
    })).rejects.toThrow("returned HTTP 503: registry unavailable");

    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => httpResponse("{broken", { raw: true }),
    })).rejects.toThrow("bulk advisory response was not valid JSON");

    vi.useFakeTimers();
    const pending = queryBulkAdvisories(inventory, {
      timeoutMs: 25,
      fetchImpl: async () => await new Promise(() => {}),
    });
    const rejection = expect(pending).rejects.toThrow("bulk advisory request timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("ignores low/moderate advisories while high/critical findings trip", () => {
    const graph = {
      inventory: {
        critical: ["1.0.0"],
        high: ["1.0.0"],
        low: ["1.0.0"],
        moderate: ["1.0.0"],
      },
      dependencyPaths: {
        "critical@1.0.0": ["fixture -> critical@1.0.0"],
        "high@1.0.0": ["fixture -> high@1.0.0"],
      },
    };
    const report = Object.fromEntries(["low", "moderate", "high", "critical"].map((severity) => [
      severity,
      [{
        id: `GHSA-${severity}`,
        severity,
        title: `${severity} fixture`,
        url: `https://github.com/advisories/GHSA-${severity}`,
        vulnerable_versions: "*",
      }],
    ]));
    const evaluation = evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report,
      dispositions: emptyDispositions(),
      now: NOW,
    });

    expect(evaluation.active.map((entry) => entry.severity).sort()).toEqual(["critical", "high"]);
    expect(evaluation.unreviewed).toHaveLength(2);
    expect(evaluation.ok).toBe(false);
  });

  it("keeps the committed current-tree dispositions structurally valid and bounded", async () => {
    const dispositions = await loadDependencyVulnerabilityDispositions();
    expect(dispositions.minimumSeverity).toBe("high");
    expect(dispositions.advisories).toHaveLength(4);
    expect(new Set(dispositions.advisories.map((entry) => `${entry.package}:${entry.id}`)).size).toBe(4);
    expect(new Set(dispositions.advisories.map((entry) => entry.expiresAt))).toEqual(new Set([EXPIRES_AT]));
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

function graphFor(packageName, version, path) {
  return {
    inventory: { [packageName]: [version] },
    dependencyPaths: { [`${packageName}@${version}`]: [path] },
  };
}

function emptyDispositions() {
  return {
    schemaVersion: 1,
    minimumSeverity: "high",
    reviewedAt: REVIEWED_AT,
    advisories: [],
  };
}

function dispositionFor(packageName, version, advisory, dependencyPaths) {
  return {
    schemaVersion: 1,
    minimumSeverity: "high",
    reviewedAt: REVIEWED_AT,
    advisories: [{
      package: packageName,
      versions: [version],
      id: advisory.id,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
      vulnerableVersions: advisory.vulnerable_versions,
      disposition: "accepted-temporarily",
      expiresAt: EXPIRES_AT,
      dependencyPaths,
      rationale: "Exact test-only disposition with a bounded expiry.",
    }],
  };
}

function wsAdvisory() {
  return {
    id: 1123259,
    severity: "high",
    title: "ws: Memory exhaustion DoS from tiny fragments and data chunks",
    url: "https://github.com/advisories/GHSA-96hv-2xvq-fx4p",
    vulnerable_versions: ">=8.0.0 <8.21.0",
  };
}

function lodashAdvisory() {
  return {
    id: 1106913,
    severity: "high",
    title: "Command Injection in lodash",
    url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
    vulnerable_versions: "<4.17.21",
  };
}

function commandResult(stdout) {
  return { exitCode: 0, stdout, stderr: "" };
}

function httpResponse(body, options = {}) {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return options.raw ? String(body) : JSON.stringify(body);
    },
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
