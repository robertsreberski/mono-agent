import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { assertPackedDependencyResolution } from "../dependency-policy.mjs";
import {
  assertMinimumNodeRuntime,
  buildPackedConsumerManifest,
  parsePackedConsumerArgs,
} from "../verify-packed-consumer.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("packed consumer verification", () => {
  test("parses the release tag and exact-minimum guard", () => {
    expect(parsePackedConsumerArgs(["--", "--tag", "v1.2.3", "--require-minimum"])).toEqual({
      tag: "v1.2.3",
      requireMinimum: true,
    });
    expect(() => parsePackedConsumerArgs(["--tag"])).toThrow(/--tag requires a value/u);
    expect(() => parsePackedConsumerArgs(["--unknown"])).toThrow(/Unknown argument/u);
  });

  test("requires the exact minimum when the proof flag is used", () => {
    expect(() => assertMinimumNodeRuntime("22.19.0")).not.toThrow();
    expect(() => assertMinimumNodeRuntime("22.18.0")).toThrow(/must run on Node\.js 22\.19\.0/u);
    expect(() => assertMinimumNodeRuntime("24.0.0")).toThrow(/current Node\.js is 24\.0\.0/u);
  });

  test("builds a deterministic all-tarball consumer manifest", () => {
    const manifest = buildPackedConsumerManifest(
      {
        name: "consumer",
        engines: { node: ">=22.19.0" },
      },
      [
        { name: "@mono-agent/z", tarballPath: "/tmp/z.tgz" },
        { name: "@mono-agent/a", tarballPath: "/tmp/a.tgz" },
      ],
    );

    expect(manifest.dependencies).toEqual({
      "@mono-agent/a": "file:/tmp/a.tgz",
      "@mono-agent/z": "file:/tmp/z.tgz",
    });
    expect(() => buildPackedConsumerManifest({ engines: { node: ">=20" } }, [])).toThrow(
      /template engines\.node must be >=22\.19\.0/u,
    );
  });

  test("accepts exact packed Pi pins and their actual installed resolution", () => {
    const fixture = packedDependencyFixture();

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).not.toThrow();
  });

  test("rejects a packed manifest that can float to a newer Pi runtime", () => {
    const fixture = packedDependencyFixture({ appPiRange: "^0.80.5" });

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).toThrow(
      /Packed @mono-agent\/agent-app dependencies\.@earendil-works\/pi-ai must remain 0\.80\.5; found \^0\.80\.5/u,
    );
  });

  test("rejects an incompatible Pi AI nested under the pinned core", () => {
    const fixture = packedDependencyFixture({ nestedCorePiVersion: "0.80.8" });

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).toThrow(
      /resolved @earendil-works\/pi-ai@0\.80\.8 from @earendil-works\/pi-agent-core@0\.80\.5; expected 0\.80\.5/u,
    );
  });
});

function packedDependencyFixture({ appPiRange = "0.80.5", nestedCorePiVersion } = {}) {
  const consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), "packed-dependency-policy-"));
  temporaryDirectories.push(consumerDir);
  const modulesDir = path.join(consumerDir, "node_modules");

  writePackage(modulesDir, {
    name: "@mono-agent/agent-app",
    version: "1.2.3",
    dependencies: { "@earendil-works/pi-ai": appPiRange },
  });
  writePackage(modulesDir, {
    name: "@mono-agent/agent-runtime",
    version: "1.2.3",
    dependencies: {
      "@earendil-works/pi-agent-core": "0.80.5",
      "@earendil-works/pi-ai": "0.80.5",
    },
  });
  const coreDir = writePackage(modulesDir, {
    name: "@earendil-works/pi-agent-core",
    version: "0.80.5",
    dependencies: { "@earendil-works/pi-ai": "^0.80.5" },
  });
  writePackage(modulesDir, {
    name: "@earendil-works/pi-ai",
    version: "0.80.5",
  });
  if (nestedCorePiVersion !== undefined) {
    writePackage(path.join(coreDir, "node_modules"), {
      name: "@earendil-works/pi-ai",
      version: nestedCorePiVersion,
    });
  }

  return {
    consumerDir,
    packages: [
      {
        name: "@mono-agent/agent-app",
        packageJson: {
          dependencies: { "@earendil-works/pi-ai": "0.80.5" },
        },
      },
      {
        name: "@mono-agent/agent-runtime",
        packageJson: {
          dependencies: {
            "@earendil-works/pi-agent-core": "0.80.5",
            "@earendil-works/pi-ai": "0.80.5",
          },
        },
      },
    ],
  };
}

function writePackage(modulesDir, manifest) {
  const packageDir = path.join(modulesDir, ...manifest.name.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({
      type: "module",
      exports: { ".": { import: "./index.js" } },
      ...manifest,
    }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(packageDir, "index.js"), "export {};\n");
  return packageDir;
}
