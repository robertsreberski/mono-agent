import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  filterBulkAdvisoryReport,
  mergeProductionInventories,
  runAllDependencyVulnerabilityChecks,
} from "../check-all-dependency-vulnerabilities.mjs";

describe("combined dependency vulnerability gate", () => {
  it("owns the package-script audit so CI cannot restore sequential full requests", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

    expect(manifest.scripts["check:dependency-vulnerabilities"])
      .toBe("node scripts/check-all-dependency-vulnerabilities.mjs");
  });

  it("merges every exact package version into one sorted inventory", () => {
    expect(mergeProductionInventories([
      graph({ shared: ["2.0.0", "1.0.0"], root: ["1.0.0"] }),
      graph({ shared: ["2.0.0", "3.0.0"], isolated: ["1.0.0"] }),
    ])).toEqual({
      isolated: ["1.0.0"],
      root: ["1.0.0"],
      shared: ["1.0.0", "2.0.0", "3.0.0"],
    });
  });

  it("filters a shared report to the exact vulnerable versions owned by one graph", () => {
    const advisory = {
      id: 123,
      severity: "high",
      title: "fixture advisory",
      url: "https://example.invalid/advisory/123",
      vulnerable_versions: "<2.0.0",
    };

    expect(filterBulkAdvisoryReport({ shared: [advisory] }, {
      shared: ["1.5.0", "2.0.0"],
    })).toEqual({
      report: { shared: [advisory] },
      advisoryVersions: { shared: { 123: ["1.5.0"] } },
    });
    expect(filterBulkAdvisoryReport({ shared: [advisory] }, {
      shared: ["2.0.0"],
    })).toEqual({ report: {}, advisoryVersions: {} });
    expect(() => filterBulkAdvisoryReport({
      shared: [{ ...advisory, vulnerable_versions: "not a range" }],
    }, {
      shared: ["1.5.0"],
    })).toThrow("invalid vulnerable_versions range");
  });

  it("queries the registry once and evaluates every graph independently", async () => {
    const stdout = sink();
    const advisory = {
      id: 123,
      severity: "high",
      title: "fixture advisory",
      url: "https://example.invalid/advisory/123",
      vulnerable_versions: "<2.0.0",
    };
    const queryAdvisories = vi.fn(async () => ({ shared: [advisory] }));
    const graphReports = [];
    const advisoryVersions = [];
    const runCheck = vi.fn(async (options) => {
      const report = await options.queryAdvisories(options.productionGraph.inventory);
      graphReports.push(report);
      advisoryVersions.push(options.advisoryVersions);
      return { exitCode: 0 };
    });
    const result = await runAllDependencyVulnerabilityChecks({
      repoRoot: "/repo",
      stdout,
      stderr: sink(),
      graphs: [
        {
          kind: "pnpm",
          label: "workspace",
          cwd: ".",
          dispositions: "root.json",
          isolated: false,
        },
        {
          kind: "pnpm",
          label: "web console",
          cwd: "web",
          rootPackageNames: ["web"],
          dispositions: "web.json",
          isolated: true,
        },
      ],
      collectGraph: async ({ cwd }) => cwd === "/repo"
        ? graph({ root: ["1.0.0"], shared: ["1.0.0"] })
        : graph({ isolated: ["1.0.0"], shared: ["2.0.0"] }),
      queryAdvisories,
      runCheck,
    });

    expect(result.exitCode).toBe(0);
    expect(queryAdvisories).toHaveBeenCalledTimes(1);
    expect(queryAdvisories.mock.calls[0][0]).toEqual({
      isolated: ["1.0.0"],
      root: ["1.0.0"],
      shared: ["1.0.0", "2.0.0"],
    });
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(graphReports).toEqual([{ shared: [advisory] }, {}]);
    expect(advisoryVersions).toEqual([
      { shared: { 123: ["1.0.0"] } },
      {},
    ]);
    expect(stdout.text).toBe("Auditing isolated web console production graph.\n");
  });

  it("fails closed before evaluation when the shared response is invalid", async () => {
    const stderr = sink();
    const runCheck = vi.fn();
    const result = await runAllDependencyVulnerabilityChecks({
      repoRoot: "/repo",
      stdout: sink(),
      stderr,
      graphs: [{
        kind: "pnpm",
        label: "workspace",
        cwd: ".",
        dispositions: "root.json",
        isolated: false,
      }],
      collectGraph: async () => graph({ root: ["1.0.0"] }),
      queryAdvisories: async () => ({ unexpected: [] }),
      runCheck,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("package absent from inventory: unexpected");
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("fails closed with a bounded diagnostic when shared advisory selection is invalid", async () => {
    const stderr = sink();
    const runCheck = vi.fn();
    const result = await runAllDependencyVulnerabilityChecks({
      repoRoot: "/repo",
      stdout: sink(),
      stderr,
      graphs: [{
        kind: "pnpm",
        label: "workspace",
        cwd: ".",
        dispositions: "root.json",
        isolated: false,
      }],
      collectGraph: async () => graph({ root: ["1.0.0"] }),
      queryAdvisories: async () => ({
        root: [{
          id: 123,
          severity: "high",
          title: "fixture advisory",
          url: "https://example.invalid/advisory/123",
          vulnerable_versions: "not a range",
        }],
      }),
      runCheck,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("invalid vulnerable_versions range");
    expect(runCheck).not.toHaveBeenCalled();
  });
});

function graph(inventory) {
  return {
    inventory,
    dependencyPaths: Object.fromEntries(Object.entries(inventory).flatMap(([name, versions]) => (
      versions.map((version) => [`${name}@${version}`, [`fixture -> ${name}@${version}`]])
    ))),
  };
}

function sink() {
  return {
    text: "",
    write(value) {
      this.text += String(value);
      return true;
    },
  };
}
