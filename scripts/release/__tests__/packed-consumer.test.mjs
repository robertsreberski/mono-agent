import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { assertPackedDependencyResolution } from "../dependency-policy.mjs";
import {
  assertIsolatedInstallLayout,
  assertMinimumNodeRuntime,
  assertPackedReleaseMetadata,
  buildIsolatedConsumerManifest,
  buildPackedConsumerManifest,
  declaredInternalPackageClosure,
  declaredInternalPackageNames,
  parsePackedConsumerArgs,
} from "../verify-packed-consumer.mjs";
import {
  parsePackedSmokeArgs,
  publicExportSpecifiers,
} from "../fixtures/packed-consumer/public-exports.mjs";

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
    expect(() => assertMinimumNodeRuntime("24.15.0")).not.toThrow();
    expect(() => assertMinimumNodeRuntime("24.14.0")).toThrow(/must run on Node\.js 24\.15\.0/u);
    expect(() => assertMinimumNodeRuntime("24.0.0")).toThrow(/current Node\.js is 24\.0\.0/u);
  });

  test("builds a deterministic all-tarball consumer manifest", () => {
    const manifest = buildPackedConsumerManifest(
      {
        name: "consumer",
        engines: { node: ">=24.15.0" },
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
      /template engines\.node must be >=24\.15\.0/u,
    );
  });

  test("derives every concrete runtime export from a packed manifest", () => {
    expect(publicExportSpecifiers("@mono-agent/example", {
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./feature": { types: "./dist/feature.d.ts", default: "./dist/feature.js" },
        "./package.json": "./package.json",
        "./blocked": null,
      },
    })).toEqual([
      "@mono-agent/example",
      "@mono-agent/example/feature",
      "@mono-agent/example/package.json",
    ]);
    expect(publicExportSpecifiers("create-example", { bin: { create: "./cli.js" } })).toEqual([]);
    expect(publicExportSpecifiers("legacy-example", { main: "./index.js" })).toEqual(["legacy-example"]);
    expect(() => publicExportSpecifiers("@mono-agent/example", {
      exports: { "./features/*": "./dist/features/*.js" },
    })).toThrow(/wildcard export/u);
    expect(parsePackedSmokeArgs(["--target", "@mono-agent/example"])).toEqual({
      target: "@mono-agent/example",
    });
    expect(() => parsePackedSmokeArgs(["--target"])).toThrow(/requires a package name/u);
  });

  test("builds an isolated manifest with only the target as a direct dependency", () => {
    const template = { name: "consumer", engines: { node: ">=24.15.0" } };
    const packedPackages = [
      { name: "@mono-agent/target", tarballPath: "/tmp/target.tgz" },
      { name: "@mono-agent/declared", tarballPath: "/tmp/declared.tgz" },
      { name: "@mono-agent/peer", tarballPath: "/tmp/peer.tgz" },
      { name: "@mono-agent/hidden", tarballPath: "/tmp/hidden.tgz" },
    ];

    const manifest = buildIsolatedConsumerManifest(
      template,
      { name: "@mono-agent/target" },
      packedPackages,
    );

    expect(manifest.dependencies).toEqual({
      "@mono-agent/target": "file:/tmp/target.tgz",
    });
    expect(manifest.overrides).toEqual({
      "@mono-agent/declared": "file:/tmp/declared.tgz",
      "@mono-agent/hidden": "file:/tmp/hidden.tgz",
      "@mono-agent/peer": "file:/tmp/peer.tgz",
    });
    expect(manifest.dependencies["@mono-agent/hidden"]).toBeUndefined();
    expect(declaredInternalPackageNames({
      dependencies: { "@mono-agent/declared": "1.2.3" },
      peerDependencies: { "@mono-agent/peer": "1.2.3" },
    }, packedPackages)).toEqual([
      "@mono-agent/declared",
      "@mono-agent/peer",
    ]);
  });

  test("ships four concrete host entrypoints without a forwarding package", () => {
    const runtime = JSON.parse(fs.readFileSync(new URL("../../../packages/turn/package.json", import.meta.url), "utf8"));
    for (const [subpath, file] of [["host", "index"], ["host/config", "config"], ["host/types", "types"], ["host/sandbox", "sandbox"]]) {
      expect(runtime.exports[`./${subpath}`]).toEqual({ types: `./types/host/${file}.d.ts`, default: `./dist/host/${file}.js` });
      expect(Object.keys(runtime.exports[`./${subpath}`])).toEqual(["types", "default"]);
    }
    expect(runtime.files).toContain("dist/host/srt-embed-runner.mjs");
    expect(runtime.dependencies).not.toHaveProperty("@mono-agent/runtime-adapter");
    expect(fs.existsSync(new URL("../../../packages/runtime-adapter", import.meta.url))).toBe(false);
  });

  test("ships exactly three engine entrypoints from runtime, excluding engine tests", () => {
    const runtime = JSON.parse(fs.readFileSync(new URL("../../../packages/turn/package.json", import.meta.url), "utf8"));
    const expected = ["./engine", "./engine/sessions.js", "./engine/owned-fs.js"];
    expect(Object.keys(runtime.exports).filter((key) => key.startsWith("./engine"))).toEqual(expected);
    for (const [subpath, file] of [["engine", "index"], ["engine/sessions.js", "sessions"], ["engine/owned-fs.js", "owned-fs"]]) {
      expect(runtime.exports[`./${subpath}`]).toEqual({ types: `./types/engine/${file}.d.ts`, default: `./src/engine/${file}.js` });
      expect(Object.keys(runtime.exports[`./${subpath}`])).toEqual(["types", "default"]);
    }
    expect(runtime.files).toContain("!src/engine/__tests__/**");
  });

  test("keeps provider interoperability on the runtime-owned public boundary", async () => {
    const runtimeManifestUrl = new URL(
      "../../../packages/turn/package.json",
      import.meta.url,
    );
    const runtime = JSON.parse(fs.readFileSync(runtimeManifestUrl, "utf8"));
    const packedRuntime = {
      name: runtime.name,
      tarballPath: "/tmp/mono-agent-agent-runtime.tgz",
    };
    const consumer = buildIsolatedConsumerManifest(
      {
        name: "runtime-only-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        engines: { node: ">=24.15.0" },
      },
      packedRuntime,
      [packedRuntime],
    );

    expect(consumer.dependencies).toEqual({
      "@mono-agent/turn": "file:/tmp/mono-agent-agent-runtime.tgz",
    });
    expect(consumer.dependencies).not.toHaveProperty("@earendil-works/pi-ai");
    expect(consumer.dependencies).not.toHaveProperty("@earendil-works/pi-agent-core");
    expect(runtime.dependencies).toMatchObject({
      "@earendil-works/pi-ai": "1.2.0",
      "@earendil-works/pi-agent-core": "1.2.0",
    });
    expect(runtime.dependencies).not.toHaveProperty("@mono-agent/engine");
    expect(fs.existsSync(new URL("../../../packages/engine", import.meta.url))).toBe(false);

    const packedImports = publicExportSpecifiers(runtime.name, runtime);
    expect(packedImports.sort()).toEqual([
      "@mono-agent/turn", "@mono-agent/turn/ai", "@mono-agent/turn/agent", "@mono-agent/turn/tools",
      "@mono-agent/turn/host", "@mono-agent/turn/host/config", "@mono-agent/turn/host/types", "@mono-agent/turn/host/sandbox",
      "@mono-agent/turn/engine", "@mono-agent/turn/engine/sessions.js", "@mono-agent/turn/engine/owned-fs.js",
    ].sort());

    const ai = await import(publicRuntimeExportUrl(runtimeManifestUrl, runtime, "./ai"));
    for (const exportName of [
      "getPiBuiltinModel",
      "listPiBuiltinModels",
      "loginPiOAuth",
      "reasoningLevelsForPiModel",
      "resolvePiOAuthApiKey",
    ]) {
      expect(ai[exportName], `${exportName} must be exported by the public AI barrel`).toBeTypeOf("function");
    }
    const listedPiModels = ai.listPiBuiltinModels("anthropic");
    expect(listedPiModels.length).toBeGreaterThan(0);
    expect(ai.getPiBuiltinModel("anthropic", listedPiModels[0].id)).toEqual(listedPiModels[0]);
    expect(listedPiModels.some((model) =>
      Object.values(model.thinkingLevelMap || {}).some((value) => value === null),
    )).toBe(true);
    const tieredPiModel = ai.listPiBuiltinModels("openai").find(
      (model) => Array.isArray(model.cost?.tiers) && model.cost.tiers.length > 0,
    );
    expect(tieredPiModel?.cost.tiers[0]).toMatchObject({
      inputTokensAbove: expect.any(Number),
      input: expect.any(Number),
      output: expect.any(Number),
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
    });

    const codexClient = await import(publicRuntimeExportUrl(
      runtimeManifestUrl,
      runtime,
      "./ai",
    ));
    expect(codexClient.createCodexAppServerClient).toBeTypeOf("function");
  });

  test("derives the complete declared internal dependency closure", () => {
    const manifests = new Map([
      ["@mono-agent/target", { dependencies: { "@mono-agent/direct": "1.2.3" } }],
      ["@mono-agent/direct", { optionalDependencies: { "@mono-agent/transitive": "1.2.3" } }],
      ["@mono-agent/transitive", {}],
      ["@mono-agent/unrelated", {}],
    ]);

    expect(declaredInternalPackageClosure("@mono-agent/target", manifests)).toEqual([
      "@mono-agent/direct",
      "@mono-agent/target",
      "@mono-agent/transitive",
    ]);
    expect(() => declaredInternalPackageClosure("@mono-agent/missing", manifests)).toThrow(
      /Packed manifest missing/u,
    );
  });

  test("requires exact release repository metadata in the packed manifest", () => {
    const pkg = {
      name: "@mono-agent/example",
      version: "1.2.3",
      relativeDir: "packages/example",
    };
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      repository: {
        type: "git",
        url: "git+https://github.com/robertsreberski/mono-agent.git",
        directory: pkg.relativeDir,
      },
    };

    expect(() => assertPackedReleaseMetadata(pkg, manifest)).not.toThrow();
    expect(() => assertPackedReleaseMetadata(pkg, {
      ...manifest,
      repository: { ...manifest.repository, directory: "packages/wrong" },
    })).toThrow(/Packed @mono-agent\/example repository must be/u);
  });

  test("isolated packed install exposes an undeclared dependency masked by the combined consumer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packed-isolation-regression-"));
    temporaryDirectories.push(root);
    const target = packSyntheticPackage(root, {
      name: "@mono-agent/target",
      version: "1.2.3",
      type: "module",
      exports: { ".": "./index.js" },
    }, 'import { hidden } from "@mono-agent/hidden"; export { hidden };\n');
    const hidden = packSyntheticPackage(root, {
      name: "@mono-agent/hidden",
      version: "1.2.3",
      type: "module",
      exports: { ".": "./index.js" },
    }, "export const hidden = true;\n");
    const template = {
      name: "consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      engines: { node: ">=24.15.0" },
    };

    const combinedDir = path.join(root, "combined");
    fs.mkdirSync(combinedDir);
    writeJson(path.join(combinedDir, "package.json"), buildPackedConsumerManifest(
      template,
      [target, hidden],
    ));
    expect(runNpmInstall(combinedDir).status).toBe(0);
    expect(importPackage(combinedDir, target.name).status).toBe(0);

    const isolatedDir = path.join(root, "isolated");
    fs.mkdirSync(isolatedDir);
    const isolatedManifest = buildIsolatedConsumerManifest(
      template,
      target,
      [target, hidden],
    );
    writeJson(path.join(isolatedDir, "package.json"), isolatedManifest);
    expect(runNpmInstall(isolatedDir).status).toBe(0);
    expect(() => assertIsolatedInstallLayout(
      isolatedDir,
      target.name,
      declaredInternalPackageClosure(target.name, new Map([
        [target.name, target.packageJson],
        [hidden.name, hidden.packageJson],
      ])),
      [target.name, hidden.name],
    )).not.toThrow();
    const isolatedImport = importPackage(isolatedDir, target.name);
    expect(isolatedImport.status).not.toBe(0);
    expect(isolatedImport.stderr).toMatch(/Cannot find package '@mono-agent\/hidden'/u);
  });

  test("accepts exact packed Pi pins and their actual installed resolution", () => {
    const fixture = packedDependencyFixture();

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).not.toThrow();
  });

  test("rejects an incompatible host Pi copy that rewires Pi Agent Core", () => {
    const fixture = packedDependencyFixture({
      rootPiVersion: "0.80.8",
      nestedCorePiVersion: null,
      nestedRuntimePiVersion: "1.2.0",
    });
    const runtimePackages = fixture.packages.filter(
      (pkg) => pkg.name === "@mono-agent/turn",
    );

    expect(runtimePackages).toHaveLength(1);
    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, runtimePackages),
    ).toThrow(
      "Packed consumer resolved @earendil-works/pi-ai@0.80.8 from @earendil-works/pi-agent-core@1.2.0; expected 1.2.0",
    );
  });

  test("rejects a packed manifest that can float to a newer Pi runtime", () => {
    const fixture = packedDependencyFixture({ appPiRange: "^1.2.0" });

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).toThrow(
      /Packed @mono-agent\/app dependencies\.@earendil-works\/pi-ai must remain 1\.2\.0; found \^1\.2\.0/u,
    );
  });

  test("rejects an incompatible Pi AI nested under the pinned core", () => {
    const fixture = packedDependencyFixture({ nestedCorePiVersion: "0.80.8" });

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).toThrow(
      /resolved @earendil-works\/pi-ai@0\.80\.8 from @earendil-works\/pi-agent-core@1\.2\.0; expected 1\.2\.0/u,
    );
  });

});

