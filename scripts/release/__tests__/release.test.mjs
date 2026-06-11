import { describe, expect, test } from "vitest";

import {
  discoverPackages,
  sortForPublish,
} from "../package-graph.mjs";
import {
  releaseVersionFromTag,
  validateRelease,
} from "../validate-release.mjs";

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

    expect(publishable).toHaveLength(30);
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/tui");
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/agent-runtime");
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/sandbox");
    expect(publishable.map((pkg) => pkg.name)).toContain("@mono-agent/agent-app");
  });

  test("validates the repository for the first npm launch tag", () => {
    const result = validateRelease({ tag: "v0.1.0", silent: true });

    expect(result.publishablePackages).toHaveLength(30);
    expect(result.publishablePackages.every((pkg) => pkg.version === "0.1.0")).toBe(true);
  });
});
