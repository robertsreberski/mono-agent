import { describe, expect, it } from "vitest";

import { checkGettingStartedVersionPins } from "../check-getting-started-version-pins.mjs";

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
          text: "npm i -g @mono-agent/agent-app@0.4.1 @mono-agent/tui@0.4.1",
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
            'npm i -g "@mono-agent/agent-app@$version" "@mono-agent/tui@$version"',
            "npm i -g @mono-agent/agent-app@latest",
          ].join("\n"),
        },
      ],
    });
    expect(result.pins).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});
