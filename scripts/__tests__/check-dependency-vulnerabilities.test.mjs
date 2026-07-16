import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectProductionGraph,
  evaluateDependencyVulnerabilities,
  loadDependencyVulnerabilityDispositions,
  normalizeDispositions,
  parsePnpmProductionGraph,
  parsePnpmProductionInventory,
  parsePnpmWhyDependencyPaths,
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
  it("parses pnpm 10's compact cross-platform production inventory", () => {
    expect(parsePnpmProductionInventory([
      "/repo/packages/portable-fixture",
      "/repo/node_modules/.pnpm/ws@8.20.1/node_modules/ws",
      "/repo/node_modules/.pnpm/ws@8.20.1/node_modules/ws",
      "/repo/node_modules/.pnpm/@img+sharp-win32-arm64@0.34.5/node_modules/@img/sharp-win32-arm64",
      "C:\\repo\\node_modules\\.pnpm\\@vscode+ripgrep-win32-x64@1.18.0\\node_modules\\@vscode\\ripgrep-win32-x64",
    ].join("\n"))).toEqual({
      "@img/sharp-win32-arm64": ["0.34.5"],
      "@vscode/ripgrep-win32-x64": ["1.18.0"],
      ws: ["8.20.1"],
    });
  });

  it("routes pnpm 10 collection through the compact parseable inventory", async () => {
    const calls = [];
    const graph = await collectProductionGraph({
      pnpmCommand: "pnpm-fixture",
      cwd: "/repo",
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        return args[0] === "--version"
          ? commandResult("10.28.2\n")
          : commandResult([
            "/repo/node_modules/.pnpm/prod-only@1.0.0/node_modules/prod-only",
            "/repo/node_modules/.pnpm/optional-win32@2.0.0/node_modules/optional-win32",
          ].join("\n"));
      },
    });

    expect(graph).toEqual({
      inventory: {
        "optional-win32": ["2.0.0"],
        "prod-only": ["1.0.0"],
      },
      dependencyPaths: {},
    });
    expect(calls).toEqual([
      { command: "pnpm-fixture", args: ["--version"], options: { cwd: "/repo" } },
      {
        command: "pnpm-fixture",
        args: ["list", "--prod", "--recursive", "--depth", "Infinity", "--parseable"],
        options: { cwd: "/repo" },
      },
    ]);
  });

  it("rejects unaudited pnpm majors and bounds malformed version output", async () => {
    const collectWithVersion = (version) => collectProductionGraph({
      pnpmCommand: "pnpm-fixture",
      cwd: "/repo",
      runCommand: async (_command, args) => {
        expect(args).toEqual(["--version"]);
        return commandResult(version);
      },
    });

    await expect(collectWithVersion("12.0.0\n"))
      .rejects.toThrow("supports audited pnpm majors 10 and 11; found 12.0.0");
    await expect(collectWithVersion("11.not-a-version\n"))
      .rejects.toThrow("pnpm returned an invalid version");
    await expect(collectWithVersion("11.13.1\nnoise\n"))
      .rejects.toThrow("pnpm returned an invalid version");

    const hugeError = await collectWithVersion(`${"x".repeat(10_000)}\n`).catch((error) => error);
    expect(hugeError).toBeInstanceOf(Error);
    expect(hugeError.message).toContain("pnpm returned an invalid version: ");
    expect(hugeError.message).toContain("…");
    expect(hugeError.message.length).toBeLessThan(550);
  });

  it("normalizes realistic pnpm 10 and pnpm 11 production JSON trees", () => {
    const expected = {
      inventory: {
        lodash: ["4.17.20"],
        "optional-win32": ["2.0.0"],
        "prod-only": ["1.0.0"],
        shared: ["7.0.0"],
        transitive: ["3.0.0"],
        "vulnerable-transitive": ["6.0.0"],
        "workspace-runtime": ["9.0.0"],
      },
      dependencyPaths: {
        "lodash@4.17.20": ["portable-fixture -> lodash@4.17.20"],
        "optional-win32@2.0.0": ["portable-fixture -> optional-win32@2.0.0"],
        "prod-only@1.0.0": ["portable-fixture -> prod-only@1.0.0"],
        "shared@7.0.0": [
          "portable-fixture -> shared@7.0.0",
          "workspace-only -> shared@7.0.0",
        ],
        "transitive@3.0.0": ["portable-fixture -> prod-only@1.0.0 -> transitive@3.0.0"],
        "vulnerable-transitive@6.0.0": [
          "workspace-only -> workspace-runtime@9.0.0 -> vulnerable-transitive@6.0.0",
        ],
        "workspace-runtime@9.0.0": ["workspace-only -> workspace-runtime@9.0.0"],
      },
    };

    expect(parsePnpmProductionGraph(pnpm10ListFixture(), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toEqual(expected);
    expect(parsePnpmProductionGraph(pnpm11ListFixture(), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toEqual(expected);
  });

  it("fails closed on unbound workspace links and contradictory pnpm 11 dedupe metadata", () => {
    const mismatchedName = JSON.parse(pnpm11ListFixture());
    mismatchedName[1].dependencies["workspace-alias"].from = "outside-workspace";
    expect(() => parsePnpmProductionGraph(JSON.stringify(mismatchedName), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("links non-publishable workspace package outside-workspace");

    const mismatchedPath = JSON.parse(pnpm11ListFixture());
    mismatchedPath[1].dependencies["workspace-alias"].path = "/outside/workspace-only";
    expect(() => parsePnpmProductionGraph(JSON.stringify(mismatchedPath), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("workspace link workspace-alias does not match root workspace-only");

    const zeroCount = JSON.parse(pnpm11ListFixture());
    zeroCount[2].dependencies["workspace-runtime"].dedupedDependenciesCount = 0;
    expect(() => parsePnpmProductionGraph(JSON.stringify(zeroCount), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("must name a positive dependency count");

    const countWithoutDedupe = JSON.parse(pnpm11ListFixture());
    countWithoutDedupe[2].dependencies["workspace-runtime"].deduped = false;
    expect(() => parsePnpmProductionGraph(JSON.stringify(countWithoutDedupe), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("dependency count without deduped true");

    const orphan = JSON.parse(pnpm11ListFixture());
    orphan[2].dependencies["workspace-runtime"].path = "/repo/node_modules/orphan-runtime";
    expect(() => parsePnpmProductionGraph(JSON.stringify(orphan), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("has no expanded subtree");

    const recursiveCount = JSON.parse(pnpm11ListFixture());
    recursiveCount[1].dependencies["workspace-alias"].dependencies["workspace-runtime"]
      .dependencies["vulnerable-transitive"].dependencies = {
        leaf: { version: "1.0.0", path: "/repo/node_modules/leaf" },
      };
    recursiveCount[2].dependencies["workspace-runtime"].dedupedDependenciesCount = 2;
    expect(parsePnpmProductionGraph(JSON.stringify(recursiveCount), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    }).dependencyPaths["leaf@1.0.0"]).toEqual([
      "workspace-only -> workspace-runtime@9.0.0 -> vulnerable-transitive@6.0.0 -> leaf@1.0.0",
    ]);

    const positiveCountMismatch = structuredClone(recursiveCount);
    positiveCountMismatch[2].dependencies["workspace-runtime"].dedupedDependenciesCount = 1;
    expect(() => parsePnpmProductionGraph(JSON.stringify(positiveCountMismatch), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("reports 1 dependencies, but its expanded subtree contains 2");

    const childBearingDedupe = JSON.parse(pnpm11ListFixture());
    childBearingDedupe[2].dependencies["workspace-runtime"].dependencies = {
      hidden: { version: "99.0.0", path: "/repo/node_modules/hidden" },
    };
    expect(() => parsePnpmProductionGraph(JSON.stringify(childBearingDedupe), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("deduped entry workspace-runtime must not include dependency children");

    const peerVariantMismatch = JSON.parse(pnpm11ListFixture());
    peerVariantMismatch[2].dependencies["workspace-runtime"].peersSuffixHash = "different";
    expect(() => parsePnpmProductionGraph(JSON.stringify(peerVariantMismatch), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("does not match its expanded subtree");
  });

  it("pins production/optional inclusion and dev/peer/workspace exclusion at the JSON boundary", async () => {
    const calls = [];
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      pnpmCommand: "pnpm-fixture",
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "--version") {
          return commandResult("11.13.1\n");
        }
        return {
          exitCode: 0,
          stdout: pnpm11ListFixture(),
          stderr: "",
        };
      },
      rootPackageNames: ["portable-fixture", "workspace-only"],
      dispositions: emptyDispositions(),
      fetchImpl: async (_url, request) => {
        expect(JSON.parse(request.body)).toEqual({
          lodash: ["4.17.20"],
          "optional-win32": ["2.0.0"],
          "prod-only": ["1.0.0"],
          shared: ["7.0.0"],
          transitive: ["3.0.0"],
          "vulnerable-transitive": ["6.0.0"],
          "workspace-runtime": ["9.0.0"],
        });
        return httpResponse({});
      },
      now: NOW,
      stdout: sink(),
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      {
        command: "pnpm-fixture",
        args: ["--version"],
        options: { cwd: process.cwd() },
      },
      {
        command: "pnpm-fixture",
        args: ["list", "--prod", "--recursive", "--depth", "Infinity", "--json"],
        options: { cwd: process.cwd() },
      },
    ]);
  });

  it("parses pnpm 10 child trees and pnpm 11 dependents trees for why paths", () => {
    const options = {
      packageName: "ws",
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/agent-app", "@mono-agent/slack-adapter"],
    };
    const expected = {
      "ws@8.20.1": [
        "@mono-agent/agent-app -> provider@2.0.0 -> ws@8.20.1",
        "@mono-agent/slack-adapter -> ws@8.20.1",
      ],
    };

    expect(parsePnpmWhyDependencyPaths(JSON.stringify([
      {
        name: "@mono-agent/agent-app",
        dependencies: {
          provider: {
            version: "2.0.0",
            dependencies: { ws: { version: "8.20.1" } },
          },
        },
      },
      {
        name: "@mono-agent/slack-adapter",
        dependencies: { "socket-alias": { from: "ws", version: "8.20.1" } },
      },
    ]), options)).toEqual(expected);

    expect(parsePnpmWhyDependencyPaths(JSON.stringify([
      { name: "@mono-agent/agent-app", version: "0.11.2", path: "/repo/packages/agent-app" },
      {
        name: "ws",
        version: "8.20.1",
        path: "/repo/node_modules/ws",
        dependents: [
          {
            name: "provider",
            version: "2.0.0",
            dependents: [{
              name: "@mono-agent/agent-app",
              version: "0.11.2",
              depField: "dependencies",
            }],
          },
          {
            name: "@mono-agent/slack-adapter",
            version: "0.11.2",
            depField: "dependencies",
          },
        ],
      },
    ]), options)).toEqual(expected);
  });

  it("hydrates realistic pnpm 11 reverse deduped branches by peer-aware identity", () => {
    const options = {
      packageName: "ws",
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/agent-app"],
    };
    expect(parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [
        {
          name: "provider",
          version: "2.0.0",
          peersSuffixHash: "same",
          dependents: [{
            name: "@mono-agent/agent-app",
            version: "0.11.3",
            depField: "dependencies",
          }],
        },
        {
          name: "wrapper",
          version: "3.0.0",
          dependents: [{
            name: "provider",
            version: "2.0.0",
            peersSuffixHash: "same",
            deduped: true,
          }],
        },
      ],
    }]), options)).toEqual({
      "ws@8.20.1": [
        "@mono-agent/agent-app -> provider@2.0.0 -> wrapper@3.0.0 -> ws@8.20.1",
        "@mono-agent/agent-app -> provider@2.0.0 -> ws@8.20.1",
      ],
    });
  });

  it("fails closed on incomplete or non-production pnpm 11 why branches", () => {
    const options = {
      packageName: "ws",
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/slack-adapter"],
    };
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [{ name: "provider", version: "1.0.0", deduped: true }],
    }]), options)).toThrow("deduped branch provider@1.0.0 above provider@1.0.0 -> ws@8.20.1 has no expanded dependents tree");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [{
        name: "@mono-agent/slack-adapter",
        version: "0.11.3",
        depField: "devDependencies",
      }],
    }]), options)).toThrow("non-production devDependencies path");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([
      null,
      {
        name: "ws",
        version: "8.20.1",
        dependents: [{
          name: "@mono-agent/slack-adapter",
          version: "0.11.3",
          depField: "dependencies",
        }],
      },
    ]), options)).toThrow("malformed top-level entry");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "incomplete",
      },
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "complete",
        dependents: [{
          name: "@mono-agent/slack-adapter",
          version: "0.11.3",
          depField: "dependencies",
        }],
      },
    ]), options)).toThrow("target variant ws@8.20.1#incomplete has no dependents tree");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "empty",
        dependents: [],
      },
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "complete",
        dependents: [{
          name: "@mono-agent/slack-adapter",
          version: "0.11.3",
          depField: "dependencies",
        }],
      },
    ]), options)).toThrow("target variant ws@8.20.1#empty has no complete production dependency path");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [
        {
          name: "provider",
          version: "1.0.0",
          dependents: [{
            name: "@mono-agent/slack-adapter",
            version: "0.11.3",
            depField: "dependencies",
          }],
        },
        {
          name: "wrapper",
          version: "1.0.0",
          dependents: [{
            name: "provider",
            version: "1.0.0",
            deduped: true,
            dependents: [],
          }],
        },
      ],
    }]), options)).toThrow("deduped branch provider@1.0.0 must not include dependents");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [
        { name: "orphan", version: "1.0.0", dependents: [] },
        {
          name: "@mono-agent/slack-adapter",
          version: "0.11.3",
          depField: "dependencies",
        },
      ],
    }]), options)).toThrow("incomplete branch orphan@1.0.0 has an empty dependents tree");
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
        if (args[0] === "--version") {
          return commandResult("11.13.1\n");
        }
        expect(args).toEqual(["list", "--prod", "--recursive", "--depth", "Infinity", "--json"]);
        return commandResult(JSON.stringify([{
          name: manifest.name,
          path: root,
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
        if (args[0] === "--version") {
          return commandResult("11.13.1\n");
        }
        expect(args).toEqual(["list", "--prod", "--recursive", "--depth", "Infinity", "--json"]);
        return commandResult(JSON.stringify([{
          name: "portable-fixture",
          path: "/repo/packages/portable-fixture",
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

function pnpm10ListFixture() {
  const workspaceRuntime = {
    version: "9.0.0",
    path: "/repo/node_modules/workspace-runtime",
    dependencies: {
      "vulnerable-transitive": {
        version: "6.0.0",
        path: "/repo/node_modules/vulnerable-transitive",
      },
    },
  };
  return JSON.stringify([
    {
      name: "portable-fixture",
      version: "1.0.0",
      path: "/repo/packages/portable-fixture",
      dependencies: {
        "prod-only": {
          version: "1.0.0",
          path: "/repo/node_modules/prod-only",
          dependencies: {
            transitive: { version: "3.0.0", path: "/repo/node_modules/transitive" },
          },
        },
        "safe-alias": {
          from: "lodash",
          version: "4.17.20",
          path: "/repo/node_modules/lodash",
        },
        shared: { version: "7.0.0", path: "/repo/node_modules/shared" },
        "workspace-alias": {
          from: "workspace-only",
          version: "link:../workspace-only",
          path: "/repo/packages/workspace-only",
          dependencies: {
            "workspace-runtime": workspaceRuntime,
          },
        },
      },
      optionalDependencies: {
        "optional-win32": { version: "2.0.0", path: "/repo/node_modules/optional-win32" },
      },
      devDependencies: {
        "dev-only": { version: "4.0.0", path: "/repo/node_modules/dev-only" },
      },
      peerDependencies: {
        "peer-only": { version: "5.0.0", path: "/repo/node_modules/peer-only" },
      },
    },
    {
      name: "workspace-only",
      version: "1.0.0",
      path: "/repo/packages/workspace-only",
      dependencies: {
        "workspace-runtime": workspaceRuntime,
        shared: { version: "7.0.0", path: "/repo/node_modules/shared" },
      },
      devDependencies: {
        "workspace-dev-only": {
          version: "10.0.0",
          path: "/repo/node_modules/workspace-dev-only",
        },
      },
    },
  ]);
}

function pnpm11ListFixture() {
  const pnpm10Roots = JSON.parse(pnpm10ListFixture());
  const workspaceRoot = structuredClone(pnpm10Roots[1]);
  workspaceRoot.dependencies["workspace-runtime"] = {
    version: "9.0.0",
    path: "/repo/node_modules/workspace-runtime",
    deduped: true,
    dedupedDependenciesCount: 1,
  };
  return JSON.stringify([
    {
      name: "mono-agent",
      version: "0.0.0",
      path: "/repo",
      private: true,
      // pnpm 11.13.1 includes these root dev packages in `--parseable`
      // output under `--prod`; root filtering plus JSON sections excludes them.
      devDependencies: {
        "@types/node": { version: "22.19.19", path: "/repo/node_modules/@types/node" },
        "@vitest/coverage-v8": { version: "3.2.4", path: "/repo/node_modules/@vitest/coverage-v8" },
        vitest: { version: "3.2.4", path: "/repo/node_modules/vitest" },
      },
    },
    pnpm10Roots[0],
    workspaceRoot,
  ]);
}

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
