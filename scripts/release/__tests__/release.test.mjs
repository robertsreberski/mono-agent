import { describe, expect, test } from "vitest";

import {
  discoverPackages,
  sortForPublish,
} from "../package-graph.mjs";
import {
  releaseVersionFromTag,
  validateRelease,
} from "../validate-release.mjs";
import { describePublishedExportsDrift } from "../publish-release.mjs";

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

describe("current launch manifest", () => {
  test("discovers all catalog-publishable packages", () => {
    const publishable = discoverPackages().filter((pkg) => pkg.catalogEntry.publishable);

    expect(publishable).toHaveLength(27);
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/tui");
    // memory-mcp was retired: the BuJo recall tool is now auto-provisioned in-app
    // from the single config.memory block (no separate stdio MCP package).
    expect(publishable.map((pkg) => pkg.name)).not.toContain("@mono-agent/memory-mcp");
    // operator-console was retired: Phoenix (observability-otel) is the trace
    // viewer and config is JSON-first, applied on `mono-agent restart`.
    expect(publishable.map((pkg) => pkg.name)).not.toContain("@mono-agent/operator-console");
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/agent-runtime");
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/sandbox");
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/agent-app");
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/observability-otel");
  });

  test("validates the repository for its current release tag", async () => {
    // Derive the version from a workspace manifest so this test keeps
    // validating the real repository state across version bumps.
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(readFileSync(new URL("../../../packages/agent-app/package.json", import.meta.url), "utf8"));

    const result = validateRelease({ tag: `v${version}`, silent: true });

    expect(result.publishablePackages).toHaveLength(27);
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