function packedDependencyFixture({
  appPiRange = "1.2.0",
  nestedCorePiVersion = "1.2.0",
  nestedRuntimePiVersion,
  rootPiVersion = "1.2.0",
} = {}) {
  const consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), "packed-dependency-policy-"));
  temporaryDirectories.push(consumerDir);
  const modulesDir = path.join(consumerDir, "node_modules");

  writePackage(modulesDir, {
    name: "@mono-agent/app",
    version: "1.2.3",
    dependencies: { "@earendil-works/pi-ai": appPiRange },
  });
  const runtimeDir = writePackage(modulesDir, {
    name: "@mono-agent/turn",
    version: "1.2.3",
    dependencies: {
      "@earendil-works/pi-agent-core": "1.2.0",
      "@earendil-works/pi-ai": "1.2.0",
    },
  });
  const coreDir = writePackage(modulesDir, {
    name: "@earendil-works/pi-agent-core",
    version: "1.2.0",
    dependencies: { "@earendil-works/pi-ai": "^1.2.0" },
  });
  writePackage(modulesDir, {
    name: "@earendil-works/pi-ai",
    version: rootPiVersion,
  });
  if (nestedRuntimePiVersion !== undefined) {
    writePackage(path.join(runtimeDir, "node_modules"), {
      name: "@earendil-works/pi-ai",
      version: nestedRuntimePiVersion,
    });
  }
  if (nestedCorePiVersion !== null) {
    writePackage(path.join(coreDir, "node_modules"), {
      name: "@earendil-works/pi-ai",
      version: nestedCorePiVersion,
    });
  }

  return {
    consumerDir,
    packages: [
      {
        name: "@mono-agent/app",
        packageJson: {
          dependencies: { "@earendil-works/pi-ai": "1.2.0" },
        },
      },
      {
        name: "@mono-agent/turn",
        packageJson: {
          dependencies: {
            "@earendil-works/pi-agent-core": "1.2.0",
            "@earendil-works/pi-ai": "1.2.0",
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

function packSyntheticPackage(root, packageJson, source) {
  const packageDir = path.join(root, packageJson.name.replace(/[^0-9A-Za-z]+/gu, "-"));
  const tarballDir = path.join(root, "tarballs");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(tarballDir, { recursive: true });
  writeJson(path.join(packageDir, "package.json"), packageJson);
  fs.writeFileSync(path.join(packageDir, "index.js"), source);
  fs.writeFileSync(path.join(packageDir, "README.md"), `${packageJson.name}\n`);
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", tarballDir], {
    cwd: packageDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`synthetic npm pack failed: ${result.stderr || result.stdout}`);
  }
  const [packed] = JSON.parse(result.stdout);
  return {
    name: packageJson.name,
    packageJson,
    tarballPath: path.join(tarballDir, packed.filename),
  };
}

function runNpmInstall(directory) {
  return spawnSync("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
  ], {
    cwd: directory,
    encoding: "utf8",
  });
}

function importPackage(directory, name) {
  return spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(name)})`,
  ], {
    cwd: directory,
    encoding: "utf8",
  });
}

function publicRuntimeExportUrl(manifestUrl, manifest, subpath) {
  const target = manifest.exports?.[subpath];
  const runtimeTarget = typeof target === "string"
    ? target
    : target?.default ?? target?.import;
  if (typeof runtimeTarget !== "string") {
    throw new Error(`Runtime package export ${subpath} has no importable runtime target.`);
  }
  return new URL(runtimeTarget, manifestUrl);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
