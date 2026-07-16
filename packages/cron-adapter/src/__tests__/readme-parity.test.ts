import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readmeUrl = new URL("../../README.md", import.meta.url);

describe("cron adapter README parity", () => {
  it("keeps direct overlap controls distinct from the agent-app config surface", async () => {
    const readme = await readFile(readmeUrl, "utf8");

    expect(readme).toContain("programmatic-only");
    expect(readme).toContain("`startCronAdapter`");
    expect(readme).toContain('`overlap: "skip" | "queue" | "replace"`');
    expect(readme).toContain("`maxQueueDepth`");
    expect(readme).toContain("`overflow`");
    expect(readme).toContain('pins `overlap: "skip"`');
    expect(readme).not.toMatch(/does not[^.\n]*queue overlapping jobs/iu);
  });
});
