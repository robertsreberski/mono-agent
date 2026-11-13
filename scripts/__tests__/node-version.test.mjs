import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  MINIMUM_NODE_VERSION,
  SUPPORTED_NODE_ENGINE,
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  parseNodeVersion,
} from "../node-version.mjs";

describe("Node.js support floor", () => {
  test("keeps the exact v1 minimum and engine range together", () => {
    expect(MINIMUM_NODE_VERSION).toBe("24.15.0");
    expect(SUPPORTED_NODE_ENGINE).toBe(">=24.15.0");
  });

  test.each([
    ["20.20.2", false],
    ["22.19.0", false],
    ["24.14.0", false],
    ["24.15.0", true],
    ["v24.15.0", true],
    ["24.15.1", true],
    ["24.18.0", true],
    ["25.0.0", true],
  ])("classifies %s", (version, supported) => {
    expect(isSupportedNodeVersion(version)).toBe(supported);
  });

  test("fails clearly for an unsupported or malformed version", () => {
    expect(() => assertSupportedNodeVersion("24.14.0")).toThrow(
      /requires Node\.js >=24\.15\.0; current Node\.js is 24\.14\.0/u,
    );
    expect(() => parseNodeVersion("current")).toThrow(/Could not parse Node\.js version/u);
  });
});

test("all workspace engine declarations and runtime guard follow the canonical floor", async () => {
  const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  expect(readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").trim().replace(/^v/, "")).toBe(MINIMUM_NODE_VERSION);
  expect(read("../../package.json").engines.node).toBe(SUPPORTED_NODE_ENGINE);
  for (const parent of ["packages", "extras"]) {
    for (const dir of readdirSync(new URL(`../../${parent}/`, import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const manifest = read(`../../${parent}/${dir.name}/package.json`);
      expect(manifest.engines.node).toBe(SUPPORTED_NODE_ENGINE);
    }
  }
  const guard = await import("../../packages/app/dist/node-version-guard.js");
  expect(guard.requiredNode).toBe(SUPPORTED_NODE_ENGINE);
  expect(guard.minimumNode).toBe(MINIMUM_NODE_VERSION);
});
