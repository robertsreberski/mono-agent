import { describe, expect, test } from "vitest";

import {
  assertMinimumNodeRuntime,
  buildPackedConsumerManifest,
  parsePackedConsumerArgs,
} from "../verify-packed-consumer.mjs";

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
});
