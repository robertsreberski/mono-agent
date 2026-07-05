import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { packageCatalog } from "../../package-catalog.mjs";
import {
  discoverPackages,
  sortForPublish,
} from "../package-graph.mjs";
import {
  assertPackResult,
  parsePnpmPackOutput,
} from "../pack-release.mjs";
import {
  releaseVersionFromTag,
  validateRelease,
} from "../validate-release.mjs";
import { describePublishedExportsDrift } from "../publish-release.mjs";

const expectedPublishablePackages = packageCatalog.filter((entry) => entry.publishable === true);
const expectedPublishablePackageCount = expectedPublishablePackages.length;
const expectedPublishablePackageNames = expectedPublishablePackages.map((entry) => entry.name).sort();

function packageRecord({
  name,
  version = "1.2.3",
  publishable = true,
  privatePackage = false,
  publishConfig = { access: "public" },
  dependencies = {},
}) {
  return {
    name,
    version,
    private: privatePackage,
    publishConfig,
    relativeDir: `packages/${name.split("/").pop()}`,
    location: "workspace",
    catalogEntry: { publishable },
    packageJson: {
      name,
      version,
      private: privatePackage,
      publishConfig,
      dependencies,
    },
  };
}

describe("release tag validation", () => {
  test("extracts semver release versions from v-prefixed tags", () => {
    expect(releaseVersionFromTag("v1.2.3")).toBe("1.2.3");
    expect(releaseVersionFromTag("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(() => releaseVersionFromTag("1.2.3")).toThrow(/must look like v1\.2\.3/);
  });
});

describe("release graph validation", () => {
  test("validates exact versions and returns dependency-first publish order", () => {
    const contracts = packageRecord({ name: "@mono-agent/agent-contracts" });
    const adapter = packageRecord({
      name: "@mono-agent/slack-adapter",
      dependencies: {
        "@mono-agent/agent-contracts": "workspace:1.2.3",
      },
    });

    const result = validateRelease({
      tag: "v1.2.3",
      packages: [adapter, contracts],
      silent: true,
    });

    expect(result.version).toBe("1.2.3");
    expect(result.publishablePackages.map((pkg) => pkg.name)).toEqual([
      "@mono-agent/agent-contracts",
      "@mono-agent/slack-adapter",
    ]);
  });

  test("rejects packages that are not launch-ready", () => {
    const contracts = packageRecord({
      name: "@mono-agent/agent-contracts",
      publishConfig: null,
    });
    const adapter = packageRecord({
      name: "@mono-agent/slack-adapter",
      dependencies: {
        "@mono-agent/agent-contracts": "workspace:*",
      },
    });
    const runtime = packageRecord({
      name: "@mono-agent/agent-runtime",
      version: "1.2.4",
    });

    expect(() =>
      validateRelease({
        tag: "v1.2.3",
        packages: [contracts, adapter, runtime],
        silent: true,
      }),
    ).toThrow(
      /@mono-agent\/agent-contracts publishConfig\.access must be public[\s\S]*@mono-agent\/agent-runtime version must be 1\.2\.3[\s\S]*@mono-agent\/slack-adapter dependencies\.@mono-agent\/agent-contracts must be workspace:1\.2\.3/,
    );
  });

  test("detects cycles before publishing", () => {
    const one = packageRecord({
      name: "@mono-agent/one",
      dependencies: { "@mono-agent/two": "workspace:1.2.3" },
    });
    const two = packageRecord({
      name: "@mono-agent/two",
      dependencies: { "@mono-agent/one": "workspace:1.2.3" },
    });

    expect(() => sortForPublish([one, two])).toThrow(/cycle in publishable package dependencies/);
  });
});

describe("release pack validation", () => {
  const pkg = packageRecord({ name: "@mono-agent/example" });

  test("parses pnpm pack JSON output", () => {
    expect(parsePnpmPackOutput(JSON.stringify({ name: pkg.name, filename: "example.tgz", files: [] }))).toEqual({
      name: pkg.name,
      filename: "example.tgz",
      files: [],
    });
  });

  test("asserts required files and a non-empty tarball", () => {
    const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-pack-test-"));
    try {
      const tarballPath = path.join(packDestination, "mono-agent-example-1.2.3.tgz");
      fs.writeFileSync(tarballPath, "tgz");

      expect(
        assertPackResult(pkg, {
          name: pkg.name,
          version: "1.2.3",
          filename: tarballPath,
          files: [{ path: "package.json" }, { path: "README.md" }],
        }, packDestination),
      ).toEqual({
        fileCount: 2,
        tarballPath,
        tarballSize: 3,
      });
    } finally {
      fs.rmSync(packDestination, { recursive: true, force: true });
    }
  });

  test("requires session-web to include its built PWA assets", () => {
    const sessionWeb = packageRecord({ name: "@mono-agent/session-web" });
    const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-pack-test-"));
    try {
      const tarballPath = path.join(packDestination, "mono-agent-session-web-1.2.3.tgz");
      fs.writeFileSync(tarballPath, "tgz");

      expect(() =>
        assertPackResult(sessionWeb, {
          name: sessionWeb.name,
          version: "1.2.3",
          filename: tarballPath,
          files: [{ path: "package.json" }, { path: "README.md" }],
        }, packDestination),
      ).toThrow(/webapp\/dist\/index\.html/);
    } finally {
      fs.rmSync(packDestination, { recursive: true, force: true });
    }
  });

  test("rejects pack output without a tarball", () => {
    const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-pack-test-"));
    try {
      expect(() =>
        assertPackResult(pkg, {
          name: pkg.name,
          version: "1.2.3",
          filename: "missing.tgz",
          files: [{ path: "package.json" }, { path: "README.md" }],
        }, packDestination),
      ).toThrow(/did not create/);
    } finally {
      fs.rmSync(packDestination, { recursive: true, force: true });
    }
  });
});

describe("current launch manifest", () => {
  test("discovers all catalog-publishable packages", () => {
    const publishable = discoverPackages().filter((pkg) => pkg.catalogEntry.publishable);
    const publishableNames = publishable.map((pkg) => pkg.name);

    expect(publishable).toHaveLength(expectedPublishablePackageCount);
    expect([...publishableNames].sort()).toEqual(expectedPublishablePackageNames);
    expect(publishableNames).toContain("@mono-agent/tui");
    expect(publishableNames).toContain("@mono-agent/agent-host");
    expect(publishableNames).toContain("@mono-agent/memory-supermemory");
    // memory-mcp was retired: the BuJo recall tool is now auto-provisioned in-app
    // from the single config.memory block (no separate stdio MCP package).
    expect(publishableNames).not.toContain("@mono-agent/memory-mcp");
    // operator-console was retired: Phoenix export is exposed from
    // @mono-agent/observability/otel and config is JSON-first, applied on
    // `mono-agent restart`.
    expect(publishableNames).not.toContain("@mono-agent/operator-console");
    expect(publishableNames).not.toContain(`@mono-agent/${"sandbox"}`);
    expect(publishableNames).not.toContain(`@mono-agent/${"tui"}-${"adapter"}`);
    expect(publishableNames).not.toContain(`@mono-agent/${"live"}-${"adapter"}`);
    expect(publishableNames).toContain("@mono-agent/operator-adapter");
    expect(publishableNames).toContain("@mono-agent/agent-runtime");
    expect(publishableNames).toContain("@mono-agent/runtime-adapter");
    expect(publishableNames).toContain("@mono-agent/agent-app");
    expect(publishableNames).toContain("@mono-agent/observability");
  });

  test("validates the repository for its current release tag", async () => {
    // Derive the version from a workspace manifest so this test keeps
    // validating the real repository state across version bumps.
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(readFileSync(new URL("../../../packages/agent-app/package.json", import.meta.url), "utf8"));

    const result = validateRelease({ tag: `v${version}`, silent: true });

    expect(result.publishablePackages).toHaveLength(expectedPublishablePackageCount);
    expect(result.publishablePackages.map((pkg) => pkg.name).sort()).toEqual(expectedPublishablePackageNames);
    expect(result.publishablePackages.every((pkg) => pkg.version === version)).toBe(true);
  });
});

describe("published exports drift guard", () => {
  const local = {
    name: "@mono-agent/observability",
    version: "0.3.0",
    packageJson: {
      exports: { ".": {}, "./event-timeline": {}, "./run-export": {} },
    },
  };

  test("flags a skipped package that adds a subpath the npm copy lacks", () => {
    // The exact incident: local adds ./run-export, npm 0.3.0 only has . and ./event-timeline.
    const published = { ".": {}, "./event-timeline": {} };
    const reason = describePublishedExportsDrift(local, published);
    expect(reason).toMatch(/run-export/u);
    expect(reason).toMatch(/bump the release version/iu);
  });

  test("passes when the published export map already exposes every local subpath", () => {
    const published = { ".": {}, "./event-timeline": {}, "./run-export": {} };
    expect(describePublishedExportsDrift(local, published)).toBeUndefined();
  });

  test("passes when the published map is a superset of local subpaths", () => {
    const published = { ".": {}, "./event-timeline": {}, "./run-export": {}, "./extra": {} };
    expect(describePublishedExportsDrift(local, published)).toBeUndefined();
  });

  test("treats a missing/undefined exports field as the main entry only", () => {
    const mainOnly = { name: "@mono-agent/x", version: "0.3.0", packageJson: {} };
    expect(describePublishedExportsDrift(mainOnly, undefined)).toBeUndefined();
    // Local exposes only ".", published has more -> still fine.
    expect(describePublishedExportsDrift(mainOnly, { ".": {}, "./sub": {} })).toBeUndefined();
  });
});
