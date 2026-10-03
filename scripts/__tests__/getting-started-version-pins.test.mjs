import { describe, expect, it } from "vitest";

import {
  checkGettingStartedVersionPins,
  checkPublishedBaselineReferences,
} from "../check-getting-started-version-pins.mjs";

describe("check-getting-started-version-pins", () => {
  it("the shipped getting-started docs carry no drifted version pins", async () => {
    const result = await checkGettingStartedVersionPins();
    expect(result.issues, result.issues.join("\n")).toEqual([]);
  });

  it("flags a pin that disagrees with the agent-app version", async () => {
    const result = await checkGettingStartedVersionPins({
      agentAppVersion: "0.4.1",
      docRecords: [
        { path: "docs/getting-started/install.md", text: "npm i -g @mono-agent/agent-app@0.4.0" },
      ],
    });
    expect(result.pins).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("@mono-agent/agent-app@0.4.0");
    expect(result.issues[0]).toContain("0.4.1");
  });

  it("accepts a pin that matches the agent-app version", async () => {
    const result = await checkGettingStartedVersionPins({
      agentAppVersion: "0.4.1",
      docRecords: [
        {
          path: "docs/getting-started/install.md",
          text: "npm i -g @mono-agent/agent-app@0.4.1 @mono-agent/web@0.4.1",
        },
      ],
    });
    expect(result.pins).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  it("ignores shell placeholders and dist-tags (versionless docs are always clean)", async () => {
    const result = await checkGettingStartedVersionPins({
      agentAppVersion: "0.4.1",
      docRecords: [
        {
          path: "docs/getting-started/install.md",
          text: [
            'version=<published-version>',
            'npm i -g "@mono-agent/agent-app@$version" "@mono-agent/web@$version"',
            'npm i -g "mono-agent@$version"',
            "npm i -g @mono-agent/agent-app@latest",
            "npx mono-agent init",
          ].join("\n"),
        },
      ],
    });
    expect(result.pins).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("flags a drifted unscoped `mono-agent@X.Y.Z` alias pin", async () => {
    const result = await checkGettingStartedVersionPins({
      agentAppVersion: "0.5.0",
      docRecords: [
        { path: "docs/getting-started/install.md", text: "npm i -g mono-agent@0.4.1" },
      ],
    });
    expect(result.pins).toHaveLength(1);
    expect(result.pins[0].pin).toBe("mono-agent@0.4.1");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("mono-agent@0.4.1");
    expect(result.issues[0]).toContain("0.5.0");
  });

  it("does not double-count the `mono-agent` inside a scoped `@mono-agent/<pkg>` pin", async () => {
    const result = await checkGettingStartedVersionPins({
      agentAppVersion: "0.5.0",
      docRecords: [
        { path: "docs/getting-started/install.md", text: "npm i -g @mono-agent/agent-app@0.5.0" },
      ],
    });
    // Exactly one pin (the scoped name), not an extra spurious `mono-agent@0.5.0`.
    expect(result.pins).toHaveLength(1);
    expect(result.pins[0].pin).toBe("@mono-agent/agent-app@0.5.0");
    expect(result.issues).toEqual([]);
  });

  it("flags a drifted `create-mono-agent@X.Y.Z` installer pin", async () => {
    const result = await checkGettingStartedVersionPins({
      agentAppVersion: "0.5.1",
      docRecords: [
        { path: "docs/getting-started/install.md", text: "npm i -g create-mono-agent@0.5.0" },
      ],
    });
    expect(result.pins).toHaveLength(1);
    expect(result.pins[0].pin).toBe("create-mono-agent@0.5.0");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("create-mono-agent@0.5.0");
    expect(result.issues[0]).toContain("0.5.1");
  });

  it("does not double-count the `mono-agent` inside a `create-mono-agent` pin", async () => {
    const result = await checkGettingStartedVersionPins({
      agentAppVersion: "0.5.1",
      docRecords: [
        { path: "docs/getting-started/install.md", text: "npm i -g create-mono-agent@0.5.1" },
      ],
    });
    // Exactly one pin (the full installer name), not a spurious inner `mono-agent@0.5.1`.
    expect(result.pins).toHaveLength(1);
    expect(result.pins[0].pin).toBe("create-mono-agent@0.5.1");
    expect(result.issues).toEqual([]);
  });

  it("accepts the `npm create mono-agent@latest` dist-tag form (no version pin)", async () => {
    const result = await checkGettingStartedVersionPins({
      agentAppVersion: "0.5.1",
      docRecords: [
        { path: "docs/getting-started/install.md", text: "npm create mono-agent@latest init\nnpx create-mono-agent init" },
      ],
    });
    expect(result.pins).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});

describe("published baseline references", () => {
  it("keeps the shipped active baseline claims consistent", async () => {
    const result = await checkPublishedBaselineReferences();
    expect(result.issues, result.issues.join("\n")).toEqual([]);
    expect(result.references).toHaveLength(3);
    expect(new Set(result.references.map((reference) => reference.version))).toEqual(new Set(["0.22.0"]));
  });

  it("flags contradictory active published baselines", async () => {
    const result = await checkPublishedBaselineReferences({
      docRecords: [
        { path: "README.md", text: "The published baseline checked on 2026-09-21 is **`create-mono-agent@0.22.0`**." },
        { path: "docs/index.md", text: "The latest published npm release is `create-mono-agent@0.21.1`." },
        {
          path: "docs/reference/release-status.md",
          text: "| Latest published npm release (registry rechecked 2026-09-21) | `create-mono-agent@0.22.0` |",
        },
      ],
    });

    expect(result.references).toHaveLength(3);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("docs/index.md:1");
    expect(result.issues[0]).toContain("create-mono-agent@0.21.1");
    expect(result.issues[0]).toContain("create-mono-agent@0.22.0");
  });

  it("allows source and published versions to differ and ignores historical citations", async () => {
    const pinResult = await checkGettingStartedVersionPins({
      agentAppVersion: "0.23.0",
      docRecords: [
        { path: "docs/getting-started/install.md", text: "npm create mono-agent@latest" },
      ],
    });
    const baselineResult = await checkPublishedBaselineReferences({
      docRecords: [
        {
          path: "README.md",
          text: [
            "The published baseline checked on 2026-09-21 is **`create-mono-agent@0.22.0`**.",
            "The historical 0.21.1 release used an older network default.",
          ].join("\n"),
        },
        { path: "docs/index.md", text: "The latest published npm release is `create-mono-agent@0.22.0`." },
        {
          path: "docs/reference/release-status.md",
          text: [
            "| Latest published npm release (registry rechecked 2026-09-21) | `create-mono-agent@0.22.0` |",
            "Compare the historical `v0.21.1` tag when investigating that release.",
          ].join("\n"),
        },
      ],
    });

    expect(pinResult.agentAppVersion).toBe("0.23.0");
    expect(pinResult.issues).toEqual([]);
    expect(baselineResult.references.map((reference) => reference.version)).toEqual([
      "0.22.0",
      "0.22.0",
      "0.22.0",
    ]);
    expect(baselineResult.issues).toEqual([]);
  });

  it("fails closed when an active baseline claim disappears", async () => {
    const result = await checkPublishedBaselineReferences({
      docRecords: [
        { path: "README.md", text: "See the release page." },
      ],
    });
    expect(result.references).toEqual([]);
    expect(result.issues).toEqual([
      "README.md: expected exactly one explicit latest-published create-mono-agent@<version> baseline; found 0.",
    ]);
  });
});
